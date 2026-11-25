# Banana Gallery Agent API v1

Base URL: `http://127.0.0.1:3333/api/v1` for the default local instance. For remote clients use the instance's HTTPS origin. All responses are JSON except protected image downloads. The legacy synchronous `POST /api/generate` now returns `410 SYNC_GENERATE_RETIRED`; submit to the asynchronous task queue instead.

## Authentication

`GET /api/v1/health` is public. A local interactive request without a token keeps the existing loopback session. To authorize an external Agent, set a high-entropy `BANANA_GALLERY_API_TOKEN` in the **server** environment and restart the server. Use a URL-safe random value (for example, 32 random bytes encoded as hex). The client sends `Authorization: Bearer <token>`; the Python CLI reads the value from `BANANA_GALLERY_TOKEN` and the origin from `BANANA_GALLERY_URL`. An invalid or unconfigured Bearer token returns `401` rather than falling back to the interactive session.

A valid token uses the same gallery but can only query, read protected assets, upload references, submit and check tasks, and save recipes. It cannot delete works, change or purge trash, manage backups, access provider credentials, or import from server-side paths. These operations return `403` even on the local listener. No token is required for normal local web use.

In `cloudflare_access` mode, the remote origin accepts a valid Agent token or the existing Cloudflare Access identity. Keep the browser UI behind Access and tunnel only to the remote origin (`3334` by default), not to either local port. Cloudflare can reject a request before it reaches Gallery: configure the edge to allow authorized machine requests through to the intended API paths and preserve `Authorization`. The v1 paths below and returned `/api/assets/…` URLs cover direct HTTP use. The compatibility CLI also uses `/api/session`, `/api/account/summary`, `/api/generation/models`, `/api/images` (GET), `/api/gallery/works/by-code/:code/context`, `/api/references/upload` and `/api/generation-tasks*`. Do not expose the interactive UI to solve an edge-authentication failure.

## Endpoints

| Method and path | Request and response |
| --- | --- |
| `GET /health` | `{status, version, authMode}`. |
| `GET /models` | `{defaultModel, defaultSettings?, models}`; each model entry includes availability and accepted parameters. |
| `GET /works`, `GET /recipes` | `{items, total, nextCursor}`. Filter with `q`, `from` / `to` (calendar dates, `YYYY-MM-DD`), `limit` (1–100, default 20), and `cursor`. Newest first by default. Use `fields=full` to include complete prompts. The endpoint fixes the asset type. |
| `GET /works/:code/context` | Work ID, `workCode`, prompt, protected `imageUrl`, ordered references, and frozen `generationTask` (or `null` if unavailable/ambiguous). URL-encode the leading `#`, e.g. `%23ABC123`. |
| `POST /recipes` | JSON `{workId, title?, tags?, sourceType?}` copies an existing work. Multipart `image` and `prompt`, plus optional `title`, JSON-array string `tags`, and `sourceType`, save an uploaded image directly as a recipe. Returns a recipe including `id`, prompt and tags. |
| `POST /references/upload` | Multipart files under the repeated field `references` (up to 16 JPG/PNG/WebP files). Returns `{filenames}` in upload order. The total multipart request is limited to 101 MiB. To recover a lost response, repeat the same upload with its original `Idempotency-Key` header (1–128 printable ASCII characters, no spaces); a successful receipt survives service restart for up to two hours. Use the returned names in a task before the upload lease expires. |
| `POST /tasks` | JSON `{key, provider, model, prompt, referenceFilenames?, referenceNotes?, aspectRatio?, imageSize?, quality?, sourceAssetId?, sourceTaskId?}`. Returns `202` with the task and its frozen `input`. Same key and input return the existing task; changed input under the same key returns `409`. |
| `GET /tasks` | Compact page `{items, total, nextCursor}`. Filters: repeated `status`, `provider`, `from` (inclusive) / `to` (exclusive) as RFC3339 timestamps, `limit` (1–100, default 20), and `cursor`. Keep filters unchanged when following a cursor. |
| `GET /tasks/:id`, `GET /tasks/by-key/:key` | Detailed public task receipt. The key lookup still identifies a retained trashed task with `deleted: true`. |

Task receipts include `id`, `key`, `status`, `provider`, `model`, timestamps, and `workCode` once a work is available. Detail may include `result: {imageUrl, width, height}` and `workSavePending`. Failure exposes a category and retry/uncertainty flags, not upstream messages, request IDs, runner metadata, or debug paths. A task may be `failed` with `failure.uncertain: true` when the upstream result could not be confirmed; this does not establish that the provider never processed it. Check the task and its `workCode` before reporting a work as saved. Origin-relative image URLs use the same authentication; do not forward the token to other origins.

Google Gemini and OpenAI-compatible models reflect changes made in the owner’s local web settings without restarting. Query `GET /models` again after a channel or model change; credentials are never part of the Agent API.

## Typical requests

Set the client environment variables first. These examples use a POSIX shell and curl. On Windows, start the built app with `npm.cmd start` (or `gallery.cmd start` for a ZIP) and use `py -3 scripts/banana-gallery.py ensure`; the ZIP puts the script under `app\scripts\`. The CLI does not start the server on Windows. If the Python launcher is missing, use `python` when it reports Python 3.10+.

```sh
api="${BANANA_GALLERY_URL:-http://127.0.0.1:3333}/api/v1"
curl -fsS "$api/health"
curl -fsS -H "Authorization: Bearer $BANANA_GALLERY_TOKEN" "$api/models"
curl -fsS -H "Authorization: Bearer $BANANA_GALLERY_TOKEN" -H 'Content-Type: application/json' \
  -d '{"key":"first-demo-001","provider":"demo","model":"banana-demo-v1","prompt":"Offline setup test"}' \
  "$api/tasks"
curl -fsS -H "Authorization: Bearer $BANANA_GALLERY_TOKEN" "$api/tasks/by-key/first-demo-001"
```

For zero-config loopback use, omit the Bearer header. Demo uses no paid provider and accepts no references. For a reference-capable model, upload with `-F 'references=@./reference.png'` and pass the returned names as `referenceFilenames`.

## Errors and retries

Error bodies are `{error, code?}`. Use HTTP status and `code`, not the human-readable message, in client logic.

| HTTP | Meaning |
| --- | --- |
| `400` / `413` | Invalid input or request body too large. |
| `401` / `403` | Missing/invalid authorization (`INVALID_AGENT_TOKEN` for rejected Bearer credentials), or out-of-scope Agent operation (`AGENT_FORBIDDEN`). |
| `404` | Work, task or reference unavailable; `TASK_KEY_NOT_FOUND` means the key is not visible. |
| `409` | Conflict: e.g. `TASK_KEY_CONFLICT`, or a gallery cursor invalidated by an update. |
| `429` | Throttled (`RATE_LIMITED`, honor `Retry-After`) or active queue full (`QUEUE_FULL`). |
| `500` / `503` | Write not confirmed, internal error, or service/channel temporarily unavailable. |

After a timeout or missing submission receipt, check `GET /tasks/by-key/:key` first. If a retry is needed, reuse the same key and exact input. Never create a new key to work around an uncertain result.
