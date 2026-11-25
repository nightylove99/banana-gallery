import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp } from '../../server/app'
import { ProviderConfig } from '../../server/personal/provider-config'
import { JsonGalleryRepository } from '../../server/gallery/json-gallery-repository'
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })) })
function setup(managed = false, defaultProvider?: 'openai-compatible') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-reliability-')); roots.push(root)
  const dataFile = path.join(root, 'gallery.json')
  const imagesDir = path.join(root, 'images')
  const referencesDir = path.join(root, 'references')
  const repo = new JsonGalleryRepository(dataFile)
  const app = createApp({ ai: { models: { generateContent: async () => ({ candidates: [] }) } }, strategy: { mode: 'apiKey', apiKey: 'test' }, providerConfig: managed ? new ProviderConfig(dataFile, {}) : undefined, defaultImageGenerationProvider: defaultProvider, dataFile, imagesDir, referencesDir, galleryRepository: repo, userAuthMode: 'local', localAuthSession: { user: { id: 'local', email: 'local@test.local' }, workspace: { id: 'local', name: 'Local' } } })
  fs.writeFileSync(path.join(imagesDir, 'main.png'), 'fixture')
  const entry = { id: 'one', filename: 'main.png', prompt: 'original', referenceImages: [], tags: [], favorited: false, createdAt: '2026-09-11', width: 1, height: 1, assetType: 'work' as const }
  fs.writeFileSync(dataFile, JSON.stringify({ images: [entry] }))
  return { app, repo, root, imagesDir, entry }
}
it('saving a generated result twice returns the same asset, while recipe is independent', async () => {
  const { app } = setup()
  const body = { filename: 'main.png', prompt: 'original', width: 1, height: 1, assetType: 'work' }
  const first = await request(app).post('/api/generate/save').send(body)
  const second = await request(app).post('/api/generate/save').send(body)
  expect(second.body.id).toBe(first.body.id)
  const recipe = await request(app).post('/api/generate/save').send({ ...body, assetType: 'recipe' })
  expect(recipe.body.id).not.toBe(first.body.id)
  expect((await request(app).get('/api/images')).body).toHaveLength(2)
})
it('failed metadata deletion preserves the image file', async () => {
  const { app, repo, imagesDir } = setup()
  vi.spyOn(repo, 'saveImages').mockRejectedValueOnce(new Error('disk full'))
  expect((await request(app).delete('/api/images/one')).status).toBe(500)
  expect(fs.existsSync(path.join(imagesDir, 'main.png'))).toBe(true)
  expect((await repo.listImages())).toHaveLength(1)
})

it('overlapping edits preserve both changes instead of overwriting the index', async () => {
  const { app, repo } = setup()
  const save = repo.saveImages.bind(repo)
  vi.spyOn(repo, 'saveImages').mockImplementation(async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 15))
    return save(...args)
  })
  const responses = await Promise.all([
    request(app).patch('/api/images/one').send({ prompt: 'changed' }),
    request(app).patch('/api/images/one').send({ tags: ['new'] }),
  ])
  expect(responses.map(r => r.status)).toEqual([200, 200])
  expect((await repo.listImages())[0]).toMatchObject({ prompt: 'changed', tags: ['new'] })
})

it('JSON saves preserve unknown entry and root metadata and reject newer schema writes', async () => {
  const { repo, root, entry } = setup()
  const dataFile = path.join(root, 'gallery.json')
  fs.writeFileSync(dataFile, JSON.stringify({ schemaVersion: 1, futureRoot: { value: 2 }, images: [{ ...entry, futureField: 'keep', generation: { aspectRatio: '1:1', futureSetting: 'keep' } }] }))
  const images = await repo.listImages()
  images[0].prompt = 'updated'
  await repo.saveImages(images)
  expect(JSON.parse(fs.readFileSync(dataFile, 'utf8'))).toMatchObject({ futureRoot: { value: 2 }, images: [{ futureField: 'keep', generation: { futureSetting: 'keep' }, prompt: 'updated' }] })
  fs.writeFileSync(dataFile, JSON.stringify({ schemaVersion: 999, images: [entry] }))
  await expect(repo.saveImages(images)).rejects.toThrow(/版本/)
  expect(JSON.parse(fs.readFileSync(dataFile, 'utf8')).schemaVersion).toBe(999)
})

