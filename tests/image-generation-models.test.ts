import assert from 'node:assert/strict'
import test from 'node:test'

import {
  IMAGE_GENERATION_MODEL_DEFINITIONS,
  IMAGE_GENERATION_PROVIDER_DEFINITIONS,
  findImageGenerationModelDefinition,
  formatImageGenerationSource,
  formatImageGenerationProvider,
  imageGenerationModelKey,
  normalizeGenerationPreferences,
} from '../src/lib/image-generation-providers.ts'

test('统一模型注册表包含八个默认产品名称与真实模型 ID', () => {
  assert.deepEqual(
    IMAGE_GENERATION_MODEL_DEFINITIONS.map(({ provider, model, label }) => ({
      provider,
      model,
      label,
    })),
    [
      { provider: 'krea-local', model: 'krea-2-turbo', label: '本地 Krea 2 Turbo' },
      { provider: 'qwen-local', model: 'qwen-image-2.1-UC-Q8_0', label: '本地 Qwen Image 2.1' },
      {
        provider: 'seedream',
        model: 'doubao-seedream-5-5-261028',
        label: 'Seedream · 5.5',
      },
      {
        provider: 'google',
        model: 'gemini-nano-banana-2.1',
        label: 'Google · Nano Banana 2.1',
      },
      {
        provider: 'qwen',
        model: 'qwen-image-3.0-pro',
        label: 'Qwen · Image 3.0 Pro',
      },
      {
        provider: 'kling',
        model: 'kling/kling-v3-omni-image-generation',
        label: 'Kling · V3 Omni Image',
      },
      { provider: 'openai-compatible', model: 'gpt-image-1', label: 'OpenAI 兼容 · gpt-image-1' },
      { provider: 'demo', model: 'banana-demo-v1', label: '免费演示 · 本地占位图' },
    ],
  )
})

test('现有渠道模型声明当前支持的生成参数', () => {
  assert.equal(
    findImageGenerationModelDefinition('seedream', 'doubao-seedream-5-5-261028')
      ?.defaultAspectRatio,
    '1:1',
  )
  const seedream = findImageGenerationModelDefinition(
    'seedream',
    'doubao-seedream-5-5-261028',
  )
  assert.ok(seedream)
  assert.equal(seedream.maxReferenceImages, 10)
  assert.deepEqual(seedream.supportedResolutions, ['1K', '2K'])
  assert.deepEqual(seedream.supportedAspectRatios, [
    '1:1',
    '2:3',
    '3:2',
    '3:4',
    '4:3',
    '4:5',
    '5:4',
    '9:16',
    '16:9',
    '21:9',
  ])
  const qwen30Pro = findImageGenerationModelDefinition('qwen', 'qwen-image-3.0-pro')
  assert.ok(qwen30Pro)
  assert.equal(qwen30Pro.label, 'Qwen · Image 3.0 Pro')
  assert.equal(qwen30Pro.parameterMode, 'resolution')
  assert.equal(qwen30Pro.maxReferenceImages, 3)
  assert.deepEqual(qwen30Pro.supportedResolutions, ['1K', '2K'])
  assert.deepEqual(qwen30Pro.supportedAspectRatios, [
    '1:1',
    '2:3',
    '3:2',
    '3:4',
    '4:3',
    '4:5',
    '5:4',
    '9:16',
    '16:9',
    '21:9',
  ])
  assert.deepEqual(
    IMAGE_GENERATION_MODEL_DEFINITIONS
      .filter((definition) => definition.provider === 'qwen')
      .map((definition) => definition.model),
    ['qwen-image-3.0-pro'],
  )
  assert.deepEqual(
    findImageGenerationModelDefinition(
      'kling',
      'kling/kling-v3-omni-image-generation',
    )?.supportedAspectRatios,
    ['1:1', '16:9', '9:16'],
  )

  const openai = findImageGenerationModelDefinition('openai-compatible', 'gpt-image-1')
  assert.equal(openai?.parameterMode, 'quality')
  assert.equal(openai?.defaultAspectRatio, 'auto')
  assert.deepEqual(openai?.supportedQualities, ['low', 'medium', 'high'])
  assert.equal(IMAGE_GENERATION_PROVIDER_DEFINITIONS['openai-compatible'].maxReferenceImages, 16)
  assert.deepEqual(openai?.supportedAspectRatios, ['auto', '1:1', '2:3', '3:2'])

  const demo = findImageGenerationModelDefinition('demo', 'banana-demo-v1')
  assert.equal(demo?.maxReferenceImages, 0)
  assert.deepEqual(demo?.supportedResolutions, ['1K'])
})

