"""One JSON-speaking command line for Gallery and thin downstream adapters."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

from .client import DEFAULT_API_BASE, GalleryClient, LegacyAdapter
from .runtime import GALLERY_ROOT, GalleryError, invalid

EXIT_CODES = {
    "invalid_input": 2,
    "network": 3,
    "timeout": 4,
    "blocked": 5,
    "cancelled": 5,
    "rate_limited": 5,
    "provider_error": 5,
    "uncertain": 6,
    "save_failed": 6,
}
FAILURE_PRIORITY = (
    "uncertain", "save_failed", "blocked", "invalid_input", "network", "timeout",
    "cancelled", "rate_limited", "provider_error",
)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise invalid(message)

    def print_help(self, file=None):
        super().print_help(file or sys.stderr)


def _prompt_options(parser, required=False):
    group = parser.add_mutually_exclusive_group(required=required)
    group.add_argument("--prompt")
    group.add_argument("--prompt-file", metavar="PATH|-")


def _model_options(parser):
    parser.add_argument("--provider")
    parser.add_argument("--model")
    parser.add_argument("--aspect-ratio")
    parser.add_argument("--image-size")
    parser.add_argument("--quality")
    parser.add_argument("--reference-notes-file", metavar="PATH|-",
                        help="UTF-8 JSON array, one string per reference slot")


def _download_options(parser):
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--output-dir", type=Path, help="Defaults to a private temporary directory")
    group.add_argument("--no-download", action="store_true")


def _listing_options(parser):
    parser.add_argument("--from", dest="from_date")
    parser.add_argument("--to", dest="to_date")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--cursor")


def build_parser():
    parser = Parser(description=__doc__,
                    epilog="Exit codes: 0 success, 2 invalid input, 3 connection failure, "
                           "4 timeout, 5 rejected/failed task, 6 uncertain outcome or save failure.")
    parser.add_argument("--api-base", help=f"Defaults to BANANA_GALLERY_URL or {DEFAULT_API_BASE}")
    parser.add_argument("--token", help="Bearer token; prefer BANANA_GALLERY_TOKEN to avoid shell history")
    parser.add_argument("--gallery-root", type=Path, default=GALLERY_ROOT)
    parser.add_argument("--no-start", action="store_true")
    commands = parser.add_subparsers(dest="command", required=True)

    ensure = commands.add_parser("ensure", help="Check that the Gallery API is ready")
    ensure.add_argument("--timeout", type=float, default=90)
    models = commands.add_parser("models", help="List the Gallery model catalogue")
    models.add_argument("--provider")
    models.add_argument("--available-only", action="store_true")

    generate = commands.add_parser("generate", help="Submit a generation with a stable key")
    generate.add_argument("--key", required=True)
    _prompt_options(generate, required=True)
    _model_options(generate)
    generate.add_argument("--reference", action="extend", nargs="+", type=Path)

    iterate = commands.add_parser("iterate", help="Submit a new task from a work's frozen input")
    iterate.add_argument("--from", dest="source_code", required=True)
    iterate.add_argument("--key", required=True)
    _prompt_options(iterate)
    _model_options(iterate)
    references = iterate.add_mutually_exclusive_group()
    references.add_argument("--reference", action="extend", nargs="+", type=Path)
    references.add_argument("--append-reference", action="extend", nargs="+", type=Path)
    references.add_argument("--clear-references", action="store_true")

    batch = commands.add_parser("batch", help="Submit a manifest or resume a batch state")
    batch_input = batch.add_mutually_exclusive_group(required=True)
    batch_input.add_argument("--manifest", metavar="PATH|-",
                             help="JSON schemaVersion 1: items or matrix (prompts × referenceGroups)")
    batch_input.add_argument("--resume", type=Path, metavar="STATE")
    batch.add_argument("--state", type=Path)
    batch.add_argument("--base-dir", type=Path)
    batch.add_argument("--submit-timeout", type=float, default=180)

    for name in ("status", "wait"):
        command = commands.add_parser(name, help=f"{name.capitalize()} one task or a whole batch")
        target = command.add_mutually_exclusive_group(required=True)
        target.add_argument("task_id", nargs="?")
        target.add_argument("--batch", type=Path, metavar="STATE")
        if name == "status":
            target.add_argument("--key", help="Look up a submission by its stable key")
        if name == "wait":
            command.add_argument("--timeout", type=float, default=180)
            _download_options(command)

    inspect = commands.add_parser("inspect", help="Read a work and its frozen generation context")
    inspect.add_argument("code")
    _download_options(inspect)
    works = commands.add_parser("works", help="List works newest first, ignoring pins")
    recipes = commands.add_parser("recipes", help="List saved recipes newest first")
    for listing in (works, recipes):
        _listing_options(listing)
        listing.add_argument("--query")
    recipes.add_argument("--full-prompt", action="store_true")

    history = commands.add_parser("history", help="List compact task history")
    _listing_options(history)
    history.add_argument("--status", action="extend", nargs="+")
    history.add_argument("--provider")

    save = commands.add_parser("save-recipe", help="Save an existing work or a local image as a recipe")
    source = save.add_mutually_exclusive_group(required=True)
    source.add_argument("--from", dest="source_code")
    source.add_argument("--image", type=Path)
    _prompt_options(save)
    save.add_argument("--title")
    save.add_argument("--tag", action="extend", nargs="+")
    save.add_argument("--source-type")

    submit = commands.add_parser("submit", help="Compatibility alias: iterate with only a new prompt")
    submit.add_argument("--from", dest="source_code", required=True)
    submit.add_argument("--prompt-file", required=True)
    submit.add_argument("--key", required=True)
    inspire = commands.add_parser("inspire", help="Compatibility recipe search with complete prompts")
    inspire.add_argument("--query", required=True)
    inspire.add_argument("--limit", type=int, default=5)
    return parser


def _text(source):
    try:
        if source != "-":
            return Path(source).expanduser().read_bytes().decode("utf-8")
        stream = getattr(sys.stdin, "buffer", None)
        if stream is None:
            return sys.stdin.read()
        return stream.read().decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
    except (OSError, UnicodeError) as error:
        raise invalid(f"Cannot read {source}: {error}") from error


def _json_input(source, label):
    try:
        return json.loads(_text(source), parse_constant=_invalid_json_constant)
    except ValueError as error:
        raise invalid(f"Invalid {label} JSON: {error}") from error


def _invalid_json_constant(value):
    raise ValueError(f"Unexpected JSON constant {value}")


def _prepare(args):
    if args.command in {"generate", "iterate", "save-recipe", "submit"}:
        direct_prompt = getattr(args, "prompt", None)
        notes_file = getattr(args, "reference_notes_file", None)
        if args.prompt_file == "-" and notes_file == "-":
            raise invalid("Only one of prompt and reference notes can read stdin")
        if args.command == "save-recipe":
            provided = args.prompt_file is not None or direct_prompt is not None
            if (args.image is not None) != provided:
                raise invalid("--image requires a prompt; --from does not accept one")
        args.prompt = _text(args.prompt_file) if args.prompt_file is not None else direct_prompt
        args.reference_notes = _json_input(notes_file, "reference notes") if notes_file is not None else None
        if notes_file is not None and not isinstance(args.reference_notes, list):
            raise invalid("Reference notes file must contain a JSON array")
    if args.command == "batch":
        if args.resume is not None and (args.state is not None or args.base_dir is not None):
            raise invalid("--state and --base-dir are only valid with --manifest")
        if args.manifest is not None:
            args.manifest_value = _json_input(args.manifest, "manifest")
            if args.base_dir is None and args.manifest != "-":
                args.base_dir = Path(args.manifest).expanduser().resolve().parent


def _dispatch(client, args):
    command = args.command
    ready = client.ensure_ready(args.timeout if command == "ensure" else 90)
    if command == "ensure":
        return {"ready": True, "apiBase": ready.api_base, "started": ready.started,
                "session": ready.session, "account": ready.account}
    if command == "models":
        return client.list_models(args.provider, args.available_only)
    if command in {"generate", "iterate"}:
        params = {arg: getattr(args, arg) for arg in
                  ("provider", "model", "aspect_ratio", "image_size", "quality", "reference_notes")}
        params["references"] = args.reference
        if command == "generate":
            return client.generate(args.key, args.prompt, **params)
        return client.iterate(args.source_code, args.key, prompt=args.prompt,
                              append_references=args.append_reference,
                              clear_references=args.clear_references, **params)
    if command == "batch":
        if args.resume:
            return client.batch.resume(args.resume, timeout=args.submit_timeout)
        return client.batch.submit(args.manifest_value, state_path=args.state,
                                   base_dir=args.base_dir, timeout=args.submit_timeout)
    if command == "status":
        if args.key is not None:
            return client.get_task_status_by_key(args.key)
        return client.batch_status(args.batch) if args.batch else client.get_task_status(args.task_id)
    if command == "wait":
        target = args.batch or args.task_id
        wait = client.batch_wait if args.batch else client.wait_for_task
        return wait(target, timeout=args.timeout, output_dir=args.output_dir, download=not args.no_download)
    if command == "inspect":
        return client.inspect_work(args.code, output_dir=args.output_dir, download=not args.no_download)
    if command in {"works", "recipes", "history"}:
        params = {field: getattr(args, field) for field in ("from_date", "to_date", "limit", "cursor")}
        if command == "history":
            return client.list_history(status=args.status, provider=args.provider, **params)
        if command == "recipes":
            return client.list_recipes(query=args.query, full_prompt=args.full_prompt, **params)
        return client.list_works(query=args.query, **params)
    if command == "save-recipe":
        updates = {"title": args.title, "tags": args.tag, "source_type": args.source_type}
        if args.image is not None:
            return client.save_recipe_from_image(args.image, args.prompt, **updates)
        return client.save_recipe_from_work(args.source_code, **updates)
    legacy = LegacyAdapter(client)
    if command == "submit":
        return legacy.submit_iteration(args.source_code, args.prompt, args.key)
    return legacy.find_recipes(args.query, args.limit)


def _exit(command, result):
    if command not in {"generate", "iterate", "batch", "status", "wait"}:
        return 0
    failures = [row["failure"]["category"] for row in result.get("items", []) if row.get("failure")]
    if result.get("failure"):
        failures.append(result["failure"]["category"])
    if result.get("timedOut"):
        failures.append("timeout")
    category = next((name for name in FAILURE_PRIORITY if name in failures), None)
    return EXIT_CODES.get(category, 5 if failures else 0)


def _token_redactor(argv):
    # Capture even malformed invocations: argparse can echo their unrecognized arguments.
    values = [os.environ.get("BANANA_GALLERY_TOKEN", "")]
    for index, arg in enumerate(argv):
        if arg == "--":
            break
        option, equals, value = arg.partition("=")
        if option.startswith("--t") and "--token".startswith(option):
            values.append(value if equals else (argv[index + 1] if index + 1 < len(argv) else ""))
    secrets = sorted({value.strip() for value in values if value.strip()}, key=len, reverse=True)

    def redact(value):
        if isinstance(value, str):
            for secret in secrets:
                value = value.replace(secret, "[redacted]")
        elif isinstance(value, dict):
            return {key: redact(item) for key, item in value.items()}
        elif isinstance(value, (list, tuple)):
            return [redact(item) for item in value]
        return value

    return redact


def main(argv=None, *, default_generate_params=None, default_source_type=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    redact = _token_redactor(argv)
    try:
        args = build_parser().parse_args(argv)
        _prepare(args)
        client = GalleryClient(args.api_base, gallery_root=args.gallery_root, no_start=args.no_start, token=args.token,
                               default_generate_params=default_generate_params, default_source_type=default_source_type)
        result = _dispatch(client, args)
        if args.command == "batch":
            print(redact(f"Batch state: {result['statePath']}"), file=sys.stderr)
        code = _exit(args.command, result)
    except GalleryError as error:
        print(redact(str(error)), file=sys.stderr)
        result, code = {"error": error.as_dict()}, EXIT_CODES[error.category]
    except (OSError, ValueError) as error:
        print(redact(str(error)), file=sys.stderr)
        result, code = {"error": invalid(str(error)).as_dict()}, 2
    except KeyboardInterrupt:
        result, code = {"error": {"category": "cancelled", "message": "Interrupted"}}, 5
    print(json.dumps(redact(result), ensure_ascii=True, allow_nan=False))
    return code
