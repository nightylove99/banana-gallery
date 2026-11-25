import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const appRoot = path.resolve(path.dirname(script), '..')
const version = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version

export function distributionPaths(root, env = process.env) {
  const configured = env.BANANA_GALLERY_DATA_DIR
  if (configured && !path.isAbsolute(configured)) throw new Error('数据目录必须是绝对路径 (absolute path)')
  const base = env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share')
  const dataDir = path.resolve(configured || path.join(base, 'BananaGallery', 'data'))
  const identity = process.platform === 'win32' ? dataDir.toLowerCase() : dataDir
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 24)
  return {
    appRoot: root, dataDir,
    backupDir: path.join(path.dirname(dataDir), 'backups'),
    logFile: path.join(path.dirname(dataDir), 'gallery.log'),
    controlPath: process.platform === 'win32'
      ? `\\\\.\\pipe\\banana-gallery-${hash}`
      : path.join(os.tmpdir(), `banana-gallery-${hash}.sock`),
  }
}

// A distribution starts with only OS essentials, never the publisher's or another app's config.
export function personalEnvironment(dataDir, port, inherited = process.env) {
  const allowed = /^(path|systemroot|windir|comspec|pathext|temp|tmp|tmpdir|home|userprofile|appdata|localappdata|systemdrive|lang|lc_all)$/i
  return {
    ...Object.fromEntries(Object.entries(inherited).filter(([key]) => allowed.test(key))),
    AUTH_MODE: 'local',
    NODE_ENV: 'production',
    BIND_HOST: '127.0.0.1', PORT: String(port),
    BANANA_GALLERY_DATA_DIR: dataDir, BANANA_GALLERY_SERVE_STATIC: 'true',
    BANANA_GALLERY_ENV_FILE: '.env.windows-distribution',
    CORS_ALLOWED_ORIGINS: `http://localhost:${port},http://127.0.0.1:${port}`,
  }
}

export function copyBackup(dataDir, backupDir) {
  const relative = path.relative(path.resolve(dataDir), path.resolve(backupDir))
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('备份目录不能位于数据目录内部')
  }
  fs.mkdirSync(backupDir, { recursive: true })
  const destination = path.join(backupDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  fs.mkdirSync(destination)
  try {
    for (const relative of ['gallery-data.json', 'generation-tasks.json', 'public/images', 'public/references']) {
      const source = path.join(dataDir, relative)
      if (fs.existsSync(source)) {
        fs.cpSync(source, path.join(destination, relative), { recursive: true, errorOnExist: true, force: false,
          filter: (file) => {
            if (fs.lstatSync(file).isSymbolicLink()) throw new Error('备份不支持符号链接，请先检查数据目录')
            return true
          },
        })
      }
    }
    fs.writeFileSync(path.join(destination, 'backup-info.json'), JSON.stringify({ version, createdAt: new Date().toISOString() }, null, 2))
    return destination
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true })
    throw error
  }
}

function control(paths, command = 'status', timeout = 4000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(paths.controlPath)
    let body = ''
    socket.setTimeout(timeout, () => socket.destroy(new Error('管理入口超时，请查看日志')))
    socket.on('connect', () => socket.write(`${command}\n`))
    socket.on('data', (chunk) => { body += chunk })
    socket.on('end', () => {
      try { resolve(JSON.parse(body)) } catch { reject(new Error('管理入口返回无效结果')) }
    })
    socket.on('error', (error) => {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve(null)
      else reject(error)
    })
  })
}

async function acquireControl(paths, handler) {
  if (await control(paths)) throw new Error('画廊正在运行或正在安装/备份，请先停止或等待操作完成')
  // Windows removes named pipes on exit. Unix smoke tests also recover crash leftovers.
  if (process.platform !== 'win32' && fs.existsSync(paths.controlPath)) fs.unlinkSync(paths.controlPath)
  const server = net.createServer((socket) => {
    socket.setTimeout(4000, () => socket.destroy())
    socket.on('error', () => {})
    let input = ''
    socket.on('data', (chunk) => {
      input += chunk
      if (input.length > 64) { socket.destroy(); return }
      if (!input.includes('\n')) return
      socket.removeAllListeners('data')
      socket.setTimeout(0)
      Promise.resolve(handler(input.trim())).then(
        (value) => socket.end(JSON.stringify(value)),
        (error) => socket.end(JSON.stringify({ error: error.message })),
      )
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(paths.controlPath, resolve)
  })
  if (process.platform !== 'win32') fs.chmodSync(paths.controlPath, 0o600)
  return server
}

function runNode(args, paths) {
  const result = spawnSync(process.execPath, args, {
    cwd: paths.appRoot, env: personalEnvironment(paths.dataDir, 3333), stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`命令未完成（退出码 ${result.status}），请保留上面的错误信息`)
}

function requireInstalled(paths) {
  const require = createRequire(path.join(paths.appRoot, 'package.json'))
  try { require.resolve('tsx'); require('sharp') } catch {
    throw new Error('依赖尚未安装或不适用于本机，请先执行 gallery.cmd install')
  }
  if (!fs.existsSync(path.join(paths.appRoot, 'dist', 'index.html'))) {
    throw new Error('缺少预构建网页，请重新完整解压 Windows 分发包')
  }
}

async function portIsFree(port) {
  const probe = net.createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', () => reject(new Error(`端口 ${port} 已被占用；不会停止其他程序。请先关闭占用程序再启动画廊。`)))
    probe.listen(port, '127.0.0.1', resolve)
  })
  await new Promise((resolve) => probe.close(resolve))
}

async function serve(paths, port) {
  let state = 'starting'
  let shutdown
  const manager = await acquireControl(paths, async (command) => {
    if (command === 'stop') {
      if (!shutdown || state !== 'running') return { error: '启动或停止尚未完成，请稍后重试' }
      state = 'stopping'
      await shutdown()
      manager.close(() => process.exit(0))
      return { state: 'stopped' }
    }
    return { state, version, appRoot: paths.appRoot, dataDir: paths.dataDir, port }
  })
  try {
    await portIsFree(port)
    const runtime = await import('../server/index.ts')
    shutdown = runtime.shutdownRuntime
    // Do not report success until the API is serving the expected local session.
    const session = await fetch(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(5000) })
    if (!session.ok || !(await session.json()).workspace) throw new Error('本地 session 检查未通过')
    state = 'running'
    console.log(`Banana Gallery ${version}; data: ${paths.dataDir}`)
  } catch (error) {
    manager.close()
    throw error
  }
}

