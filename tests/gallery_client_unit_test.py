import contextlib
import errno
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from gallery_client import BatchRunner, GalleryClient, GalleryError, classify_failure
from gallery_client.runtime import file_lock, timeout_deadline

MODEL = {"provider": "google", "model": "model-a", "available": True,
         "parameterMode": "resolution", "supportedResolutions": ["1K", "2K"],
         "defaultAspectRatio": "1:1", "supportedAspectRatios": ["1:1", "16:9"],
         "maxReferenceImages": 3}


@contextlib.contextmanager
def mock_server(callback, port=0, *, observe_headers=lambda _: None):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def handle_api(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            observe_headers(self.headers)
            response = callback(self.command, self.path, body)
            if response is None:
                return  # simulates a dropped response
            status, headers, value = response
            if not isinstance(value, bytes):
                value = json.dumps(value).encode()
                headers = {"Content-Type": "application/json", **headers}
            self.send_response(status)
            headers = {"Content-Length": str(len(value)), **headers}
            for name, data in headers.items():
                self.send_header(name, data)
            self.end_headers()
            self.wfile.write(value)

        do_GET = do_POST = do_PATCH = do_DELETE = handle_api

    with ThreadingHTTPServer(("127.0.0.1", port), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .01})
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            thread.join()


def reply(value, status=200, **headers):
    return status, headers, value


class GalleryClientTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.ref = self.root / "image.png"
        self.ref.write_bytes(b"reference")
        self.posts = []
        self.jobs = {}
        self.uploads = 0
        self.post_replies = []
        self.model = MODEL

    def client(self, url, **kwargs):
        return GalleryClient(url, state_dir=self.root / "state", **kwargs)

    def api(self, method, path, body):
        if path in {"/api/session", "/api/account/summary"}:
            return reply({"user": {"id": "u"}, "workspace": {"id": "w"},
                          "runtimeMode": "personal-local", "plan": {"id": "personal"}})
        if path == "/api/generation/models":
            return reply({"models": [self.model], "defaultModel": MODEL})
        if path.startswith("/api/generation-tasks/by-key/"):
            key = path.rsplit("/", 1)[-1]
            return reply(self.jobs[key]) if key in self.jobs else reply(
                {"code": "TASK_KEY_NOT_FOUND"}, 404)
        if path == "/api/references/upload":
            self.uploads += 1
            return reply({"filenames": [f"uploaded-{self.uploads}.png"]})
        if path == "/api/generation-tasks" and method == "POST":
            data = json.loads(body)
            self.posts.append(data)
            if self.post_replies:
                return self.post_replies.pop(0)
            job = {"id": f"task-{len(self.posts)}", "key": data["key"], "status": "queued",
                   "input": {key: value for key, value in data.items() if key != "key"}}
            self.jobs[data["key"]] = job
            return reply(job, 202)
        if path.startswith("/api/generation-tasks/task-"):
            return reply({"id": path.rsplit("/", 1)[-1], "status": "completed", "workCode": "#NEW",
                          "result": {"imageUrl": "/api/assets/images/work.png"}})
        if path.endswith("/context"):
            return reply({"id": "work", "generationTask": {"id": "old-task", "input": {
                "prompt": "old", "provider": "google", "model": "model-a",
                "aspectRatio": "1:1", "imageSize": "2K", "referenceFilenames": ["old.png"],
                "referenceNotes": ["old note"]}}})
        if path.startswith("/api/assets/"):
            return reply(b"image bytes")
        return reply({"error": "unexpected route"}, 404)

    def test_bearer_header_from_environment_and_cli_override(self):
        headers = []
        with mock_server(self.api, observe_headers=lambda h: headers.append(h.get("Authorization"))) as url:
            env = {**os.environ, "BANANA_GALLERY_URL": url, "BANANA_GALLERY_TOKEN": "environment-token"}
            with patch.dict(os.environ, env):
                self.assertEqual(GalleryClient(state_dir=self.root).ensure_ready().api_base, url)
            command = [sys.executable, str(ROOT / "scripts/banana-gallery.py")]
            result = subprocess.run(command + ["--token", "argument-token", "models"], env=env,
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(json.loads(result.stdout)["models"])
            self.assertEqual(headers, ["Bearer environment-token"] * 2 + ["Bearer argument-token"] * 3)

    def test_bearer_token_is_redacted_from_http_and_parser_errors(self):
        token = "do-not-print-this-token"
        with mock_server(lambda *_: reply({"error": f"Rejected Bearer {token}", "code": token}, 403)) as url:
            env = {**os.environ, "BANANA_GALLERY_URL": url, "BANANA_GALLERY_TOKEN": token}
            command = [sys.executable, str(ROOT / "scripts/banana-gallery.py"), "--token", token]
            for args, code in [(["ensure"], 5), (["ensure", token], 2)]:
                result = subprocess.run(command + args, env=env, capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, code)
                self.assertNotIn(token, result.stdout + result.stderr)
                self.assertIn("error", json.loads(result.stdout))

    def test_file_lock_excludes_another_descriptor_and_releases_on_exception(self):
        path = self.root / "shared.lock"
        with self.assertRaisesRegex(RuntimeError, "release"):
            with file_lock(path, timeout_deadline(1)):
                with self.assertRaises(GalleryError) as failure:
                    with file_lock(path, timeout_deadline(.08)):
                        self.fail("Concurrent descriptor acquired the lock")
                self.assertEqual(failure.exception.category, "timeout")
                raise RuntimeError("release")
        with file_lock(path, timeout_deadline(1)):
            self.assertTrue(path.is_file())

    def test_windows_lock_retries_the_same_byte_on_contention(self):
        crt = Mock(LK_NBLCK=2, LK_UNLCK=0)
        crt.locking.side_effect = [OSError(errno.EACCES, "lock held"), None, None]
        path = self.root / "windows.lock"
        with patch("gallery_client.runtime.IS_WINDOWS", True), \
                patch("gallery_client.runtime.msvcrt", crt, create=True):
            with file_lock(path, timeout_deadline(1)):
                pass
        self.assertEqual(crt.locking.call_count, 3)
        first, second, unlock = crt.locking.call_args_list
        self.assertEqual(first, second)
        self.assertEqual(first.args[1:], (crt.LK_NBLCK, 1))
        self.assertEqual(unlock.args, (first.args[0], crt.LK_UNLCK, 1))

    def test_existing_batch_state_can_use_the_new_loopback_default(self):
        state = self.root / "old-batch.json"
        state.write_text(json.dumps({
            "schemaVersion": 1, "apiBase": "http://localhost:3333", "batchId": "old",
            "items": [{"itemId": "1", "key": "old-1", "phase": "prepared",
                       "spec": {"prompt": "a", "references": []}}],
        }), encoding="utf-8")
        client = self.client("http://127.0.0.1:3333", no_start=True)
        self.assertEqual(client.batch_status(state)["total"], 1)

    def test_windows_loopback_does_not_autostart(self):
        with mock_server(self.api) as url:
            port = int(url.rsplit(":", 1)[1])
        with patch("gallery_client.runtime.IS_WINDOWS", True, create=True), \
                patch("gallery_client.runtime.LOCAL_PORT", port), \
                patch("gallery_client.runtime.subprocess.run") as launch:
            with self.assertRaisesRegex(GalleryError, "npm start"):
                self.client(url).ensure_ready(timeout=5)
            launch.assert_not_called()

    def test_status_can_recover_server_receipt_by_key(self):
        with mock_server(self.api) as url:
            job = self.client(url).generate("recover-key", "hello")
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts/banana-gallery.py"), "--api-base", url,
                 "status", "--key", "recover-key"], capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(json.loads(result.stdout)["id"], job["id"])

    def test_reference_dedup_ttl_and_iteration(self):
        copy = self.root / "copy.png"
        copy.write_bytes(self.ref.read_bytes())
        with mock_server(self.api) as url:
            client = self.client(url)
            client.generate("one", "prompt", references=[self.ref, copy])
            self.assertEqual(self.posts[-1]["referenceFilenames"], ["uploaded-1.png"] * 2)
            client.iterate("#WORK", "two", append_references=[copy], aspect_ratio="16:9")
            self.assertEqual(self.uploads, 1)
            self.assertEqual(self.posts[-1]["referenceFilenames"], ["old.png", "uploaded-1.png"])
            self.assertEqual(self.posts[-1]["referenceNotes"], ["old note", ""])
            self.assertEqual(self.posts[-1]["aspectRatio"], "16:9")
            self.assertEqual(self.posts[-1]["sourceTaskId"], "old-task")
            with patch("gallery_client.submission.time.time", return_value=time.time() + 29 * 60 + 1):
                client.generate("three", "prompt", references=[copy])
            self.assertEqual(self.uploads, 2)
            for overrides in ({"reference_notes": []}, {"reference_notes": ["🙂" * 251, ""]},
                              {"prompt": "🙂" * 10001}, {"references": [copy], "append_references": [copy]},
                              {"clear_references": True, "append_references": [copy]},
                              {"references": [copy] * 4}):
                if "references" not in overrides:
                    overrides.setdefault("append_references", [copy])
                with self.subTest(overrides=list(overrides)), self.assertRaises(GalleryError):
                    client.iterate("#WORK", "invalid", **overrides)
            self.assertEqual(len(self.posts), 3)

    def test_recovers_lost_post_and_does_not_repost_or_change_key(self):
        def api(method, path, body):
            response = self.api(method, path, body)
            return None if path == "/api/generation-tasks" and method == "POST" else response

        with mock_server(api) as url:
            job = self.client(url).generate("same", "prompt", references=[self.ref])
            self.assertEqual(self.client(url).generate("same", "prompt", references=[self.ref])["id"],
                             job["id"])
            with self.assertRaises(GalleryError) as caught:
                self.client(url).generate("same", "different", references=[self.ref])
            self.assertEqual(caught.exception.code, "TASK_KEY_CONFLICT")
            self.assertEqual(len(self.posts), 1)
            self.assertEqual(self.uploads, 1)

    def test_429_retry_after_queue_backoff_and_explicit_conflict(self):
        self.post_replies = [reply({"code": "RATE_LIMITED"}, 429, **{"Retry-After": "2"}),
                             reply({"code": "QUEUE_FULL"}, 429)]
        with mock_server(self.api) as url, patch("gallery_client.submission.time.sleep") as sleep:
            client = self.client(url)
            client.generate("first", "prompt")
            self.assertEqual(sleep.call_args_list[0].args, (2.0,))
            self.assertGreater(sleep.call_args_list[1].args[0], 0)
            self.assertEqual([post["key"] for post in self.posts], ["first"] * 3)
            self.post_replies = [reply({"code": "TASK_KEY_CONFLICT"}, 409)]
            with self.assertRaises(GalleryError) as caught:
                client.generate("conflict", "prompt")
            self.assertEqual(caught.exception.code, "TASK_KEY_CONFLICT")
            self.assertEqual(len(self.posts), 4)

    def test_injected_defaults_and_partial_model_switch(self):
        quality_model = {**MODEL, "provider": "other", "model": "quality-model",
                         "parameterMode": "quality", "supportedQualities": ["high", "low"],
                         "maxReferenceImages": 0}

        def api(method, path, body):
            if path == "/api/generation/models":
                return reply({"models": [MODEL, quality_model], "defaultModel": MODEL})
            return self.api(method, path, body)

        with mock_server(api) as url:
            client = self.client(url, default_generate_params={
                "provider": "google", "model": "model-a", "imageSize": "1K",
            })
            self.assertEqual(client.generate("defaults", "prompt")["input"]["imageSize"], "1K")
            with self.assertRaisesRegex(GalleryError, "at most 0"):
                client.iterate("#WORK", "too-many", model="quality-model")
            switched = client.iterate("#WORK", "switched", model="quality-model", quality="low",
                                      clear_references=True)["input"]
            self.assertEqual(switched["provider"], "other")
            self.assertEqual(switched["referenceFilenames"], [])
            self.assertEqual(switched["quality"], "low")
            self.assertNotIn("referenceNotes", switched)
            self.assertNotIn("imageSize", switched)

    def test_batch_matrix_resume_status_and_wait(self):
        state = self.root / "batch.json"
        manifest = {"schemaVersion": 1, "matrix": {"prompts": [{"id": "one", "prompt": "one"}, "two"],
                    "referenceGroups": [{"id": "double", "references": [self.ref.name, self.ref.name]}, []]}}
        self.post_replies = [reply({"code": "RATE_LIMITED"}, 429, **{"Retry-After": "1"})]
        with mock_server(self.api) as url:
            runner = BatchRunner(self.client(url))
            first = runner.submit(manifest, state_path=state, base_dir=self.root, timeout=.5)
            self.assertEqual(first["pending"], 4)
            self.assertEqual(first["items"][0]["itemId"], "one:double")
            self.assertTrue(state.is_file())
            resumed = BatchRunner(self.client(url)).resume(state, timeout=5)
            self.assertEqual([item["key"] for item in resumed["items"]],
                             [item["key"] for item in first["items"]])
            self.assertTrue(all(item["taskId"] for item in resumed["items"]))
            self.assertEqual(self.uploads, 1)
            self.assertEqual(runner.batch_status(state)["completed"], 4)
            summary = runner.batch_wait(state, output_dir=self.root / "downloads")
            self.assertEqual(summary["completed"], 4)
            self.assertTrue(all(Path(item["imagePath"]).is_file() for item in summary["items"]))

    def test_batch_status_recovers_after_response_and_lookup_are_lost(self):
        state = self.root / "batch.json"
        lost = True

        def api(method, path, body):
            if path.startswith("/api/generation-tasks/by-key/") and self.posts and lost:
                return None
            response = self.api(method, path, body)
            return None if path == "/api/generation-tasks" and method == "POST" else response

        with mock_server(api) as url:
            runner = BatchRunner(self.client(url))
            result = runner.submit({"schemaVersion": 1, "items": [{"prompt": "one"}]},
                                   state_path=state, timeout=5)
            self.assertEqual(result["items"][0]["failure"]["category"], "uncertain")
            self.assertIsNone(result["items"][0]["taskId"])
            lost = False
            self.assertEqual(runner.batch_status(state)["completed"], 1)
            self.assertEqual(runner.batch_wait(state, download=False)["completed"], 1)
            self.assertEqual(runner.resume(state)["items"][0]["taskId"], "task-1")
            self.assertEqual(len(self.posts), 1)

    def test_batch_resume_recovers_lost_receipt_before_opening_missing_reference(self):
        state = self.root / "batch.json"
        lost = True

        def api(method, path, body):
            if path.startswith("/api/generation-tasks/by-key/") and self.posts and lost:
                return None
            response = self.api(method, path, body)
            return None if path == "/api/generation-tasks" and method == "POST" else response

        with mock_server(api) as url:
            runner = BatchRunner(self.client(url))
            result = runner.submit({"schemaVersion": 1, "items": [{"prompt": "one", "references": [str(self.ref)]}]},
                                   state_path=state, timeout=5)
            self.assertEqual(result["items"][0]["failure"]["category"], "uncertain")
            self.assertIsNone(result["items"][0]["taskId"])
            self.ref.unlink()
            lost = False
            key = result["items"][0]["key"]
            self.jobs[key].update(status="completed", workCode="#NEW")
            self.assertEqual(runner.batch_status(state)["completed"], 1)
            self.assertEqual(runner.batch_wait(state, download=False)["completed"], 1)
            resumed = runner.resume(state)["items"][0]
            self.assertEqual((resumed["taskId"], resumed["status"], resumed["workCode"]),
                             ("task-1", "completed", "#NEW"))
            self.assertIsNone(resumed["failure"])
            self.assertEqual(self.uploads, 1)
            self.assertEqual(len(self.posts), 1)

    def test_wait_does_not_treat_queued_provider_retry_as_terminal(self):
        responses = [
            {"id": "task-1", "status": "queued",
             "failure": {"category": "network", "retryable": True, "uncertain": True}},
            {"id": "task-1", "status": "completed", "workCode": "#DONE"},
        ]
        with mock_server(lambda *_: reply(responses.pop(0))) as url:
            result = self.client(url, poll_interval=.01).wait_for_task("task-1", download=False)
            self.assertEqual(result["workCode"], "#DONE")
            self.assertFalse(responses)

    def test_download_validates_and_preserves_existing_file_on_truncation(self):
        def api(method, path, body):
            if path.endswith("broken.png"):
                return reply(b"short", **{"Content-Length": "50"})
            return self.api(method, path, body)

        # Send the custom length as the only length to model a broken connection.
        with mock_server(api) as url:
            client = self.client(url)
            out = self.root / "out"
            for asset in ("/api/assets/images/%2e%2e", "/api/assets/images/x%2fy",
                          "/api/assets/references/x%5cy", url + "/api/assets/images/x"):
                with self.assertRaises(GalleryError):
                    client.download_asset(asset, out)
            result = client.download_asset("/api/assets/images/work.png", out)
            self.assertEqual(Path(result).read_bytes(), b"image bytes")
            self.assertEqual(client.download_asset("/api/assets/images/work.png", out), result)
            previous = out / "broken.png"
            previous.write_bytes(b"previous")
            with self.assertRaises(GalleryError):
                client.download_asset("/api/assets/images/broken.png", out)
            self.assertEqual(previous.read_bytes(), b"previous")
            self.assertEqual({path.resolve() for path in out.iterdir()}, {Path(result), previous.resolve()})

    def test_failure_precedence(self):
        self.assertEqual(classify_failure({"status": "uncertain", "workSaveError": "disk",
                                          "failure": {"category": "blocked"}})["category"], "uncertain")
        self.assertEqual(classify_failure({"workSaveError": "disk",
                                          "failure": {"category": "blocked"}})["category"], "save_failed")
        for incoming, expected in [("blocked", "blocked"), ("network", "network"),
                                   ("storage", "save_failed"), ("rate_limit", "rate_limited"),
                                   ("unavailable", "provider_error"), ("cancelled", "cancelled"),
                                   ("invalid_input", "invalid_input"), ("timeout", "timeout")]:
            with self.subTest(category=incoming):
                self.assertEqual(classify_failure({"status": "failed", "failure": {
                    "category": incoming}})["category"], expected)
        self.assertEqual(classify_failure({"timedOut": True})["category"], "timeout")

    def test_save_recipe_paths_only_purge_the_uploaded_work(self):
        calls = []

        def api(method, path, body):
            calls.append((method, path))
            if path == "/api/images" and method == "POST":
                self.assertIn(b"new prompt", body)
                return reply({"id": "temporary"})
            if method == "POST" and path.endswith("/recipe"):
                return reply({"id": "recipe"})
            if method == "PATCH":
                return reply({"id": "recipe", **json.loads(body)})
            if method == "DELETE":
                return reply({"ok": True})
            return self.api(method, path, body)

        with mock_server(api) as url:
            client = self.client(url, default_source_type="openai")
            self.assertEqual(client.save_recipe_from_work("#WORK", title="a")["sourceType"], "openai")
            self.assertEqual(calls, [("GET", "/api/gallery/works/by-code/%23WORK/context"),
                                     ("POST", "/api/images/work/recipe"), ("PATCH", "/api/images/recipe")])
            calls.clear()
            self.assertEqual(client.save_recipe_from_image(self.ref, "new prompt", tags=["tag"])["tags"], ["tag"])
            self.assertEqual(calls, [("POST", "/api/images"), ("POST", "/api/images/temporary/recipe"),
                                     ("PATCH", "/api/images/recipe"), ("DELETE", "/api/images/temporary"),
                                     ("DELETE", "/api/trash/temporary")])

    def test_file_recipe_cleanup_runs_if_metadata_patch_fails(self):
        deleted = []

        def api(method, path, body):
            if method == "DELETE":
                deleted.append(path)
                return reply({"ok": True})
            if method == "PATCH":
                return reply({"error": "conflict"}, 409)
            return reply({"id": "temporary" if path == "/api/images" else "recipe"})

        with mock_server(api) as url, self.assertRaises(GalleryError) as caught:
            self.client(url).save_recipe_from_image(self.ref, "new prompt", title="title")
        self.assertEqual(caught.exception.category, "save_failed")
        self.assertEqual(caught.exception.details["recipeId"], "recipe")
        self.assertEqual(deleted, ["/api/images/temporary", "/api/trash/temporary"])

    def test_file_recipe_cleanup_runs_on_interrupt(self):
        deleted = []

        def api(method, path, body):
            if method == "DELETE":
                deleted.append(path)
                return reply({"ok": True})
            return reply({"id": "temporary"})

        with mock_server(api) as url:
            client = self.client(url)
            with patch.object(client, "_create_recipe", side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    client.save_recipe_from_image(self.ref, "prompt")
        self.assertEqual(deleted, ["/api/images/temporary", "/api/trash/temporary"])

    def test_probe_blocks_unauthorized_non_gallery_and_redirects(self):
        for code, response in ((401, {"error": "denied"}), (403, {}), (503, {}),
                               (200, {"hello": "world"}), (302, {})):
            with self.subTest(code=code), mock_server(
                lambda *_: reply(response, code, Location="http://127.0.0.1:1")
            ) as url, patch("gallery_client.runtime.subprocess.run") as launch:
                with patch("gallery_client.runtime.LOCAL_PORT", int(url.rsplit(":", 1)[1])):
                    with self.assertRaises(GalleryError) as caught:
                        self.client(url).ensure_ready(timeout=2)
                self.assertEqual(caught.exception.status, code if code != 200 else None)
                launch.assert_not_called()

    def test_proxy_is_disabled_and_custom_or_no_start_endpoints_do_not_launch(self):
        proxy_requests = []
        with mock_server(self.api) as url, mock_server(
            lambda *args: proxy_requests.append(args) or reply({}, 503)
        ) as proxy:
            with patch.dict(os.environ, {"http_proxy": proxy, "no_proxy": ""}):
                self.assertFalse(self.client(url).ensure_ready().started)
            self.assertFalse(proxy_requests)
        # The listener is now closed, giving a real ECONNREFUSED.
        with patch("gallery_client.runtime.subprocess.run") as launch:
            with self.assertRaises(GalleryError):
                self.client(url).ensure_ready(timeout=2)
            with patch("gallery_client.runtime.LOCAL_PORT", int(url.rsplit(":", 1)[1])):
                with self.assertRaises(GalleryError):
                    self.client(url, no_start=True).ensure_ready(timeout=2)
            launch.assert_not_called()

    def test_cli_batch_status_wait_and_single_json_failures(self):
        def run(url, *args):
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts/banana-gallery.py"),
                 "--api-base", url, "--no-start", *map(str, args)], capture_output=True, text=True,
                env={**os.environ, **dict.fromkeys(
                    ("HOME", "USERPROFILE", "LOCALAPPDATA", "XDG_STATE_HOME", "TMPDIR", "TEMP", "TMP"), str(self.root)
                )}, timeout=5,
            )
            return result.returncode, json.loads(result.stdout)

        with mock_server(self.api) as url:
            state = self.root / "batch.json"
            BatchRunner(self.client(url)).submit(
                {"schemaVersion": 1, "items": [{"prompt": "a"}]}, state_path=state,
            )
            self.assertEqual(run(url, "status", "--batch", state)[1]["completed"], 1)
            self.assertEqual(run(url, "wait", "--batch", state, "--no-download")[0], 0)
            code, result = run(url, "save-recipe", "--image", self.ref)
            self.assertEqual((code, result["error"]["category"]), (2, "invalid_input"))

        for task, code in ({"status": "queued"}, 4), (
            {"status": "failed", "failure": {"category": "blocked"}}, 5
        ), ({"status": "uncertain"}, 6):
            def api(method, path, body):
                if path == "/api/generation-tasks/task-1":
                    return reply({"id": "task-1", **task})
                return self.api(method, path, body)

            with self.subTest(task=task), mock_server(api) as url:
                self.assertEqual(run(url, "wait", "task-1", "--timeout", ".2")[0], code)
        # Winsock can take about two seconds to reject a closed loopback port.
        self.assertEqual(run(url, "ensure", "--timeout", "5")[0], 3)

    @unittest.skipIf(os.name == "nt", "POSIX-only service autostart")
    def test_parallel_start_lock_reprobes_before_running_gallery_sh(self):
        # Use an ephemeral listener while retaining the real production allowlist in other tests.
        fixture = self.root / "fake_server.py"
        fixture.write_text(
            "from http.server import BaseHTTPRequestHandler, HTTPServer\n"
            "import json, sys\n"
            "class Handler(BaseHTTPRequestHandler):\n"
            " def do_GET(self):\n"
            "  body={'user': {'id':'u'}, 'workspace': {'id':'w'}, 'runtimeMode':'personal-local', 'plan': {'id':'personal'}}\n"
            "  self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(body).encode())\n"
            "HTTPServer(('127.0.0.1', int(sys.argv[1])), Handler).serve_forever()\n"
        )
        import socket
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        script = self.root / "gallery.sh"
        script.write_text(f'#!/bin/sh\necho "$1" >> calls\n"{sys.executable}" fake_server.py {port} >/dev/null 2>&1 &\necho $! > pid\n')
        script.chmod(0o700)
        url = f"http://127.0.0.1:{port}"
        from concurrent.futures import ThreadPoolExecutor
        try:
            with patch("gallery_client.runtime.LOCAL_PORT", port), ThreadPoolExecutor(4) as pool:
                clients = [self.client(url, gallery_root=self.root) for _ in range(4)]
                results = list(pool.map(lambda client: client.ensure_ready(timeout=5), clients))
            self.assertEqual((self.root / "calls").read_text().splitlines(), ["start"])
            self.assertEqual(sum(result.started for result in results), 1)
        finally:
            pid_file = self.root / "pid"
            if pid_file.exists():
                import os
                import signal
                with contextlib.suppress(ProcessLookupError):
                    os.kill(int(pid_file.read_text()), signal.SIGTERM)
