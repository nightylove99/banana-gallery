import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../../server/app'

const tempRoots: string[] = []
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
  'base64',
)

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 })
    } catch {
      // Ignore late async thumbnail warmup cleanup races on temporary test dirs.
    }
  }
})

function createLocalApp(options: Partial<Parameters<typeof createApp>[0]> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-gallery-gemini-import-'))
  tempRoots.push(root)

  return {
    root,
    app: createApp({
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
      ...options,
    }),
  }
}

async function getFreePort(excludedPort?: number): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve, reject) => probe.close((error) => (
    error ? reject(error) : resolve()
  )))
  return port === excludedPort ? getFreePort(excludedPort) : port
}

async function closeServer(server: ReturnType<ReturnType<typeof createApp>['listen']>) {
  await new Promise<void>((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )))
}

describe('Gemini web extension import API', () => {
  it('手动上传完成后也预热主图缩略图', async () => {
    const warmed: Array<{ source: string; size: string }> = []
    const { app, root } = createLocalApp({ thumbnailCache: { get: async source => source, warm: async (source, size='standard') => { warmed.push({source,size}); return source } } })
    const response = await request(app)
      .post('/api/images')
      .field('prompt', 'manual upload')
      .field('tags', '[]')
      .attach('image', tinyPng, { filename: 'manual.png', contentType: 'image/png' })
    expect(response.status).toBe(200)
    expect(warmed).toEqual(['standard','preview'].map(size=>({source:path.join(root,'images',response.body.filename),size})))
  })

  it('导入完成后异步预热缩略图，不阻塞保存响应', async () => {
    const warmed: Array<{ source: string; size: string }> = []
    const thumbnailCache = {
      get: async (source: string) => source,
      warm: (source: string, size='standard') => {
        warmed.push({source,size})
        return new Promise<string>(() => {})
      },
    }
    const { app, root } = createLocalApp({ thumbnailCache } as never)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await Promise.race([
        request(app)
          .post('/api/external/gemini-web/import')
          .field('metadata', JSON.stringify({ prompt: 'warm this image', assetType: 'work' }))
          .attach('image', tinyPng, { filename: 'result.png', contentType: 'image/png' }),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('import waited for thumbnail warmup')), 500) }),
      ])
      expect(response.status).toBe(200)
      expect(warmed).toEqual(['standard','preview'].map(size=>({source:path.join(root,'images',response.body.filename),size})))
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  })

  it('导入作品并按顺序保存参考图', async () => {
    const { app } = createLocalApp()

    const response = await request(app)
      .post('/api/external/gemini-web/import')
      .field('metadata', JSON.stringify({
        prompt: 'a banana gallery from Gemini',
        assetType: 'work',
        tags: ['saved'],
        sourceUrl: 'https://gemini.google.com/app/test',
        capturedAt: '2026-06-20T01:02:03.000Z',
      }))
      .attach('image', tinyPng, { filename: 'result.png', contentType: 'image/png' })
      .attach('references', tinyPng, { filename: 'ref-a.png', contentType: 'image/png' })
      .attach('references', tinyPng, { filename: 'ref-b.png', contentType: 'image/png' })

    expect(response.status).toBe(200)
    expect(response.body).toEqual(expect.objectContaining({
      prompt: 'a banana gallery from Gemini',
      assetType: 'work',
      tags: ['gemini-web', 'saved'],
      sourceFile: 'gemini-web',
        sourceType: 'gemini-web',
        sourceUrl: 'https://gemini.google.com/app/test',
        capturedAt: '2026-06-20T01:02:03.000Z',
      createdAt: '2026-06-20T01:02:03.000Z',
    }))
    expect(response.body.referenceImages).toHaveLength(2)
    expect(response.body.referenceImages[0]).toMatch(/^ref_/)
    expect(response.body.referenceImages[1]).toMatch(/^ref_/)
  })

  it('可以导入配方', async () => {
    const { app } = createLocalApp()

    const response = await request(app)
      .post('/api/external/gemini-web/import')
      .field('metadata', JSON.stringify({
        prompt: 'recipe prompt',
        assetType: 'recipe',
      }))
      .attach('image', tinyPng, { filename: 'result.png', contentType: 'image/png' })

    expect(response.status).toBe(200)
    expect(response.body.assetType).toBe('recipe')
    expect(response.body.tags).toEqual(['gemini-web'])
  })

  it('拒绝缺少主图、非图片和缺少提示词的请求', async () => {
    const { app } = createLocalApp()

    const noImage = await request(app)
      .post('/api/external/gemini-web/import')
      .field('metadata', JSON.stringify({ prompt: 'prompt' }))
    expect(noImage.status).toBe(400)
    expect(noImage.body).toEqual({ error: 'No image file' })

    const textFile = await request(app)
      .post('/api/external/gemini-web/import')
      .field('metadata', JSON.stringify({ prompt: 'prompt' }))
      .attach('image', Buffer.from('not image'), { filename: 'notes.txt', contentType: 'text/plain' })
    expect(textFile.status).toBe(400)
    expect(textFile.body).toEqual({ error: '仅支持 JPG、PNG、WebP 图片' })

    const noPrompt = await request(app)
      .post('/api/external/gemini-web/import')
      .field('metadata', JSON.stringify({ prompt: '' }))
      .attach('image', tinyPng, { filename: 'result.png', contentType: 'image/png' })
    expect(noPrompt.status).toBe(400)
    expect(noPrompt.body).toEqual({ error: '请提供提示词' })
  })

  it('personal-remote 配置下仍允许从本机监听端口导入', async () => {
    const localAccessPort = await getFreePort()
    const remoteAccessPort = await getFreePort(localAccessPort)
    const { app } = createLocalApp({
      userAuthMode: 'cloudflare_access',
      localAuthSession: undefined,
      cloudflareAccessVerifier: {
        verify: async (assertion) => (
          assertion === 'valid-assertion' ? { email: 'owner@example.com' } : null
        ),
      },
      cloudflareAccessSession: {
        user: { id: 'local-user', email: 'local-user@banana.gallery' },
        workspace: { id: 'local-workspace', name: 'Local Workspace' },
      },
      localAccessPort,
      remoteAccessPort,
    })
    const localServer = app.listen(localAccessPort, '127.0.0.1')

    try {
      const response = await request(`http://127.0.0.1:${localAccessPort}`)
        .post('/api/external/gemini-web/import')
        .field('metadata', JSON.stringify({ prompt: 'local personal prompt' }))
        .attach('image', tinyPng, { filename: 'result.png', contentType: 'image/png' })

      expect(response.status).toBe(200)
      expect(response.body.prompt).toBe('local personal prompt')
    } finally {
      await closeServer(localServer)
    }
  })

  it('personal-remote 配置下拒绝从远程监听端口调用扩展导入', async () => {
    const localAccessPort = await getFreePort()
    const remoteAccessPort = await getFreePort(localAccessPort)
    const { app } = createLocalApp({
      userAuthMode: 'cloudflare_access',
      localAuthSession: undefined,
      cloudflareAccessVerifier: {
        verify: async (assertion) => (
          assertion === 'valid-assertion' ? { email: 'owner@example.com' } : null
        ),
      },
      cloudflareAccessSession: {
        user: { id: 'local-user', email: 'local-user@banana.gallery' },
        workspace: { id: 'local-workspace', name: 'Local Workspace' },
      },
      localAccessPort,
      remoteAccessPort,
    })
    const remoteServer = app.listen(remoteAccessPort, '127.0.0.1')

    try {
      const response = await request(`http://127.0.0.1:${remoteAccessPort}`)
        .post('/api/external/gemini-web/import')
        .set('Cf-Access-Jwt-Assertion', 'valid-assertion')
        .field('metadata', JSON.stringify({ prompt: 'remote prompt' }))
        .attach('image', tinyPng, { filename: 'result.png', contentType: 'image/png' })

      expect(response.status).toBe(401)
      expect(response.body).toEqual({
        error: 'Gemini 网页扩展导入第一版仅支持 personal 本地入口',
      })
    } finally {
      await closeServer(remoteServer)
    }
  })


})
it('rejects non-web source URLs and removes uploaded fixture files on rejection',async()=>{
 const {app,root}=createLocalApp()
 const response=await request(app).post('/api/external/gemini-web/import').field('metadata',JSON.stringify({prompt:'test',sourceUrl:'javascript:alert(1)'})).attach('image',tinyPng,{filename:'image.png',contentType:'image/png'})
 expect(response.status).toBe(400)
 expect(fs.readdirSync(path.join(root,'images'))).toEqual([])
})

