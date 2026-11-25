import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const projectRoot = path.resolve(import.meta.dirname, '..')
const posixOnly = { skip: process.platform === 'win32' && 'gallery.sh is a POSIX launcher' }

test('gallery.sh 可以通过环境变量选择 Cloudflare Access 远程配置', posixOnly, () => {
  const output = execFileSync('./gallery.sh', ['profile'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      BANANA_GALLERY_PROFILE: 'cloudflare_access',
    },
  }).trim()

  assert.equal(output, 'cloudflare_access')
})

test('gallery.sh 会拒绝未知运行配置', posixOnly, () => {
  assert.throws(
    () => execFileSync('./gallery.sh', ['profile'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        BANANA_GALLERY_PROFILE: 'public_without_auth',
      },
    }),
    /Command failed/,
  )
})

test('gallery.sh does not opt into path imports without explicit opt-in', posixOnly, () => {
  const output = execFileSync('bash', ['-c', [
    'set -- profile',
    'source ./gallery.sh >/dev/null',
    'set_personal_env',
    'printf "%s:%s" "$AUTH_MODE" "${ALLOW_SERVER_SIDE_IMPORT:-unset}"',
  ].join('; ')], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, ALLOW_SERVER_SIDE_IMPORT: '' },
  })
  assert.equal(output, 'local:unset')
})

test('macOS start, restart and stop use launchd without creating a tmux session', posixOnly, () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'gallery-launchd-')))
  try {
    const bin = path.join(root, 'bin')
    const agents = path.join(root, 'Library', 'LaunchAgents')
    mkdirSync(bin)
    mkdirSync(agents, { recursive: true })
    const job = path.join(agents, 'com.banana.gallery.plist')
    writeFileSync(job, '')
    copyFileSync(path.join(projectRoot, 'gallery.sh'), path.join(root, 'gallery.sh'))
    const trace = path.join(root, 'trace')
    const loaded = path.join(root, 'loaded')
    const commands = {
      uname: 'echo Darwin',
      plutil: 'printf "%s" "$HOME"',
      launchctl: 'echo "$*" >> "$TRACE"; case "$1" in print) [ -f "$LOADED" ] && echo "state = running";; bootstrap) touch "$LOADED";; kickstart) [ -f "$LOADED" ];; bootout) rm "$LOADED";; *) exit 1;; esac',
      tmux: '[ "$1" = has-session ] && exit 1; echo "tmux $*" >> "$TRACE"; exit 1',
      curl: '[ -f "$LOADED" ] || exit 1; case "$*" in *generation-tasks*) printf \'{"total":%s}\' "$ACTIVE";; esac',
      sleep: 'exit 0',
    }
    for (const [name, body] of Object.entries(commands)) {
      writeFileSync(path.join(bin, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 })
    }
    const runGallery = (command: string, args: string[] = [], active = 0) => spawnSync('bash', ['./gallery.sh', command, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, HOME: root, PATH: bin + path.delimiter + process.env.PATH, TRACE: trace, LOADED: loaded, ACTIVE: String(active), BANANA_GALLERY_PROFILE: 'personal' },
    })
    assert.equal(runGallery('start').status, 0)
    for (const command of ['restart', 'stop']) {
      const blocked = runGallery(command, [], 1)
      assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr)
      assert.match(blocked.stderr, /--force/)
      const allowed = runGallery(command, ['--force'], 1)
      assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr)
    }
    const actions = readFileSync(trace, 'utf8').trim().split('\n').filter(line => !line.startsWith('print '))
    assert.deepEqual(actions.map(line => line.split(' ')[0]), ['bootstrap', 'kickstart', 'bootout'])
    assert.match(actions[0], /^bootstrap gui\/\d+ .*com\.banana\.gallery\.plist$/)
    assert.match(actions[1], /^kickstart -kp gui\/\d+\/com\.banana\.gallery$/)
    assert.match(actions[2], /^bootout gui\/\d+\/com\.banana\.gallery$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
