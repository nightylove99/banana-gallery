---
name: banana-gallery
description: Use Banana Gallery to inspect images by work code, generate or iterate prompts, reuse external outfit, expression, or pose references, submit resumable reference matrices, or save recipes from another project.
---

# Banana Gallery

Use the CLI from the same Banana Gallery checkout or distribution as this skill. The CLI is Python 3.10+ and uses only the standard library. From an external project, keep its working directory and invoke the Gallery script by absolute path:

```sh
python3 "/path/to/banana-gallery/scripts/banana-gallery.py" ensure
python3 "/path/to/banana-gallery/scripts/banana-gallery.py" models --available-only
```

On Windows use `py -3 "C:\path\to\banana-gallery\scripts\banana-gallery.py"` (for a Windows ZIP, the script is under `app\scripts\`). If the launcher is missing, use `python` when it reports Python 3.10+. Quote any reference or output path containing spaces. Below, `python3 scripts/banana-gallery.py` represents that invocation.

Set `BANANA_GALLERY_URL` to the instance's HTTP(S) origin; the default is `http://127.0.0.1:3333`. If the instance owner provides an Agent token, inject it as `BANANA_GALLERY_TOKEN` from the environment. Do not write it to the project, manifest, or conversation. `--api-base` and `--token` override the environment when placed before the subcommand. Windows and remote URLs never start the service automatically; if a local source checkout is offline, run `npm start` after building it, or use `gallery.cmd start` for a Windows ZIP. For a remote instance use its provided HTTPS entry point. Run `ensure` and `models --available-only` before submitting; the catalogue shows available providers, model IDs, and reference limits.

If the owner changes image channels in the local web settings, refresh the model catalogue with `models --available-only` before choosing a model. Provider credentials are managed by the owner, not through the Agent API.

## First run: zero-cost demo

```sh
python3 scripts/banana-gallery.py generate --provider demo --model banana-demo-v1 --key setup-demo-001 --prompt "An offline setup check"
python3 scripts/banana-gallery.py wait TASK_ID --no-download
```

Use the `id` returned by `generate` as `TASK_ID`. Demo stores a local placeholder; it does not interpret prompts or accept references. If demo is disabled, do not substitute a billable model without approval.

## Prompt iteration

1. Write the prompt as a UTF-8 file in the prompt project. Submit with `generate --key PROJECT-SCENE-v1 --prompt-file prompt.txt --provider PROVIDER --model MODEL`. Wait for the task and record its `workCode`.
2. Read the saved prompt and frozen generation input with `inspect "#WORKCODE" --no-download`, or omit `--no-download` to review the image and references. Quote the code to preserve the `#` in shell commands.
3. Submit an intentional new iteration with `iterate --from "#WORKCODE" --key PROJECT-SCENE-v2 --prompt-file revised.txt`. This reuses the frozen model and ordered references unless overridden. If no unambiguous frozen input exists, use `generate` with explicit inputs instead. Save a reusable result with `save-recipe --from "#WORKCODE" --title "Reusable recipe"`.

## External reference collections

Select only the image files needed from the external project. Paths are on the **CLI machine**; the CLI uploads bytes, not server-side paths. For a single image use `generate --key PROJECT-LOOK-v1 --prompt-file prompt.txt --provider PROVIDER --model MODEL --reference "references/coat.png"`. Ensure the model supports the number of references.

For combinations, adapt [batch-matrix.json](examples/batch-matrix.json). Its two prompts × two reference groups submit **four tasks**, not two. Confirm the count, model, and expected cost before running a batch. Use a state path that survives the session:

```sh
python3 scripts/banana-gallery.py batch --manifest batch-matrix.json --base-dir "/path/to/asset-project" --state gallery-batch.json
python3 scripts/banana-gallery.py status --batch gallery-batch.json
python3 scripts/banana-gallery.py batch --resume gallery-batch.json
python3 scripts/banana-gallery.py wait --batch gallery-batch.json --no-download
```

Without `--base-dir`, references are relative to the manifest's directory. `status` and `wait` only observe; `--resume` continues unconfirmed items with their original keys. Do not start a fresh batch to recover a lost response. Change the example paths and provider/model to match the selected files and available catalogue; demo cannot run this reference matrix.

## Receipts and reporting

Give every new generation a stable `--key` (batch state persists its per-item keys). After a timeout or missing receipt, check `status --key ORIGINAL_KEY` first, or `status TASK_ID` if the ID is known. If the server confirms the key is absent, retry only with the **same key and identical input**. Do not work around a conflict or an uncertain result by submitting a new key. A failed task with an uncertain result may still have been processed upstream; do not treat it as permission to submit again. Report each saved `#workCode`; distinguish unresolved tasks from work confirmed in the gallery. For direct HTTP reference uploads, reuse the same `Idempotency-Key` to recover a lost upload response (see the API v1 guide).

For direct HTTP integration, see [the API v1 guide](../../doc/api-v1.md) in the same checkout.
