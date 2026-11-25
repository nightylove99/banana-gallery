"""Idempotent submission and resumable local batch manifests."""
from __future__ import annotations

from datetime import timezone
from email.utils import parsedate_to_datetime
import hashlib
import json
import math
from pathlib import Path
import random
import re
import time
import uuid

from .runtime import (
    GalleryError, TERMINAL_FAILURES, asset_filename, atomic_json, classify_failure,
    file_lock, invalid, remaining, segment, timeout_deadline,
)

TASKS = "/api/generation-tasks"
REFERENCE_TTL = 29 * 60
IMAGE_SUFFIXES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                  ".webp": "image/webp"}
INPUT_OPTIONS = {"provider": "provider", "model": "model", "aspectRatio": "aspect_ratio",
                 "imageSize": "image_size", "quality": "quality", "referenceNotes": "reference_notes"}
RETRYABLE = {"network", "timeout", "rate_limited", "uncertain"}


def validate_key(key):
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", key):
        raise invalid("Submission key must contain 1–128 ASCII letters, digits, '_' or '-'")
    return key


def image_path(value):
    try:
        path = Path(value).expanduser().resolve()
        if path.suffix.lower() not in IMAGE_SUFFIXES or not path.is_file():
            raise invalid(f"Expected a local PNG, JPG or WebP file: {path}")
        limit = (100 if path.suffix.lower() == ".png" else 25) * 1024 * 1024
        if not 0 < path.stat().st_size <= limit:
            raise invalid(f"Image is empty or larger than {limit // (1024 * 1024)} MiB: {path}")
        return path
    except (TypeError, OSError, ValueError) as error:
        raise invalid(f"Cannot open image: {error}") from error


def image_bytes(path):
    try:
        return path.read_bytes()
    except OSError as error:
        raise invalid(f"Cannot read image: {error}") from error


def multipart(field, path, content, fields=None):
    boundary = f"banana-gallery-{uuid.uuid4().hex}"
    parts = []
    for name, value in (fields or {}).items():
        parts.extend([f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
                      value.encode(), b"\r\n"])
    # The server only needs the suffix; do not copy an arbitrary local name into a header.
    suffix = path.suffix.lower()
    parts.extend([
        (f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="upload{suffix}"\r\n'
         f"Content-Type: {IMAGE_SUFFIXES[suffix]}\r\n\r\n").encode(),
        content, f"\r\n--{boundary}--\r\n".encode(),
    ])
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def retry_after(error):
    value = error.headers.get("Retry-After", "").strip()
    if value.isascii() and value.isdecimal():
        seconds = float(value)
        return seconds if math.isfinite(seconds) else None
    if value:
        try:
            date = parsedate_to_datetime(value)
            if date.tzinfo is None:
                date = date.replace(tzinfo=timezone.utc)
            return max(0.0, date.timestamp() - time.time())
        except (TypeError, ValueError, OverflowError):
            pass
    return None


def read_state(path):
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise invalid(f"Cannot read state {path}: {error}") from error
    if not isinstance(raw, dict) or type(raw.get("schemaVersion")) is not int or raw["schemaVersion"] != 1:
        raise invalid(f"Unsupported schemaVersion in {path}")
    return raw


