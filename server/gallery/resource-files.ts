import type { ReadOnlyGalleryResources } from './gallery-repository'

export const assetKinds = ['images', 'references'] as const
export type AssetKind = typeof assetKinds[number]

export interface AssetReference {
  kind: AssetKind
  filename: string
  ownerId: string
  required: boolean
}

export function* resourceFileReferences(resources: ReadOnlyGalleryResources = {}): Iterable<AssetReference> {
  for (const task of resources.generationTasks || []) {
    const required = task.purgePending !== true
    if (task.result) yield { kind: 'images', filename: task.result.filename, ownerId: task.id, required }
    for (const filename of task.input.referenceFilenames) yield { kind: 'references', filename, ownerId: task.id, required }
  }
  for (const asset of resources.referenceAssets || []) {
    for (const version of asset.versions) {
      yield { kind: 'references', filename: version.filename, ownerId: asset.id, required: true }
    }
  }
}

/** Includes trash and pending purges; ownership/cleanup must see all references. */
export function resourceFiles(resources: ReadOnlyGalleryResources = {}) {
  const files = { images: new Set<string>(), references: new Set<string>() }
  for (const { kind, filename } of resourceFileReferences(resources)) files[kind].add(filename)
  return files
}
