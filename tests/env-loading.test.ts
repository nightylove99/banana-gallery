import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { assertAuthModeSupported, loadAppEnv } from '../server/config/env.js'
import { loadProjectEnvFile } from '../server/config/load-env.ts'

test('loadProjectEnvFile 会把项目根目录 .env 加载进目标 env', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-gallery-env-'))
  const envFile = path.join(projectRoot, '.env')
  const targetEnv: NodeJS.ProcessEnv = {}

  fs.writeFileSync(envFile, [
    'DATABASE_URL=postgresql://tester:secret@localhost:5432/gallery',
    'DATA_DRIVER=postgres',
    'AUTH_BASE_URL=http://localhost:3333',
  ].join('\n'))

  const loadedPath = loadProjectEnvFile({
    projectRoot,
    env: targetEnv,
  })

  assert.equal(loadedPath, envFile)
  assert.equal(targetEnv.DATABASE_URL, 'postgresql://tester:secret@localhost:5432/gallery')
  assert.equal(targetEnv.DATA_DRIVER, 'postgres')
  assert.equal(targetEnv.AUTH_BASE_URL, 'http://localhost:3333')

  fs.rmSync(projectRoot, { recursive: true, force: true })
})

test('loadProjectEnvFile 不会覆盖目标 env 中已有的显式变量', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-gallery-env-'))
  const envFile = path.join(projectRoot, '.env')
  const targetEnv: NodeJS.ProcessEnv = {
    DATABASE_URL: 'postgresql://shell:override@localhost:5432/gallery',
  }

  fs.writeFileSync(envFile, [
    'DATABASE_URL=postgresql://tester:secret@localhost:5432/gallery',
    'DATA_DRIVER=postgres',
  ].join('\n'))

  loadProjectEnvFile({
    projectRoot,
    env: targetEnv,
  })

  assert.equal(targetEnv.DATABASE_URL, 'postgresql://shell:override@localhost:5432/gallery')
  assert.equal(targetEnv.DATA_DRIVER, 'postgres')

  fs.rmSync(projectRoot, { recursive: true, force: true })
})

