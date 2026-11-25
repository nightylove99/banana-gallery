import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyVertexEnvironment,
  resolveApiKey,
  resolveGenAIAuthStrategy,
} from '../server/genai-auth.ts'

test('未显式配置服务账号时只读取环境变量 API Key', () => {
  const strategy = resolveGenAIAuthStrategy({
    env: { GOOGLE_API_KEY: 'google-api-key' },
    fileExists: () => { throw new Error('不应检查未配置的文件路径') },
  })

  assert.deepEqual(strategy, { mode: 'apiKey', apiKey: 'google-api-key' })
})

test('显式指定 GOOGLE_APPLICATION_CREDENTIALS 时优先使用该文件', () => {
  const strategy = resolveGenAIAuthStrategy({
    env: {
      GOOGLE_APPLICATION_CREDENTIALS: '/secure/custom-sa.json',
      GOOGLE_CLOUD_PROJECT: 'custom-project',
      GOOGLE_CLOUD_LOCATION: 'us-central1',
    },
    fileExists: (targetPath) => targetPath === '/secure/custom-sa.json',
  })

  assert.equal(strategy.mode, 'vertex')
  assert.equal(strategy.credentialPath, '/secure/custom-sa.json')
  assert.equal(strategy.project, 'custom-project')
  assert.equal(strategy.location, 'us-central1')
})

test('未配置 GOOGLE_CLOUD_PROJECT 时使用服务账号自带的 project_id', () => {
  const strategy = resolveGenAIAuthStrategy({
    env: { GOOGLE_APPLICATION_CREDENTIALS: '/secure/service-account.json' },
    fileExists: () => true,
    readFile: () =>
      JSON.stringify({ type: 'service_account', project_id: 'new-sa-project' }),
  })

  assert.equal(strategy.mode, 'vertex')
  assert.equal(strategy.project, 'new-sa-project')
})

test('显式 GOOGLE_CLOUD_PROJECT 优先于服务账号内的 project_id', () => {
  const strategy = resolveGenAIAuthStrategy({
    env: { GOOGLE_APPLICATION_CREDENTIALS: '/secure/service-account.json', GOOGLE_CLOUD_PROJECT: 'explicit-project' },
    fileExists: () => true,
    readFile: () => JSON.stringify({ project_id: 'new-sa-project' }),
  })

  assert.equal(strategy.mode, 'vertex')
  assert.equal(strategy.project, 'explicit-project')
})

test('服务账号文件缺少 project_id 且未配置项目时，不使用内置项目', () => {
  assert.throws(() => resolveGenAIAuthStrategy({
    env: { GOOGLE_APPLICATION_CREDENTIALS: '/secure/service-account.json' },
    fileExists: () => true,
    readFile: () => JSON.stringify({ project_id: '   ' }),
  }), /GOOGLE_CLOUD_PROJECT/)
})

test('服务账号文件不存在时回退到环境变量 API Key', () => {
  const strategy = resolveGenAIAuthStrategy({
    env: { GOOGLE_APPLICATION_CREDENTIALS: '/secure/missing.json', GEMINI_API_KEY: 'fallback-api-key' },
    fileExists: () => false,
  })

  assert.deepEqual(strategy, { mode: 'apiKey', apiKey: 'fallback-api-key' })
})

test('显式指定 GEMINI_API_KEY 时优先使用环境变量', () => {
  const apiKey = resolveApiKey({
    env: {
      GEMINI_API_KEY: '  env-api-key  ',
    },
  })

  assert.equal(apiKey, 'env-api-key')
})

test('服务账号模式会同步补齐 Vertex AI 相关环境变量', () => {
  const env: NodeJS.ProcessEnv = { BANANA_GALLERY_SERVICE_ACCOUNT_PATH: '/secure/service-account.json' }
  const strategy = resolveGenAIAuthStrategy({
    env,
    fileExists: (targetPath) => targetPath === '/secure/service-account.json',
    readFile: () => JSON.stringify({ project_id: 'service-account-project' }),
  })

  assert.equal(strategy.mode, 'vertex')
  applyVertexEnvironment(strategy, env)

  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, strategy.credentialPath)
  assert.equal(env.GOOGLE_GENAI_USE_VERTEXAI, 'true')
  assert.equal(env.GOOGLE_CLOUD_PROJECT, 'service-account-project')
  assert.equal(env.GOOGLE_CLOUD_LOCATION, 'global')
})