it('retries an identical import once, previews duplicate evidence and allows an explicit second record',async()=>{
 const {app,root}=createLocalApp()
 const metadata={prompt:'same prompt',assetType:'recipe',tags:['gemini-web'],sourceUrl:'https://gemini.google.com/app/test',capturedAt:'2026-09-11T00:00:00Z',requestId:'stable-request',checkDuplicates:true}
 const send=(body:unknown)=>request(app).post('/api/external/gemini-web/import').field('metadata',JSON.stringify(body)).attach('image',tinyPng,{filename:'capture.png',contentType:'image/png'})
 const first=await send(metadata);expect(first.status).toBe(200)
 const retry=await send(metadata);expect(retry.body.id).toBe(first.body.id);expect((await request(app).get('/api/images')).body).toHaveLength(1)
 const preview=await send({...metadata,requestId:'second-request'});expect(preview.status).toBe(200);expect(preview.body.requiresConfirmation).toBe(true);expect(preview.body.candidates[0].id).toBe(first.body.id)
 expect((await request(app).get('/api/images')).body).toHaveLength(1);expect(fs.readdirSync(path.join(root,'images'))).toHaveLength(1)
 const kept=await send({...metadata,requestId:'second-request',allowDuplicate:true});expect(kept.status).toBe(200);expect(kept.body.id).not.toBe(first.body.id)
 expect((await send({...metadata,prompt:'different input'})).status).toBe(409)
})

