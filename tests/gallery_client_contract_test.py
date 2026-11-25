"""Exercise the public CLI against the real server, without live data or credentials."""
import base64
import json
import os
from pathlib import Path
from queue import Queue
import subprocess
import sys
import tempfile
from threading import Thread
import unittest

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_NAME = "参考 image.png"
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC"
SERVER = """
import fs from 'node:fs'
import path from 'node:path'
import { createApp } from './server/app.ts'
import { workCode } from './server/gallery/work-code.ts'
const [root, png] = process.argv.slice(1)
const buffer = Buffer.from(png, 'base64')
const imagesDir = path.join(root, 'images')
const dataFile = path.join(root, 'gallery-data.json')
fs.mkdirSync(imagesDir)
fs.writeFileSync(path.join(imagesDir, 'old.png'), buffer)
fs.writeFileSync(dataFile, JSON.stringify({images: [{
  id: 'older', filename: 'old.png', prompt: 'older pinned work', pinned: true,
  createdAt: '2000-01-01T00:00:00Z', referenceImages: [], tags: [],
  width: 1, height: 1, assetType: 'work', favorited: false
}]}))
const app = createApp({
  ai: { models: { generateContent: async () => ({ candidates: [] }) } },
  strategy: { mode: 'apiKey', apiKey: 'fixture-only' },
  userAuthMode: 'local',
  agentApiToken: 'fixture-agent-token',
  localAuthSession: { user: { id: 'fixture' }, workspace: { id: 'fixture', name: 'Fixture' } },
  dataFile, imagesDir, referencesDir: path.join(root, 'references'),
  imageGenerationProvider: {
    async generateImage(args) {
      await args.onRequestStarted?.()
      return { buffer, mimeType: 'image/png' }
    }
  }
})
const server = app.listen(0, '127.0.0.1', () => console.log(JSON.stringify({
  port: server.address().port, oldCode: workCode('older')
})))
process.on('SIGTERM', async () => {
  await app.locals.stopTaskQueue()
  server.close()
})
"""


