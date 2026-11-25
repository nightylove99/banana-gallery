"""Stable, importable Banana Gallery client. Call ensure_ready before a session."""
from __future__ import annotations

from datetime import date
import json
import os
import re
import time
from urllib.parse import urlencode

from .runtime import (
    GALLERY_ROOT, TERMINAL_FAILURES, GalleryError, Runtime, asset_filename,
    classify_failure, default_state_dir, invalid, remaining, segment, timeout_deadline,
)
from .submission import (
    TASKS, BatchRunner, Submission, image_bytes, image_path as local_image_path, multipart, validate_key,
)

DEFAULT_API_BASE = "http://127.0.0.1:3333"
MODEL_OPTIONS = {"provider", "model", "aspectRatio", "imageSize", "quality"}
IMAGES = "/api/images"


def _string_units(value, label, limit, *, nonempty=False):
    if not isinstance(value, str) or (nonempty and not value.strip()):
        raise invalid(f"{label} must be {'a nonempty' if nonempty else 'a'} string")
    try:
        count = len(value.encode("utf-16-le")) // 2
    except UnicodeError as error:
        raise invalid(f"{label} contains invalid Unicode") from error
    if count > limit:
        raise invalid(f"{label} must be at most {limit} UTF-16 code units")


def _references(values):
    if values is None:
        return []
    if not isinstance(values, (list, tuple)):
        raise invalid("References must be a sequence of local image paths")
    return list(values)


def _object(value, label, *required):
    if not isinstance(value, dict) or any(not value.get(name) for name in required):
        raise GalleryError("network", f"Invalid Gallery {label} response")
    return value


def _options(provider, model, aspect_ratio, image_size, quality):
    return {name: value for name, value in {
        "provider": provider, "model": model, "aspectRatio": aspect_ratio,
        "imageSize": image_size, "quality": quality,
    }.items() if value is not None}


def _validate_day(value):
    if value is None:
        return
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        raise invalid("Gallery date filters use YYYY-MM-DD")
    try:
        date.fromisoformat(value)
    except ValueError as error:
        raise invalid("Gallery date filters must be valid calendar dates") from error


