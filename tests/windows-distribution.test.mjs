import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const exec = promisify(execFile)

test('distribution carries only the fixed Qwen workflow JSON assets', async () => {
 const { isReleaseSource } = await import('../scripts/package-windows.mjs')
 assert.equal(isReleaseSource('server/ai/workflows/qwen21-t2i-api.json'), true)
 assert.equal(isReleaseSource('server/ai/workflows/qwen21-edit-api.json'), true)
 assert.equal(isReleaseSource('server/ai/workflows/qwen21-v2-t2i-api.json'), true)
 assert.equal(isReleaseSource('server/ai/workflows/qwen21-v2-edit-api.json'), true)
 assert.equal(isReleaseSource('server/ai/workflows/private.json'), false)
})

test('Windows distribution includes the external Agent client, skill and API guide', async () => {
  const { isReleaseSource } = await import('../scripts/package-windows.mjs')
  for (const file of [
    'scripts/banana-gallery.py', 'scripts/gallery_client/client.py',
    'skills/banana-gallery/SKILL.md', 'skills/banana-gallery/examples/batch-matrix.json', 'doc/api-v1.md',
  ]) assert.equal(isReleaseSource(file), true, file)
  for (const file of [
    'scripts/gallery_client/.env', 'skills/banana-gallery/examples/local-state.json', 'skills/private/SKILL.md',
  ]) assert.equal(isReleaseSource(file), false, file)
})

async function distribution() {
  const module = await import('../scripts/windows-gallery.mjs').catch(() => null)
  assert.ok(module, 'Windows distribution launcher must be importable without starting a service')
  return module
}

