import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { afterEach, expect, it } from 'vitest'
import { createApp } from '../../server/app'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-trash-')); roots.push(root)
  const paths = { dataFile: path.join(root, 'gallery-data.json'), imagesDir: path.join(root, 'images'), referencesDir: path.join(root, 'references') }
  const app = createApp({ ...paths, ai: { models: { generateContent: async () => ({ candidates: [] }) } }, strategy: { mode: 'apiKey', apiKey: 'fixture' }, userAuthMode: 'local', localAuthSession: { user: { id: 'one', email: 'one@test' }, workspace: { id: 'one', name: 'Test' } } })
  const entry = { id: 'one', filename: 'a.png', prompt: 'keep me', referenceImages: ['r.png'], favorited: true, tags: ['tag'], assetType: 'recipe', createdAt: '2026-09-11', width: 1, height: 1 }
  fs.writeFileSync(paths.dataFile, JSON.stringify({ images: [entry, { ...entry, id: 'two' }] }))
  fs.writeFileSync(path.join(paths.imagesDir, 'a.png'), 'image'); fs.writeFileSync(path.join(paths.referencesDir, 'r.png'), 'ref')
  return { app, paths, entry }
}
it('delete hides the entry while retaining all data, and restore is idempotent', async () => {
  const { app, paths, entry } = setup()
  expect((await request(app).delete('/api/images/one')).status).toBe(200)
  expect((await request(app).get('/api/images')).body.map((image: { id: string }) => image.id)).toEqual(['two'])
  const trash = await request(app).get('/api/trash')
  expect(trash.body).toHaveLength(1)
  expect(trash.body[0]).toMatchObject({ ...entry, deletedAt: expect.any(String) })
  expect(fs.existsSync(path.join(paths.imagesDir, 'a.png'))).toBe(true)
  const restored = await request(app).post('/api/trash/one/restore')
  expect(restored.status).toBe(200)
  const repeated = await request(app).post('/api/trash/one/restore')
  expect(repeated.body).toEqual(restored.body)
  expect((await request(app).get('/api/images')).body.find((image: { id: string }) => image.id === 'one')).toMatchObject(entry)
})
it('permanent deletion requires trash and explicit intent, preserving shared files until the final reference', async () => {
  const { app, paths } = setup()
  expect((await request(app).delete('/api/trash/one').send({ confirm: true })).status).toBe(409)
  await request(app).delete('/api/images/one')
  expect((await request(app).delete('/api/trash/one')).status).toBe(400)
  expect((await request(app).delete('/api/trash/one').send({ confirm: true })).status).toBe(200)
  expect(fs.existsSync(path.join(paths.imagesDir, 'a.png'))).toBe(true)
  expect(fs.existsSync(path.join(paths.referencesDir, 'r.png'))).toBe(true)
  await request(app).delete('/api/images/two')
  expect((await request(app).delete('/api/trash/two').send({ confirm: true })).status).toBe(200)
  expect(fs.existsSync(path.join(paths.imagesDir, 'a.png'))).toBe(false)
  expect(fs.existsSync(path.join(paths.referencesDir, 'r.png'))).toBe(false)
})

it('a partial physical cleanup is visible, cannot pretend to restore, and can be retried', async () => {
  const { vi } = await import('vitest')
  const { app, paths } = setup()
  await request(app).delete('/api/images/one'); await request(app).delete('/api/images/two')
  await request(app).delete('/api/trash/one').send({ confirm: true })
  const unlink = fs.unlinkSync.bind(fs)
  const spy = vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
    if (String(file) === path.join(paths.referencesDir, 'r.png')) throw new Error('locked reference')
    return unlink(file)
  })
  try {
    const api = request(app)
    await api.delete('/api/trash/two').send({ confirm: true, expectedVersion: 1 }).expect(500)
    const pending = (await api.get('/api/trash').expect(200)).body[0]
    expect(pending).toMatchObject({ purgePending: true, version: 2, updatedAt: expect.any(String) })
    expect(pending.thumbnailVersion).toBeUndefined()
    expect(pending.originalMissing).toBeUndefined()
    expect((await api.get('/api/gallery/state').expect(200)).body).toMatchObject({ count: 0, trashCount: 1 })
    expect((await api.post('/api/trash/two/restore').send({ expectedVersion: 2 }).expect(409)).body.code).toBe('TRASH_PURGE_PENDING')
    expect((await api.post('/api/trash/two/restore').expect(409)).body.code).toBe('TRASH_PURGE_PENDING')
    await api.delete('/api/trash/two').send({ confirm: true, expectedVersion: 2 }).expect(500)
    expect((await api.get('/api/trash').expect(200)).body).toEqual([pending])
    const snapshot = await request(app).post('/api/personal/backups')
    expect(snapshot.status).toBe(201)
    expect(snapshot.body.files.map((file: { path: string }) => file.path)).toEqual(['gallery-data.json', 'public/references/r.png'])
    expect((await request(app).post(`/api/personal/backups/${snapshot.body.id}/verify`)).status).toBe(200)
  } finally { spy.mockRestore() }
  await request(app).delete('/api/trash/two').send({ confirm: true, expectedVersion: 2 }).expect(200, { ok: true })
  const trash = await request(app).get('/api/trash')
  expect(trash.status, trash.text).toBe(200)
  expect(trash.body).toEqual([])
  expect(JSON.parse(fs.readFileSync(paths.dataFile, 'utf8')).images).toEqual([])
  expect(fs.existsSync(path.join(paths.referencesDir, 'r.png'))).toBe(false)
})

