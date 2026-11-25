import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixed = new Set([
  'package.json', 'package-lock.json', 'index.html', 'vite.config.ts',
  'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json',
  'scripts/windows-gallery.mjs', 'scripts/verify-gallery-assets.ts',
  'scripts/banana-gallery.py', 'scripts/gallery_client/__init__.py',
  'scripts/gallery_client/cli.py', 'scripts/gallery_client/client.py',
  'scripts/gallery_client/runtime.py', 'scripts/gallery_client/submission.py',
  'skills/banana-gallery/SKILL.md', 'skills/banana-gallery/examples/batch-matrix.json', 'doc/api-v1.md',
  'server/auth/agent-access.ts',
  'public/apple-touch-icon.png', 'public/favicon-32x32.png', 'public/icon.svg',
  'public/pwa-192x192.png', 'public/pwa-512x512.png', 'public/robots.txt',
])

export function isReleaseSource(file) {
  if (file.split('/').some((part) => part.startsWith('.') || part === 'node_modules')) return false
  if (fixed.has(file)) return true
  if (['qwen21-t2i-api.json', 'qwen21-edit-api.json', 'qwen21-v2-t2i-api.json', 'qwen21-v2-edit-api.json', 'krea2-turbo-v1-t2i-api.json'].some(name => file === `server/ai/workflows/${name}`)) return true
  if (/^(server|src)\//.test(file)) return /\.(ts|tsx|css|svg|png)$/.test(file)
  return /^extension\/gemini-to-banana\/[^/]+\.(js|json|html|css)$/.test(file)
}

function listFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`分发包禁止符号链接：${relative}`)
    return entry.isDirectory() ? listFiles(path.join(directory, entry.name), relative) : [relative]
  })
}

function main() {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const releases = path.join(root, 'releases')
  fs.mkdirSync(releases, { recursive: true })
  const name = `banana-gallery-${version}-windows`
  const archive = path.join(releases, `${name}.zip`)
  if (fs.existsSync(archive)) throw new Error(`分发包已存在，不覆盖：${archive}`)
  const staging = fs.mkdtempSync(path.join(releases, '.build-'))
  const output = path.join(staging, name)
  const app = path.join(output, 'app')
  fs.mkdirSync(app, { recursive: true })
  try {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
    // These new task files also work before the first release commit. All other sources must be tracked.
    const candidates = new Set([...tracked, ...fixed, 'server/config/runtime-paths.ts'])
    for (const file of [...candidates].filter(isReleaseSource)) {
      const source = path.join(root, file)
      if (!fs.statSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) throw new Error(`不是普通文件：${file}`)
      const target = path.join(app, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target)
    }
    fs.copyFileSync(path.join(root, 'gallery.cmd'), path.join(output, 'gallery.cmd'))
    for (const [source, destination] of [
      ['doc/windows-local.md', 'README.txt'],
    ]) fs.copyFileSync(path.join(root, source), path.join(output, destination))

    // Build from the clean copy. Never reuse local dist/public or load the publisher's .env.
    const buildEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(path|systemroot|windir|temp|tmp|tmpdir|home|userprofile|lang|lc_all)$/i.test(key)))
    execFileSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], {
      cwd: app, env: buildEnv, stdio: 'inherit',
    })
    // Vite may create a temporary node_modules/.vite-temp while loading its config.
    fs.rmSync(path.join(app, 'node_modules'), { recursive: true, force: true })
    const files = listFiles(output).sort()
    const manifest = {
      version, platform: 'windows', extensionVersion: JSON.parse(fs.readFileSync(path.join(app, 'extension/gemini-to-banana/manifest.json'), 'utf8')).version,
      validation: 'Cross-platform automated checks; Windows desktop acceptance still required.',
      files: files.map((file) => ({ file, sha256: createHash('sha256').update(fs.readFileSync(path.join(output, file))).digest('hex') })),
    }
    fs.writeFileSync(path.join(output, 'CONTENTS.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    execFileSync('zip', ['-q', '-r', archive, name], { cwd: staging, stdio: 'inherit' })
    const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
    fs.writeFileSync(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`)
    console.log(`分发包：${archive}\nSHA-256：${digest}`)
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
