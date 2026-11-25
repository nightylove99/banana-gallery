import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import request from 'supertest'
import { afterEach, expect, it, vi } from 'vitest'

import { createApp } from '../../server/app'
import * as workCodes from '../../server/gallery/work-code'
import { JsonGalleryRepository } from '../../server/gallery/json-gallery-repository'
import type { GalleryImage } from '../../src/types'

const tempRoots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function createImage(overrides: Partial<GalleryImage> = {}): GalleryImage {
  return {
    id: 'workspace-image-1',
    filename: 'workspace-image-1.jpg',
    prompt: 'banana gallery prompt',
    referenceImages: [],
    tags: ['banana'],
    favorited: false,
    createdAt: '2026-03-19T00:00:00.000Z',
    width: 1024,
    height: 768,
    assetType: 'work',
    ...overrides,
  }
}

const session = {
  user: { id: 'local-user', email: 'local-user@banana.gallery' },
  workspace: { id: 'local-workspace', name: 'Local Workspace' },
}
const scope = { workspaceId: session.workspace.id, ownerUserId: session.user.id, userId: session.user.id }

function createLocalApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-gallery-work-codes-'))
  tempRoots.push(root)
  const dataFile = path.join(root, 'gallery-data.json')
  const galleryRepository = new JsonGalleryRepository(dataFile)
  const app = createApp({
    ai: { models: { generateContent: async () => ({ candidates: [] }) } },
    strategy: { mode: 'apiKey', apiKey: 'test-api-key' },
    dataFile,
    imagesDir: path.join(root, 'images'),
    referencesDir: path.join(root, 'references'),
    galleryRepository,
    localAuthSession: session,
  })
  return { app, galleryRepository }
}

it('resolves local image codes and links new and legacy generation results', async () => {
  const { app, galleryRepository } = createLocalApp()
  const image = createImage()
  const lookup = '/api/gallery/works/by-code/%23f75g25xx80'
  await galleryRepository.saveImages([image], scope)

  expect((await request(app).get(lookup)).body).toEqual({ id: image.id, prompt: image.prompt })
  expect((await request(app).get('/api/images')).body[0].workCode).toBe('#F75G25XX80')

  const job: import('../../src/types').GenerationTask = {
    id: 'legacy', key: 'legacy', scope,
    input: { prompt: 'task snapshot', provider: 'google', model: 'gemini-nano-banana-2.1', referenceFilenames: [], aspectRatio: '1:1' },
    status: 'completed', createdAt: image.createdAt, updatedAt: image.createdAt,
    result: { filename: image.filename, prompt: 'task snapshot', provider: 'google', model: 'gemini-nano-banana-2.1', aspectRatio: '1:1', width: 1024, height: 1024 },
  }
  await galleryRepository.saveResources({ generationTasks: [
    job,
    { ...job, id: 'linked', key: 'linked', workAssetId: image.id },
    { ...job, id: 'pending', key: 'pending', workSavePending: true, result: { ...job.result!, filename: 'pending.png' } },
  ] }, scope)
  const contextUrl = lookup + '/context'
  const taskUrl = '/api/generation-tasks/linked'
  const context = await request(app).get(contextUrl)
  expect(context.status).toBe(200)
  expect(context.body).toMatchObject({
    id: image.id, prompt: image.prompt, workCode: '#F75G25XX80',
    imageUrl: '/api/assets/images/' + encodeURIComponent(image.filename),
    generationTask: { id: 'linked', input: job.input },
  })
  const taskResponse = await request(app).get(taskUrl)
  expect(taskResponse.status, taskResponse.text).toBe(200)
  expect(taskResponse.body).toMatchObject({
    id: 'linked', workCode: '#F75G25XX80', status: 'completed',
  })
  expect((await request(app).get('/api/generation-tasks/pending')).body)
    .toMatchObject({ id: 'pending', workSavePending: true })
  const list = async () => (await request(app).get('/api/generation-tasks')).body.tasks as import('../../src/types').GenerationTask[]
  expect((await list()).find(task => task.id === 'legacy')?.workCode).toBe('#F75G25XX80')
  expect((await list()).find(task => task.id === 'linked')?.workCode).toBe('#F75G25XX80')
  expect((await list()).find(task => task.id === 'pending')?.workCode).toBeUndefined()

  await galleryRepository.saveResources({ generationTasks: [job] }, scope)
  expect((await request(app).get(contextUrl)).body.generationTask.id).toBe('legacy')
  expect((await request(app).post('/api/generation-tasks/legacy/trash').send({})).status).toBe(200)
  expect((await request(app).get(contextUrl)).body)
    .toMatchObject({ generationTask: { id: 'legacy', input: job.input } })
  expect((await request(app).get('/api/generation-tasks?view=summary&limit=10')).body.items).toEqual([])
  expect((await request(app).get('/api/generation-tasks/legacy')).status).toBe(404)

  const updated = await request(app).patch(`/api/images/${image.id}`).send({ prompt: 'updated prompt' })
  expect(updated.body.workCode).toBe('#F75G25XX80')
  expect((await request(app).get(lookup)).body.prompt).toBe('updated prompt')
  await galleryRepository.saveImages([{ ...image, deletedAt: image.createdAt }], scope)
  expect((await request(app).get(lookup)).status).toBe(404)
  expect((await list()).every(task => task.workCode === undefined)).toBe(true)
})

it('rejects ambiguous image codes and only uses filename fallback for a unique active work', async () => {
  const { app, galleryRepository } = createLocalApp()
  const first = createImage()
  const second = createImage({ id: 'second-image' })
  await galleryRepository.saveImages([first, second], scope)
  vi.spyOn(workCodes, 'workCode').mockReturnValue('#F75G25XX80')

  const lookup = '/api/gallery/works/by-code/F75G25XX80'
  expect((await request(app).get(lookup)).status).toBe(409)
  const job: import('../../src/types').GenerationTask = {
    id: 'legacy-duplicate', key: 'legacy-duplicate', scope,
    input: { prompt: 'snapshot', provider: 'google', model: 'gemini-nano-banana-2.1', referenceFilenames: [], aspectRatio: '1:1' },
    status: 'completed', createdAt: first.createdAt, updatedAt: first.createdAt,
    result: { filename: first.filename, prompt: 'snapshot', provider: 'google', model: 'gemini-nano-banana-2.1', aspectRatio: '1:1', width: 1024, height: 768 },
  }
  await galleryRepository.saveResources({ generationTasks: [job] }, scope)
  const list = async () => (await request(app).get('/api/generation-tasks')).body.tasks as import('../../src/types').GenerationTask[]
  expect((await list())[0].workCode).toBeUndefined()

  await galleryRepository.saveImages([first, { ...second, assetType: 'recipe' }], scope)
  expect((await request(app).get(lookup)).body.id).toBe(first.id)
  expect((await list())[0].workCode).toBe('#F75G25XX80')
})
