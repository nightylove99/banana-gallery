"""Transport, local service lifecycle, and filesystem primitives."""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import errno
import hashlib
from http.client import HTTPException
import json
import math
import os
from pathlib import Path, PureWindowsPath
import re
import subprocess
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

IS_WINDOWS = os.name == "nt"
if IS_WINDOWS:
    import msvcrt
else:
    import fcntl

LOCAL_PORT = 3333
GALLERY_ROOT = Path(__file__).resolve().parents[2]
TERMINAL_FAILURES = {"failed", "cancelled", "uncertain"}


class GalleryError(RuntimeError):
    """A client failure safe to report as structured JSON."""

    def __init__(self, category, message, *, code=None, status=None, headers=None,
                 err_no=None, **details):
        super().__init__(message)
        self.category = category
        self.code = code
        self.status = status
        self.headers = headers or {}
        self.errno = err_no
        self.details = details

    def as_dict(self):
        return {
            "category": self.category, "message": str(self),
            **({"code": self.code} if self.code else {}),
            **({"httpStatus": self.status} if self.status is not None else {}),
            **self.details,
        }


def invalid(message):
    return GalleryError("invalid_input", message)


def classify_failure(task):
    """Normalize task status, server diagnostics, and client wait failures."""
    failure = task.get("failure") or {}
    category = failure.get("category")
    status = task.get("status")
    if status == "uncertain" or failure.get("uncertain") or category == "uncertain":
        normalized = "uncertain"
    elif (task.get("workSaveError") or category in {"storage", "save_failed"}
          or (status == "completed" and not task.get("workSavePending") and not task.get("workCode"))):
        normalized = "save_failed"
    elif category in {"blocked", "invalid_input", "network", "timeout"}:
        normalized = category
    elif task.get("timedOut"):
        normalized = "timeout"
    elif status == "cancelled" or category == "cancelled":
        normalized = "cancelled"
    elif category in {"rate_limit", "rate_limited"}:
        normalized = "rate_limited"
    elif status == "failed" or category:
        normalized = "provider_error"
    else:
        return None
    defaults = {
        "timeout": "Timed out waiting for Gallery",
        "save_failed": "Generation finished but no accessible work was saved",
        "cancelled": "Generation was cancelled",
        "uncertain": "Generation outcome is uncertain",
    }
    message = (task.get("workSaveError") if normalized == "save_failed" else None)
    return {**failure, "category": normalized, "message": message or failure.get("message")
            or task.get("error") or defaults.get(normalized, normalized)}


@dataclass(frozen=True)
class EnsureResult:
    api_base: str
    started: bool
    session: dict
    account: dict


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Reject all redirects, including same-origin redirects on mutation requests.
        return None


def timeout_deadline(seconds):
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or seconds <= 0:
        raise invalid("Timeout must be a positive, finite number")
    return time.monotonic() + seconds


def remaining(deadline):
    if deadline is None:
        return 15.0
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        raise GalleryError("timeout", "Gallery deadline expired")
    return seconds


def segment(value):
    if not isinstance(value, str) or not value or value in {".", ".."} or any(c in value for c in "/\\\0"):
        raise invalid("Invalid Gallery identifier")
    return quote(value, safe="")