test('模型键和历史来源文案保持稳定', () => {
  assert.equal(imageGenerationModelKey('seedream', 'doubao-seedream-5-0-260128'), 'seedream:doubao-seedream-5-5-261028')
  assert.equal(formatImageGenerationSource('seedream', 'doubao-seedream-5-0-260128'), 'Seedream · 5.0 Lite')
  assert.equal(imageGenerationModelKey('google', 'nano-banana-2'), 'google:nano-banana-2')
  assert.equal(formatImageGenerationProvider('poe'), 'Poe')
  assert.equal(formatImageGenerationSource('poe', 'gpt-image-2'), 'Poe · GPT Image 2')
  assert.equal(formatImageGenerationSource('poe', 'nano-banana-2.1'), 'Poe · Nano Banana 2.1')
  assert.equal(formatImageGenerationSource('poe', 'gpt-image-2.6-sunburst'), 'Poe · GPT Image 2.6 Sunburst')
  assert.equal(formatImageGenerationSource('poe', 'nano-banana-2'), 'Poe · Nano Banana 2')
  assert.equal(
    formatImageGenerationSource('google', 'gemini-nano-banana-2.1'),
    'Google · Nano Banana 2.1',
  )
  assert.equal(formatImageGenerationSource('poe'), 'Poe · 模型未记录')
  assert.equal(
    formatImageGenerationSource('poe', 'custom-image-model'),
    'Poe · custom-image-model',
  )
  assert.equal(
    formatImageGenerationSource('retired-provider', 'archived-model'),
    '已下线渠道 · archived-model',
  )
})

test('弃用的 Google Nano Banana 2 会被迁移到 2.1，且不丢分辨率与收藏', () => {
  assert.equal(
    imageGenerationModelKey('google', 'gemini-3.1-flash-image'),
    'google:gemini-nano-banana-2.1',
  )
  assert.equal(
    formatImageGenerationSource('google', 'gemini-3.1-flash-image'),
    'Google · Nano Banana 2',
  )

  const migrated = normalizeGenerationPreferences({
    version: 3,
    defaultGeneration: {
      provider: 'google',
      model: 'gemini-3.1-flash-image',
      aspectRatio: '4:3',
      imageSize: '4K',
    },
    favoriteModels: ['google:gemini-3.1-flash-image'],
  })

  assert.equal(migrated.defaultGeneration?.model, 'gemini-nano-banana-2.1')
  assert.equal(migrated.defaultGeneration?.imageSize, '4K')
  assert.deepEqual(migrated.favoriteModels, ['google:gemini-nano-banana-2.1'])
})

test('Seedream Lite 迁往 5.5仍会把不兼容的分辨率收敛到 2K', () => {
  const migrated = normalizeGenerationPreferences({
    version: 1,
    defaultGeneration: {
      provider: 'seedream',
      model: 'doubao-seedream-5-0-260128',
      aspectRatio: '1:1',
      imageSize: '4K',
    },
    favoriteModels: [],
  })

  assert.equal(migrated.defaultGeneration?.model, 'doubao-seedream-5-5-261028')
  assert.equal(migrated.defaultGeneration?.imageSize, '2K')
})

test('迁移 5.0 Flash 和 1.5K 偏好，合并收藏并保留历史标签', () => {
  const legacy = 'doubao-seedream-5-0-flash-260915'
  const current = 'doubao-seedream-5-5-261028'
  const preferences = normalizeGenerationPreferences({
    version: 1,
    defaultGeneration: { provider: 'seedream', model: legacy, aspectRatio: '2:3', imageSize: '1.5K' },
    favoriteModels: [`seedream:${legacy}`, `seedream:${current}`],
  })
  assert.deepEqual(preferences.defaultGeneration, { provider: 'seedream', model: current, aspectRatio: '2:3', imageSize: '1K' })
  assert.deepEqual(preferences.favoriteModels, [`seedream:${current}`])
  assert.equal(formatImageGenerationSource('seedream', legacy), 'Seedream · 5.0 Flash')
})

test('旧 Poe 默认偏好回退到 Google，收藏仅保留现存模型', () => {
  const migrated = normalizeGenerationPreferences({
    version: 3,
    defaultGeneration: { provider: 'poe', model: 'gpt-image-2', aspectRatio: 'auto', quality: 'medium' },
    favoriteModels: ['poe:gpt-image-2', 'google:gemini-nano-banana-2.1'],
  })
  assert.deepEqual(migrated.defaultGeneration, {
    provider: 'google', model: 'gemini-nano-banana-2.1', aspectRatio: '1:1', imageSize: '2K',
  })
  assert.deepEqual(migrated.favoriteModels, ['google:gemini-nano-banana-2.1'])
})
