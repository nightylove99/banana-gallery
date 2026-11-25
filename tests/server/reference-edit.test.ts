import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../server/app'
import { JsonGalleryRepository } from '../../server/gallery/json-gallery-repository'
import { DiskAssetStorage } from '../../server/storage/disk-asset-storage'
import type { GalleryImage } from '../../src/types'

const roots: string[] = []
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==', 'base64')
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })) })
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-reference-edit-'))
  roots.push(root)
  const dataFile = path.join(root, 'gallery.json')
  const referencesDir = path.join(root, 'references')
  const storage = new DiskAssetStorage({ imagesDir: path.join(root, 'images'), referencesDir })
  storage.ensureDirectories()
  for (const name of ['a.png', 'b.png']) fs.writeFileSync(path.join(referencesDir, name), png)
  const image: GalleryImage = { id: 'one', filename: 'main.png', referenceImages: ['a.png', 'b.png'], prompt: 'original', assetType: 'recipe', tags: [], favorited: false, createdAt: '2026-09-06', width: 1, height: 1 }
  fs.writeFileSync(dataFile, JSON.stringify({ images: [image] }))
  const repo = new JsonGalleryRepository(dataFile)
  const app = createApp({ ai: { models: { generateContent: async () => ({ candidates: [] }) } }, strategy: { mode: 'apiKey', apiKey: 'test' }, dataFile, imagesDir: storage.getImagesDir(), referencesDir, galleryRepository: repo, assetStorage: storage, userAuthMode: 'local', localAuthSession: { user: { id: 'local', email: 'local@test.local' }, workspace: { id: 'local', name: 'Local' } } })
  const edit = (order: unknown, base = image.referenceImages) => request(app).put('/api/images/one/references').field('order', JSON.stringify(order)).field('baseReferences', JSON.stringify(base))
  return { app, root, referencesDir, repo, storage, image, edit }
}