class Submission:
    def __init__(self, runtime):
        self.runtime = runtime

    def _lookup(self, key, deadline):
        try:
            job = self.runtime.json("GET", f"{TASKS}/by-key/{segment(key)}", deadline=deadline)
        except GalleryError as error:
            if error.status == 404 and error.code == "TASK_KEY_NOT_FOUND":
                return None
            raise
        if (not isinstance(job, dict) or not job.get("id") or not job.get("status") or job.get("key") != key
                or not isinstance(job.get("input"), dict)):
            raise GalleryError("network", "Invalid Gallery by-key response")
        return job

    @staticmethod
    def _existing(job, payload):
        if payload != job["input"]:
            raise GalleryError("invalid_input", "Submission key already belongs to different input",
                               code="TASK_KEY_CONFLICT", status=409, taskId=job["id"])
        if job.get("deleted"):
            raise GalleryError("invalid_input", "Submission key belongs to a deleted task",
                               code="TASK_DELETED", taskId=job["id"])
        return job

    @staticmethod
    def _submitted(task, key, payload):
        result = {"id": task["id"], "key": key, "status": task["status"], "input": payload}
        if task.get("workCode"):
            result["workCode"] = task["workCode"]
        if task["status"] in TERMINAL_FAILURES:
            result["failure"] = classify_failure(task)
        return result

    def _prepare_files(self, references):
        files = []
        for value in references:
            path = image_path(value)
            try:
                with path.open("rb") as stream:
                    digest = self._file_digest(stream)
            except OSError as error:
                raise invalid(f"Cannot read reference: {error}") from error
            files.append((path, digest))
        return files

    @staticmethod
    def _file_digest(stream):
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(128 * 1024), b""):
            digest.update(chunk)
        return digest.hexdigest()

    def _cache_paths(self):
        path = self.runtime.state_dir / f"references-{self.runtime.endpoint_key}.json"
        return path, path.with_suffix(".lock")

    @staticmethod
    def _read_cache(path):
        if not path.exists():
            return {}
        now = time.time()
        return {digest: entry for digest, entry in read_state(path)["entries"].items()
                if 0 < entry["expiresAt"] - now <= REFERENCE_TTL}

    def _upload(self, files, deadline):
        if not files:
            return []
        cache_path, lock_path = self._cache_paths()
        with file_lock(lock_path, deadline):
            cache = self._read_cache(cache_path)
            slots = []
            for path, digest in files:
                if digest not in cache or cache[digest]["expiresAt"] <= time.time():
                    content = image_bytes(path)
                    if hashlib.sha256(content).hexdigest() != digest:
                        raise invalid(f"Reference changed during submission: {path}")
                    body, content_type = multipart("references", path, content)
                    expires_at = time.time() + REFERENCE_TTL
                    result = self.runtime.json("POST", "/api/references/upload", body=body,
                                               content_type=content_type, deadline=deadline)
                    filenames = result.get("filenames") if isinstance(result, dict) else None
                    if not isinstance(filenames, list) or len(filenames) != 1:
                        raise GalleryError("network", "Gallery upload did not return one reference filename")
                    cache[digest] = {"name": asset_filename(filenames[0]), "expiresAt": expires_at}
                    atomic_json(cache_path, {"schemaVersion": 1, "entries": cache})
                slots.append(cache[digest])
            return slots

    def _forget_rejected_references(self, files, refs, deadline):
        cache_path, lock_path = self._cache_paths()
        with file_lock(lock_path, deadline):
            cache = self._read_cache(cache_path)
            for (_, digest), rejected in zip(files, refs):
                if cache.get(digest) == rejected:
                    cache.pop(digest)
            atomic_json(cache_path, {"schemaVersion": 1, "entries": cache})

    @staticmethod
    def _digest(value):
        data = json.dumps(value, sort_keys=True, ensure_ascii=True).encode()
        return hashlib.sha256(data).hexdigest()

    @staticmethod
    def _payload(inputs, refs):
        return {**inputs, "referenceFilenames": inputs["referenceFilenames"] + [ref["name"] for ref in refs]}

    def _receipt_path(self, key):
        return self.runtime.state_dir / f"submission-{self.runtime.endpoint_key}-{key}.json"

    def recover(self, key, deadline):
        """Read-only observation of a batch item whose task ID was not persisted."""
        path = self._receipt_path(validate_key(key))
        if not path.exists():
            return None
        receipt = read_state(path)
        if not (receipt.get("posting") or receipt.get("taskId")):
            return None
        job = self._lookup(key, deadline)
        if job:
            if (self._digest(job["input"]) != receipt["payloadDigest"]
                    or receipt.get("taskId") not in (None, job["id"])):
                raise GalleryError("invalid_input", "Submission key already belongs to different input",
                                   code="TASK_KEY_CONFLICT", status=409, taskId=job["id"])
            return self._existing(job, job["input"])
        if receipt.get("taskId"):
            raise GalleryError("uncertain", "Previously accepted task is no longer visible by key",
                               key=key, taskId=receipt["taskId"])
        return None

    def submit(self, key, inputs, references, deadline, progress=lambda _: None):
        validate_key(key)
        progress("prepared")
        files = self._prepare_files(references)
        signature = self._digest([inputs, [digest for _, digest in files]])
        path = self._receipt_path(key)
        with file_lock(path.with_suffix(".lock"), deadline):
            return self._submit_locked(key, inputs, files, signature, path, deadline, progress)

    def _submit_locked(self, key, inputs, files, signature, path, deadline, progress):
        receipt = read_state(path) if path.exists() else {}
        in_doubt = bool(receipt.get("posting"))
        refs = receipt.get("references", [])
        retry_at = receipt.get("retryAt")
        attempt, refreshed = 0, False
        while True:
            try:
                job = self._lookup(key, deadline)
                if receipt and receipt["signature"] != signature:
                    if in_doubt or receipt.get("taskId"):
                        raise GalleryError("invalid_input", "Submission key already belongs to different input",
                                           code="TASK_KEY_CONFLICT", status=409)
                    # A definitively rejected submission does not reserve the key.
                    refs, receipt = [], {}
                if job:
                    task = self._existing(job, self._payload(inputs, refs))
                    if in_doubt:
                        receipt.update(posting=False, taskId=task["id"])
                        atomic_json(path, receipt)
                    progress("accepted")
                    return self._submitted(task, key, job["input"])
                if receipt.get("taskId"):
                    raise GalleryError("uncertain", "Previously accepted task is no longer visible by key",
                                       key=key, taskId=receipt["taskId"])
                if retry_at is not None:
                    self._backoff(GalleryError("rate_limited", "Gallery is rate limited", retryAt=retry_at),
                                  retry_at - time.time(), deadline)
                    retry_at = None
                if not in_doubt and (len(refs) != len(files) or any(
                    not 0 < ref["expiresAt"] - time.time() <= REFERENCE_TTL for ref in refs
                )):
                    progress("uploading")
                    refs = self._upload(files, deadline)
                payload = self._payload(inputs, refs)
                progress("refs_ready")
                # The exact input and reference names are durable before any POST.
                receipt = {"schemaVersion": 1, "signature": signature, "references": refs,
                           "payloadDigest": self._digest(payload), "posting": True}
                atomic_json(path, receipt)
                progress("posting")
                try:
                    task = self.runtime.json("POST", TASKS, {**payload, "key": key}, deadline=deadline)
                    if not isinstance(task, dict) or not task.get("id") or not task.get("status"):
                        raise GalleryError("network", "Gallery POST did not return a valid task")
                except GalleryError as error:
                    if error.category in {"network", "timeout"}:
                        in_doubt = True
                        job = self._lookup(key, deadline)
                        if job:
                            task = self._existing(job, payload)
                        else:
                            progress("retry_wait")
                            attempt += 1
                            self._backoff(error, self._jitter(attempt), deadline)
                            continue
                    else:
                        # A rejection only settles this POST, not an earlier lost response.
                        receipt["posting"] = in_doubt
                        if error.code == "RATE_LIMITED":
                            delay = retry_after(error)
                            if delay is not None:
                                receipt["retryAt"] = time.time() + delay
                                error.details["retryAt"] = receipt["retryAt"]
                        atomic_json(path, receipt)
                        if error.code == "REFERENCE_UNAVAILABLE" and files and not refreshed and not in_doubt:
                            refreshed = True
                            self._forget_rejected_references(files, refs, deadline)
                            refs = []
                            continue
                        raise
                receipt.update(posting=False, taskId=task["id"])
                atomic_json(path, receipt)
                progress("accepted")
                return self._submitted(task, key, payload)
            except GalleryError as error:
                if error.code in {"RATE_LIMITED", "QUEUE_FULL"}:
                    progress("retry_wait")
                    attempt += 1
                    delay = retry_after(error) if error.code == "RATE_LIMITED" else None
                    try:
                        self._backoff(error, self._jitter(attempt) if delay is None else delay, deadline)
                        continue
                    except GalleryError as elapsed:
                        error = elapsed
                if in_doubt and error.code not in {"TASK_KEY_CONFLICT", "TASK_DELETED"}:
                    raise GalleryError("uncertain", f"Could not confirm submission: {error}",
                                       key=key) from error
                raise error

    @staticmethod
    def _jitter(attempt):
        backoff = min(8, .5 * 2 ** min(attempt - 1, 4))
        return random.uniform(backoff / 2, backoff)

    @staticmethod
    def _backoff(error, delay, deadline):
        if delay >= remaining(deadline):
            raise error
        if delay > 0:
            time.sleep(delay)


