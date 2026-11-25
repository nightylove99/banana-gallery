import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { captureStorageIndex, storageSummary } from '../../server/personal/storage-summary'
import type { GalleryImage, GalleryResources } from '../../src/types'

it('asynchronously counts physical bytes and all durable references, including trashed records', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-storage-summary-'))
  const imagesDir = path.join(root, 'images'), referencesDir = path.join(root, 'references')
  const cacheDir = path.join(root, 'cache'), backupDir = path.join(root, 'not-a-directory', 'backups')
  const image: GalleryImage = { id: 'image', filename: 'shared.png', assetType: 'work', favorited: false, tags: [], referenceImages: ['missing.png'], prompt: '', createdAt: '2026-09-11', width: 1, height: 1 }
  const resources: GalleryResources = {
    generationTasks: [{
      id: 'task', key: 'task', scope: { workspaceId: 'local', userId: 'local' }, status: 'completed', createdAt: '', updatedAt: '',
      input: { provider: 'google', model: '', aspectRatio: '1:1', imageSize: '1K', prompt: '', referenceFilenames: ['missing.png'] },
      result: { filename: 'shared.png', width: 1, height: 1, prompt: '', provider: 'google', model: '', aspectRatio: '1:1' },
    }],
    referenceAssets: [{
      id: 'material', name: '', tags: [], favorited: false, version: 1, createdAt: '', updatedAt: '', currentVersionId: 'v', deletedAt: '2026-09-11',
      versions: [{ id: 'v', filename: 'missing.png', sha256: '', createdAt: '' }],
    }],
  }
  try {
    for (const dir of [imagesDir, referencesDir, path.join(cacheDir, 'nested'), path.join(imagesDir, 'ignored')]) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(imagesDir, 'shared.png'), '123')
    fs.writeFileSync(path.join(imagesDir, 'orphan.png'), '12')
    fs.writeFileSync(path.join(imagesDir, 'ignored', 'hidden.png'), 'ignored')
    fs.writeFileSync(path.join(cacheDir, 'nested', 'thumb.webp'), '1234')
    fs.writeFileSync(path.join(referencesDir, 'orphan.png'), '1')
    fs.writeFileSync(path.join(root, 'not-a-directory'), 'fixture')
    fs.symlinkSync(path.join(imagesDir, 'shared.png'), path.join(referencesDir, 'link.png'))
    const index = captureStorageIndex([{ ...image, deletedAt: '2026-09-11' }], resources)
    const result = storageSummary({ imagesDir, referencesDir, cacheDir, backupDir }, index)
    await expect(result).resolves.toEqual({
      originals: { files: 2, bytes: 5 }, references: { files: 1, bytes: 1 },
      cache: { files: 1, bytes: 4 }, backups: { files: 0, bytes: 0 }, physicalBytes: 10,
      history: { entries: 1, files: 1, bytes: 3, missing: 0 },
      trash: { entries: 1, files: 1, bytes: 3, missing: 0 },
      materials: { entries: 1, files: 1, bytes: 0, missing: 1 }, galleryEntries: 0, workEntries: 0,
      unreferenced: { images: { files: 1, bytes: 2, missing: 0 }, references: { files: 1, bytes: 1, missing: 0 } },
      missingImages: 0, missingReferences: 1, skipped: 1,
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
