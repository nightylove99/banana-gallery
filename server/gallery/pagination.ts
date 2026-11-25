import { createHash } from 'node:crypto'
import type { GalleryImage } from '../../src/types'
import { filterGalleryImages, galleryQueryFromParams, galleryQueryToParams, type GalleryQuery } from '../../src/lib/gallery-query'

export function galleryStatistics(images: readonly GalleryImage[]) {
  const tags: Record<string, number> = Object.create(null)
  const stats = { total: 0, works: 0, recipes: 0, favorites: 0, favoriteWorks: 0, favoriteRecipes: 0, tags }
  for (const image of images) {
    if (image.deletedAt) continue
    stats.total++
    if (image.assetType === 'work') stats.works++
    if (image.assetType === 'recipe') stats.recipes++
    if (image.favorited) {
      stats.favorites++
      if (image.assetType === 'work') stats.favoriteWorks++
      if (image.assetType === 'recipe') stats.favoriteRecipes++
    }
    for (const tag of new Set(image.tags)) tags[tag] = (tags[tag] || 0) + 1
  }
  return stats
}

function preparePage(images: readonly GalleryImage[], query: GalleryQuery, queryKey: string) {
  const filtered = filterGalleryImages(images, query)
  const hash = createHash('sha256').update(JSON.stringify(images)).update(queryKey)
  let expiresAt = Infinity
  if (query.inbox === 'recent') {
    // A recent item can age out without an index write.
    for (const image of filtered) {
      const expires = Date.parse(image.capturedAt || image.createdAt) + 7 * 86_400_000 + 1
      if (Number.isFinite(expires)) expiresAt = Math.min(expiresAt, expires)
    }
    hash.update(JSON.stringify(filtered.map(image => image.id)))
  }
  return { filtered, revision: hash.digest('hex'), stats: galleryStatistics(filtered), expiresAt }
}

function pageLimit(params: URLSearchParams) {
  const limit = Number(params.get('limit') || 60)
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('每页数量必须为 1–200')
  return limit
}

function slicePage({ filtered, revision, stats }: ReturnType<typeof preparePage>, limit: number, cursor: string | null) {
  let offset = 0
  if (cursor) {
    let decoded: { revision?: string; offset?: number } | null
    try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()) }
    catch { throw new Error('分页游标无效') }
    if (!decoded) throw new Error('分页游标无效')
    if (decoded.revision !== revision) throw new Error('图库已变化，请重新加载')
    if (!Number.isInteger(decoded.offset) || decoded.offset! < 0 || decoded.offset! > filtered.length) throw new Error('分页游标无效')
    offset = decoded.offset!
  }
  const end = Math.min(offset + limit, filtered.length)
  return {
    items: filtered.slice(offset, end), total: filtered.length, stats, revision,
    nextCursor: end < filtered.length ? Buffer.from(JSON.stringify({ revision, offset: end })).toString('base64url') : null,
  }
}

export function createGalleryPage(images: readonly GalleryImage[], params: URLSearchParams) {
  const limit = pageLimit(params)
  const query = galleryQueryFromParams(params)
  return slicePage(preparePage(images, query, galleryQueryToParams(query).toString()), limit, params.get('cursor'))
}

export class GalleryPaginationCache {
  private revision?: string
  private queries = new Map<string, ReturnType<typeof preparePage>>()

  page(revision: string, scopeKey: string, images: () => readonly GalleryImage[], params: URLSearchParams) {
    const limit = pageLimit(params)
    if (revision !== this.revision) {
      this.queries.clear()
      this.revision = revision
    }
    const query = galleryQueryFromParams(params)
    const queryKey = galleryQueryToParams(query).toString()
    const cacheKey = JSON.stringify([scopeKey, queryKey])
    let prepared = this.queries.get(cacheKey)
    this.queries.delete(cacheKey)
    if (!prepared || Date.now() >= prepared.expiresAt) prepared = preparePage(images(), query, queryKey)
    this.queries.set(cacheKey, prepared)
    if (this.queries.size > 8) this.queries.delete(this.queries.keys().next().value!)
    return slicePage(prepared, limit, params.get('cursor'))
  }
}