it.each(['prompt', 'title', 'category', 'tags', 'createdAt'])('rejects repeated upload field %s without blocking the gallery', async field => {
  const { app, root } = createLocalApp()
  const upload = () => request(app).post('/api/images').attach('image', tinyPng, 'manual.png')
  const existing = await upload().expect(200)
  const index = path.join(root, 'gallery-data.json')
  const original = fs.readFileSync(index)

  const rejected = await upload().field(field, ['first', 'second'])
  expect(rejected.status).toBe(400)
  expect(rejected.body.error).toContain(field)
  expect(fs.readFileSync(index)).toEqual(original)
  expect(fs.readdirSync(path.join(root, 'images'))).toEqual([existing.body.filename])
  await request(app).get(`/api/assets/images/${existing.body.filename}`).expect(200)
  await upload().field('prompt', 'valid').expect(200)
})

it('rejects repeated Gemini metadata and cleans the staged files', async () => {
  const { app, root } = createLocalApp()
  const rejected = await request(app).post('/api/external/gemini-web/import')
    .field('metadata', ['{"prompt":"first"}', '{"prompt":"second"}'])
    .attach('image', tinyPng, 'manual.png')
    .attach('references', tinyPng, 'ref.png')
  expect(rejected.status).toBe(400)
  expect(rejected.body.error).toContain('metadata')
  expect(fs.readdirSync(path.join(root, 'images'))).toEqual([])
  expect(fs.readdirSync(path.join(root, 'references'))).toEqual([])
})

it.each(['manual', 'Gemini', 'reference append'])('removes uncommitted %s files when the index cannot be saved', async kind => {
  const { app, root } = createLocalApp()
  const existing = await request(app).post('/api/images').attach('image', tinyPng, 'existing.png').expect(200)
  const index = path.join(root, 'gallery-data.json')
  // The existing image is still readable by listImages, but the repository must refuse to overwrite.
  const before = JSON.stringify({ images: [existing.body, { invalid: true }] })
  fs.writeFileSync(index, before)

  const upload = kind === 'manual'
    ? request(app).post('/api/images').attach('image', tinyPng, 'manual.png')
    : kind === 'Gemini'
      ? request(app).post('/api/external/gemini-web/import').field('metadata', '{"prompt":"valid"}')
        .attach('image', tinyPng, 'gemini.png').attach('references', tinyPng, 'ref.png')
      : request(app).post(`/api/images/${existing.body.id}/references`).attach('references', tinyPng, 'ref.png')
  await upload.expect(500)
  expect(fs.readFileSync(index, 'utf8')).toBe(before)
  expect(fs.readdirSync(path.join(root, 'images'))).toEqual([existing.body.filename])
  expect(fs.readdirSync(path.join(root, 'references'))).toEqual([])
})

it('rejects a file part in place of a text upload field', async () => {
  const { app, root } = createLocalApp()
  const rejected = await request(app).post('/api/images')
    .attach('image', tinyPng, 'manual.png')
    .attach('prompt', Buffer.from('not a text field'), 'prompt.txt')
  expect(rejected.status).toBe(400)
  expect(rejected.body.error).toContain('prompt')
  expect(fs.readdirSync(path.join(root, 'images'))).toEqual([])
})