it('personal backups contain a verified index and protected assets; corrupt backup cannot verify', async () => {
  const { app, root } = setup()
  const response = await request(app).post('/api/personal/backups').send({})
  expect(response.status).toBe(201)
  expect(response.body.id).toMatch(/^backup-/)
  expect((await request(app).post(`/api/personal/backups/${response.body.id}/verify`)).status).toBe(200)
  const status = await request(app).get('/api/personal/backups')
  expect(status.body.backups).toHaveLength(1)
  const file = path.join(root, 'backups', response.body.id, 'gallery-data.json')
  fs.writeFileSync(file, '{}')
  expect((await request(app).post(`/api/personal/backups/${response.body.id}/verify`)).status).toBe(422)
})

it('remote Access sessions can read backup status but cannot create or restore; anonymous sessions cannot read', async () => {
  const { createServer } = await import('node:http')
  const { root } = setup()
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const remotePort = (server.address() as import('node:net').AddressInfo).port
  const app = createApp({ ai: { models: { generateContent: async () => ({ candidates: [] }) } }, strategy: { mode: 'apiKey', apiKey: 'test' }, dataFile: path.join(root, 'gallery.json'), imagesDir: path.join(root, 'images'), referencesDir: path.join(root, 'references'), providerConfig: new ProviderConfig(path.join(root, 'gallery.json'), {}), agentApiToken: 'fixture-agent-token', userAuthMode: 'cloudflare_access', localAccessPort: 1, remoteAccessPort: remotePort, cloudflareAccessVerifier: { verify: async assertion => assertion === 'valid' ? { email: 'owner@test.local' } : null }, cloudflareAccessSession: { user: { id: 'local', email: 'owner@test.local' }, workspace: { id: 'local', name: 'Local' } } })
  server.on('request', app)
  try {
    expect((await request(server).get('/api/personal/backups')).status).toBe(401)
    const status = await request(server).get('/api/personal/backups').set('cf-access-jwt-assertion', 'valid')
    expect(status.status).toBe(200)
    expect(status.body.canManage).toBe(false)
    expect((await request(server).post('/api/personal/backups').set('cf-access-jwt-assertion', 'valid')).status).toBe(403)
    expect((await request(server).post('/api/personal/backups/fake/restore').set('cf-access-jwt-assertion', 'valid')).status).toBe(403)
    const endpoint = '/api/personal/provider-config'
    await request(server).get(endpoint).expect(401)
    const remote = await request(server).get(endpoint).set('cf-access-jwt-assertion', 'valid').expect(200)
    expect(remote.body).toMatchObject({ canManage: false, agentTokenConfigured: true })
    expect(remote.text).not.toContain('fixture-agent-token')
    const blocked = await request(server).put(endpoint).set('cf-access-jwt-assertion', 'valid')
      .send({ google: { apiKey: 'should-not-save' } }).expect(403)
    expect(blocked.body.error).toBe('请在本机入口修改生图凭据')
    await request(server).post(endpoint + '/service-account').set('cf-access-jwt-assertion', 'valid').send({}).expect(403)
    for (const operation of [
      request(server).get(endpoint),
      request(server).put(endpoint).send({}),
      request(server).post(endpoint + '/service-account').send({}),
    ]) await operation.set('Authorization', 'Bearer fixture-agent-token').expect(403)
    expect(fs.existsSync(path.join(root, '.provider-config.json'))).toBe(false)
    expect(fs.existsSync(path.join(root, '.vertex-service-account.json'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'backups'))).toBe(false)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

it('automatic backup policy is validated, persisted and included in the baseline snapshot', async () => {
  const { app, root } = setup()
  expect((await request(app).patch('/api/personal/backups/policy').send({ enabled: true, intervalHours: 0, maxCount: 0, maxBytes: 1 })).status).toBe(400)
  const policy = { enabled: true, intervalHours: 24, maxCount: 2, maxBytes: 1024 ** 2 }
  expect((await request(app).patch('/api/personal/backups/policy').send(policy)).status).toBe(200)
  const status = (await request(app).get('/api/personal/backups')).body
  expect(status.policy).toEqual(policy)
  expect(status.backups).toHaveLength(1)
  expect(status.backups[0].automatic).toBe(true)
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'backups', status.backups[0].id, 'gallery-data.json'), 'utf8'))
  expect(snapshot.backupPolicy).toEqual(policy)
})