describe('reference editing', () => {
  it('replaces in position, reorders, and persists without changing the prompt or main image', async () => {
    const { app, edit, referencesDir } = setup()
    const response = await edit([{ upload: 0 }, { filename: 'a.png' }]).attach('references', png, 'new.png')
    expect(response.status).toBe(200)
    expect(response.body.referenceImages).toEqual([expect.stringMatching(/^ref_/), 'a.png'])
    expect(response.body.prompt).toBe('original')
    expect(response.body.filename).toBe('main.png')
    expect(fs.existsSync(path.join(referencesDir, 'b.png'))).toBe(false)
    expect((await request(app).get('/api/images')).body[0].referenceImages).toEqual(response.body.referenceImages)
  })
  it('clears references while preserving a file shared with another entry', async () => {
    const { edit, repo, image, referencesDir } = setup()
    await repo.saveImages([image, { ...image, id: 'two', referenceImages: ['a.png'] }])
    expect((await edit([])).status).toBe(200)
    expect(fs.readdirSync(referencesDir)).toEqual(['a.png'])
    expect((await repo.listImages())[1].referenceImages).toEqual(['a.png'])
  })
  it('releases a validated WebP reference so it can be removed in the same session', async () => {
    const { edit, referencesDir } = setup()
    const webp = await sharp(png).webp().toBuffer()
    const saved = await edit([{ upload: 0 }]).attach('references', webp, 'new.webp').expect(200)
    const [filename] = saved.body.referenceImages
    expect(fs.readFileSync(path.join(referencesDir, filename))).toEqual(webp)
    await edit([], [filename]).expect(200)
    expect(fs.readdirSync(referencesDir)).toEqual([])
  })
  it('rejects foreign references and cleans newly uploaded files', async () => {
    const { edit, referencesDir, repo } = setup()
    expect((await edit([{ filename: '../private.png' }, { upload: 0 }]).attach('references', png, 'new.png')).status).toBe(400)
    expect(fs.readdirSync(referencesDir).sort()).toEqual(['a.png', 'b.png'])
    expect((await repo.listImages())[0].referenceImages).toEqual(['a.png', 'b.png'])
  })
  it('rejects stale edits so a second tab cannot silently overwrite references', async () => {
    const { edit } = setup()
    expect((await edit([{ filename: 'b.png' }, { filename: 'a.png' }])).status).toBe(200)
    expect((await edit([])).status).toBe(409)
  })
  it('keeps originals and cleans uploads when persistence fails', async () => {
    const { edit, repo, referencesDir } = setup()
    vi.spyOn(repo, 'saveImages').mockRejectedValueOnce(new Error('disk full'))
    expect((await edit([{ upload: 0 }]).attach('references', png, 'new.png')).status).toBe(500)
    expect(fs.readdirSync(referencesDir).sort()).toEqual(['a.png', 'b.png'])
    expect((await repo.listImages())[0].referenceImages).toEqual(['a.png', 'b.png'])
  })
  it('rejects forged image content and an unused upload without leaving files', async () => {
    const { edit, referencesDir } = setup()
    expect((await edit([{ upload: 0 }]).attach('references', Buffer.from('fake'), 'fake.png')).status).toBe(400)
    expect((await edit([]).attach('references', png, 'unused.png')).status).toBe(400)
    expect(fs.readdirSync(referencesDir).sort()).toEqual(['a.png', 'b.png'])
  })
  it('reports a committed save as successful even if post-save cleanup fails', async () => {
    const { edit, repo, referencesDir } = setup()
    const original = repo.listImages.bind(repo)
    let reads = 0
    vi.spyOn(repo, 'listImages').mockImplementation(async scope => {
      if (++reads === 4) throw new Error('temporary cleanup read failure')
      return original(scope)
    })
    expect((await edit([{ filename: 'a.png' }])).status).toBe(200)
    expect((await repo.listImages())[0].referenceImages).toEqual(['a.png'])
    expect(fs.existsSync(path.join(referencesDir, 'b.png'))).toBe(true)
  })
  it('rolls back partially finalized uploads without deleting the originals', async () => {
    const { edit, storage, referencesDir } = setup()
    vi.spyOn(storage, 'finalizeReferences').mockResolvedValueOnce().mockRejectedValueOnce(new Error('object store unavailable'))
    expect((await edit([{ upload: 0 }, { upload: 1 }]).attach('references', png, 'first.png').attach('references', png, 'second.png')).status).toBe(500)
    expect(fs.readdirSync(referencesDir).sort()).toEqual(['a.png', 'b.png'])
  })

  it('preserves the original JSON index when a disk write fails midway', async () => {
    const { edit, root, referencesDir } = setup()
    const dataFile = path.join(root, 'gallery.json')
    const before = fs.readFileSync(dataFile, 'utf8')
    const write = fs.writeFileSync.bind(fs)
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(file => {
      write(file, '{partial')
      throw new Error('disk full during write')
    })
    expect((await edit([])).status).toBe(500)
    expect(fs.readFileSync(dataFile, 'utf8')).toBe(before)
    expect(fs.readdirSync(referencesDir).sort()).toEqual(['a.png', 'b.png'])
    expect(fs.readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

})

it('duplicate references retain distinct ordered notes and reject stale annotation edits',async()=>{
 const {app,repo,image}=setup()
 await repo.saveImages([{...image,referenceImages:['a.png','a.png'],referenceNotes:['角色','姿势']}])
 const response=await request(app).put('/api/images/one/references').field('baseReferences',JSON.stringify(['a.png','a.png'])).field('order',JSON.stringify([{filename:'a.png'},{filename:'a.png'}])).field('referenceNotes',JSON.stringify(['姿势','角色'])).field('expectedVersion','0')
 expect(response.status).toBe(200);expect(response.body.referenceNotes).toEqual(['姿势','角色'])
 const stale=await request(app).put('/api/images/one/references').field('baseReferences',JSON.stringify(['a.png','a.png'])).field('order',JSON.stringify([{filename:'a.png'}])).field('referenceNotes',JSON.stringify(['stale'])).field('expectedVersion','0')
 expect(stale.status).toBe(409);expect((await repo.listImages())[0].referenceNotes).toEqual(['姿势','角色'])
})

it('rejects an array-shaped version field rather than coercing it to a scalar', async () => {
  const { edit, referencesDir } = setup()
  const response = await edit([{ upload: 0 }]).field('expectedVersion[]', '0').attach('references', png, 'new.png')
  expect(response.status).toBe(400)
  expect(response.body.error).toContain('expectedVersion')
  expect(fs.readdirSync(referencesDir).sort()).toEqual(['a.png', 'b.png'])
})
