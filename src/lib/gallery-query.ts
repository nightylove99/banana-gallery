import type { GalleryAssetType, GalleryImage } from '../types'
export interface GalleryQuery {
  view?: 'overview' | 'all'
  inbox?: 'unnamed' | 'untagged' | 'recent'
  groupId?: string
  q?: string
  assetType?: GalleryAssetType
  favorites?: boolean
  pinned?: boolean
  pinFirst?: boolean
  tags?: string[]
  source?: string
  model?: string
  dateFrom?: string
  dateTo?: string
  sort?: 'newest' | 'oldest' | 'updated'
}
export const assetTitle = (image: GalleryImage) => image.title ?? image.generation?.title ?? ''
export const assetNotes = (image: GalleryImage) => image.notes ?? image.generation?.notes ?? ''
export const assetModel = (image: GalleryImage) => image.generation?.model ? `${image.generation.provider || 'unknown'}:${image.generation.model}` : 'unknown'
export const assetSource = (image: GalleryImage) => image.sourceType || image.sourceFile || 'unknown'
export const gallerySourceLabel = (source: string) => ({
  unknown: '未记录',
  generated: '应用生成',
  'gemini-web': 'Gemini 网页',
  seedream: 'Seedream',
  openai: 'OpenAI',
} as Record<string, string>)[source] || source
const time = (value?: string) => value ? Date.parse(value) || 0 : 0
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
export function filterGalleryImages(images: readonly GalleryImage[], query: GalleryQuery, { includeWorkCode = false } = {}): GalleryImage[] {
  const words = (query.q || '').normalize('NFC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  return images.filter(image => {
    if (image.deletedAt || (query.assetType && image.assetType !== query.assetType) || (query.favorites && !image.favorited) || (query.pinned && !image.pinned)) return false
    if (query.inbox === 'unnamed' && assetTitle(image).trim()) return false
    if (query.inbox === 'untagged' && image.tags.some(tag => !['gemini-web', 'generated', 'imported'].includes(tag))) return false
    if (query.inbox === 'recent' && Date.parse(image.capturedAt || image.createdAt) < Date.now() - 7 * 86400000) return false
    if (query.tags?.some(tag => !image.tags.includes(tag))) return false
    if (query.source && assetSource(image) !== query.source) return false
    if (query.model && assetModel(image) !== query.model) return false
    const day = image.createdAt.slice(0, 10)
    if ((query.dateFrom && day < query.dateFrom) || (query.dateTo && day > query.dateTo)) return false
    const haystack = [image.prompt, assetTitle(image), assetNotes(image), includeWorkCode ? image.workCode : undefined, ...image.tags].join('\n').normalize('NFC').toLocaleLowerCase()
    return words.every(word => haystack.includes(word))
  }).sort((a, b) => {
    const pinned = Number(!!b.pinned) - Number(!!a.pinned)
    if (query.pinFirst !== false && pinned) return pinned
    const date = query.sort === 'oldest' ? time(a.createdAt) - time(b.createdAt) : query.sort === 'updated' ? time(b.updatedAt || b.createdAt) - time(a.updatedAt || a.createdAt) : time(b.createdAt) - time(a.createdAt)
    return date || compareId(a.id, b.id)
  })
}
export function galleryQueryFromParams(params: URLSearchParams): GalleryQuery {
  const assetType = params.get('assetType')
  const sort = params.get('sort')
  return {
    inbox: ['unnamed', 'untagged', 'recent'].includes(params.get('inbox') || '') ? params.get('inbox') as GalleryQuery['inbox'] : undefined,
    groupId: params.get('group') || '',
    view: params.get('view') === 'all' ? 'all' : 'overview',
    q: params.get('q') || '',
    ...(assetType === 'recipe' || assetType === 'work' ? { assetType } : {}),
    favorites: params.get('favorites') === 'true', pinned: params.get('pinned') === 'true',
    tags: params.getAll('tag').filter(Boolean), source: params.get('source') || '', model: params.get('model') || '',
    dateFrom: params.get('from') || '', dateTo: params.get('to') || '',
    ...(params.get('pinFirst') === '0' ? { pinFirst: false } : {}),
    sort: sort === 'oldest' || sort === 'updated' ? sort : 'newest',
  }
}
export function galleryQueryToParams(query: GalleryQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.view) params.set('view', query.view)
  if (query.inbox) params.set('inbox', query.inbox)
  if (query.groupId) params.set('group', query.groupId)
  if (query.q) params.set('q', query.q)
  if (query.assetType) params.set('assetType', query.assetType)
  if (query.favorites) params.set('favorites', 'true')
  if (query.pinned) params.set('pinned', 'true')
  if (query.pinFirst === false) params.set('pinFirst', '0')
  for (const tag of query.tags || []) params.append('tag', tag)
  if (query.source) params.set('source', query.source)
  if (query.model) params.set('model', query.model)
  if (query.dateFrom) params.set('from', query.dateFrom)
  if (query.dateTo) params.set('to', query.dateTo)
  if (query.sort && query.sort !== 'newest') params.set('sort', query.sort)
  return params
}
