import assert from 'node:assert/strict'
import test from 'node:test'

import { generateImage } from '../src/api.ts'
import { buildGeneratePageState, buildGenerationSnapshot } from '../src/lib/generate-state.ts'
import type { GalleryImage } from '../src/types.ts'

test('buildGenerationSnapshot：保留当前生成参数', () => {
  const snapshot = buildGenerationSnapshot({
    aspectRatio: '16:9',
    imageSize: '2K',
    provider: 'seedream',
    model: 'doubao-seedream-5-5-261028',
  })

  assert.deepEqual(snapshot, {
    aspectRatio: '16:9',
    imageSize: '2K',
    provider: 'seedream',
    model: 'doubao-seedream-5-5-261028',
  })
})

test('buildGeneratePageState：优先使用已保存的 generation 快照', () => {
  const image: GalleryImage = {
    id: 'recipe-1',
    filename: 'recipe.jpg',
    prompt: '配方提示词',
    referenceImages: ['ref-1.jpg'],
    tags: [],
    favorited: false,
    createdAt: '2026-03-20T00:00:00.000Z',
    width: 1536,
    height: 1024,
    assetType: 'recipe',
    generation: {
      aspectRatio: '4:3',
      imageSize: '4K',
      outputFormat: 'png',
      provider: 'poe',
      model: 'nano-banana-2',
    },
  }

  assert.deepEqual(buildGeneratePageState(image), {
    sourceAssetId: 'recipe-1',
    prompt: '配方提示词',
    referenceImages: ['ref-1.jpg'],
    aspectRatio: '4:3',
    imageSize: '4K',
    provider: 'poe',
    model: 'nano-banana-2',
    outputFormat: 'png',
  })
})

test('buildGeneratePageState：旧作品缺少 generation 时回退到尺寸推断', () => {
  const image: GalleryImage = {
    id: 'work-1',
    filename: 'work.jpg',
    prompt: '作品提示词',
    referenceImages: [],
    tags: [],
    favorited: false,
    createdAt: '2026-03-20T00:00:00.000Z',
    width: 1024,
    height: 1024,
    assetType: 'work',
  }

  assert.deepEqual(buildGeneratePageState(image), {
    sourceAssetId: 'work-1',
    prompt: '作品提示词',
    referenceImages: [],
    aspectRatio: '1:1',
    imageSize: '2K',
  })
})

test('generateImage：请求体不发送输出格式字段', async (t) => {
  const originalFetch = globalThis.fetch
  let requestBody: Record<string, unknown> | null = null

  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({
      filename: 'gen_test.png',
      width: 1024,
      height: 1024,
      prompt: 'banana',
    })
  }) as typeof fetch

  await generateImage({
    prompt: 'banana',
    referenceFilenames: ['ref.png'],
    aspectRatio: '1:1',
    imageSize: '2K',
    provider: 'seedream',
    model: 'doubao-seedream-5-5-261028',
  })

  assert.deepEqual(requestBody, {
    prompt: 'banana',
    referenceFilenames: ['ref.png'],
    aspectRatio: '1:1',
    imageSize: '2K',
    provider: 'seedream',
    model: 'doubao-seedream-5-5-261028',
  })
})

test('buildGenerationSnapshot：质量模型不要求保存分辨率', () => {
  const snapshot = buildGenerationSnapshot({
    aspectRatio: '3:2',
    provider: 'openai-compatible',
    model: 'gpt-image-1',
    quality: 'high',
  })

  assert.deepEqual(snapshot, {
    aspectRatio: '3:2',
    provider: 'openai-compatible',
    model: 'gpt-image-1',
    quality: 'high',
  })
})