def _entries(manifest):
    if ("items" in manifest) == ("matrix" in manifest):
        raise invalid("Manifest requires exactly one of items or matrix")
    if "items" in manifest:
        return manifest["items"]
    matrix = manifest["matrix"]
    if not isinstance(matrix, dict):
        raise invalid("matrix must be an object")
    prompts = matrix.get("prompts")
    groups = matrix.get("referenceGroups")
    if not isinstance(prompts, list) or not isinstance(groups, list) or not prompts or not groups:
        raise invalid("matrix requires nonempty prompts and referenceGroups arrays")
    if len(prompts) * len(groups) > 500:
        raise invalid("A batch can contain at most 500 items")
    rows = []
    for prompt_index, prompt in enumerate(prompts, 1):
        prompt = {"prompt": prompt} if isinstance(prompt, str) else prompt
        if not isinstance(prompt, dict):
            raise invalid("Matrix prompts must be strings or objects")
        prompt = prompt.copy()
        prompt_id = prompt.pop("itemId", prompt.pop("id", None))
        if prompt_id is not None and (not isinstance(prompt_id, str) or not prompt_id):
            raise invalid("Matrix prompt IDs must be nonempty strings")
        for group_index, group in enumerate(groups, 1):
            group = {"references": group} if isinstance(group, list) else group
            if not isinstance(group, dict) or set(group) - {"id", "references", "referenceNotes"}:
                raise invalid("Reference groups must be arrays or objects with references and optional referenceNotes")
            group_id = group.get("id")
            if group_id is not None and (not isinstance(group_id, str) or not group_id):
                raise invalid("Matrix reference group IDs must be nonempty strings")
            row = {**prompt, "references": group.get("references", [])}
            if "referenceNotes" in group:
                row["referenceNotes"] = group["referenceNotes"]
            if prompt_id is not None or group_id is not None:
                row["itemId"] = f"{prompt_id or prompt_index}:{group_id or group_index}"
            if "key" in row and len(groups) > 1:
                row["key"] = f"{validate_key(row['key'])}-{group_index}"
            rows.append(row)
    return rows


