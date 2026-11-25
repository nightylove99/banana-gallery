import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { afterEach, expect, it } from 'vitest'
import { createApp } from '../../server/app'
import { loadAppEnv, type UserAuthMode } from '../../server/config/env'
import { workCode } from '../../server/gallery/work-code'
import type { GenerationTask } from '../../src/types'

const token = 'fixture-agent-token'
const session = { user: { id: 'u', email: 'fixture@example.test' }, workspace: { id: 'w', name: 'Fixture' } }
const work = {
  id: 'work', filename: 'old.png', prompt: 'original prompt', referenceImages: [],
  tags: [], favorited: false, assetType: 'work', createdAt: '2026-01-01T00:00:00Z', width: 1, height: 1,
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC', 'base64')
const diagnostics = 'private-provider-response at /private/upstream/debug.txt'
const task: GenerationTask = {
  id: 'old-task', key: 'old-key', scope: { workspaceId: 'w', userId: 'u' },
  status: 'failed', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  input: { prompt: 'old', provider: 'demo', model: 'banana-demo-v1', aspectRatio: '1:1', referenceFilenames: [] },
  error: diagnostics, workSaveError: diagnostics, upstreamTaskId: diagnostics, runnerId: diagnostics,
  failure: { category: 'unknown', message: diagnostics, requestId: diagnostics, detail: diagnostics, retryable: false, uncertain: false },
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

function fixture(mode: UserAuthMode = 'local', apiToken = token) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-agent-api-'))
  const dataFile = path.join(root, 'gallery-data.json')
  fs.writeFileSync(dataFile, JSON.stringify({ images: [work], resources: { generationTasks: [task] } }))
  const app = createApp({
    ai: { models: { generateContent: async () => ({ candidates: [] }) } },
    strategy: { mode: 'demo', model: 'banana-demo-v1' },
    imageGenerationProviders: {
      google: { generateImage: async () => ({ buffer: png, mimeType: 'image/png' }) },
    },
    dataFile, imagesDir: path.join(root, 'images'), referencesDir: path.join(root, 'references'),
    userAuthMode: mode, agentApiToken: apiToken,
    localAuthSession: mode === 'local' ? session : undefined,
    cloudflareAccessSession: mode === 'cloudflare_access' ? session : undefined,
    cloudflareAccessVerifier: { verify: async () => null },
    allowServerSideImport: true,
  })
  fs.writeFileSync(path.join(root, 'images', 'old.png'), png)
  cleanup.push(async () => {
    await app.locals.stopTaskQueue()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { api: request(app), dataFile }
}

it('loads an optional instance token without changing the default', () => {
  expect(loadAppEnv({}).agentApiToken).toBeUndefined()
  expect(loadAppEnv({ BANANA_GALLERY_API_TOKEN: token }).agentApiToken).toBe(token)
})

it.each(['local', 'cloudflare_access'] as const)('restricts agent credentials in %s mode', async mode => {
  const { api, dataFile } = fixture(mode)
  const auth = { Authorization: `Bearer ${token}` }
  const before = fs.readFileSync(dataFile, 'utf8')
  await api.get('/api/v1/models').set(auth).expect(200)
  await api.get('/api/v1/models').set('Authorization', 'Bearer invalid-secret').expect(401)
  await api.get('/api/v1/models').expect(mode === 'local' ? 200 : 401)
  await api.delete('/api/images/work').set(auth).expect(403)
  await api.get('/api/trash').set(auth).expect(403)
  await api.delete('/api/trash/work').set(auth).send({ confirm: true, expectedVersion: 1 }).expect(403)
  await api.post('/api/trash/work/restore').set(auth).send({ expectedVersion: 1 }).expect(403)
  await api.post('/api/generation-tasks/trash-all').set(auth).expect(403)
  await api.post('/api/import').set(auth).send({ markdownPath: 'not-allowed', vaultImagesPath: 'not-allowed' }).expect(403)
  await api.get('/api/personal/backups').set(auth).expect(403)
  await api.post('/api/personal/backups').set(auth).expect(403)
  await api.patch('/api/images/work').set(auth).send({ title: 'not allowed' }).expect(403)
  await api.post('/api/images').set(auth).attach('image', png, 'not-allowed.png').expect(403)
  expect(fs.readFileSync(dataFile, 'utf8')).toBe(before)
})

it('keeps zero-config local web and v1 access', async () => {
  const { api } = fixture('local', '')
  await api.get('/api/v1/models').expect(200)
  await api.get('/api/v1/tasks/old-task').expect(200)
    .expect(({ text }) => expect(text).not.toContain(diagnostics))
  await api.get('/api/generation-tasks/old-task').expect(200)
    .expect(({ body }) => expect(body.error).toBe(diagnostics))
  await api.delete('/api/images/work').expect(200)
})

it('serves public v1 works, recipes, references and shared task receipts', async () => {
  const { api } = fixture('cloudflare_access')
  const auth = { Authorization: `Bearer ${token}` }
  await api.get('/api/v1/health').expect(200).expect(({ body }) => expect(body.status).toBe('ok'))
  await api.get('/api/v1/works?assetType=recipe').set(auth).expect(200)
    .expect(({ body }) => expect(body.items).toMatchObject([{ workCode: workCode('work') }]))
  await api.get(`/api/v1/works/${encodeURIComponent(workCode('work'))}/context`).set(auth).expect(200)
    .expect(({ body }) => expect(body.prompt).toBe(work.prompt))
  await api.get('/api/assets/images/old.png').set(auth).expect(200)
  await api.post('/api/v1/recipes').set(auth).send({ workId: 'work', title: 'Copied', tags: ['test'] }).expect(200)
    .expect(({ body }) => expect(body).toMatchObject({ title: 'Copied', tags: ['test'], sourceAssetId: 'work' }))
  await api.post('/api/v1/recipes').set(auth).field('prompt', 'Uploaded recipe').attach('image', png, 'sample.png').expect(200)
    .expect(({ body }) => expect(body).toMatchObject({ assetType: 'recipe', prompt: 'Uploaded recipe' }))
  await api.get('/api/v1/recipes?fields=full').set(auth).expect(200)
    .expect(({ body }) => expect(body.items).toHaveLength(2))
  await api.get('/api/v1/works').set(auth).expect(200)
    .expect(({ body }) => expect(body.items).toHaveLength(1))

  const uploaded = await api.post('/api/v1/references/upload').set(auth).attach('references', png, 'sample.png').expect(200)
  expect(uploaded.body.filenames).toHaveLength(1)
  const input = {
    key: 'shared-key', provider: 'google', model: 'gemini-nano-banana-2.1',
    prompt: 'reference test', referenceFilenames: uploaded.body.filenames,
  }
  const submitted = await api.post('/api/v1/tasks').set(auth).send(input).expect(202)
  expect(submitted.body.input.referenceFilenames).toEqual(uploaded.body.filenames)
  expect(submitted.body).not.toHaveProperty('scope')
  await api.post('/api/v1/tasks').set(auth).send(input).expect(202)
    .expect(({ body }) => expect(body.id).toBe(submitted.body.id))
  await api.get('/api/generation-tasks/by-key/shared-key').set(auth).expect(200)
    .expect(({ body }) => expect(body.id).toBe(submitted.body.id))
  await api.post('/api/v1/tasks').set(auth).send({ ...input, prompt: 'changed' }).expect(409)
  await api.get('/api/v1/tasks/by-key/missing').set(auth).expect(404)
    .expect(({ body }) => expect(body.code).toBe('TASK_KEY_NOT_FOUND'))
  await api.post('/api/v1/tasks').set(auth).type('json').send('{malformed').expect(400)
    .expect(({ body }) => expect(body.error).toBe('Invalid request body'))

  for (const route of ['/api/v1/tasks?view=raw', '/api/v1/tasks/old-task', '/api/v1/tasks/by-key/old-key',
    '/api/generation-tasks', '/api/generation-tasks/old-task', '/api/generation-tasks/by-key/old-key']) {
    const response = await api.get(route).set(auth).expect(200)
    expect(response.text).not.toMatch(/private-provider-response|runnerId|upstreamTaskId|requestId|responseEvidence|debug.txt/)
    if (route === '/api/v1/tasks?view=raw') {
      expect(response.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'old-task' })]))
    }
  }
})