test('loadProjectEnvFile 可以显式加载 personal-remote 配置文件', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-gallery-env-'))
  const envFile = path.join(projectRoot, '.env.personal-remote')
  const targetEnv: NodeJS.ProcessEnv = {}
  fs.writeFileSync(envFile, [
    'AUTH_MODE=cloudflare_access',
    'REMOTE_ACCESS_PORT=3334',
  ].join('\n'))

  const loadedPath = loadProjectEnvFile({
    projectRoot,
    env: targetEnv,
    fileName: '.env.personal-remote',
  })

  assert.equal(loadedPath, envFile)
  assert.equal(targetEnv.AUTH_MODE, 'cloudflare_access')
  assert.equal(targetEnv.REMOTE_ACCESS_PORT, '3334')
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

test('loadProjectEnvFile 拒绝用 fileName 逃逸项目根目录', () => {
  assert.throws(
    () => loadProjectEnvFile({
      projectRoot: '/tmp/banana-gallery',
      fileName: '../outside.env',
    }),
    /环境文件名必须是项目根目录下的文件名/,
  )
})

test('loadAppEnv 默认启用 local 模式并解析跨域白名单', () => {
  const config = loadAppEnv({
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173, https://banana.example',
  })

  assert.equal(config.authMode, 'local')
  assert.deepEqual(config.corsAllowedOrigins, [
    'http://localhost:5173',
    'https://banana.example',
  ])
})

test('loadAppEnv：开发者诊断默认关闭，仅 SHOW_DEVELOPER_DIAGNOSTICS=true 时开启', () => {
  assert.equal(loadAppEnv({ NODE_ENV: 'production' }).showDeveloperDiagnostics, false)
  assert.equal(loadAppEnv({ NODE_ENV: 'development' }).showDeveloperDiagnostics, false)
  assert.equal(
    loadAppEnv({ NODE_ENV: 'production', SHOW_DEVELOPER_DIAGNOSTICS: 'true' }).showDeveloperDiagnostics,
    true,
  )
  assert.equal(
    loadAppEnv({ NODE_ENV: 'development', SHOW_DEVELOPER_DIAGNOSTICS: 'true' }).showDeveloperDiagnostics,
    true,
  )
  assert.equal(loadAppEnv({ SHOW_DEVELOPER_DIAGNOSTICS: 'false' }).showDeveloperDiagnostics, false)
})

test('loadAppEnv：图片生成默认使用 Google，旧 Poe 配置回退到 Google', () => {
  assert.equal(loadAppEnv({}).imageGenerationProvider, 'google')
  assert.equal(loadAppEnv({ IMAGE_GENERATION_PROVIDER: 'poe' }).imageGenerationProvider, 'google')
  assert.equal(loadAppEnv({ IMAGE_GENERATION_PROVIDER: 'google' }).imageGenerationProvider, 'google')
  assert.equal(
    loadAppEnv({ IMAGE_GENERATION_PROVIDER: 'seedream' }).imageGenerationProvider,
    'seedream',
  )
  assert.equal(
    loadAppEnv({}).seedreamImageModel,
    'doubao-seedream-5-5-261028',
  )
  assert.equal(
    loadAppEnv({ VOLCENGINE_DOUBAO_API_KEY: ' ark-key ' }).seedreamApiKey,
    'ark-key',
  )
  assert.equal(
    loadAppEnv({ IMAGE_GENERATION_PROVIDER: 'qwen' }).imageGenerationProvider,
    'qwen',
  )
  assert.equal(
    loadAppEnv({ IMAGE_GENERATION_PROVIDER: 'kling' }).imageGenerationProvider,
    'kling',
  )
  assert.equal(
    loadAppEnv({ IMAGE_GENERATION_PROVIDER: 'openai-compatible' }).imageGenerationProvider,
    'openai-compatible',
  )
  assert.equal(
    loadAppEnv({ IMAGE_GENERATION_PROVIDER: 'demo' }).imageGenerationProvider,
    'demo',
  )
  assert.equal(loadAppEnv({}).qwenImageModel, 'qwen-image-3.0-pro')
  assert.equal(
    loadAppEnv({}).klingImageModel,
    'kling/kling-v3-omni-image-generation',
  )
  assert.equal(
    loadAppEnv({ DASHSCOPE_API_KEY: ' dashscope-key ' }).dashscopeApiKey,
    'dashscope-key',
  )

})

test('Seedream 旧模型配置统一迁移到 5.5', () => {
  for (const model of ['doubao-seedream-5-0-flash-260915', 'doubao-seedream-5-0-260128', 'doubao-seedream-5-0-lite-260128']) {
    assert.equal(loadAppEnv({ SEEDREAM_IMAGE_MODEL: model }).seedreamImageModel, 'doubao-seedream-5-5-261028')
  }
})

test('production 允许回环地址上的本机免登模式', () => {
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    for (const BIND_HOST of ['127.0.0.1', '::1', 'localhost']) {
      assert.doesNotThrow(() => assertAuthModeSupported(loadAppEnv({ AUTH_MODE: 'local', BIND_HOST })))
    }
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
})

test('本机路径导入默认关闭，只有本机模式显式设为 true 才开启', () => {
  assert.equal(loadAppEnv({}).allowServerSideImport, false)
  assert.equal(loadAppEnv({ ALLOW_SERVER_SIDE_IMPORT: 'true' }).allowServerSideImport, true)
  assert.equal(loadAppEnv({ AUTH_MODE: 'cloudflare_access', ALLOW_SERVER_SIDE_IMPORT: 'true' }).allowServerSideImport, false)
})

test('loadAppEnv 拒绝退役的认证模式', () => {
  assert.throws(() => loadAppEnv({ AUTH_MODE: 'magic_link' }), /不支持的驱动配置/)
})

test('loadAppEnv 会解析 Cloudflare Access 单人远程模式配置', () => {
  const config = loadAppEnv({
    AUTH_MODE: 'cloudflare_access',
    CF_ACCESS_TEAM_DOMAIN: 'banana.cloudflareaccess.com',
    CF_ACCESS_AUDIENCE: 'audience-id',
    AUTH_ALLOWED_EMAILS: ' owner@example.com,backup@example.com ',
    REMOTE_ACCESS_PORT: '3334',
  })

  assert.equal(config.authMode, 'cloudflare_access')
  assert.equal(config.cloudflareAccessTeamDomain, 'banana.cloudflareaccess.com')
  assert.equal(config.cloudflareAccessAudience, 'audience-id')
  assert.deepEqual(config.authAllowedEmails, ['owner@example.com', 'backup@example.com'])
  assert.equal(config.remoteAccessPort, 3334)
  assert.equal(config.bindHost, '127.0.0.1')
  assert.equal(config.allowServerSideImport, false)
})

test('assertAuthModeSupported 会拒绝缺少验证参数的 Cloudflare Access 模式', () => {
  const config = loadAppEnv({
    AUTH_MODE: 'cloudflare_access',
  })

  assert.throws(
    () => assertAuthModeSupported(config),
    /CF_ACCESS_TEAM_DOMAIN、CF_ACCESS_AUDIENCE 和 AUTH_ALLOWED_EMAILS/,
  )
})
