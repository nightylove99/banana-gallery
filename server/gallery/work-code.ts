import { createHash } from 'node:crypto'
import type { GalleryImage } from '../../src/types'

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function workCode(id: string): string {
  const bits = createHash('sha256').update(id).digest().readBigUInt64BE()
  let code = '#'
  for (let shift = 59n; shift >= 14n; shift -= 5n) {
    code += alphabet[Number((bits >> shift) & 31n)]
  }
  return code
}

export function isAvailableWork(image: GalleryImage): boolean {
  return image.assetType === 'work' && !image.deletedAt && !image.purgePending
}

export function withWorkCode(image: GalleryImage): GalleryImage {
  return isAvailableWork(image) ? { ...image, workCode: workCode(image.id) } : image
}
