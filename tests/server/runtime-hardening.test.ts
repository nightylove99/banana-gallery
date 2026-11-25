import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'

it('starts an isolated loopback runtime and shuts it down with an idle keep-alive connection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'banana-json-runtime-'))
  const portReservation = net.createServer()
  await once(portReservation.listen(0, '127.0.0.1'), 'listening')
  const port = (portReservation.address() as net.AddressInfo).port
  await new Promise<void>(resolve => portReservation.close(() => resolve()))

  // Windows does not deliver a catchable SIGTERM to a child process. Exercise
  // the same graceful shutdown function used by the Windows launcher via stdin.
  const usesStdin = process.platform === 'win32'
  const entry = usesStdin ? ['--input-type=module', '-e', `
    const { shutdownRuntime } = await import('./server/index.ts')
    process.stdin.once('data', async () => {
      process.stdin.pause()
      await shutdownRuntime()
    })
  `] : ['server/index.ts']
  const child = spawn(process.execPath, ['--import', 'tsx', ...entry], {
    env: {
      ...process.env,
      AUTH_MODE: 'local', BIND_HOST: '127.0.0.1',
      PORT: String(port), BANANA_GALLERY_DATA_DIR: root, BANANA_GALLERY_BACKUP_DIR: path.join(root, 'backups'),
      BANANA_GALLERY_ENV_FILE: 'no-hardening-test.env', BANANA_GALLERY_SERVE_STATIC: 'false',
      QWEN_LOCAL_SSH_HOST: '', GEMINI_API_KEY: 'fixture',
      GOOGLE_APPLICATION_CREDENTIALS: '', BANANA_GALLERY_SERVICE_ACCOUNT_PATH: '',
    },
    stdio: [usesStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  try {
    await vi.waitFor(() => expect(output).toContain(`127.0.0.1:${port}`), { timeout: 4_000 })
    const res = await fetch(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(2000) })
    expect(res.status).toBe(200)
    await res.text()
    if (usesStdin) child.stdin?.end('stop')
    else child.kill('SIGTERM')
    await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 2_000 })
  } finally {
    child.kill('SIGKILL')
    await exited
    await fs.rm(root, { recursive: true, force: true })
  }
})