it('supports common title/notes and pins, rejecting stale revisions without overwriting', async () => {
  const { app } = setup()
  const changed = await request(app).patch('/api/images/one').send({ title: '常用构图', notes: '保留脸部细节', pinned: true, expectedVersion: 0 })
  expect(changed.status).toBe(200)
  expect(changed.body).toMatchObject({ title: '常用构图', notes: '保留脸部细节', pinned: true, version: 1, updatedAt: expect.any(String) })
  const stale = await request(app).patch('/api/images/one').send({ title: '旧窗口覆盖', expectedVersion: 0 })
  expect(stale.status).toBe(409)
  expect((await request(app).get('/api/images')).body[0].title).toBe('常用构图')
})

it('shares an in-flight storage scan and lets gallery writes proceed while disk stats wait', async () => {
  const { app, imagesDir } = setup()
  const file = path.join(imagesDir, 'main.png')
  const stat = fs.promises.stat.bind(fs.promises)
  let unblock!: () => void
  let scanning!: () => void
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  const started = new Promise<void>(resolve => { scanning = resolve })
  let stats = 0
  vi.spyOn(fs.promises, 'stat').mockImplementation(async (name, options) => {
    if (name === file && !options?.bigint) {
      stats++
      scanning()
      await blocked
    }
    return stat(name, options)
  })
  const api = request(app)
  const first = api.get('/api/personal/storage').expect(200).then(res => res.body)
  let second: typeof first | undefined
  try {
    await started
    second = api.get('/api/personal/storage').expect(200).then(res => res.body)
    await api.patch('/api/images/one').send({ favorited: true }).timeout(1_000).expect(200)
  } finally {
    unblock()
    await Promise.all([first, second])
  }
  expect(await first).toEqual(await second)
  expect(stats).toBe(1)
})

it('automatic backup leaves gallery writes and collection reads available during the media copy', async () => {
  const { app, repo, root, imagesDir } = setup()
  const copy = fs.promises.copyFile.bind(fs.promises)
  let release!: () => void
  let copying!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { copying = resolve })
  const pauseMedia = async (file: unknown) => {
    if (String(file) === path.join(imagesDir, 'main.png')) {
      copying()
      await blocked
    }
  }
  vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (from, to, flags) => {
    await pauseMedia(from)
    return copy(from, to, flags)
  })

  const backup = request(app).patch('/api/personal/backups/policy')
    .send({ enabled: true, intervalHours: 24, maxCount: 2, maxBytes: 1024 ** 2 }).then(response => response)
  try {
    await Promise.race([started, backup.then(response => { throw new Error(`备份未进入复制阶段：${response.status}`) })])
    expect((await request(app).get('/api/groups').timeout({ response: 1000 })).status).toBe(200)
    expect((await request(app).patch('/api/images/one').send({ prompt: 'new' }).timeout({ response: 1000 })).status).toBe(200)
    expect((await repo.listImages())[0].prompt).toBe('new')
    expect((await request(app).delete('/api/images/one')).status).toBe(200)
    expect((await request(app).delete('/api/trash/one').send({ confirm: true })).status).toBe(200)
    expect(fs.existsSync(path.join(imagesDir, 'main.png'))).toBe(false)
    // The captured file must be independent even if its original name is reused.
    fs.writeFileSync(path.join(imagesDir, 'main.png'), 'replacement')
  } finally {
    release()
    await backup
  }
  const status = (await request(app).get('/api/personal/backups')).body
  expect(status.automaticBackupError).toBeNull()
  const snapshot = path.join(root, 'backups', status.backups[0].id)
  expect(fs.readFileSync(path.join(snapshot, 'public/images/main.png'), 'utf8')).toBe('fixture')
  expect(JSON.parse(fs.readFileSync(path.join(snapshot, 'gallery-data.json'), 'utf8')).images[0].prompt).toBe('original')
  expect(fs.readdirSync(imagesDir)).toEqual(['main.png'])
  expect(fs.existsSync(path.join(root, 'gallery.json.backup-media.json'))).toBe(false)
})