test('Windows data stays outside versioned application directories', async () => {
  const { distributionPaths } = await distribution()
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-paths-'))
  try {
    const first = distributionPaths(path.join(base, 'v1'), { LOCALAPPDATA: base })
    const second = distributionPaths(path.join(base, 'v2'), { LOCALAPPDATA: base })
    assert.equal(first.dataDir, path.join(base, 'BananaGallery', 'data'))
    assert.equal(first.dataDir, second.dataDir)
    assert.equal(first.controlPath, second.controlPath)
    assert.throws(() => distributionPaths(base, { BANANA_GALLERY_DATA_DIR: './data' }), /absolute|绝对/)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('distribution forces loopback personal mode and cannot inherit hosted settings or secrets', async () => {
  const { personalEnvironment } = await distribution()
  const env = personalEnvironment('/unused/data', 3333, {
    PATH: '/bin', AUTH_MODE: 'magic_link', DATABASE_URL: 'private-database',
    NODE_ENV: 'production', BIND_HOST: '0.0.0.0', GEMINI_API_KEY: 'private-key',
    NODE_OPTIONS: '--require /untrusted.js', VITE_PRIVATE_VALUE: 'private-value',
  })
  assert.equal(env.AUTH_MODE, 'local')
  assert.equal(env.BIND_HOST, '127.0.0.1')
  assert.equal(env.NODE_ENV, 'production')
  assert.equal(env.ALLOW_SERVER_SIDE_IMPORT, undefined)
  assert.equal(env.DATABASE_URL, undefined)
  assert.equal(env.BANANA_GALLERY_DATA_DIR, '/unused/data')
  assert.equal(env.BANANA_GALLERY_SERVE_STATIC, 'true')
  assert.equal(env.GEMINI_API_KEY, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.VITE_PRIVATE_VALUE, undefined)
})

test('backup copies metadata, originals and references together, without overwriting earlier backups', async () => {
  const { copyBackup } = await distribution()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-backup-'))
  try {
    const data = path.join(root, 'data')
    fs.mkdirSync(path.join(data, 'public', 'images'), { recursive: true })
    fs.mkdirSync(path.join(data, 'public', 'references'), { recursive: true })
    fs.writeFileSync(path.join(data, 'gallery-data.json'), '{"images":[]}')
    fs.writeFileSync(path.join(data, 'generation-tasks.json'), '{"generationTasks":[]}')
    fs.writeFileSync(path.join(data, 'public', 'images', 'original.png'), 'original')
    fs.writeFileSync(path.join(data, 'public', 'references', 'ref.png'), 'reference')
    const first = copyBackup(data, path.join(root, 'backups'))
    const second = copyBackup(data, path.join(root, 'backups'))
    assert.notEqual(first, second)
    assert.equal(fs.readFileSync(path.join(first, 'public', 'images', 'original.png'), 'utf8'), 'original')
    assert.equal(fs.readFileSync(path.join(first, 'public', 'references', 'ref.png'), 'utf8'), 'reference')
    assert.equal(fs.readFileSync(path.join(first, 'gallery-data.json'), 'utf8'), '{"images":[]}')
    assert.equal(fs.readFileSync(path.join(data, 'public', 'images', 'original.png'), 'utf8'), 'original')
    assert.equal(fs.readFileSync(path.join(first, 'generation-tasks.json'), 'utf8'), '{"generationTasks":[]}')
    assert.throws(() => copyBackup(data, path.join(data, 'backups')), /inside|内部/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release allowlist rejects gallery assets, private config, local dependencies and operational documents', async () => {
  const module = await import('../scripts/package-windows.mjs').catch(() => null)
  assert.ok(module, 'Windows packaging must expose its release allowlist')
  for (const file of ['.env', '.env.personal-remote', 'gallery-data.json', 'public/images/private.png',
    'public/references/private.png', 'node_modules/sharp/a.node', '.git/config',
    'doc/private-operations.md', 'doc/internal-notes.md', 'server/private.env', 'src/.env']) {
    assert.equal(module.isReleaseSource(file), false, file)
  }
  for (const file of ['package.json', 'package-lock.json', 'server/index.ts', 'src/App.tsx',
    'public/icon.svg', 'extension/gemini-to-banana/manifest.json']) {
    assert.equal(module.isReleaseSource(file), true, file)
  }
})

test('packaged runtime serves the gallery, preserves imported originals across restart, and backs up while stopped', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana Windows 中文 space-'))
  const app = path.join(root, 'app')
  const data = path.join(root, 'user', 'data')
  const project = path.resolve(import.meta.dirname, '..')
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const env = { ...process.env, BANANA_GALLERY_DATA_DIR: data, BANANA_GALLERY_PORT: String(port) }
  const cli = (command) => exec(process.execPath, [path.join(app, 'scripts/windows-gallery.mjs'), command], { env, timeout: 25000 })
  try {
    fs.mkdirSync(path.join(app, 'scripts'), { recursive: true })
    fs.mkdirSync(path.join(app, 'dist'))
    for (const file of ['package.json', 'tsconfig.json', 'tsconfig.app.json', 'scripts/windows-gallery.mjs', 'scripts/verify-gallery-assets.ts']) {
      fs.copyFileSync(path.join(project, file), path.join(app, file))
    }
    for (const dir of ['server', 'src']) fs.cpSync(path.join(project, dir), path.join(app, dir), { recursive: true })
    fs.symlinkSync(path.join(project, 'node_modules'), path.join(app, 'node_modules'), 'junction')
    const { personalEnvironment } = await distribution()
    const startupEnv = personalEnvironment(data, port)
    const proxyPassword = 'test-proxy-password'
    const tlsCheck = path.join(root, 'check-tls.mjs')
    fs.writeFileSync(tlsCheck, `
      process.on('exit', () => {
        console.log(process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
          ? 'TLS verification disabled' : 'TLS verification enabled')
      })
    `)
    const startupArgs = ['--import', pathToFileURL(tlsCheck).href, '--import', 'tsx', 'server/index.ts']
    await assert.rejects(exec(process.execPath, startupArgs, {
      cwd: app,
      env: { ...startupEnv, HTTPS_PROXY: `http://proxy-user:${proxyPassword}@127.0.0.1:9` },
      timeout: 15_000,
    }), error => {
      assert.match(error.stdout, /已启用 HTTP\(S\) 代理/)
      assert.match(error.stderr, /请先运行 npm run build/)
      assert.match(error.stdout, /TLS verification enabled/)
      assert.doesNotMatch(error.stdout + error.stderr, /proxy-user|test-proxy-password/)
      return true
    })
    fs.writeFileSync(path.join(app, 'dist', 'index.html'), '<!doctype html><title>packaged gallery</title>')
    // A leftover hosted .env must not alter a distributed personal startup.
    fs.writeFileSync(path.join(app, '.env'), 'AUTH_MODE=magic_link\nDATABASE_URL=invalid\nBIND_HOST=0.0.0.0\n')
    assert.match((await cli('status')).stdout, /未运行/)
    await cli('start')
    const status = JSON.parse((await cli('status')).stdout)
    assert.equal(status.state, 'running')
    assert.equal(status.dataDir, data)
    await cli('start') // Repeated start does not create a second writer.
    const url = `http://127.0.0.1:${port}`
    assert.match(await (await fetch(`${url}/recipes`)).text(), /packaged gallery/)
    const { version } = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'))
    assert.deepEqual(await (await fetch(`${url}/api/health`)).json(), { status: 'ok', version, authMode: 'local' })
    assert.equal((await (await fetch(`${url}/api/session`)).json()).workspace.id, 'local-workspace')
    const absent = await fetch(`${url}/api/not-a-route`)
    assert.equal(absent.status, 404)
    assert.doesNotMatch(await absent.text(), /packaged gallery/)
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC', 'base64')
    const body = new FormData()
    body.set('image', new Blob([image], { type: 'image/png' }), 'original.png')
    body.set('metadata', JSON.stringify({ prompt: 'distribution smoke prompt', assetType: 'recipe', tags: ['smoke'] }))
    body.append('references', new Blob([image], { type: 'image/png' }), 'reference.png')
    const response = await fetch(`${url}/api/external/gemini-web/import`, { method: 'POST', body })
    assert.equal(response.status, 200, await response.clone().text())
    const saved = await response.json()
    assert.equal(saved.prompt, 'distribution smoke prompt')
    assert.equal(saved.referenceImages.length, 1)
    assert.deepEqual(fs.readFileSync(path.join(data, 'public', 'images', saved.filename)), image)
    await assert.rejects(cli('backup'), /正在运行/)
    await cli('restart')
    const listed = await (await fetch(`${url}/api/images`)).json()
    assert.ok(listed.some((entry) => entry.id === saved.id))
    await cli('stop')
    await cli('verify')
    const backupResult = await cli('backup')
    assert.match(backupResult.stdout, /备份完成/)
    const backups = fs.readdirSync(path.join(root, 'user', 'backups'))
    assert.equal(backups.length, 1)
    assert.deepEqual(fs.readFileSync(path.join(root, 'user', 'backups', backups[0], 'public', 'images', saved.filename)), image)
    assert.ok(fs.existsSync(path.join(data, 'gallery-data.json')))
    assert.equal(fs.existsSync(path.join(app, 'gallery-data.json')), false)
    assert.match((await cli('status')).stdout, /未运行/)
  } finally {
    await cli('stop').catch(() => {})
    fs.rmSync(root, { recursive: true, force: true })
  }
})