it('guards stale restore and purge after restoring and recycling the same entry', async () => {
  const { app } = setup()
  const api = request(app)
  await api.delete('/api/images/one').expect(200, { ok: true, version: 1, moved: true })
  await api.delete('/api/images/one').expect(200, { ok: true, version: 1, moved: false })
  await api.post('/api/trash/one/restore').send({ expectedVersion: 1 }).expect(200)
  expect((await api.post('/api/trash/one/restore').send({ expectedVersion: 1 }).expect(409)).body.code).toBe('TRASH_NOT_DELETED')
  await api.delete('/api/images/one').expect(200, { ok: true, version: 3, moved: true })
  expect((await api.post('/api/trash/one/restore').send({ expectedVersion: 1 }).expect(409)).body.code).toBe('TRASH_VERSION_CONFLICT')
  expect((await api.delete('/api/trash/one').send({ confirm: true, expectedVersion: 1 }).expect(409)).body.code).toBe('TRASH_VERSION_CONFLICT')
  await api.delete('/api/trash/one').send({ confirm: true, expectedVersion: 3 }).expect(200, { ok: true })
  expect((await api.delete('/api/trash/one').send({ confirm: true, expectedVersion: 3 }).expect(404)).body.code).toBe('TRASH_NOT_FOUND')
  await api.delete('/api/trash/one').send({ confirm: true }).expect(200, { ok: true })
})

it.each([null, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1])('rejects an invalid precondition %j', async expectedVersion => {
  const { app } = setup()
  const api = request(app)
  await api.delete('/api/images/one').expect(200)
  await api.post('/api/trash/one/restore').send({ expectedVersion }).expect(400)
  await api.delete('/api/trash/one').send({ confirm: true, expectedVersion }).expect(400)
})

it('sorts legacy tombstones by parsed dates, exposes derived media state and keeps it out of the index', async () => {
  const { app, paths, entry } = setup()
  const images = [
    { id: 'invalid', deletedAt: 'unknown', filename: 'missing.png' },
    { id: 'b', deletedAt: '2026-10-04T03:00:00Z', assetType: 'work' },
    { id: 'a', deletedAt: '2026-10-04T06:00:00+03:00', purgePending: true },
    { id: 'old', deletedAt: '2026-10-04T07:00:00+08:00' },
  ].map(image => ({ ...entry, ...image }))
  fs.writeFileSync(paths.dataFile, JSON.stringify({ images }))
  const api = request(app)
  const { body } = await api.get('/api/trash').expect(200).expect('Cache-Control', 'no-store')
  expect(body.map((item: { id: string }) => item.id)).toEqual(['a', 'b', 'old', 'invalid'])
  expect(body[0]).toMatchObject({ version: 0, purgePending: true })
  expect(body[0].thumbnailVersion).toBeUndefined()
  expect(body[1]).toMatchObject({ version: 0, thumbnailVersion: expect.any(String) })
  expect(body[3]).toMatchObject({ version: 0, originalMissing: true })
  expect(JSON.parse(fs.readFileSync(paths.dataFile, 'utf8')).images).toEqual(images)
  const restored = await api.post('/api/trash/b/restore').send({ expectedVersion: 0 }).expect(200)
  expect(restored.body).toMatchObject({ version: 1, thumbnailVersion: expect.any(String), workCode: expect.stringMatching(/^#/) })
  expect(restored.body.deletedAt).toBeUndefined()
})
