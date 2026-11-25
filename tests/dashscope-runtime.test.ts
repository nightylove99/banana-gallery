import assert from 'node:assert/strict'
import test from 'node:test'

import { createDashscopeRuntimeProviders } from '../server/ai/dashscope-runtime.ts'

const baseEnv = {
  dashscopeApiKey: undefined,
  qwenImageModel: 'qwen-image-3.0-pro',
  qwenImageEndpoint: 'https://example.com/qwen',
  klingImageModel: 'kling/kling-v3-omni-image-generation',
  klingImageEndpoint: 'https://example.com/kling',
  dashscopeTaskEndpoint: 'https://example.com/tasks',
  dashscopeUploadEndpoint: 'https://example.com/uploads',
}

test('DashScope key 缺失时 Qwen 与 Kling 都降级但不阻止启动', async () => {
  const runtime = createDashscopeRuntimeProviders(baseEnv, {
    readAgentSecret: () => {
      throw new Error('missing')
    },
  })
  assert.equal(runtime.available, false)
  await assert.rejects(
    runtime.qwenProvider.generateImage({
      prompt: 'test',
      referenceImages: [],
      aspectRatio: '1:1',
      imageSize: '1K',
    }),
    /DASHSCOPE_API_KEY_NOT_CONFIGURED/,
  )
})

test('DashScope runtime 可从 agent secret 读取共享 key', () => {
  const runtime = createDashscopeRuntimeProviders(baseEnv, {
    readAgentSecret: (key) => {
      assert.equal(key, 'DASHSCOPE_API_KEY')
      return ' shared-key '
    },
  })
  assert.equal(runtime.available, true)
  assert.deepEqual(runtime.qwenStrategy, {
    mode: 'qwen',
    model: 'qwen-image-3.0-pro',
  })
  assert.deepEqual(runtime.klingStrategy, {
    mode: 'kling',
    model: 'kling/kling-v3-omni-image-generation',
  })
})

test('Qwen 渠道为注册表里模型与环境变量模型各建 provider，并按模型限制参考图', async () => {
  const runtime = createDashscopeRuntimeProviders(
    baseEnv,
    { readAgentSecret: () => 'shared-key' },
  )
  assert.deepEqual(Object.keys(runtime.qwenProviders), [
    'qwen-image-3.0-pro',
  ])
  assert.equal(runtime.qwenProvider, runtime.qwenProviders['qwen-image-3.0-pro'])

  const references = (count: number) => Array.from({ length: count }, () => ({
    mimeType: 'image/png',
    data: Buffer.from([1]),
  }))
  // 用无效分辨率把"参考图数量检查"挡在网络请求之前：超限的模型先报上限，未超限的模型报分辨率。
  await assert.rejects(
    runtime.qwenProviders['qwen-image-3.0-pro'].generateImage({
      prompt: 'test',
      referenceImages: references(4),
      aspectRatio: '1:1',
      imageSize: '4K',
    }),
    /最多支持 3 张参考图/,
  )
  await assert.rejects(
    runtime.qwenProviders['qwen-image-3.0-pro'].generateImage({
      prompt: 'test',
      referenceImages: references(3),
      aspectRatio: '1:1',
      imageSize: '4K',
    }),
    /仅支持 1K 或 2K/,
  )
})

test('DashScope key 缺失时每个 Qwen 模型都降级为不可用', async () => {
  const runtime = createDashscopeRuntimeProviders(baseEnv, {
    readAgentSecret: () => {
      throw new Error('missing')
    },
  })
  assert.equal(runtime.available, false)
  assert.deepEqual(Object.keys(runtime.qwenProviders), [
    'qwen-image-3.0-pro',
  ])
  await assert.rejects(
    runtime.qwenProviders['qwen-image-3.0-pro'].generateImage({
      prompt: 'test',
      referenceImages: [],
      aspectRatio: '1:1',
      imageSize: '1K',
    }),
    /DASHSCOPE_API_KEY_NOT_CONFIGURED/,
  )
})
