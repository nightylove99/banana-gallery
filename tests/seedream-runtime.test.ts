import assert from 'node:assert/strict'
import test from 'node:test'

import { findImageGenerationModelDefinition } from '../src/lib/image-generation-providers.ts'
import { resolveSeedreamOutputSize } from '../server/ai/seedream-image-provider.ts'
import { createSeedreamRuntimeProvider } from '../server/ai/seedream-runtime.ts'

test('Seedream key 缺失时不阻断启动，只在生成时报告不可用', async () => {
  const warnings: string[] = []
  const runtime = createSeedreamRuntimeProvider(
    {
      seedreamApiKey: undefined,
      seedreamImageModel: 'doubao-seedream-5-5-261028',
    },
    {
      readAgentSecret: () => {
        throw new Error('missing secret')
      },
      warn: (message) => warnings.push(message),
    },
  )

  assert.equal(runtime.available, false)
  assert.equal(runtime.strategy.mode, 'seedream')
  assert.equal(warnings.length, 1)
  assert.deepEqual(Object.keys(runtime.imageGenerationModels).sort(), [
    'doubao-seedream-5-5-261028',
  ])

  await assert.rejects(
    () =>
      runtime.imageGenerationProvider.generateImage({
        prompt: 'banana',
        referenceImages: [],
        aspectRatio: '1:1',
        imageSize: '1K',
      }),
    /VOLCENGINE_DOUBAO_API_KEY_NOT_CONFIGURED/,
  )
})

test('Seedream runtime 优先使用环境变量中的 key', () => {
  let secretReads = 0
  const runtime = createSeedreamRuntimeProvider(
    {
      seedreamApiKey: 'env-seedream-key',
      seedreamImageModel: 'custom-seedream-model',
    },
    {
      readAgentSecret: () => {
        secretReads += 1
        return 'agent-secret-key'
      },
    },
  )

  assert.equal(runtime.available, true)
  assert.deepEqual(runtime.strategy, {
    mode: 'seedream',
    model: 'doubao-seedream-5-5-261028',
  })
  assert.deepEqual(Object.keys(runtime.imageGenerationModels).sort(), [
    'doubao-seedream-5-5-261028',
  ])
  assert.equal(
    runtime.imageGenerationProvider,
    runtime.imageGenerationModels['doubao-seedream-5-5-261028'],
  )
  assert.equal(secretReads, 0)
})

test('Seedream 5.5 可选，仅支持 1K 和 2K', () => {
  const model = 'doubao-seedream-5-5-261028'
  const runtime = createSeedreamRuntimeProvider(
    { seedreamApiKey: 'test', seedreamImageModel: 'doubao-seedream-5-5-261028' },
    { readAgentSecret: () => '' },
  )

  assert.ok(runtime.imageGenerationModels[model])
  assert.equal(runtime.strategy.model, 'doubao-seedream-5-5-261028')
  const definition = findImageGenerationModelDefinition('seedream', model)
  assert.deepEqual(definition?.supportedResolutions, ['1K', '2K'])
  assert.equal(definition?.maxReferenceImages, 10)
  assert.throws(() => resolveSeedreamOutputSize('1.5K', '1:1', model), /1K 或 2K/)
})