it('does not publish an automatic snapshot that fails readback and retries the same on-disk index', async () => {
  const { app, root, repo } = setup()
  const policy = { enabled: true, intervalHours: 24, maxCount: 2, maxBytes: 1024 ** 2 }
  const write = fs.promises.writeFile.bind(fs.promises)
  const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
    await write(file, data, options)
    if (path.basename(String(file)) === 'backup-info.json') {
      fs.writeFileSync(path.join(path.dirname(String(file)), 'public/images/main.png'), 'corrupted')
    }
  })
  const first = await request(app).patch('/api/personal/backups/policy').send(policy)
  expect(first.body.automaticBackupError).toMatch(/校验失败/)
  const backupDir = path.join(root, 'backups')
  expect(fs.readdirSync(backupDir)).toEqual([])
  expect((await request(app).get('/api/personal/backups')).body.automaticBackupError).toBe(first.body.automaticBackupError)

  spy.mockRestore()
  // A disabled tick is not a successful backup and must not erase its error.
  const disabled = await request(app).patch('/api/personal/backups/policy').send({ ...policy, enabled: false })
  expect(disabled.body.automaticBackupError).toBe(first.body.automaticBackupError)
  repo.saveMetadata({ backupPolicy: policy })
  const stop = app.locals.startAutomaticBackups()
  try {
    await vi.waitFor(async () => {
      const status = (await request(app).get('/api/personal/backups')).body
      expect(status.automaticBackupBusy).toBe(false)
      expect(status.backups).toHaveLength(1)
      expect(status.automaticBackupError).toBeNull()
    })
  } finally { stop() }
})

