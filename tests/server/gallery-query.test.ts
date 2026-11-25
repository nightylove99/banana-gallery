import { expect, it } from 'vitest'
import type { GalleryImage } from '../../src/types'
const image = (id: string, extra: Partial<GalleryImage> = {}): GalleryImage => ({ id, filename: `${id}.png`, prompt: 'LONG English prompt 夕阳', referenceImages: [], tags: ['风景', 'gemini-web'], assetType: 'recipe', createdAt: '2026-09-11T00:00:00Z', favorited: false, width: 1, height: 1, ...extra })
it('searches complete prompt and common or legacy title/notes with case insensitive AND terms', async () => {
  const { filterGalleryImages } = await import('../../src/lib/gallery-query')
  const images = [image('a', { generation: { aspectRatio: '1:1', title: '海边', notes: '柔和' } }), image('b', { ...{ title: '城市', notes: '夜晚' }, prompt: 'urban english' })]
  expect(filterGalleryImages(images, { q: '海边 ENGLISH 柔和 夕阳' }).map(image => image.id)).toEqual(['a'])
  expect(filterGalleryImages(images, { q: '夜晚 english' }).map(image => image.id)).toEqual(['b'])
  expect(filterGalleryImages(images, { q: '不存在' })).toEqual([])
})
it('combines tags, recipe favorites, model/source/date and stable pin sorting', async () => {
  const { filterGalleryImages } = await import('../../src/lib/gallery-query')
  const images = [image('b', { favorited: true, sourceFile: 'gemini-web' }), image('a', { favorited: true, sourceFile: 'gemini-web' }), image('p', { ...{ pinned: true }, createdAt: '2025-01-01' }), image('trash', { deletedAt: '2026-09-11' })]
  expect(filterGalleryImages(images, {}).map(image => image.id)).toEqual(['p', 'a', 'b'])
  expect(filterGalleryImages(images, { favorites: true, assetType: 'recipe', source: 'gemini-web', model: 'unknown', dateFrom: '2026-01-01', tags: ['风景', 'gemini-web'] }).map(image => image.id)).toEqual(['a', 'b'])
  expect(filterGalleryImages(images, { tags: ['风景', '人物'] })).toEqual([])
})

it('can sort oldest or recently updated without promoting pinned rows', async () => {
 const { filterGalleryImages } = await import('../../src/lib/gallery-query')
 const rows = [image('p', {pinned:true}), image('a', {createdAt:'2025-01-01', updatedAt:'2027-01-01'})]
 for (const sort of ['oldest', 'updated'] as const) {
   expect(filterGalleryImages(rows, {pinFirst:false, sort}).map(row=>row.id)).toEqual(['a','p'])
 }
})
