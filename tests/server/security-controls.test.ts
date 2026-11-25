import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../server/app'
import { JsonGalleryRepository } from '../../server/gallery/json-gallery-repository'
import { GalleryWriteCoordinator } from '../../server/gallery/write-coordinator'
import { DiskAssetStorage } from '../../server/storage/disk-asset-storage'
import { version } from '../../package.json'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function createLocalSecurityApp(options: Partial<Parameters<typeof createApp>[0]> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-gallery-security-'))
  tempRoots.push(root)

  return createApp({
    ai: {
      models: {
        generateContent: async () => ({ candidates: [] }),
      },
    },
    strategy: { mode: 'apiKey', apiKey: 'test-api-key' },
    dataFile: path.join(root, 'gallery-data.json'),
    imagesDir: path.join(root, 'images'),
    referencesDir: path.join(root, 'references'),
    userAuthMode: 'local',
    localAuthSession: {
      user: { id: 'local-user', email: 'local-user@banana.gallery' },
      workspace: { id: 'local-workspace', name: 'Local Workspace' },
    },
    corsAllowedOrigins: ['http://allowed.example'],
    ...options,
  })
}

describe('security controls', () => {
  it('只对允许的 Origin 返回 CORS 响应头', async () => {
    const app = createLocalSecurityApp()

    const allowed = await request(app)
      .get('/api/session')
      .set('Origin', 'http://allowed.example')

    expect(allowed.status).toBe(200)
    expect(allowed.headers['access-control-allow-origin']).toBe('http://allowed.example')

    const denied = await request(app)
      .get('/api/session')
      .set('Origin', 'http://denied.example')

    expect(denied.status).toBe(200)
    expect(denied.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('会拒绝非图片类型的上传文件', async () => {
    const app = createLocalSecurityApp()

    const response = await request(app)
      .post('/api/references/upload')
      .attach('references', Buffer.from('not-an-image'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: '仅支持 JPG、PNG、WebP 图片' })
  })
})

async function listenOnLoopback(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function createDualSecurityApp(options: Partial<Parameters<typeof createApp>[0]> = {}) {
  const local = createServer(), remote = createServer()
  const localAccessPort = await listenOnLoopback(local)
  const remoteAccessPort = await listenOnLoopback(remote)
  const app = createLocalSecurityApp({
    userAuthMode: 'cloudflare_access',
    localAuthSession: undefined,
    localAccessPort,
    remoteAccessPort,
    cloudflareAccessVerifier: { verify: async assertion => assertion === 'valid' ? { email: 'local-user@banana.gallery' } : null },
    cloudflareAccessSession: {user:{id:'local-user',email:'local-user@banana.gallery'},workspace:{id:'local-workspace',name:'Local Workspace'}},
    ...options,
  })
  local.on('request', app)
  remote.on('request', app)
  const close = async () => {
    await app.locals.stopTaskQueue()
    await Promise.all([local, remote].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  }
  const post = (server: Server, route: string) => request(server).post(route)
    .set('cf-access-jwt-assertion','valid')
    .set('Host', `localhost:${localAccessPort}`)
    .set('X-Forwarded-Port', String(localAccessPort))
    .set('X-Forwarded-Host', `localhost:${localAccessPort}`)
  return {local, remote, close, post}
}

it.each(['/api/generation-tasks', '/api/references/upload'])('applies independent socket-based rate buckets to %s', async route => {
  const {local, remote, close, post} = await createDualSecurityApp()
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  const send = (server: Server) => post(server, route).send({})
  try {
    for(let i=0;i<120;i++) expect((await send(local)).status).toBe(400)
    now.mockReturnValue(59_999)
    const localLimited=await send(local)
    expect(localLimited).toMatchObject({status:429,body:{error:'请求过于频繁，请稍后再试',code:'RATE_LIMITED'}})
    expect(localLimited.headers['retry-after']).toBe('2')
    for(let i=0;i<20;i++) expect((await send(remote)).status).toBe(400)
    const remoteLimited=await send(remote)
    expect(remoteLimited).toMatchObject({status:429,body:{code:'RATE_LIMITED'}})
    expect(remoteLimited.headers['retry-after']).toBe('60')
    now.mockReturnValue(61_000)
    expect((await send(local)).status).toBe(400)
    expect((await send(remote)).status).toBe(429)
  } finally {
    now.mockRestore()
    await close()
  }
})

it('honors a test-injected limit and window for generation', async () => {
  const app = createLocalSecurityApp({securityLimits:{generate:{max:1,windowMs:1_500}}})
  const now = vi.spyOn(Date,'now').mockReturnValue(1_000)
  try {
    const post=()=>request(app).post('/api/generation-tasks').send({})
    expect((await post()).status).toBe(400)
    const limited=await post()
    expect(limited).toMatchObject({status:429,body:{code:'RATE_LIMITED'}})
    expect(limited.headers['retry-after']).toBe('2')
    now.mockReturnValue(2_500)
    expect((await post()).status).toBe(400)
  } finally {now.mockRestore()}
})


it('rejects a remote submission after local tasks fill the shared 20-slot threshold', async () => {
  const {local, remote, close, post} = await createDualSecurityApp({
    imageGenerationProvider: {generateImage: () => new Promise(() => {})},
  })
  const submit = (server: Server, key: string) => post(server, '/api/generation-tasks').send({
    key, prompt: 'queue fixture', provider: 'google', model: 'gemini-nano-banana-2.1',
  })
  try {
    for (let index = 0; index < 19; index++) expect((await submit(local, `local-${index}`)).status).toBe(202)
    expect((await submit(remote, 'remote-20')).status).toBe(202)
    expect(await submit(remote, 'remote-21')).toMatchObject({status:429,body:{code:'QUEUE_FULL'}})
    expect((await submit(local, 'local-21')).status).toBe(202)
    expect(await submit(remote, 'remote-22')).toMatchObject({status:429,body:{code:'QUEUE_FULL'}})
  } finally {await close()}
})


function expectNoUploadedFiles() {
  const root = tempRoots.at(-1)!
  expect(fs.readdirSync(path.join(root, 'images'))).toEqual([])
  expect(fs.readdirSync(path.join(root, 'references'))).toEqual([])
}

it.each([
  ['post', '/api/images', 'image'],
  ['post', '/api/external/gemini-web/import', 'image'],
  ['post', '/api/images/work/references', 'references'],
  ['post', '/api/references/upload', 'references'],
  ['put', '/api/images/work/references', 'references'],
] as const)('authenticates before parsing %s %s', async (method, url, field) => {
  const { remote, close } = await createDualSecurityApp()
  try {
    await request(remote)[method](url)
      .attach(field, Buffer.from('not an image'), { filename: 'file.txt', contentType: 'text/plain' })
      .expect(401, { error: 'UNAUTHORIZED' })
    expectNoUploadedFiles()
  } finally {
    await close()
  }
})

it('rejects Gemini uploads on the remote listener even with an Access session', async () => {
  const { remote, close, post } = await createDualSecurityApp()
  try {
    await post(remote, '/api/external/gemini-web/import')
      .attach('image', Buffer.from('not an image'), { filename: 'file.txt', contentType: 'text/plain' })
      .expect(401)
    expectNoUploadedFiles()
  } finally {
    await close()
  }
})

it('does not leave files when finalizing a reference upload fails', async () => {
  const app = createLocalSecurityApp()
  const finalize = vi.spyOn(DiskAssetStorage.prototype, 'finalizeReferences')
    .mockRejectedValueOnce(new Error('reference storage failure'))
  try {
    await request(app).post('/api/references/upload')
      .attach('references', Buffer.from('test bytes'), 'file.jpg')
      .expect(500)
    expectNoUploadedFiles()
  } finally {
    finalize.mockRestore()
  }
})

it('does not leave files if the write coordinator fails before running the handler', async () => {
  const app = createLocalSecurityApp()
  const lock = vi.spyOn(GalleryWriteCoordinator.prototype, 'run')
    .mockRejectedValueOnce(new Error('write lock failure'))
  try {
    await request(app).post('/api/images')
      .attach('image', Buffer.from('test bytes'), 'file.jpg')
      .expect(500)
    expectNoUploadedFiles()
  } finally {
    lock.mockRestore()
  }
})

it('does not leave files when saving a Gemini import fails before finalization', async () => {
  const app = createLocalSecurityApp()
  const list = vi.spyOn(JsonGalleryRepository.prototype, 'listImages')
    .mockRejectedValueOnce(new Error('gallery read failure'))
  try {
    await request(app).post('/api/external/gemini-web/import')
      .field('metadata', JSON.stringify({ prompt: 'fixture' }))
      .attach('image', Buffer.from('test bytes'), 'file.jpg')
      .attach('references', Buffer.from('test bytes'), 'ref.jpg')
      .expect(500)
    expectNoUploadedFiles()
  } finally {
    list.mockRestore()
  }
})

it('disables local path imports by default, but accepts the local opt-in', async () => {
  const app = createLocalSecurityApp()
  await request(app).post('/api/import').send({}).expect(403)
  const enabled = createLocalSecurityApp({ allowServerSideImport: true })
  await request(enabled).post('/api/import').send({}).expect(400)
})

it('disables local path imports on both listeners in Cloudflare Access mode', async () => {
  const { local, remote, close, post } = await createDualSecurityApp({ allowServerSideImport: true })
  try {
    for (const server of [local, remote]) {
      await post(server, '/api/import').send({}).expect(403)
    }
  } finally {
    await close()
  }
})

it('reports only health status, version and auth mode without a session', async () => {
  const app = createLocalSecurityApp({ localAuthSession: undefined })
  await request(app).get('/api/health').expect(200, { status: 'ok', version, authMode: 'local' })
  const { remote, close } = await createDualSecurityApp()
  try {
    await request(remote).get('/api/health').expect(200, { status: 'ok', version, authMode: 'cloudflare_access' })
  } finally {
    await close()
  }
})
