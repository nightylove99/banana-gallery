import type { GalleryImage } from '../../src/types'
import { assetSource, assetTitle } from '../../src/lib/gallery-query'
import { isAvailableWork, workCode } from './work-code'

export function galleryImageSummary(image: GalleryImage) {
  const { id, assetType, createdAt, updatedAt, tags, width, height, pinned, favorited } = image
  // Slice by Unicode code point without splitting surrogate pairs.
  const excerpt: string[] = []
  for (const character of image.prompt) {
    excerpt.push(character)
    if (excerpt.length === 160) break
  }
  return {
    id, workCode: isAvailableWork(image) ? workCode(id) : undefined,
    assetType, title: assetTitle(image), createdAt, updatedAt, model: image.generation?.model,
    sourceType: assetSource(image), tags, width, height, pinned, favorited,
    promptExcerpt: excerpt.join(''),
  }
}