def asset_filename(value):
    if (not isinstance(value, str) or not value or value.startswith(".")
            or any(c in value for c in "/\\") or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise invalid("Invalid Gallery asset filename")
    if IS_WINDOWS and (re.search(r'[<>:"|?*]', value) or value.endswith((" ", "."))
                       or PureWindowsPath(value).is_reserved()):
        raise invalid("Gallery asset filename cannot be downloaded on Windows")
    return value


def default_state_dir():
    home = Path.home()
    if IS_WINDOWS:
        return Path(os.environ.get("LOCALAPPDATA") or home / "AppData" / "Local") / "Banana Gallery CLI"
    legacy = home / "Library/Application Support/Banana Gallery CLI"
    if sys.platform == "darwin" or legacy.is_dir():
        return legacy
    return Path(os.environ.get("XDG_STATE_HOME") or home / ".local" / "state") / "banana-gallery"


def _try_file_lock(fd):
    if IS_WINDOWS:
        # Windows locks a byte range from the current position (even on an empty file).
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    else:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


@contextmanager
def file_lock(path, deadline):
    try:
        flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
        if IS_WINDOWS and path.is_symlink():
            raise OSError("Lock path must not be a link")
        fd = os.open(path, flags, 0o600)
    except OSError as error:
        raise GalleryError("save_failed", f"Cannot open Gallery state lock: {error}") from error
    try:
        while True:
            remaining(deadline)
            try:
                _try_file_lock(fd)
                break
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise GalleryError("save_failed", f"Cannot acquire Gallery state lock: {error}") from error
                time.sleep(min(.05, remaining(deadline)))
        try:
            yield
        finally:
            if IS_WINDOWS:
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    finally:
        os.close(fd)


def atomic_json(path, value):
    try:
        _write_json_file(path, value)
    except OSError as error:
        raise GalleryError("save_failed", f"Cannot persist Gallery state: {error}") from error


def _write_json_file(path, value):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
        staged = Path(stream.name)
        try:
            json.dump(value, stream, ensure_ascii=True, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
            stream.close()
            staged.replace(path)
        finally:
            staged.unlink(missing_ok=True)


class Runtime:
    def __init__(self, api_base, gallery_root, no_start, state_dir, *, token=None):
        try:
            url = urlsplit(api_base)
            port = url.port
        except ValueError as error:
            raise invalid("Invalid Gallery API base") from error
        if (url.scheme not in {"http", "https"} or not url.hostname or url.username is not None
                or url.path.rstrip("/") or "?" in api_base or "#" in api_base
                or any(c.isspace() for c in api_base)):
            raise invalid("Gallery API base must be an HTTP(S) origin without credentials")
        self.api_base = api_base.rstrip("/")
        self.token = (os.environ.get("BANANA_GALLERY_TOKEN", "") if token is None else token).strip()
        if self.token and not re.fullmatch(r"[A-Za-z0-9._~+/\-]+=*", self.token):
            raise invalid("Invalid Gallery Bearer token format")
        self.gallery_root = Path(gallery_root).expanduser().resolve()
        self._state_dir = Path(state_dir).expanduser().resolve()
        self.is_loopback = url.hostname in {"localhost", "127.0.0.1", "::1"}
        self.can_start = (not IS_WINDOWS and not no_start and url.scheme == "http"
                          and url.hostname in {"localhost", "127.0.0.1"} and port == LOCAL_PORT)
        # Both localhost spellings reach the same daily service and must share a lock.
        self.endpoint = self.canonical_endpoint(self.api_base)
        self.endpoint_key = hashlib.sha256(self.endpoint.encode()).hexdigest()
        self.opener = build_opener(ProxyHandler({}), NoRedirect())
        self.downloads = {}
        self.download_lock = threading.Lock()
        self._temp_downloads = None

    @staticmethod
    def canonical_endpoint(api_base):
        if isinstance(api_base, str) and re.fullmatch(
            rf"http://(?:localhost|127\.0\.0\.1):0*{LOCAL_PORT}/*", api_base, re.IGNORECASE
        ):
            return f"http://127.0.0.1:{LOCAL_PORT}"
        return api_base

    def _redact(self, value):
        return value.replace(self.token, "[redacted]") if self.token and isinstance(value, str) else value

    @property
    def state_dir(self):
        try:
            self._state_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
            if not IS_WINDOWS:
                self._state_dir.chmod(0o700)
        except OSError as error:
            raise GalleryError("save_failed", f"Cannot open private Gallery state directory: {error}") from error
        return self._state_dir

    @contextmanager
    def open(self, method, path, *, body=None, content_type=None, deadline=None):
        if not path.startswith("/api/") or "\\" in path:
            raise invalid("Invalid Gallery API path")
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if content_type:
            headers["Content-Type"] = content_type
        request = Request(self.api_base + path, data=body, method=method, headers=headers)
        try:
            response = self.opener.open(request, timeout=min(15.0, remaining(deadline)))
        except HTTPError as error:
            with error:
                try:
                    parsed = json.loads(error.read(65536))
                except (ValueError, OSError, HTTPException):
                    parsed = {}
            data = parsed if isinstance(parsed, dict) else {}
            code = data.get("code")
            message = data.get("error")
            if error.code == 429:
                category = "rate_limited"
            elif error.code in {401, 403}:
                category = "blocked"
            elif error.code in {408, 504}:
                category = "timeout"
            elif 400 <= error.code < 500:
                category = "invalid_input"
            else:
                category = "network"
            raise GalleryError(category, self._redact(message) if isinstance(message, str) else f"Gallery HTTP {error.code}",
                               code=self._redact(code), status=error.code, headers=error.headers) from None
        except (OSError, HTTPException) as error:
            raise self._transport_error(error) from error
        with response:
            yield response

    def _transport_error(self, error):
        cause = error.reason if isinstance(error, URLError) else error
        err_no = getattr(cause, "errno", None)
        timed_out = isinstance(cause, TimeoutError) or err_no == errno.ETIMEDOUT
        return GalleryError("timeout" if timed_out else "network",
                            self._redact(f"Gallery connection failed: {cause}"), err_no=err_no)

    def json(self, method, path, payload=None, *, deadline=None, body=None, content_type=None):
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=True, allow_nan=False).encode()
            content_type = "application/json"
        with self.open(method, path, body=body, content_type=content_type, deadline=deadline) as response:
            try:
                value = json.load(response)
            except (OSError, HTTPException) as error:
                # Only an actual connection refusal during open permits autostart.
                failure = self._transport_error(error)
                failure.errno = None
                raise failure from error
            except ValueError as error:
                raise GalleryError("network", "Endpoint did not return valid Gallery JSON") from error
            if not isinstance(value, (dict, list)):
                raise GalleryError("network", "Endpoint did not return a Gallery JSON object or array")
            return value

    def probe(self, deadline):
        session = self.json("GET", "/api/session", deadline=deadline)
        if not self._session_shape(session):
            raise GalleryError("network", "Endpoint is not a Banana Gallery session API")
        try:
            account = self.json("GET", "/api/account/summary", deadline=deadline)
        except GalleryError as error:
            # A listener answered /api/session. A failure on the second probe is not
            # evidence that the configured local service is absent.
            if error.errno == errno.ECONNREFUSED:
                error.errno = None
            raise
        if (not self._session_shape(account) or account["workspace"]["id"] != session["workspace"]["id"]
                or account["user"]["id"] != session["user"]["id"]
                or account.get("runtimeMode") not in {"personal-local", "personal-remote", "hosted"}
                or not isinstance(account.get("plan"), dict) or not account["plan"].get("id")):
            raise GalleryError("network", "Endpoint is not a Banana Gallery account API")
        return session, account

    @staticmethod
    def _session_shape(value):
        return isinstance(value, dict) and all(
            isinstance(value.get(field), dict) and isinstance(value[field].get("id"), str)
            and bool(value[field]["id"]) for field in ("user", "workspace")
        )

    def _probe_or_absent(self, deadline):
        try:
            return self.probe(deadline)
        except GalleryError as error:
            if error.errno == errno.ECONNREFUSED and self.can_start:
                return None
            if error.errno is not None or (error.category == "network" and error.status is None):
                hint = ("Start Banana Gallery with npm start, then retry." if self.is_loopback
                        else "Check BANANA_GALLERY_URL and that the remote instance is running.")
                raise GalleryError(error.category, f"{error}. {hint}", code=error.code,
                                   status=error.status, err_no=error.errno) from error
            raise

    def ensure_ready(self, timeout=90):
        deadline = timeout_deadline(timeout)
        result = self._probe_or_absent(deadline)
        if result is not None:
            return EnsureResult(self.api_base, False, *result)
        with file_lock(self.state_dir / f"start-{self.endpoint_key}.lock", deadline):
            result = self._probe_or_absent(deadline)
            if result is not None:
                return EnsureResult(self.api_base, False, *result)
            try:
                subprocess.run(["./gallery.sh", "start"], cwd=self.gallery_root,
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=remaining(deadline), check=True)
            except subprocess.TimeoutExpired as error:
                raise GalleryError("timeout", "Timed out running gallery.sh start") from error
            except (OSError, subprocess.CalledProcessError) as error:
                raise GalleryError("network", f"Could not run gallery.sh start: {error}") from error
            while (result := self._probe_or_absent(deadline)) is None:
                time.sleep(min(.25, remaining(deadline)))
            return EnsureResult(self.api_base, True, *result)

    def download_asset(self, url, output_dir=None, *, deadline=None):
        if not isinstance(url, str):
            raise invalid("Invalid Gallery asset URL")
        match = re.fullmatch(r"/api/assets/(images|references)/([^/?#]+)", url)
        if not match or re.search(r"%(?![0-9a-fA-F]{2})", url):
            raise invalid("Invalid Gallery asset URL")
        kind, encoded = match.groups()
        try:
            name = asset_filename(unquote(encoded, errors="strict"))
        except UnicodeError as error:
            raise invalid("Invalid Gallery asset URL encoding") from error
        path = f"/api/assets/{kind}/{quote(name, safe='')}"
        with self.download_lock:
            try:
                if output_dir is None:
                    if self._temp_downloads is None:
                        self._temp_downloads = Path(tempfile.mkdtemp(prefix="banana-gallery-"))
                    output_dir = self._temp_downloads
                directory = Path(output_dir).expanduser().resolve()
                cache_key = (directory, path)
                cached = self.downloads.get(cache_key)
                if cached and cached.is_file() and not cached.is_symlink():
                    return str(cached)
                directory.mkdir(parents=True, mode=0o700, exist_ok=True)
                destination = directory / (name if kind == "images" else f"reference-{name}")
                # Images and references can have colliding names in older galleries.
                if any(other == destination and key != cache_key for key, other in self.downloads.items()):
                    digest = hashlib.sha256(path.encode()).hexdigest()[:12]
                    destination = directory / f"{digest}-{name}"
                self._download(path, destination, deadline)
            except OSError as error:
                raise GalleryError("save_failed", f"Cannot write downloaded asset: {error}") from error
            self.downloads[cache_key] = destination
            return str(destination)

    def _download(self, path, destination, deadline):
        staged = None
        try:
            with self.open("GET", path, deadline=deadline) as response:
                with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as output:
                    staged = Path(output.name)
                    while True:
                        remaining(deadline)
                        try:
                            chunk = response.read1(128 * 1024)
                        except (OSError, HTTPException) as error:
                            raise self._transport_error(error) from error
                        if not chunk:
                            break
                        output.write(chunk)
                    size = response.headers.get("Content-Length")
                    if size is not None and (not size.isdecimal() or output.tell() != int(size)):
                        raise GalleryError("network", "Gallery asset download was truncated")
                    output.flush()
                    os.fsync(output.fileno())
            staged.replace(destination)
        finally:
            # Windows cannot unlink an open file. The context manager has closed it,
            # even when a truncated response or another error interrupted the write.
            if staged is not None:
                staged.unlink(missing_ok=True)
