import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { generationTasksFileFor } from '../../server/gallery/generation-task-storage'
import { JsonGalleryRepository } from '../../server/gallery/json-gallery-repository'
import type { GalleryImage } from '../../src/types'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const image: GalleryImage = { id: 'one', filename: 'one.png', referenceImages: ['ref.png'], prompt: 'fixture', tags: [], favorited: false, assetType: 'work', createdAt: '2026-10-12', width: 1, height: 1 }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-snapshot-')); roots.push(root)
  const file = path.join(root, 'gallery.json')
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, images: [image], resources: {}, future: { keep: true } }))
  return { file, repository: new JsonGalleryRepository(file) }
}

it('reads an unchanged index once across gallery and resource reads', async () => {
  const { file, repository } = fixture()
  const read = vi.spyOn(fs, 'readFileSync')
  await repository.listImages(); await repository.readResources(); await repository.listImages()
  expect(read.mock.calls.filter(args => args[0] === file)).toHaveLength(1)
})

it('uses a permission index and never exposes the cached mutable snapshot', async () => {
  const { repository } = fixture()
  expect(typeof repository.hasAssetAccess).toBe('function')
  const images = await repository.listImages(); images[0].filename = 'stolen.png'; images[0].referenceImages.push('stolen-ref.png')
  const metadata = repository.readMetadata(); (metadata.future as { keep: boolean }).keep = false
  expect(await repository.hasAssetAccess(undefined, 'images', 'one.png')).toBe(true)
  expect(await repository.hasAssetAccess(undefined, 'images', 'stolen.png')).toBe(false)
  expect(await repository.hasAssetAccess(undefined, 'references', 'stolen-ref.png')).toBe(false)
  expect(repository.readMetadata().future).toEqual({ keep: true })
})

it('invalidates permissions after same-size atomic replacement and after deletion', async () => {
  const { file, repository } = fixture()
  expect(typeof repository.hasAssetAccess).toBe('function')
  expect(await repository.hasAssetAccess(undefined, 'images', 'one.png')).toBe(true)
  const previous = fs.statSync(file), replacement = file + '.new'
  fs.writeFileSync(replacement, fs.readFileSync(file, 'utf8').replace('one.png', 'two.png'))
  fs.utimesSync(replacement, previous.atime, previous.mtime); fs.renameSync(replacement, file)
  expect(await repository.hasAssetAccess(undefined, 'images', 'one.png')).toBe(false)
  expect(await repository.hasAssetAccess(undefined, 'images', 'two.png')).toBe(true)
  fs.unlinkSync(file)
  expect(await repository.hasAssetAccess(undefined, 'images', 'two.png')).toBe(false)
})

it('updates permissions only after successful writes and preserves unknown metadata', async () => {
  const { file, repository } = fixture()
  expect(typeof repository.hasAssetAccess).toBe('function')
  await repository.saveImages([{ ...image, filename: 'two.png', thumbnailVersion: 'response-only' }])
  expect(await repository.hasAssetAccess(undefined, 'images', 'two.png')).toBe(true)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  expect(saved.future).toEqual({ keep: true }); expect(saved.images[0]).not.toHaveProperty('thumbnailVersion')
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk failure') })
  await expect(repository.saveImages([image])).rejects.toThrow('disk failure'); rename.mockRestore()
  expect(await repository.hasAssetAccess(undefined, 'images', 'two.png')).toBe(true)
})

it('fails closed after malformed JSON or damaged records instead of reusing old permissions', async () => {
  const { file, repository } = fixture()
  expect(typeof repository.hasAssetAccess).toBe('function')
  await repository.hasAssetAccess(undefined, 'images', 'one.png')
  fs.writeFileSync(file, '{invalid')
  await expect(repository.hasAssetAccess(undefined, 'images', 'one.png')).rejects.toThrow()
  fs.writeFileSync(file, JSON.stringify({ images: [image, { invalid: true }] }))
  await expect(repository.hasAssetAccess(undefined, 'images', 'one.png')).rejects.toThrow()
})

it('indexes durable history and material references including their recycle bins', async () => {
  const { repository } = fixture()
  expect(typeof repository.hasAssetAccess).toBe('function')
  await repository.saveResources({ referenceAssets: [{ id: 'material', name: 'material', tags: [], favorited: false, version: 0, createdAt: '', updatedAt: '', deletedAt: 'today', currentVersionId: 'v', versions: [{ id: 'v', filename: 'material.png', sha256: 'hash', createdAt: '' }] }] })
  expect(await repository.hasAssetAccess(undefined, 'references', 'material.png')).toBe(true)
  expect(await repository.hasAssetAccess(undefined, 'references', 'ref.png')).toBe(true)
})