def expand_manifest(manifest, base_dir, batch_id):
    if not isinstance(manifest, dict) or type(manifest.get("schemaVersion")) is not int or manifest["schemaVersion"] != 1:
        raise invalid("Manifest schemaVersion must be 1")
    defaults = manifest.get("defaults", {})
    if not isinstance(defaults, dict):
        raise invalid("Manifest defaults must be an object")
    entries = _entries(manifest)
    if not isinstance(entries, list) or not 1 <= len(entries) <= 500:
        raise invalid("A batch must contain 1–500 items")
    keys, ids, items = set(), set(), []
    for index, entry in enumerate(entries, 1):
        if not isinstance(entry, dict):
            raise invalid(f"Batch item {index} must be an object")
        spec = {**defaults, **entry}
        item_id = spec.pop("itemId", spec.pop("id", str(index)))
        key = validate_key(spec.pop("key", f"{batch_id}-{index:03d}"))
        if not isinstance(item_id, str) or not item_id or item_id in ids or key in keys:
            raise invalid(f"Batch item {index} needs a unique itemId and key")
        refs = spec.pop("references", [])
        if not isinstance(refs, list) or any(not isinstance(p, str) or not p for p in refs):
            raise invalid(f"Batch item {item_id}: references must be an array of paths")
        if set(spec) - (set(INPUT_OPTIONS) | {"prompt"}):
            raise invalid(f"Batch item {item_id} has unknown fields")
        if not isinstance(spec.get("prompt"), str):
            raise invalid(f"Batch item {item_id} requires a prompt string")
        spec["references"] = [str((base_dir / Path(p).expanduser()).resolve()) for p in refs]
        keys.add(key)
        ids.add(item_id)
        items.append({"itemId": item_id, "key": key, "spec": spec, "phase": "prepared"})
    return items


