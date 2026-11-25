import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRecipeFromImage,
  galleryEntryFromGenerateSave,
  inferAssetTypeFromLegacy,
  normalizeGalleryData,
  normalizeGalleryImage,
} from '../server/gallery-normalize.ts'

test('旧导入记录：有 sourceFile 且非 generated → recipe', () => {
  const { image, migrated } = normalizeGalleryImage({
    id: 'a',
    filename: 'x.png',
    prompt: 'p',
    referenceImages: [],
    tags: [],
    favorited: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    width: 1,
    height: 1,
    sourceFile: 'note.md',
  })
  assert.equal(image.assetType, 'recipe')
  assert.equal(migrated, true)
  assert.equal(inferAssetTypeFromLegacy('note.md'), 'recipe')
})

test('旧 generated 记录：sourceFile === generated → work', () => {
  const { image, migrated } = normalizeGalleryImage({
    id: 'b',
    filename: 'g.jpg',
    prompt: 'gen',
    referenceImages: [],
    tags: [],
    favorited: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    width: 2,
    height: 2,
    sourceFile: 'generated',
  })
  assert.equal(image.assetType, 'work')
  assert.equal(migrated, true)
  assert.equal(inferAssetTypeFromLegacy('generated'), 'work')
})

test('无 sourceFile 的旧条目 → work', () => {
  const { image, migrated } = normalizeGalleryImage({
    id: 'c',
    filename: 'u.jpg',
    prompt: 'up',
    referenceImages: [],
    tags: [],
    favorited: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    width: 3,
    height: 3,
  })
  assert.equal(image.assetType, 'work')
  assert.equal(migrated, true)
  assert.equal(inferAssetTypeFromLegacy(undefined), 'work')
})

test('新写入（generate/save）含 assetType 与 generation', () => {
  const entry = galleryEntryFromGenerateSave({
    filename: 'gen_foo.jpg',
    prompt: 'hello',
    width: 1024,
    height: 768,
    referenceFilenames: ['ref_a.png'],
    assetType: 'work',
    generation: {
      aspectRatio: '16:9',
      imageSize: '2K',
      provider: 'seedream',
      model: 'doubao-seedream-5-0-pro-260628',
      outputFormat: 'jpeg',
      title: 't',
      notes: 'n',
    },
  })
  assert.equal(entry.assetType, 'work')
  assert.equal(entry.sourceFile, 'generated')
  assert.deepEqual(entry.generation, {
    aspectRatio: '16:9',
    imageSize: '2K',
    provider: 'seedream',
    model: 'doubao-seedream-5-0-pro-260628',
    outputFormat: 'jpeg',
    title: 't',
    notes: 'n',
  })
  assert.equal(entry.filename, 'gen_foo.jpg')
  assert.deepEqual(entry.referenceImages, ['ref_a.png'])
})

test('新写入（generate/save）允许 generation 不含输出格式', () => {
  const entry = galleryEntryFromGenerateSave({
    filename: 'gen_foo.png',
    prompt: 'hello',
    width: 1024,
    height: 768,
    referenceFilenames: [],
    assetType: 'work',
    generation: {
      aspectRatio: '16:9',
      imageSize: '2K',
    },
  })

  assert.deepEqual(entry.generation, {
    aspectRatio: '16:9',
    imageSize: '2K',
  })
})

test('新写入（generate/save）保留 GPT Image 2 的质量参数', () => {
  const entry = galleryEntryFromGenerateSave({
    filename: 'gen_gpt.png',
    prompt: 'hello',
    width: 1536,
    height: 1024,
    referenceFilenames: [],
    assetType: 'work',
    generation: {
      aspectRatio: '3:2',
      provider: 'poe',
      model: 'gpt-image-2',
      quality: 'high',
    },
  })

  assert.deepEqual(entry.generation, {
    aspectRatio: '3:2',
    provider: 'poe',
    model: 'gpt-image-2',
    quality: 'high',
  })
})

test('createRecipeFromImage：会把作品复制成配方记录', () => {
  const recipe = createRecipeFromImage({
    id: 'work-1',
    filename: 'work.jpg',
    prompt: 'work prompt',
    referenceImages: ['ref-1.jpg'],
    tags: ['测试'],
    favorited: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    width: 1024,
    height: 1024,
    assetType: 'work',
    generation: {
      aspectRatio: '1:1',
      imageSize: '2K',
      outputFormat: 'jpeg',
      provider: 'poe',
      model: 'nano-banana-2',
    },
  })

  assert.notEqual(recipe.id, 'work-1')
  assert.equal(recipe.assetType, 'recipe')
  assert.equal(recipe.favorited, false)
  assert.equal(recipe.filename, 'work.jpg')
  assert.deepEqual(recipe.referenceImages, ['ref-1.jpg'])
  assert.deepEqual(recipe.generation, {
    aspectRatio: '1:1',
    imageSize: '2K',
    outputFormat: 'jpeg',
    provider: 'poe',
    model: 'nano-banana-2',
  })
})

test('normalizeGalleryData：已带 assetType 的条目不重复迁移', () => {
  const { images, changed, writeSafe } = normalizeGalleryData({
    images: [
      {
        id: 'x',
        filename: 'f.jpg',
        prompt: 'p',
        referenceImages: [],
        tags: [],
        favorited: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        width: 1,
        height: 1,
        assetType: 'recipe',
        sourceFile: 'generated',
      },
    ],
  })
  assert.equal(changed, false)
  assert.equal(writeSafe, true)
  assert.equal(images[0]!.assetType, 'recipe')
})

test('normalizeGalleryData：根结构非法时不会标记为可安全写回', () => {
  const result = normalizeGalleryData({ nope: [] })
  assert.deepEqual(result.images, [])
  assert.equal(result.changed, false)
  assert.equal(result.writeSafe, false)
})

test('normalizeGalleryData：存在损坏条目时不会自动写回', () => {
  const result = normalizeGalleryData({
    images: [
      {
        id: 'ok',
        filename: 'ok.jpg',
        prompt: 'ok',
        referenceImages: [],
        tags: [],
        favorited: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        width: 1,
        height: 1,
      },
      {
        filename: 'broken.jpg',
      },
    ],
  })
  assert.equal(result.images.length, 1)
  assert.equal(result.images[0]!.id, 'ok')
  assert.equal(result.changed, true)
  assert.equal(result.writeSafe, false)
})