class GalleryClientContractTest(unittest.TestCase):
    def test_real_cli_workflow(self):
        with tempfile.TemporaryDirectory(prefix="gallery-contract-") as directory:
            root = Path(directory)
            # Do not forward any provider credentials, proxy settings, or real HOME.
            env = {name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR")
                   if name in os.environ}
            env.update(HOME=directory, USERPROFILE=directory, LOCALAPPDATA=directory,
                       XDG_STATE_HOME=directory, TMPDIR=directory, TMP=directory, TEMP=directory,
                       PYTHONDONTWRITEBYTECODE="1")
            with (root / "server.stderr").open("w+") as diagnostics, subprocess.Popen(
                ["node", "--import", "tsx", "--input-type=module", "-e", SERVER, directory, PNG],
                cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=diagnostics, text=True,
            ) as server:
                try:
                    # Windows selectors only accept sockets, not subprocess pipes.
                    output = Queue()
                    reader = Thread(target=lambda: output.put(server.stdout.readline()), daemon=True)
                    reader.start()
                    line = output.get(timeout=20)
                    diagnostics.seek(0)
                    self.assertTrue(line, diagnostics.read())
                    address = json.loads(line)
                    self.exercise_cli(root, env, address)
                    self.exercise_agent_cli(root, env, address)
                finally:
                    server.terminate()
                    try:
                        server.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        server.kill()
                        server.wait(timeout=5)

    def exercise_cli(self, root, env, address):
        def cli(*args, stdin=None):
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts/banana-gallery.py"), "--api-base",
                 f"http://127.0.0.1:{address['port']}", "--no-start", *map(str, args)],
                cwd=ROOT, env=env, input=stdin, capture_output=True, text=True, timeout=25,
            )
            self.assertEqual(result.returncode, 0, (args, result.stdout, result.stderr))
            return json.loads(result.stdout)

        ref = root / REFERENCE_NAME
        ref.write_bytes(base64.b64decode(PNG))
        self.assertTrue(cli("models", "--provider", "google", "--available-only")["models"])
        job = cli("generate", "--key", "original", "--prompt", "original prompt",
                  "--provider", "google", "--model", "gemini-nano-banana-2.1",
                  "--reference", ref, "--reference-notes-file", "-", stdin='["palette"]')
        work = cli("wait", job["id"], "--timeout", "15")
        work_path = Path(work["imagePath"])
        self.assertTrue(work_path.read_bytes().startswith(b"\x89PNG"))
        self.assertTrue(work_path.parent.name.startswith("banana-gallery-"))
        self.assertEqual(cli("generate", "--key", "original", "--prompt", "original prompt",
                             "--provider", "google", "--model", "gemini-nano-banana-2.1",
                             "--reference", ref, "--reference-notes-file", "-",
                             stdin='["palette"]')["id"], job["id"])
        context = cli("inspect", work["workCode"])
        self.assertEqual(context["generationTask"]["input"]["referenceNotes"], ["palette"])
        self.assertTrue(Path(context["references"][0]["path"]).is_file())
        replaced = cli("iterate", "--from", work["workCode"], "--key", "replace", "--reference", ref)
        replaced_work = cli("wait", replaced["id"], "--timeout", "15", "--no-download")
        self.assertNotIn("imagePath", replaced_work)
        appended = cli("iterate", "--from", replaced_work["workCode"], "--key", "append",
                       "--append-reference", ref, "--prompt", "updated prompt",
                       "--reference-notes-file", "-", stdin='["first", "second"]')
        appended_work = cli("wait", appended["id"], "--timeout", "15", "--no-download")
        frozen = cli("inspect", appended_work["workCode"], "--no-download")["generationTask"]["input"]
        self.assertEqual(frozen["sourceTaskId"], replaced["id"])
        self.assertEqual(frozen["referenceNotes"], ["first", "second"])
        state = root / "batch.json"
        manifest = {"schemaVersion": 1, "defaults": {"provider": "google", "model": "gemini-nano-banana-2.1"},
                    "matrix": {"prompts": ["batch first", "batch second"], "referenceGroups": [[ref.name], []]}}
        result = cli("batch", "--manifest", "-", "--base-dir", root, "--state", state,
                     stdin=json.dumps(manifest))
        self.assertEqual(result["total"], 4)
        self.assertTrue(all(item["taskId"] for item in result["items"]))
        self.assertEqual(cli("status", "--batch", state)["total"], 4)
        summary = cli("wait", "--batch", state, "--timeout", "15")
        self.assertEqual(summary["completed"], 4)
        self.assertTrue(all(Path(item["imagePath"]).is_file() for item in summary["items"]))
        works = cli("works", "--limit", "20")["items"]
        self.assertEqual(works[-1]["workCode"], address["oldCode"])
        self.assertTrue(works[-1]["pinned"])
        self.assertIn("promptExcerpt", works[0])
        self.assertNotIn("prompt", works[0])
        history = cli("history", "--provider", "google", "--status", "completed")["items"]
        self.assertEqual(len(history), 7)
        self.assertNotIn("input", history[0])
        self.assertEqual(cli("recipes")["total"], 0)
        source = cli("save-recipe", "--from", work["workCode"], "--title", "From work",
                     "--tag", "contract", "--source-type", "openai")
        uploaded = cli("save-recipe", "--image", ref, "--prompt-file", "-", "--title", "From file",
                       stdin="standalone recipe")
        self.assertEqual(source["id"], cli("recipes", "--query", "From work")["items"][0]["id"])
        full = cli("recipes", "--query", "From file", "--full-prompt")["items"][0]
        self.assertEqual(full["id"], uploaded["id"])
        self.assertEqual(full["prompt"], "standalone recipe")
        self.assertEqual(cli("inspire", "--query", "From file")[0]["prompt"], "standalone recipe")
        self.assertEqual(cli("works")["total"], 8)
        snapshot = json.loads((root / "gallery-data.json").read_text())
        self.assertFalse(any(item.get("deletedAt") for item in snapshot["images"]))
        self.assertNotIn(uploaded["sourceAssetId"], {item["id"] for item in snapshot["images"]})
        legacy = cli("submit", "--from", work["workCode"], "--key", "legacy",
                     "--prompt-file", "-", stdin="legacy replacement")
        self.assertEqual(set(legacy), {"id"})
        self.assertTrue(cli("wait", legacy["id"], "--timeout", "15", "--no-download")["workCode"])


    def exercise_agent_cli(self, root, env, address):
        env = {**env, "BANANA_GALLERY_URL": f"http://127.0.0.1:{address['port']}",
               "BANANA_GALLERY_TOKEN": "fixture-agent-token"}

        def cli(*args):
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts/banana-gallery.py"), *map(str, args)],
                cwd=root, env=env, capture_output=True, text=True, timeout=25,
            )
            self.assertEqual(result.returncode, 0, (args, result.stdout, result.stderr))
            return json.loads(result.stdout)

        self.assertTrue(cli("ensure")["ready"])
        self.assertTrue(cli("models", "--provider", "demo", "--available-only")["models"])
        job = cli("generate", "--provider", "demo", "--model", "banana-demo-v1",
                  "--key", "agent-demo", "--prompt", "Offline setup check")
        self.assertEqual(cli("status", "--key", "agent-demo")["id"], job["id"])
        finished = cli("wait", job["id"], "--timeout", 15)
        code = finished["workCode"]
        self.assertTrue(code.startswith("#"))
        self.assertTrue(Path(cli("inspect", code)["imagePath"]).is_file())
        copied = cli("save-recipe", "--from", code, "--title", "Agent copy")
        before = cli("works")["total"]
        uploaded = cli("save-recipe", "--image", root / REFERENCE_NAME, "--prompt", "Agent upload",
                       "--title", "Agent asset", "--tag", "fixture")
        self.assertEqual(cli("works")["total"], before)
        self.assertEqual(uploaded["tags"], ["fixture"])
        self.assertEqual(cli("recipes", "--query", "Agent copy")["items"][0]["id"], copied["id"])