async function start(paths, port) {
  const existing = await control(paths)
  if (existing) {
    if (existing.state !== 'running') throw new Error(`当前状态：${existing.state}，请稍后重试`)
    console.log(`已运行：${existing.appRoot}\nhttp://localhost:${existing.port}`)
    return
  }
  requireInstalled(paths)
  await portIsFree(port)
  fs.mkdirSync(path.dirname(paths.logFile), { recursive: true })
  const log = fs.openSync(paths.logFile, 'a')
  const child = spawn(process.execPath, ['--import', 'tsx', script, 'serve'], {
    cwd: paths.appRoot, env: { ...personalEnvironment(paths.dataDir, port), BANANA_GALLERY_PORT: String(port) },
    detached: true, windowsHide: true, stdio: ['ignore', log, log],
  })
  fs.closeSync(log)
  let childError
  child.on('error', (error) => { childError = error })
  child.unref()
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    if (childError) throw childError
    const status = await control(paths)
    if (status?.state === 'running') {
      console.log(`已启动：http://localhost:${status.port}\n数据：${paths.dataDir}\n日志：${paths.logFile}`)
      return
    }
    if (child.exitCode !== null || child.signalCode !== null) break
  }
  throw new Error(`启动未完成，请执行 gallery.cmd status 和 gallery.cmd log。日志：${paths.logFile}`)
}

async function stop(paths) {
  const result = await control(paths, 'stop', 360000)
  if (result?.error) throw new Error(result.error)
  if (result && result.state !== 'stopped') throw new Error('当前正在安装或备份，请等待完成')
  for (let i = 0; result && i < 50; i++) {
    if (!await control(paths)) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  console.log(result ? '已停止；数据保留。' : '未运行；数据保留。')
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (!((major === 22 && minor >= 23) || major >= 24)) {
    throw new Error('请安装 Node.js 24 LTS（或 22.23+），然后重新打开命令窗口')
  }
  const paths = distributionPaths(appRoot)
  const command = process.argv[2] || 'status'
  const port = Number(process.env.BANANA_GALLERY_PORT || 3333)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须在 1024–65535 之间')
  if (command === 'serve') { await serve(paths, port); return }
  if (command === 'start') { await start(paths, port); return }
  if (command === 'stop') { await stop(paths); return }
  if (command === 'restart') { await stop(paths); await start(paths, port); return }
  if (command === 'status') {
    const status = await control(paths)
    console.log(status ? JSON.stringify(status, null, 2) : `未运行\n数据：${paths.dataDir}\n日志：${paths.logFile}`)
    return
  }
  if (command === 'log') {
    console.log(fs.existsSync(paths.logFile) ? fs.readFileSync(paths.logFile, 'utf8').split('\n').slice(-100).join('\n') : '尚无日志')
    return
  }
  if (['install', 'backup', 'verify'].includes(command)) {
    fs.mkdirSync(paths.dataDir, { recursive: true })
    const lock = await acquireControl(paths, () => ({ state: command }))
    try {
      if (command === 'install') {
        const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
        if (!fs.existsSync(npm)) throw new Error('未找到随 Node.js 安装的 npm，请使用官方 Windows Node.js LTS 安装包')
        runNode([npm, 'ci', '--include=dev', '--include=optional', '--no-audit', '--no-fund'], paths)
        requireInstalled(paths)
        console.log('安装完成。现在执行 gallery.cmd start。')
      } else {
        requireInstalled(paths)
        runNode(['--import', 'tsx', 'scripts/verify-gallery-assets.ts'], paths)
        if (command === 'backup') console.log(`备份完成：${copyBackup(paths.dataDir, paths.backupDir)}`)
      }
    } finally { lock.close() }
    return
  }
  throw new Error('用法：gallery.cmd install|start|stop|restart|status|log|backup|verify')
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(script)) {
  main().catch((error) => { console.error(error.message); process.exit(1) })
}
