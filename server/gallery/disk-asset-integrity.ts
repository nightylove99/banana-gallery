import fs from 'node:fs'
import path from 'node:path'

import { normalizeGalleryData } from '../gallery-normalize.ts'
import { parseGenerationTaskIndex, splitGenerationResources } from './generation-task-storage.js'
import type { ReadOnlyGalleryResources } from './gallery-repository'
import { assetKinds, resourceFileReferences, type AssetReference } from './resource-files'

export function isAssetBasename(name: unknown): name is string {
  return typeof name === 'string' && Boolean(name) && name === path.basename(name) &&
    !/[\\/\r\n]/.test(name) && !name.includes('\0') && name !== '.' && name !== '..'
}

/** Keep reversible trash strict. Only interrupted permanent purges may lack bytes. */
export function galleryAssetIndex(raw: unknown, taskIndex?: Buffer) {
  const { images, writeSafe } = normalizeGalleryData(raw)
  if (!writeSafe) throw new Error('图库索引损坏，无法校验完整性')
  const { resources, schemaVersion } = raw as { resources?: ReadOnlyGalleryResources; schemaVersion?: unknown }
  if (schemaVersion !== undefined && schemaVersion !== 1) throw new Error('图库索引版本不受支持')

  const files = { images: new Map<string, AssetReference>(), references: new Map<string, AssetReference>() }
  const add = (reference: AssetReference) => {
    const { filename, kind, required } = reference
    if (!isAssetBasename(filename)) throw new Error('索引包含非法文件名')
    // A live reference in any part of the index wins over an interrupted purge.
    if (required || !files[kind].has(filename)) files[kind].set(filename, reference)
  }
  for (const image of images) {
    const required = image.purgePending !== true
    add({ kind: 'images', filename: image.filename, ownerId: image.id, required })
    for (const filename of image.referenceImages) add({ kind: 'references', filename, ownerId: image.id, required })
  }
  // The sidecar replaces the legacy task fields, including any task deleted
  // since migration; ordinary gallery resources still come from the main index.
  const effectiveResources = taskIndex
    ? { ...splitGenerationResources(resources ?? {}).gallery, ...parseGenerationTaskIndex(taskIndex).tasks }
    : resources
  for (const reference of resourceFileReferences(effectiveResources)) add(reference)
  return { imageCount: images.length, files }
}

export function diskAssetDirectory(dir: string): boolean {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false })
  if (stat && !stat.isDirectory()) throw new Error('图片目录必须是普通目录，不能是符号链接')
  return Boolean(stat)
}

export function diskAssetStat(file: string): fs.Stats | undefined {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (stat && !stat.isFile()) throw new Error(`图片必须是普通文件，不能是符号链接：${path.basename(file)}`)
  return stat
}

export function inspectGalleryDiskAssets(raw: unknown, imagesDir: string, referencesDir: string, taskIndex?: Buffer) {
  const { imageCount, files } = galleryAssetIndex(raw, taskIndex)
  const dirs = { images: imagesDir, references: referencesDir }
  const missing: AssetReference[] = []
  for (const kind of assetKinds) {
    const references = files[kind]
    if (references.size === 0) continue
    const dir = dirs[kind]
    const exists = diskAssetDirectory(dir)
    for (const reference of references.values()) {
      const stat = exists && diskAssetStat(path.join(dir, reference.filename))
      if (!stat && reference.required) missing.push(reference)
    }
  }
  return { imageCount, missing }
}