class BatchRunner:
    """Submit a manifest once; observe or resume its durable state independently."""

    def __init__(self, client):
        self.client = client

    def submit(self, manifest, *, state_path=None, base_dir=None, timeout=180):
        deadline = timeout_deadline(timeout)
        batch_id = f"batch-{uuid.uuid4().hex}"
        if state_path is None:
            state_path = self.client.runtime.state_dir / f"{batch_id}.json"
        path = Path(state_path).expanduser().resolve()
        root = Path(base_dir or Path.cwd()).expanduser().resolve()
        state = {"schemaVersion": 1, "batchId": batch_id, "apiBase": self.client.runtime.api_base,
                 "items": expand_manifest(manifest, root, batch_id)}
        path.parent.mkdir(parents=True, exist_ok=True)
        with file_lock(path.with_name(path.name + ".lock"), deadline):
            if path.exists():
                raise invalid(f"Batch state already exists; use --resume: {path}")
            atomic_json(path, state)
            return self._run(path, state, deadline)

    def _state(self, path):
        state = read_state(path)
        runtime = self.client.runtime
        if runtime.canonical_endpoint(state.get("apiBase")) != runtime.endpoint:
            raise invalid("Batch state belongs to a different Gallery API base")
        if (not isinstance(state.get("batchId"), str) or not isinstance(state.get("items"), list)
                or not 1 <= len(state["items"]) <= 500):
            raise invalid("Invalid batch state")
        for item in state["items"]:
            if (not isinstance(item, dict) or not isinstance(item.get("itemId"), str)
                    or not isinstance(item.get("spec"), dict)
                    or not isinstance(item["spec"].get("prompt"), str)
                    or not isinstance(item["spec"].get("references"), list)
                    or item.get("phase") not in {"prepared", "uploading", "refs_ready", "posting",
                                                 "accepted", "retry_wait", "failed"}):
                raise invalid("Invalid batch item state")
            validate_key(item.get("key"))
        return state

    def resume(self, state_path, *, timeout=180):
        path = Path(state_path).expanduser().resolve()
        deadline = timeout_deadline(timeout)
        with file_lock(path.with_name(path.name + ".lock"), deadline):
            return self._run(path, self._state(path), deadline, resume=True)

    def _run(self, path, state, deadline, *, resume=False):
        timed_out = False
        for item in state["items"]:
            if item.get("taskId") or item["phase"] == "failed":
                continue

            def progress(phase):
                # "accepted" is persisted together with the task ID below.
                if phase != "accepted":
                    item["phase"] = phase
                    atomic_json(path, state)

            spec = item["spec"]
            params = {arg: spec[field] for field, arg in INPUT_OPTIONS.items() if field in spec}
            try:
                remaining(deadline)
                job = self.client.submission.recover(item["key"], deadline) if resume else None
                if job is None:
                    job = self.client._generate(item["key"], spec["prompt"], deadline=deadline,
                                                references=spec["references"], progress=progress, **params)
                status = "saving" if job["status"] == "completed" and not job.get("workCode") else job["status"]
                item.update(phase="accepted", taskId=job["id"], status=status,
                            workCode=job.get("workCode"), failure=job.get("failure"))
            except GalleryError as error:
                retryable = error.category in RETRYABLE
                item.update(phase="retry_wait" if retryable else "failed", failure=error.as_dict())
                timed_out = error.category == "timeout"
                if retryable:
                    atomic_json(path, state)
                    break
            atomic_json(path, state)
        return self._summary(path, state, timed_out=timed_out)

    @staticmethod
    def _summary(path, state, *, timed_out=False):
        items = []
        for item in state["items"]:
            status = item.get("status") or ("failed" if item["phase"] == "failed" else item["phase"])
            items.append({"itemId": item["itemId"], "key": item["key"], "taskId": item.get("taskId"),
                          "status": status, "workCode": item.get("workCode"),
                          "imagePath": item.get("imagePath"), "failure": item.get("failure")})
        completed = sum(item["status"] == "completed" and not item["failure"] for item in items)
        failed = sum(item["status"] in TERMINAL_FAILURES
                     or (item["status"] == "completed" and bool(item["failure"])) for item in items)
        return {"batchId": state["batchId"], "statePath": str(path), "total": len(items),
                "completed": completed, "failed": failed, "pending": len(items) - completed - failed,
                "timedOut": timed_out, "items": items}

    def _observe(self, state, *, deadline=None, download=False, output_dir=None):
        for item in state["items"]:
            if item.get("_settled"):
                continue
            try:
                if not item.get("taskId"):
                    if item["phase"] not in {"posting", "retry_wait"}:
                        continue
                    recovered = self.client.submission.recover(item["key"], deadline)
                    if not recovered:
                        continue
                    item.update(taskId=recovered["id"], phase="accepted")
                job = self.client._task_status(item["taskId"], deadline)
            except GalleryError as error:
                if error.category in {"network", "timeout"}:
                    raise
                job = {"status": "failed", "failure": error.as_dict()}
            pending = job.get("workSavePending") and not job.get("failure")
            item.update(status="saving" if pending else job["status"], workCode=job.get("workCode"),
                        failure=job.get("failure"))
            if download and self.client._saved(job):
                job = self.client._download_task(job, output_dir, deadline)
                item.update(imagePath=job.get("imagePath"), failure=job.get("failure"))
            item["_settled"] = (item["status"] in TERMINAL_FAILURES or item["status"] == "completed")

    def batch_status(self, state_path):
        path = Path(state_path).expanduser().resolve()
        state = self._state(path)
        self._observe(state)
        return self._summary(path, state)

    def batch_wait(self, state_path, timeout=180, output_dir=None, download=True):
        path = Path(state_path).expanduser().resolve()
        state = self._state(path)
        deadline = timeout_deadline(timeout)
        while True:
            try:
                self._observe(state, deadline=deadline, download=download, output_dir=output_dir)
                summary = self._summary(path, state)
                if not summary["pending"]:
                    return summary
                time.sleep(min(self.client.poll_interval, remaining(deadline)))
                # A separate process may have resumed submission while we were waiting.
                latest = self._state(path)
                state["items"] = [old if old.get("taskId") else new
                                  for old, new in zip(state["items"], latest["items"])]
            except GalleryError as error:
                if error.category == "timeout":
                    return self._summary(path, state, timed_out=True)
                raise