it('rejects an unsafe replacement before changing the original index', async () => {
  const { file, repository } = fixture()
  const original = fs.readFileSync(file)
  const malformed = { ...image, prompt: ['first', 'second'] } as unknown as GalleryImage

  await expect(repository.saveImages([image, malformed])).rejects.toThrow(/不安全|损坏/)
  expect(fs.readFileSync(file)).toEqual(original)
  expect(await repository.hasAssetAccess(undefined, 'images', image.filename)).toBe(true)
  await repository.saveImages([{ ...image, prompt: 'updated' }])
  expect((await repository.listImages())[0].prompt).toBe('updated')
})

it('does not install a resource index that protected asset reads cannot use', async () => {
  const { file, repository } = fixture()
  const original = fs.readFileSync(file)

  expect(() => repository.saveMetadata({ resources: { referenceAssets: [{ versions: null }] } }))
    .toThrow(/资源记录损坏/)
  expect(fs.readFileSync(file)).toEqual(original)
  expect(await repository.hasAssetAccess(undefined, 'references', 'ref.png')).toBe(true)
})

it('reuses the validated replacement without synchronously rereading the index', async () => {
  const { file, repository } = fixture()
  await repository.saveImages([{ ...image, filename: 'new.png' }])
  const read = vi.spyOn(fs, 'readFileSync')
  expect((await repository.listImages())[0].filename).toBe('new.png')
  expect(await repository.hasAssetAccess(undefined, 'images', 'new.png')).toBe(true)
  expect(read.mock.calls.some(([name]) => name === file)).toBe(false)
})

it('migrates queue writes without touching or rereading the main index', async () => {
  const { file, repository } = fixture()
  const legacy = {
    images: [image],
    resources: { generationTasks: [{ id: 'legacy', input: { referenceFilenames: ['legacy.png'] } }] },
  }
  const raw = JSON.stringify(legacy)
  fs.writeFileSync(file, raw)
  const previous = fs.statSync(file, { bigint: true })
  const resources = await repository.readResources()
  const revision = repository.snapshotRevision()
  resources.generationTasks!.push({ ...resources.generationTasks![0], id: 'new', input: { ...resources.generationTasks![0].input, referenceFilenames: ['new.png'] } })
  const read = vi.spyOn(fs, 'readFileSync')
  await new JsonGalleryRepository(file).saveResources(resources)
  read.mockClear()
  expect(repository.snapshotRevision()).not.toBe(revision)
  expect(repository.readOnlySnapshot().resources.generationTasks?.map(task => task.id)).toEqual(['legacy', 'new'])
  expect(await repository.hasAssetAccess(undefined, 'references', 'new.png')).toBe(true)
  expect(read.mock.calls.some(([name]) => name === file)).toBe(false)
  expect(fs.statSync(file, { bigint: true }).mtimeNs).toBe(previous.mtimeNs)
  expect(fs.readFileSync(file, 'utf8')).toBe(raw)
  await repository.saveImages([{ ...image, prompt: 'updated' }])
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).resources).not.toHaveProperty('generationTasks')
  expect((await new JsonGalleryRepository(file).readResources()).generationTasks).toHaveLength(2)
})

it.each(['main', 'tasks'])('does not partially install combined resources when writing %s fails', async failedIndex => {
  const { file, repository } = fixture()
  const resources = { generationProviderStates: { google: { cooldownUntil: '2026-11-25', consecutiveRateLimits: 1 } } }
  await repository.saveResources(resources)
  const before = fs.readFileSync(file)
  const taskFile = generationTasksFileFor(file)
  const queueBefore = fs.readFileSync(taskFile)
  const failedFile = failedIndex === 'main' ? file : taskFile
  const rename = fs.renameSync.bind(fs)
  const failMain = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === failedFile) throw new Error('cannot write index')
    return rename(from, to)
  })
  try {
    await expect(repository.saveResources({
      generationProviderStates: { google: { cooldownUntil: '2026-11-26', consecutiveRateLimits: 2 } },
      preferences: { version: 1, favoriteModels: [] },
    })).rejects.toThrow('cannot write index')
    expect(fs.readFileSync(file)).toEqual(before)
    expect(fs.readFileSync(taskFile)).toEqual(queueBefore)
    expect(await new JsonGalleryRepository(file).readResources()).toEqual(resources)
  } finally { failMain.mockRestore() }
})
