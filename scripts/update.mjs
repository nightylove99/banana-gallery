#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

export function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {}
  const values = {}
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    values[key] = val
  }
  return values
}

export function countActiveGenerationTasks(payload) {
  const items = payload?.tasks ?? payload?.items ?? payload
  if (!Array.isArray(items)) return 0
  let active = 0
  for (const item of items) {
    const status = typeof item?.status === 'string' ? item.status.toLowerCase() : ''
    if (status === 'queued' || status === 'running' || status === 'pending' || status === 'processing') {
      active += 1
    }
  }
  return active
}

export function analyzeChangedFiles(changedFiles) {
  const normalized = changedFiles.map((file) => file.replace(/\\/g, '/').trim()).filter(Boolean)
  const needsInstall = normalized.some((file) => file === 'package.json' || file === 'package-lock.json')
  const skillChanged = normalized.some((file) => file.startsWith('skills/banana-gallery/'))
  const envExampleChanged = normalized.some((file) => file === '.env.example')
  return { needsInstall, skillChanged, envExampleChanged }
}

function runGit(args, cwd = ROOT) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function runInherited(cmd, args, cwd = ROOT) {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32' && cmd === 'npm',
  })
  if (res.error) throw res.error
  if (res.status !== 0) {
    throw new Error(`命令执行失败：${cmd} ${args.join(' ')}（退出码 ${res.status ?? 1}）`)
  }
}

async function checkLocalActiveTasks(port) {
  const url = `http://127.0.0.1:${port}/api/generation-tasks`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return { reachable: false, activeCount: 0 }
    const data = await res.json()
    return { reachable: true, activeCount: countActiveGenerationTasks(data) }
  } catch {
    return { reachable: false, activeCount: 0 }
  }
}

function readPackageVersion(rootDir = ROOT) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

export async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run')
  const skipQueueCheck = argv.includes('--skip-queue-check')

  console.log('Banana Gallery 安全更新向导\n')

  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    console.error('[STOP] 当前目录不是 Git 仓库（例如 Windows 独立压缩包版本）。')
    console.error('请前往 GitHub Releases 下载新版压缩包，解压后保留原有 .env 与数据目录即可。')
    process.exitCode = 1
    return
  }

  let statusOut = ''
  try {
    statusOut = runGit(['status', '--porcelain'])
  } catch (err) {
    console.error('[STOP] 无法执行 git status，请确认已安装 Git。')
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
    return
  }

  if (statusOut.length > 0) {
    console.error('[STOP] 检测到未提交的本地代码改动，为避免覆盖你的修改，已停止更新：')
    console.error(statusOut)
    console.error('\n请先提交、暂存或还原上述文件后再运行 npm run update（.env 与图库数据不受影响）。')
    process.exitCode = 1
    return
  }

  const fileEnv = parseEnvFile(path.join(ROOT, '.env'))
  const merged = { ...fileEnv, ...process.env }
  const port = Number.parseInt(merged.PORT || '3333', 10) || 3333

  if (!skipQueueCheck) {
    const queue = await checkLocalActiveTasks(port)
    if (queue.reachable && queue.activeCount > 0) {
      console.error(`[STOP] 检测到本地服务（127.0.0.1:${port}）仍有 ${queue.activeCount} 个排队或执行中的生图任务。`)
      console.error('请等待当前任务完成后再执行更新，避免中断生图（如确需强制继续，可加 --skip-queue-check）。')
      process.exitCode = 1
      return
    }
  }

  const beforeVersion = readPackageVersion()
  const beforeHead = runGit(['rev-parse', 'HEAD'])
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
  console.log(`[INFO] 当前分支: ${branch}，当前版本: v${beforeVersion} (${beforeHead.slice(0, 7)})`)

  if (dryRun) {
    console.log('[DRY-RUN] 检查通过：工作区干净且无运行中任务。未执行 git pull 或构建。')
    return
  }

  console.log('\n[1/3] 拉取最新代码 (git pull --ff-only)...')
  try {
    runInherited('git', ['pull', '--ff-only'])
  } catch {
    console.error('\n[STOP] git pull --ff-only 失败。请检查网络连接，或确认当前分支未与远端分叉。')
    process.exitCode = 1
    return
  }

  const afterHead = runGit(['rev-parse', 'HEAD'])
  if (afterHead === beforeHead) {
    console.log(`\n[OK] 当前已是最新版本 (v${beforeVersion})，无需重新构建。`)
    return
  }

  const diffOut = runGit(['diff', '--name-only', beforeHead, afterHead])
  const changedFiles = diffOut ? diffOut.split(/\r?\n/) : []
  const { needsInstall, skillChanged, envExampleChanged } = analyzeChangedFiles(changedFiles)

  if (needsInstall) {
    console.log('\n[2/3] 检测到依赖变化，运行 npm install...')
    runInherited('npm', ['install'])
  } else {
    console.log('\n[2/3] 依赖未变化，跳过 npm install。')
  }

  console.log('\n[3/3] 重新构建前端 (npm run build)...')
  runInherited('npm', ['run', 'build'])

  const afterVersion = readPackageVersion()
  console.log(`\n[OK] 更新完成：v${beforeVersion} -> v${afterVersion}`)

  if (skillChanged) {
    console.log('\n[提醒] 本次更新包含 Agent Skill (skills/banana-gallery) 改动：')
    console.log('  · 如果你是通过软链接 / Windows 目录联接安装的 Skill，已自动同步，无需操作。')
    console.log('  · 如果你是直接复制安装的 Skill，请将最新的 skills/banana-gallery 重新复制到你的 Agent Skills 目录。')
  }

  if (envExampleChanged) {
    console.log('\n[提醒] .env.example 有新增或说明调整，可按需对照检查你的 .env（已有配置保持兼容）。')
  }

  console.log('\n下一步：重启本地服务使新版本生效（例如 npm start 或 ./gallery.sh restart）。')
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntrypoint) {
  main().catch((err) => {
    console.error('[ERROR]', err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
