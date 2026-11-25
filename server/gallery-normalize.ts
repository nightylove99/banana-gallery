import { randomUUID } from 'node:crypto'
import type {
  GalleryAssetType,
  GalleryImage,
  GalleryImageGeneration,
} from '../src/types.ts'

/** 旧数据：无 assetType 时根据 sourceFile 推断 */
export function inferAssetTypeFromLegacy(
  sourceFile: string | undefined,
): GalleryAssetType {
  if (sourceFile === undefined || sourceFile === '') return 'work'
  if (sourceFile === 'generated') return 'work'
  return 'recipe'
}

function pickGeneration(raw: Record<string, unknown>): GalleryImageGeneration | undefined {
  const g = raw.generation
  if (!g || typeof g !== 'object') return undefined
  const o = g as Record<string, unknown>
  const aspectRatio = o.aspectRatio
  const imageSize = o.imageSize
  const outputFormat = o.outputFormat
  if (typeof aspectRatio !== 'string') {
    return undefined
  }
  const gen: GalleryImageGeneration = {
    ...o,
    aspectRatio,
  }
  if (typeof imageSize === 'string') gen.imageSize = imageSize
  if (typeof o.provider !== 'string') delete gen.provider
  if (typeof o.model === 'string' && o.model) gen.model = o.model
  if (o.quality === 'low' || o.quality === 'medium' || o.quality === 'high') {
    gen.quality = o.quality
  }
  if (outputFormat === 'jpeg' || outputFormat === 'png') gen.outputFormat = outputFormat
  if (typeof o.title === 'string') gen.title = o.title
  if (typeof o.notes === 'string') gen.notes = o.notes
  return gen
}

/**
 * 将磁盘上的单条记录归一化为完整 GalleryImage（含 assetType / generation）。
 */
export function normalizeGalleryImage(raw: unknown): { image: GalleryImage; migrated: boolean } {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid gallery image record')
  }
  const o = raw as Record<string, unknown>
  let migrated = false

  const id = o.id
  const filename = o.filename
  const prompt = o.prompt
  if (typeof id !== 'string' || typeof filename !== 'string' || typeof prompt !== 'string') {
    throw new Error('Invalid gallery image record: missing id, filename, or prompt')
  }

  const referenceImages = Array.isArray(o.referenceImages)
    ? o.referenceImages.filter((x): x is string => typeof x === 'string')
    : []
  const tags = Array.isArray(o.tags) ? o.tags.filter((x): x is string => typeof x === 'string') : []
  const favorited = typeof o.favorited === 'boolean' ? o.favorited : false
  const createdAt = typeof o.createdAt === 'string' ? o.createdAt : new Date().toISOString()
  const width = typeof o.width === 'number' ? o.width : 0
  const height = typeof o.height === 'number' ? o.height : 0
  const sourceFile =
    o.sourceFile === undefined || o.sourceFile === null
      ? undefined
      : typeof o.sourceFile === 'string'
        ? o.sourceFile
        : undefined

  let assetType: GalleryAssetType
  if (o.assetType === 'work' || o.assetType === 'recipe') {
    assetType = o.assetType
  } else {
    assetType = inferAssetTypeFromLegacy(sourceFile)
    migrated = true
  }

  const generation = pickGeneration(o)

  const image: GalleryImage = {
    ...o,
    id,
    filename,
    prompt,
    referenceImages,
    tags,
    favorited,
    createdAt,
    width,
    height,
    assetType,
    ...(sourceFile !== undefined ? { sourceFile } : {}),
    ...(generation ? { generation } : {}),
  }

  return { image, migrated }
}

export function normalizeGalleryData(raw: unknown): {
  images: GalleryImage[]
  changed: boolean
  writeSafe: boolean
} {
  if (!raw || typeof raw !== 'object') {
    return { images: [], changed: false, writeSafe: false }
  }
  const data = raw as Record<string, unknown>
  const list = data.images
  if (!Array.isArray(list)) {
    return { images: [], changed: false, writeSafe: false }
  }

  let changed = false
  let writeSafe = true
  const images: GalleryImage[] = []
  for (const item of list) {
    try {
      const { image, migrated } = normalizeGalleryImage(item)
      if (migrated) changed = true
      images.push(image)
    } catch {
      // 跳过损坏条目避免整文件无法加载，但禁止自动写回，避免静默删数据。
      writeSafe = false
    }
  }

  return { images, changed, writeSafe }
}

/** POST /api/generate/save 请求体 → 画廊条目 */
export function galleryEntryFromGenerateSave(body: Record<string, unknown>): GalleryImage {
  const filename = body.filename
  const prompt = body.prompt
  if (typeof filename !== 'string' || !filename) {
    throw new Error('filename required')
  }

  const referenceFilenames = Array.isArray(body.referenceFilenames)
    ? body.referenceFilenames.filter((x): x is string => typeof x === 'string')
    : []

  let assetType: GalleryAssetType = 'work'
  if (body.assetType === 'recipe' || body.assetType === 'work') {
    assetType = body.assetType
  }

  const width = typeof body.width === 'number' ? body.width : 0
  const height = typeof body.height === 'number' ? body.height : 0
  const promptStr = typeof prompt === 'string' ? prompt : ''

  const gen = pickGeneration(body)
  const entry: GalleryImage = {
    id: randomUUID(),
    filename,
    prompt: promptStr,
    referenceImages: referenceFilenames,
    tags: [],
    favorited: false,
    createdAt: new Date().toISOString(),
    width,
    height,
    assetType,
    sourceFile: 'generated',
    ...(gen ? { generation: gen } : {}),
  }

  return entry
}

export function createRecipeFromImage(source: GalleryImage): GalleryImage {
  return {
    ...source,
    id: randomUUID(),
    assetType: 'recipe',
    sourceAssetId: source.id,
    createdAt: new Date().toISOString(),
    favorited: false,
  }
}
