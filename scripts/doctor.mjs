#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findPython } from './python-runtime.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

function parseEnvFile(filePath) {
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

async function checkServerHealth(port) {
  const url = `http://127.0.0.1:${port}/api/v1/health`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return { running: false, detail: `HTTP ${res.status}`, url }
    const data = await res.json()
    return { running: true, data, url }
  } catch {
    return { running: false, url }
  }
}

async function main() {
  let hasBlocker = false
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
  const nodeOk = (nodeMajor === 22 && nodeMinor >= 13) || nodeMajor >= 24
  console.log('Banana Gallery 环境自检 (doctor)\n')
  console.log(`[${nodeOk ? 'OK' : 'WARN'}] Node.js: v${process.versions.node}${nodeOk ? '' : '（需要 Node 22.13+ 的 22.x，或 Node 24+）'}`)

  const python = findPython()
  console.log(`[${python ? 'OK' : 'INFO'}] Python CLI 运行时: ${python
    ? `${python.command} (${python.version})`
    : '未检测到 Python 3.10+（仅影响 Agent CLI；网页端无需 Python）'}`)

  const distIndex = path.join(ROOT, 'dist', 'index.html')
  const built = fs.existsSync(distIndex)
  console.log(`[${built ? 'OK' : 'WARN'}] 前端构建产物: ${built ? '已就绪 (dist/index.html)' : '尚未构建，请运行 npm run build'}`)
  if (!built) hasBlocker = true

  const envPath = path.join(ROOT, '.env')
  const envFileExists = fs.existsSync(envPath)
  const fileEnv = parseEnvFile(envPath)
  const merged = { ...fileEnv, ...process.env }

  console.log(`[${envFileExists ? 'OK' : 'INFO'}] 配置文件 (.env): ${envFileExists ? '已存在' : '未创建（Google / OpenAI 可在网页配置，无需 .env）'}`)

  const configuredProviders = []
  if (merged.ENABLE_DEMO_PROVIDER !== 'false') configuredProviders.push('demo (免费演示)')
  if (merged.GEMINI_API_KEY || merged.GOOGLE_API_KEY) configuredProviders.push('google (Gemini API Key)')
  if (merged.GOOGLE_APPLICATION_CREDENTIALS || merged.BANANA_GALLERY_SERVICE_ACCOUNT_PATH) {
    configuredProviders.push('google (Vertex AI 服务账号)')
  }
  if (merged.OPENAI_IMAGE_API_KEY) configuredProviders.push('openai-compatible')
  if (merged.VOLCENGINE_DOUBAO_API_KEY) configuredProviders.push('seedream (可选)')
  if (merged.DASHSCOPE_API_KEY) configuredProviders.push('qwen/kling (可选)')

  console.log(`[INFO] 环境配置中的渠道: ${configuredProviders.join(', ') || '无'}（网页配置请在设置中查看）`)

  const port = Number.parseInt(merged.PORT || '3333', 10) || 3333
  const health = await checkServerHealth(port)
  if (health.running) {
    console.log(`[OK] 本地服务已运行: ${health.url} (v${health.data.version}, authMode=${health.data.authMode})`)
  } else {
    console.log(`[INFO] 本地服务未运行 (${health.url})，运行 npm start 启动`)
  }

  console.log('\n下一步建议:')
  if (!built) {
    console.log('  1. 运行 npm run build 构建前端')
    console.log('  2. 运行 npm start 启动服务，然后打开 http://127.0.0.1:' + port)
  } else if (!health.running) {
    console.log('  1. 运行 npm start 启动服务，然后打开 http://127.0.0.1:' + port)
    console.log('  2. 可用免费演示渠道测试，或打开网页「设置 → 生图渠道与默认参数」')
  } else {
    console.log('  · 网页端: http://127.0.0.1:' + port)
    if (python) console.log(`  · Agent CLI 自检: ${python.command} scripts/banana-gallery.py models --available-only`)
  }

  process.exitCode = hasBlocker ? 1 : 0
}

main()
