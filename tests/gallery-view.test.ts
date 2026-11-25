import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterImagesByView,
  getFavoriteCountForWorks,
  getHeaderTitle,
  getTagsForAssetType,
} from '../src/lib/gallery-view.ts'
import type { GalleryImage } from '../src/types.ts'

const demoImages: GalleryImage[] = [
  {
    id: 'work-a',
    filename: 'work-a.jpg',
    prompt: '作品 A',
    referenceImages: [],
    tags: ['城市', '夜景'],
    favorited: true,
    createdAt: '2026-03-20T00:00:00.000Z',
    width: 1024,
    height: 1024,
    assetType: 'work',
  },
  {
    id: 'work-b',
    filename: 'work-b.jpg',
    prompt: '作品 B',
    referenceImages: [],
    tags: ['人像'],
    favorited: false,
    createdAt: '2026-03-20T00:00:00.000Z',
    width: 1024,
    height: 1024,
    assetType: 'work',
  },
  {
    id: 'recipe-a',
    filename: 'recipe-a.jpg',
    prompt: '配方 A',
    referenceImages: [],
    tags: ['城市', '电影感'],
    favorited: true,
    createdAt: '2026-03-20T00:00:00.000Z',
    width: 1024,
    height: 1024,
    assetType: 'recipe',
  },
]

test('filterImagesByView：作品视图只返回作品', () => {
  const result = filterImagesByView(demoImages, 'work', 'all')
  assert.deepEqual(result.map((image) => image.id), ['work-a', 'work-b'])
})

test('filterImagesByView：作品收藏视图只返回已收藏作品', () => {
  const result = filterImagesByView(demoImages, 'work', 'favorites')
  assert.deepEqual(result.map((image) => image.id), ['work-a'])
})

test('filterImagesByView：配方视图忽略 favorites 只保留配方', () => {
  const result = filterImagesByView(demoImages, 'recipe', 'favorites')
  assert.deepEqual(result.map((image) => image.id), ['recipe-a'])
})

test('filterImagesByView：标签筛选按当前资产类型生效', () => {
  const result = filterImagesByView(demoImages, 'recipe', 'tag:城市')
  assert.deepEqual(result.map((image) => image.id), ['recipe-a'])
})

test('getTagsForAssetType：只返回当前资产类型标签并去重排序', () => {
  assert.deepEqual(getTagsForAssetType(demoImages, 'work'), ['城市', '人像', '夜景'])
  assert.deepEqual(getTagsForAssetType(demoImages, 'recipe'), ['城市', '电影感'])
})

test('getFavoriteCountForWorks：只统计作品收藏数', () => {
  assert.equal(getFavoriteCountForWorks(demoImages), 1)
})

test('getHeaderTitle：返回分区标题', () => {
  assert.equal(getHeaderTitle('work', 'all'), '作品库')
  assert.equal(getHeaderTitle('work', 'favorites'), '喜欢的作品')
  assert.equal(getHeaderTitle('recipe', 'all'), '配方库')
  assert.equal(getHeaderTitle('recipe', 'tag:城市'), '# 城市')
})
