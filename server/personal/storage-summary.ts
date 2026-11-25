import fs from 'node:fs/promises'
import path from 'node:path'
import type { GalleryImage } from '../../src/types'
import type { ReadOnlyGalleryResources } from '../gallery/gallery-repository'
import { resourceFiles } from '../gallery/resource-files'

export function captureStorageIndex(images: readonly GalleryImage[], resources: ReadOnlyGalleryResources) {
  const protectedFiles = resourceFiles(resources)
  const trashNames = new Set<string>()
  let trashEntries = 0
  let workEntries = 0
  for (const image of images) {
    protectedFiles.images.add(image.filename)
    for (const ref of image.referenceImages) protectedFiles.references.add(ref)
    if (image.deletedAt) {
      trashEntries++
      trashNames.add(image.filename)
    } else if (image.assetType !== 'recipe') {
      workEntries++
    }
  }
  const tasks = resources.generationTasks || []
  const materials = resources.referenceAssets || []
  return {
    protectedFiles,
    galleryEntries: images.length - trashEntries,
    workEntries,
    trash: { entries: trashEntries, names: trashNames },
    history: { entries: tasks.length, names: new Set(tasks.flatMap(job => job.result ? [job.result.filename] : [])) },
    materials: { entries: materials.length, names: new Set(materials.flatMap(asset => asset.versions.map(version => version.filename))) },
  }
}

const statConcurrency = 16
type StorageDirectories = { imagesDir: string; referencesDir: string; cacheDir: string; backupDir: string }
const exists = (filename: string) => fs.access(filename).then(() => true, () => false)

export async function storageSummary(
  { imagesDir, referencesDir, cacheDir, backupDir }: StorageDirectories,
  index: ReturnType<typeof captureStorageIndex>,
) {
  let skipped = 0
  async function scan(root: string, recursive = false) {
    const files = new Map<string, number>()
    // Missing roots (including dangling links and paths under a file) are not skipped entries.
    if (!await exists(root)) return files
    try {
      if ((await fs.lstat(root)).isSymbolicLink()) {
        skipped++
        return files
      }
    } catch {
      skipped++
      return files
    }

    const directories = [root]
    for (const dir of directories) {
      if (dir !== root && !await exists(dir)) continue
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        const filenames: string[] = []
        for (const entry of entries) {
          const file = path.join(dir, entry.name)
          if (entry.isSymbolicLink()) skipped++
          else if (recursive && entry.isDirectory()) directories.push(file)
          else if (entry.isFile()) filenames.push(file)
        }
        for (let start = 0; start < filenames.length; start += statConcurrency) {
          await Promise.all(filenames.slice(start, start + statConcurrency).map(async file => {
            try { files.set(path.relative(root, file), (await fs.stat(file)).size) }
            catch { skipped++ }
          }))
        }
      } catch {
        skipped++
      }
    }
    return files
  }

  // Scan one root at a time so the stat limit applies to the entire request.
  const imageFiles = await scan(imagesDir)
  const referenceFiles = await scan(referencesDir)
  const cacheFiles = await scan(cacheDir, true)
  const backupFiles = await scan(backupDir, true)
  const total = (files: Map<string, number>) => ({ files: files.size, bytes: [...files.values()].reduce((a, b) => a + b, 0) })
  const counts = (names: Set<string>, files: Map<string, number>) => {
    let bytes = 0, missing = 0
    for (const name of names) {
      const size = files.get(name)
      if (size === undefined) missing++
      else bytes += size
    }
    return { files: names.size, bytes, missing }
  }
  const originals = total(imageFiles), references = total(referenceFiles)
  const cache = total(cacheFiles), backups = total(backupFiles)
  return {
    originals, references, cache, backups,
    physicalBytes: originals.bytes + references.bytes + cache.bytes + backups.bytes,
    history: { entries: index.history.entries, ...counts(index.history.names, imageFiles) },
    trash: { entries: index.trash.entries, ...counts(index.trash.names, imageFiles) },
    materials: { entries: index.materials.entries, ...counts(index.materials.names, referenceFiles) },
    galleryEntries: index.galleryEntries,
    workEntries: index.workEntries,
    unreferenced: {
      images: counts(new Set([...imageFiles.keys()].filter(name => !index.protectedFiles.images.has(name))), imageFiles),
      references: counts(new Set([...referenceFiles.keys()].filter(name => !index.protectedFiles.references.has(name))), referenceFiles),
    },
    missingImages: counts(index.protectedFiles.images, imageFiles).missing,
    missingReferences: counts(index.protectedFiles.references, referenceFiles).missing,
    skipped,
  }
}