class GalleryClient:
    def __init__(self, api_base=None, *, gallery_root=GALLERY_ROOT, no_start=False,
                 state_dir=None, default_generate_params=None, default_source_type=None,
                 poll_interval=1.0, token=None):
        if api_base is None:
            api_base = os.environ.get("BANANA_GALLERY_URL") or DEFAULT_API_BASE
        self.runtime = Runtime(api_base, gallery_root, no_start,
                               state_dir if state_dir is not None else default_state_dir(), token=token)
        self.submission = Submission(self.runtime)
        self.default_generate_params = dict(default_generate_params or {})
        if set(self.default_generate_params) - MODEL_OPTIONS:
            raise invalid("Unknown default generation parameter")
        self.default_source_type = default_source_type
        timeout_deadline(poll_interval)
        self.poll_interval = poll_interval
        self.batch = BatchRunner(self)

    def ensure_ready(self, timeout=90):
        return self.runtime.ensure_ready(timeout)

    def _models(self, deadline=None):
        result = _object(self.runtime.json("GET", "/api/generation/models", deadline=deadline),
                         "models")
        if not isinstance(result.get("models"), list) or any(not isinstance(row, dict) for row in result["models"]):
            raise GalleryError("network", "Invalid Gallery models list")
        return result

    def list_models(self, provider=None, available_only=False):
        result = self._models()
        return {**result, "models": [model for model in result["models"]
                if (provider is None or model.get("provider") == provider)
                and (not available_only or model.get("available"))]}

    @staticmethod
    def _choose_model(catalog, provider, model):
        choices = catalog["models"]
        preferred = catalog.get("defaultModel") or {}
        if provider is None and model is None:
            provider, model = preferred.get("provider"), preferred.get("model")
        if model is None and provider == preferred.get("provider"):
            model = preferred.get("model")
        matching = [item for item in choices if (provider is None or item.get("provider") == provider)
                    and (model is None or item.get("model") == model)]
        if not matching:
            raise invalid("Provider/model combination is not in Gallery's model catalogue")
        result = next((item for item in matching if item.get("available")), matching[0])
        # Existing keys remain recoverable even if their channel is now unavailable;
        # the server is authoritative when a new task actually runs.
        return result

    @staticmethod
    def _canonical_input(definition, options, prompt, inherited, local_count, notes):
        _string_units(prompt, "Prompt", 20000, nonempty=True)
        count = len(inherited) + local_count
        maximum = definition["maxReferenceImages"]
        if count > maximum:
            raise invalid(f"Selected model supports at most {maximum} reference images")
        if notes is not None:
            if not isinstance(notes, (list, tuple)) or len(notes) != count:
                raise invalid("referenceNotes must contain one string per reference slot")
            for note in notes:
                _string_units(note, "Reference note", 500)
        mode = definition.get("referenceAspectRatioMode")
        ratios = definition["supportedAspectRatios"]
        default_ratio = definition["defaultAspectRatio"]
        if count > 0 and mode == "source":
            ratios, default_ratio = ["source"], "source"
        elif count > 0 and mode == "source-or-preset":
            ratios, default_ratio = ["source", *ratios], "source"
        ratio = options.get("aspectRatio", default_ratio)
        if ratio not in ratios:
            raise invalid(f"Unsupported aspect ratio for selected model/references: {ratio}")
        payload = {"prompt": prompt, "provider": definition["provider"], "model": definition["model"],
                   "aspectRatio": ratio, "referenceFilenames": inherited}
        if definition["parameterMode"] == "resolution":
            size = options.get("imageSize", definition.get("defaultResolution") or "2K")
            if size not in definition["supportedResolutions"]:
                raise invalid(f"Unsupported image size for selected model: {size}")
            payload["imageSize"] = size
            fixed_quality = definition.get("fixedQuality")
            if "quality" in options and options["quality"] != fixed_quality:
                raise invalid("Selected resolution model does not support that quality")
            if fixed_quality is not None:
                payload["quality"] = fixed_quality
        else:
            if "imageSize" in options:
                raise invalid("Selected quality model does not accept an image size")
            quality = options.get("quality", "high")
            if quality not in definition["supportedQualities"]:
                raise invalid(f"Unsupported quality for selected model: {quality}")
            payload["quality"] = quality
        if notes is not None:
            payload["referenceNotes"] = list(notes)
        return payload

    def generate(self, key, prompt, *, provider=None, model=None, aspect_ratio=None,
                 image_size=None, quality=None, references=None, reference_notes=None, timeout=180):
        return self._generate(key, prompt, provider=provider, model=model, aspect_ratio=aspect_ratio,
                              image_size=image_size, quality=quality, references=references,
                              reference_notes=reference_notes, deadline=timeout_deadline(timeout))

    def _generate(self, key, prompt, *, deadline, provider=None, model=None, aspect_ratio=None,
                  image_size=None, quality=None, references=None, reference_notes=None,
                  progress=lambda _: None):
        validate_key(key)
        _string_units(prompt, "Prompt", 20000, nonempty=True)
        refs = _references(references)
        catalog = self._models(deadline)
        explicit = _options(provider, model, aspect_ratio, image_size, quality)
        injected = self.default_generate_params.copy()
        if any(field in injected and field in explicit and injected[field] != explicit[field]
               for field in ("provider", "model")):
            # An explicit different channel should use its own parameter defaults.
            injected = {}
        options = {**injected, **explicit}
        definition = self._choose_model(catalog, options.get("provider"), options.get("model"))
        preferred = catalog.get("defaultSettings") or {}
        if all(preferred.get(field) == definition.get(field) for field in ("provider", "model")):
            options = {**{field: preferred[field] for field in MODEL_OPTIONS if preferred.get(field) is not None},
                       **options}
            if definition.get("referenceAspectRatioMode") == "source" and refs and "aspectRatio" not in explicit:
                options.pop("aspectRatio", None)
            if not refs and options.get("aspectRatio") == "source" and "aspectRatio" not in explicit:
                options.pop("aspectRatio", None)
            if definition["parameterMode"] == "quality" and "imageSize" not in explicit and "imageSize" not in injected:
                options.pop("imageSize", None)
            if definition["parameterMode"] == "resolution" and "quality" not in explicit and "quality" not in injected:
                options.pop("quality", None)
        inputs = self._canonical_input(definition, options, prompt, [], len(refs), reference_notes)
        return self.submission.submit(key, inputs, refs, deadline, progress)

    def inspect_work(self, code, *, output_dir=None, download=False):
        context = _object(self.runtime.json("GET", f"/api/gallery/works/by-code/{segment(code)}/context"),
                          "work context", "id")
        if download:
            context["imagePath"] = self.download_asset(context.get("imageUrl"), output_dir)
            for reference in context.get("references", []):
                reference["path"] = self.download_asset(reference.get("url"), output_dir)
        return context

    def download_asset(self, url, output_dir=None):
        return self.runtime.download_asset(url, output_dir)

    def iterate(self, code, key, *, prompt=None, provider=None, model=None, aspect_ratio=None,
                image_size=None, quality=None, references=None, append_references=None,
                clear_references=False, reference_notes=None, timeout=180):
        validate_key(key)
        if sum((references is not None, append_references is not None, bool(clear_references))) > 1:
            raise invalid("Replacement, append, and clear reference modes are mutually exclusive")
        deadline = timeout_deadline(timeout)
        context = _object(self.runtime.json("GET", f"/api/gallery/works/by-code/{segment(code)}/context",
                                           deadline=deadline), "work context", "id")
        if not context.get("generationTask"):
            raise invalid(f"{code} has no unambiguous frozen generation input")
        frozen = _object(context["generationTask"], "frozen generation task", "id")
        original = _object(frozen.get("input"), "frozen input", "provider", "model", "prompt")
        catalog = self._models(deadline)
        selected_provider = provider if provider is not None else (original["provider"] if model is None else None)
        selected_model = model if model is not None else (
            original["model"] if provider is None or provider == original["provider"] else None)
        definition = self._choose_model(catalog, selected_provider, selected_model)
        explicit = _options(provider, model, aspect_ratio, image_size, quality)
        local = _references(references if references is not None else append_references)
        replacing = references is not None or clear_references
        inherited = [] if replacing else [asset_filename(name) for name in original.get("referenceFilenames", [])]
        notes = reference_notes
        if notes is None and not replacing and original.get("referenceNotes") is not None:
            notes = [*original["referenceNotes"], *([""] * len(local))]
        options = {field: original[field] for field in MODEL_OPTIONS if field in original}
        count = len(local) + len(inherited)
        if (count and definition.get("referenceAspectRatioMode") == "source"
                or not count and options.get("aspectRatio") == "source"):
            options.pop("aspectRatio", None)
        if definition["parameterMode"] != "resolution":
            options.pop("imageSize", None)
        if definition["parameterMode"] != "quality" and definition.get("fixedQuality") != options.get("quality"):
            options.pop("quality", None)
        inputs = self._canonical_input(definition, {**options, **explicit},
                                       original["prompt"] if prompt is None else prompt,
                                       inherited, len(local), notes)
        inputs["sourceTaskId"] = frozen["id"]
        if "sourceAssetId" in original:
            inputs["sourceAssetId"] = original["sourceAssetId"]
        return self.submission.submit(key, inputs, local, deadline)

    def get_task_status(self, task_id):
        return self._task_status(task_id)

    def get_task_status_by_key(self, key):
        validate_key(key)
        job = self.runtime.json("GET", f"{TASKS}/by-key/{segment(key)}")
        return self._normalize_task_status(job)

    def _task_status(self, task_id, deadline=None):
        job = self.runtime.json("GET", f"{TASKS}/{segment(task_id)}", deadline=deadline)
        return self._normalize_task_status(job)

    @staticmethod
    def _normalize_task_status(job):
        _object(job, "task status", "id", "status")
        if job["status"] not in TERMINAL_FAILURES | {"queued", "running", "completed"}:
            raise GalleryError("network", "Unknown Gallery task status")
        failure = classify_failure(job)
        if failure:
            if job["status"] in {"queued", "running"} and not job.get("workSaveError"):
                job.pop("failure", None)
                job["lastFailure"] = failure
            else:
                job["failure"] = failure
        return job

    @staticmethod
    def _saved(job):
        return (job["status"] == "completed" and job.get("workCode")
                and not job.get("workSavePending") and not job.get("failure"))

    def _download_task(self, job, output_dir, deadline=None):
        try:
            image_url = (job.get("result") or {}).get("imageUrl")
            if not image_url:
                context = _object(self.runtime.json("GET", f"/api/gallery/works/by-code/{segment(job['workCode'])}/context",
                                                   deadline=deadline), "work context", "imageUrl")
                image_url = context["imageUrl"]
            return {**job, "imagePath": self.runtime.download_asset(image_url, output_dir, deadline=deadline)}
        except GalleryError as error:
            return {**job, "failure": error.as_dict()}

    def wait_for_task(self, task_id, timeout=180, output_dir=None, download=True):
        segment(task_id)
        deadline = timeout_deadline(timeout)
        job = {"id": task_id, "status": "pending"}
        while True:
            try:
                job = self._task_status(task_id, deadline)
                if self._saved(job):
                    if download:
                        job = self._download_task(job, output_dir, deadline)
                    return job
                if job.get("failure") or job["status"] in TERMINAL_FAILURES:
                    return job
                time.sleep(min(self.poll_interval, remaining(deadline)))
            except GalleryError as error:
                if error.category != "timeout":
                    raise
                job["timedOut"] = True
                job["failure"] = classify_failure(job)
                return job

    def _list_gallery(self, asset_type, query, from_date, to_date, limit, cursor, full_prompt):
        _validate_day(from_date)
        _validate_day(to_date)
        params = {"assetType": asset_type, "pinFirst": "0", "sort": "newest", "limit": limit,
                  "q": query, "from": from_date, "to": to_date, "cursor": cursor,
                  "fields": None if full_prompt else "summary"}
        return self._page(IMAGES, params)

    def _page(self, path, params):
        limit = params["limit"]
        if type(limit) is not int or not 1 <= limit <= 100:
            raise invalid("Page limit must be an integer from 1 to 100")
        query = urlencode({field: value for field, value in params.items() if value is not None}, doseq=True)
        page = _object(self.runtime.json("GET", f"{path}?{query}"), "collection")
        if not isinstance(page.get("items"), list):
            raise GalleryError("network", "Gallery collection did not return a page")
        return page

    def list_works(self, *, query=None, from_date=None, to_date=None, limit=20, cursor=None):
        return self._list_gallery("work", query, from_date, to_date, limit, cursor, False)

    def list_recipes(self, *, query=None, from_date=None, to_date=None, limit=20, cursor=None,
                     full_prompt=False):
        return self._list_gallery("recipe", query, from_date, to_date, limit, cursor, full_prompt)

    def list_history(self, *, status=None, provider=None, from_date=None, to_date=None,
                     limit=20, cursor=None):
        return self._page(TASKS, {"view": "summary", "status": status, "provider": provider,
                                 "from": from_date, "to": to_date, "limit": limit, "cursor": cursor})

    def find_recipes_legacy(self, query, limit=5):
        if not isinstance(query, str) or not query.strip() or type(limit) is not int or not 1 <= limit <= 50:
            raise invalid("inspire requires a nonempty query and limit 1–50")
        page = self.list_recipes(query=query.strip(), limit=limit, full_prompt=True)
        return [{field: item.get(field, default) for field, default in
                 (("id", None), ("title", ""), ("prompt", ""), ("tags", []))}
                for item in page["items"]]

    def _recipe_updates(self, title, tags, source_type):
        source = self.default_source_type if source_type is None else source_type
        if source is not None and source not in ("openai", "gemini-web", "seedream"):
            raise invalid("Unknown recipe source type")
        if title is not None:
            _string_units(title, "Recipe title", 200)
        if tags is not None and (not isinstance(tags, (list, tuple)) or
                                 any(not isinstance(tag, str) for tag in tags)):
            raise invalid("Recipe tags must be a sequence of strings")
        return {field: value for field, value in {"title": title, "tags": tags, "sourceType": source}.items()
                if value is not None}

    def _create_recipe(self, work_id, updates):
        recipe_id = None
        try:
            recipe = _object(self.runtime.json("POST", f"{IMAGES}/{segment(work_id)}/recipe"),
                             "created recipe", "id")
            recipe_id = recipe["id"]
            if updates:
                recipe = _object(self.runtime.json("PATCH", f"{IMAGES}/{segment(recipe_id)}", updates),
                                 "updated recipe", "id")
            return recipe
        except GalleryError as error:
            category = "uncertain" if recipe_id is None and error.category in {"network", "timeout"} else (
                "save_failed" if recipe_id else error.category)
            raise GalleryError(category, str(error), code=error.code, status=error.status,
                               **({"recipeId": recipe_id} if recipe_id else {})) from error

    def save_recipe_from_work(self, code, title=None, tags=None, source_type=None):
        updates = self._recipe_updates(title, tags, source_type)
        work = self.inspect_work(code)
        if self.runtime.token:
            return self._save_recipe_v1({"workId": work["id"], **updates})
        return self._create_recipe(work["id"], updates)

    def _save_recipe_v1(self, payload=None, **upload):
        try:
            return _object(self.runtime.json("POST", "/api/v1/recipes", payload, **upload),
                           "saved recipe", "id")
        except GalleryError as error:
            if error.category in {"network", "timeout"}:
                raise GalleryError("uncertain", f"Could not confirm recipe save: {error}") from error
            raise

    def save_recipe_from_image(self, image_path, prompt, title=None, tags=None, source_type=None):
        _string_units(prompt, "Prompt", 20000, nonempty=True)
        updates = self._recipe_updates(title, [] if tags is None else tags, source_type)
        path = local_image_path(image_path)
        if self.runtime.token:
            fields = {"prompt": prompt, **updates, "tags": json.dumps(updates["tags"])}
            body, content_type = multipart("image", path, image_bytes(path), fields)
            return self._save_recipe_v1(body=body, content_type=content_type)
        body, content_type = multipart("image", path, image_bytes(path), {"prompt": prompt})
        try:
            work = _object(self.runtime.json("POST", IMAGES, body=body, content_type=content_type),
                           "uploaded work", "id")
        except GalleryError as error:
            if error.category in {"network", "timeout"}:
                raise GalleryError("uncertain", f"Could not confirm temporary upload: {error}") from error
            raise
        work_id = segment(work["id"])
        recipe, failure = None, None
        try:
            recipe = self._create_recipe(work["id"], updates)
        except GalleryError as error:
            failure = error
            raise
        finally:
            try:
                self.runtime.json("DELETE", f"{IMAGES}/{work_id}")
                self.runtime.json("DELETE", f"/api/trash/{work_id}", {"confirm": True})
            except GalleryError as error:
                if failure:
                    failure.details.update(cleanupError=error.as_dict(), temporaryWorkId=work["id"])
                elif recipe:
                    raise GalleryError("save_failed", "Recipe saved, but temporary work cleanup failed",
                                       recipeId=recipe["id"], temporaryWorkId=work["id"],
                                       cleanupError=error.as_dict()) from error
        return recipe

    def batch_status(self, state_path):
        return self.batch.batch_status(state_path)

    def batch_wait(self, state_path, timeout=180, output_dir=None, download=True):
        return self.batch.batch_wait(state_path, timeout, output_dir, download)


class LegacyAdapter:
    """Compatibility names/shapes; callers supply any preferred default policy."""

    def __init__(self, client):
        self.client = client

    def submit_iteration(self, code, prompt, key):
        return {"id": self.client.iterate(code, key, prompt=prompt)["id"]}

    def find_recipes(self, query, limit=5):
        return self.client.find_recipes_legacy(query, limit)

    def inspect_work(self, code, output_dir=None):
        return self.client.inspect_work(code, output_dir=output_dir, download=output_dir is not None)

    def wait_for_work(self, task_id, timeout=180, output_dir=None):
        return self.client.wait_for_task(task_id, timeout, output_dir, download=output_dir is not None)