it('hot reloads saved channels and removes old models without publishing credentials', async () => {
  const { app, root } = setup(true)
  const api = request(app)
  const endpoint = '/api/personal/provider-config'
  const before = await api.get(endpoint).expect(200)
  expect(before.body).toMatchObject({ canManage: true, agentTokenConfigured: false, skillPath: 'skills/banana-gallery' })
  const models = '/api/generation/models'
  const initial = (await api.get(models).expect(200)).body
  expect(initial.defaultModel.provider).toBe('demo')
  expect(initial.models).toContainEqual(expect.objectContaining({ provider: 'google', available: false }))
  const upload = endpoint + '/service-account'
  const invalid = await api.post(upload).send({ private_key: 'do-not-echo' }).expect(400)
  expect(invalid.text).not.toContain('do-not-echo')
  const malformed = await api.post(upload).type('json').send('{"private_key":"do-not-echo"').expect(400)
  expect(malformed.text).not.toContain('do-not-echo')
  await api.post(upload).send({ private_key: 'x'.repeat(256 * 1024) }).expect(413)
  const vertex = await api.post(upload).send({
    type: 'service_account', project_id: 'fixture-project', client_email: 'fixture@example.test', private_key: 'test-private-key',
  }).expect(200)
  expect(vertex.body.google).toMatchObject({ activeMode: 'vertex', projectId: 'fixture-project', clientEmail: 'fixture@example.test' })
  expect(vertex.text).not.toContain('test-private-key')
  const afterUpload = (await api.get(models).expect(200)).body
  expect(afterUpload.defaultModel.provider).toBe('google')
  expect(afterUpload.models).toContainEqual(expect.objectContaining({ provider: 'google', available: true }))

  const googleKey = 'test-google-key-abcd'
  const openaiKey = 'test-openai-key-efgh'
  const saved = await api.put(endpoint).send({
    google: { apiKey: googleKey },
    openaiCompatible: { apiKey: openaiKey, model: 'fixture-image', baseUrl: 'https://images.example.test/v1' },
  }).expect(200)
  expect(saved.body.google).toMatchObject({ apiKeyMasked: '...abcd', activeMode: 'vertex' })
  expect(saved.body.openaiCompatible).toMatchObject({ apiKeyMasked: '...efgh', source: 'ui' })
  expect(saved.text).not.toContain(googleKey)
  expect(saved.text).not.toContain(openaiKey)
  expect((await api.get('/api/generation/providers').expect(200)).body.providers).toContainEqual(
    expect.objectContaining({ id: 'openai-compatible', model: 'fixture-image', available: true }),
  )
  for (const route of [models, '/api/v1/models']) {
    expect((await api.get(route).expect(200)).body.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'google', available: true }),
      expect.objectContaining({ provider: 'openai-compatible', model: 'fixture-image', available: true }),
    ]))
  }
  await api.patch('/api/preferences').send({
    expectedVersion: 0, defaultGeneration: { provider: 'openai-compatible', model: 'fixture-image', aspectRatio: '1:1', quality: 'high' },
  }).expect(200)
  const snapshot = await api.post('/api/personal/backups').expect(201)
  expect(fs.existsSync(path.join(root, 'backups', snapshot.body.id, '.provider-config.json'))).toBe(false)
  expect(fs.existsSync(path.join(root, 'backups', snapshot.body.id, '.vertex-service-account.json'))).toBe(false)
  const cleared = await api.put(endpoint).send({
    google: { clearServiceAccount: true }, openaiCompatible: { apiKey: null, model: null },
  }).expect(200)
  expect(cleared.body.google.activeMode).toBe('apiKey')
  const after = (await api.get(models).expect(200)).body
  expect(after.defaultModel).toEqual({ provider: 'openai-compatible', model: 'gpt-image-1' })
  expect(after.models).not.toContainEqual(expect.objectContaining({ model: 'fixture-image' }))
})

it('uses the new OpenAI client on new submissions without interrupting an executing request', async () => {
  const { app } = setup(true, 'openai-compatible')
  const api = request(app)
  const endpoint = '/api/personal/provider-config'
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC'
  let finishOld!: () => void
  const waitForRelease = new Promise<void>(resolve => { finishOld = resolve })
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(url).toBe('https://relay.example.test/v1/images/generations')
    const { model } = JSON.parse(String(init?.body))
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer fixture-${model}`)
    if (model === 'old-model') await waitForRelease
    return Response.json({ data: [{ b64_json: png }] })
  })
  const submit = (model: string) => api.post('/api/generation-tasks').send({
    key: model, provider: 'openai-compatible', model, prompt: 'test reload', quality: 'medium',
  }).expect(202)
  try {
    await api.put(endpoint).send({ openaiCompatible: { apiKey: 'fixture-old-model', model: 'old-model', baseUrl: 'https://relay.example.test/v1' } }).expect(200)
    expect((await api.get('/api/generation/providers')).body.defaultProvider).toBe('openai-compatible')
    const before = await submit('old-model')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await api.put(endpoint).send({ openaiCompatible: { apiKey: 'fixture-new-model', model: 'new-model' } }).expect(200)
    expect((await api.get('/api/generation/models').expect(200)).body.defaultModel)
      .toEqual({ provider: 'openai-compatible', model: 'new-model' })
    const after = await submit('new-model')
    await vi.waitFor(async () => {
      expect((await api.get('/api/generation-tasks/' + after.body.id)).body.status).toBe('completed')
    })
    finishOld()
    await vi.waitFor(async () => {
      expect((await api.get('/api/generation-tasks/' + before.body.id)).body.status).toBe('completed')
    })
  } finally {
    finishOld()
    await app.locals.stopTaskQueue()
  }
})
