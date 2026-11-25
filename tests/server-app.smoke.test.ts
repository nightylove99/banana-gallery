import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { submitGeneration, waitForGeneration } from './helpers/generation-queue'
import { createApp } from '../server/app'
import type { ImageGenerationProvider } from '../server/ai/image-generation-provider'
import type { ImageGenerationProviderName } from '../src/lib/image-generation-providers'
import type { GenAIAuthStrategy } from '../server/genai-auth'
import type { GalleryImage } from '../src/types'

const tempRoots: string[] = []
const apps: Array<ReturnType<typeof createApp>> = []
const submit = (app: ReturnType<typeof createApp>, input: Record<string, unknown>) =>
  submitGeneration(app, input)
const waitForTask = (app: ReturnType<typeof createApp>, id: string) =>
  waitForGeneration(app, id)
const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC'

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.locals.stopTaskQueue()))
  vi.restoreAllMocks()
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function createImage(overrides: Partial<GalleryImage> = {}): GalleryImage {
  return {
    id: 'image-1',
    filename: 'image-1.jpg',
    prompt: 'banana gallery prompt',
    referenceImages: ['ref-1.jpg', 'ref-2.png'],
    tags: ['banana'],
    favorited: false,
    createdAt: '2026-03-19T00:00:00.000Z',
    width: 1024,
    height: 768,
    assetType: 'work',
    ...overrides,
  }
}

function writeGalleryData(dataFile: string, images: GalleryImage[]) {
  fs.writeFileSync(dataFile, JSON.stringify({ images }, null, 2))
}

function readGalleryData(dataFile: string) {
  return JSON.parse(fs.readFileSync(dataFile, 'utf-8')) as { images: GalleryImage[] }
}

function importFromWorktree<T>(relativePath: string) {
  return import(pathToFileURL(path.join(process.cwd(), relativePath)).href) as Promise<T>
}

function createTestApp(options: {
  strategy?: GenAIAuthStrategy
  images?: GalleryImage[]
  galleryRepository?: unknown
  assetStorage?: unknown
  ai?: {
    models: {
      generateContent: (request: GenerateContentParameters) => Promise<GenerateContentResponse>
    }
  }
  anonymous?: boolean
  localAuthSession?: {
    user: { id: string; email: string }
    workspace: { id: string; name: string }
  }
  allowServerSideImport?: boolean
  showDeveloperDiagnostics?: boolean
  imageGenerationProvider?: ImageGenerationProvider
  defaultImageGenerationProvider?: ImageGenerationProviderName
  defaultImageGenerationModel?: string
  imageGenerationProviders?: Partial<Record<ImageGenerationProviderName, ImageGenerationProvider>>
  imageGenerationModelProviders?: Record<string, ImageGenerationProvider>
  imageGenerationProviderAvailability?: Partial<Record<ImageGenerationProviderName, boolean>>
  imageGenerationProviderModels?: Partial<Record<ImageGenerationProviderName, string>>
} = {}) {
  const {
    strategy = { mode: 'apiKey', apiKey: 'test-api-key' },
    images,
    localAuthSession = {
      user: { id: 'user-test', email: 'user@example.com' },
      workspace: { id: 'workspace-test', name: 'Workspace Test' },
    },
    allowServerSideImport,
    showDeveloperDiagnostics = true,
    ai: injectedAi,
  } = options
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-gallery-app-'))
  tempRoots.push(root)

  const dataFile = path.join(root, 'gallery-data.json')
  const imagesDir = path.join(root, 'images')
  const referencesDir = path.join(root, 'references')

  if (images) {
    writeGalleryData(dataFile, images)
  }

  const ai = injectedAi ?? {
    models: {
      generateContent: async (request: GenerateContentParameters) => {
        void request
        return { candidates: [] } as GenerateContentResponse
      },
    },
  }

  const app = createApp({
    ai,
    strategy,
    dataFile,
    imagesDir,
    referencesDir,
    localAuthSession: options.anonymous ? undefined : localAuthSession,
    allowServerSideImport,
    showDeveloperDiagnostics,
    ...(options.imageGenerationProvider ? { imageGenerationProvider: options.imageGenerationProvider } : {}),
    ...(options.defaultImageGenerationProvider
      ? { defaultImageGenerationProvider: options.defaultImageGenerationProvider }
      : {}),
    ...(options.defaultImageGenerationModel
      ? { defaultImageGenerationModel: options.defaultImageGenerationModel }
      : {}),
    ...(options.imageGenerationProviders
      ? { imageGenerationProviders: options.imageGenerationProviders }
      : {}),
    ...(options.imageGenerationModelProviders
      ? { imageGenerationModelProviders: options.imageGenerationModelProviders }
      : {}),
    ...(options.imageGenerationProviderAvailability
      ? { imageGenerationProviderAvailability: options.imageGenerationProviderAvailability }
      : {}),
    ...(options.imageGenerationProviderModels
      ? { imageGenerationProviderModels: options.imageGenerationProviderModels }
      : {}),
    ...(options.galleryRepository ? { galleryRepository: options.galleryRepository } : {}),
    ...(options.assetStorage ? { assetStorage: options.assetStorage } : {}),
  } as Parameters<typeof createApp>[0])

  apps.push(app)
  return {
    app,
    root,
    dataFile,
    imagesDir,
    referencesDir,
  }
}

describe('createApp 冒烟测试', () => {
  it('真实 HTTP 客户端提交异步任务后仍可取回生成结果', async () => {
    const { app } = createTestApp({
      localAuthSession: {
        user: { id: 'local-user', email: 'local@example.com' },
        workspace: { id: 'local-workspace', name: 'Local Workspace' },
      },
      ai: {
        models: {
          generateContent: async () => ({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        data: tinyPngBase64,
                        mimeType: 'image/png',
                      },
                    },
                  ],
                },
              },
            ],
          } as GenerateContentResponse),
        },
      },
    })

    const server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Failed to bind test server')

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/generation-tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'real-http-generation',
          provider: 'google',
          model: 'gemini-nano-banana-2.1',
          prompt: 'banana',
          referenceFilenames: [],
          imageSize: '2K',
          aspectRatio: '1:1',
          outputFormat: 'png',
        }),
        signal: AbortSignal.timeout(1500),
      })

      expect(response.status).toBe(202)
      const job = await waitForGeneration(app, (await response.json()).id)
      expect(job.result).toEqual(expect.objectContaining({
        filename: expect.stringMatching(/^gen_.*\.png$/),
        prompt: 'banana',
      }))
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    }
  })

  it('生成接口优先使用注入的图片生成 provider', async () => {
    let receivedPrompt = ''
    let receivedAspectRatio = ''
    const { app } = createTestApp({
      localAuthSession: {
        user: { id: 'local-user', email: 'local@example.com' },
        workspace: { id: 'local-workspace', name: 'Local Workspace' },
      },
      imageGenerationProvider: {
        generateImage: async (input) => {
          receivedPrompt = input.prompt
          receivedAspectRatio = input.aspectRatio
          return {
            buffer: Buffer.from(tinyPngBase64, 'base64'),
            mimeType: 'image/png',
          }
        },
      },
    })

    const response = await submit(app, {
        prompt: 'injected provider prompt',
        referenceFilenames: [],
        imageSize: '1K',
        aspectRatio: '1:1',
        outputFormat: 'png',
      })

    expect(response.status).toBe(202)
    const job = await waitForTask(app, response.body.id)
    expect(job.result?.filename).toMatch(/^gen_.*\.png$/)
    expect(receivedPrompt).toBe('injected provider prompt')
    expect(receivedAspectRatio).toBe('1:1')
  })

  it('生成接口按请求中的供应商选择对应 provider', async () => {
    const calls: string[] = []
    const makeProvider = (name: string): ImageGenerationProvider => ({
      generateImage: async () => {
        calls.push(name)
        return {
          buffer: Buffer.from(tinyPngBase64, 'base64'),
          mimeType: 'image/png',
        }
      },
    })
    const { app } = createTestApp({
      localAuthSession: {
        user: { id: 'local-user', email: 'local@example.com' },
        workspace: { id: 'local-workspace', name: 'Local Workspace' },
      },
      defaultImageGenerationProvider: 'google',
      imageGenerationProviders: {
        seedream: makeProvider('seedream'),
        google: makeProvider('google'),
        qwen: makeProvider('qwen'),
        kling: makeProvider('kling'),
        'openai-compatible': makeProvider('openai-compatible'),
      },
    })

    const response = await submit(app, {
        provider: 'seedream',
        model: 'doubao-seedream-5-5-261028',
        prompt: 'seedream prompt',
        referenceFilenames: [],
        imageSize: '2K',
        aspectRatio: '4:5',
      })

    expect(response.status).toBe(202)
    expect((await waitForTask(app, response.body.id)).status).toBe('completed')
    expect(calls).toEqual(['seedream'])
  })

  it('生成接口按标准模型 ID 路由', async () => {
    const calls: string[] = []
    const makeProvider = (name: string): ImageGenerationProvider => ({
      generateImage: async () => {
        calls.push(name)
        return {
          buffer: Buffer.from(tinyPngBase64, 'base64'),
          mimeType: 'image/png',
        }
      },
    })
    const { app } = createTestApp({
      imageGenerationModelProviders: {
        'seedream:doubao-seedream-5-5-261028': makeProvider('seedream'),
        'google:gemini-nano-banana-2.1': makeProvider('google'),
        'qwen:qwen-image-3.0-pro': makeProvider('qwen'),
        'kling:kling/kling-v3-omni-image-generation': makeProvider('kling'),
        'openai-compatible:gpt-image-1': makeProvider('openai-compatible'),
      },
    })
    const requests = [
      {
        provider: 'seedream',
        model: 'doubao-seedream-5-5-261028',
        aspectRatio: '1:1',
        imageSize: '2K',
      },
      {
        provider: 'google',
        model: 'gemini-nano-banana-2.1',
        aspectRatio: '1:1',
        imageSize: '2K',
      },
      {
        provider: 'qwen',
        model: 'qwen-image-3.0-pro',
        aspectRatio: '1:1',
        imageSize: '2K',
      },
      {
        provider: 'kling',
        model: 'kling/kling-v3-omni-image-generation',
        aspectRatio: '16:9',
        imageSize: '4K',
      },
      {
        provider: 'openai-compatible',
        model: 'gpt-image-1',
        aspectRatio: '2:3',
        quality: 'high',
      },
    ]

    for (const selection of requests) {
      const response = await submit(app, {
          ...selection,
          prompt: 'model route',
          referenceFilenames: [],
        })
      expect(response.status).toBe(202)
      const job = await waitForTask(app, response.body.id)
      expect(job.result).toEqual(expect.objectContaining({
        provider: selection.provider,
        model: selection.model,
      }))
    }

    expect(calls).toEqual([
      'seedream',
      'google',
      'qwen',
      'kling',
      'openai-compatible',
    ])
  })

  it('供应商列表返回能力与可用状态且不泄露密钥', async () => {
    const { app } = createTestApp({
      defaultImageGenerationProvider: 'seedream',
      imageGenerationProviders: {
        seedream: {
          generateImage: async () => ({
            buffer: Buffer.from(tinyPngBase64, 'base64'),
            mimeType: 'image/png',
          }),
        },
      },
      imageGenerationProviderAvailability: {
        google: false,
        seedream: true,
        qwen: false,
        kling: false,
        'openai-compatible': false,
      },
    })

    const response = await request(app)
      .get('/api/generation/providers')

    expect(response.status).toBe(200)
    expect(response.body.defaultProvider).toBe('seedream')
    expect(response.body.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'seedream',
        available: true,
        maxReferenceImages: 10,
        supportedResolutions: ['1K', '2K'],
      }),
      expect.objectContaining({ id: 'google', available: false }),
    ]))
    expect(JSON.stringify(response.body)).not.toContain('key')
  })

  it('模型列表返回八个默认模型、能力和实际可用状态', async () => {
    const provider: ImageGenerationProvider = {
      generateImage: async () => ({
        buffer: Buffer.from(tinyPngBase64, 'base64'),
        mimeType: 'image/png',
      }),
    }
    const { app } = createTestApp({
      imageGenerationModelProviders: {
        'google:gemini-nano-banana-2.1': provider,
      },
      imageGenerationProviderAvailability: {
        seedream: false,
        google: true,
        qwen: false,
        kling: false,
        'openai-compatible': false,
      },
    })

    const response = await request(app)
      .get('/api/generation/models')

    expect(response.status).toBe(200)
    expect(response.body.defaultModel).toEqual({
      provider: 'google',
      model: 'gemini-nano-banana-2.1',
    })
    expect(response.body.models).toHaveLength(8)
    expect(response.body.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'google',
        model: 'gemini-nano-banana-2.1',
        label: 'Google · Nano Banana 2.1',
        parameterMode: 'resolution',
        available: true,
        supportedResolutions: ['1K', '2K', '4K'],
      }),
      expect.objectContaining({
        provider: 'seedream',
        model: 'doubao-seedream-5-5-261028',
        available: false,
      }),
      expect.objectContaining({
        provider: 'qwen',
        model: 'qwen-image-3.0-pro',
        available: false,
        maxReferenceImages: 3,
        supportedResolutions: ['1K', '2K'],
      }),
      expect.objectContaining({
        provider: 'kling',
        model: 'kling/kling-v3-omni-image-generation',
        available: false,
        maxReferenceImages: 10,
        supportedResolutions: ['1K', '2K', '4K'],
        supportedAspectRatios: ['1:1', '16:9', '9:16'],
      }),
      expect.objectContaining({
        provider: 'openai-compatible',
        model: 'gpt-image-1',
        parameterMode: 'quality',
        available: false,
        maxReferenceImages: 16,
        supportedQualities: ['low', 'medium', 'high'],
        supportedAspectRatios: ['auto', '1:1', '2:3', '3:2'],
      }),
      expect.objectContaining({ provider: 'demo', model: 'banana-demo-v1', available: true }),
    ]))
    expect(JSON.stringify(response.body)).not.toContain('key')
  })

  it('OpenAI 兼容渠道支持上传、生成及保存 16 张有序参考图', async () => {
    const model = 'gpt-image-1'
    const generateImage = vi.fn(async () => ({
      buffer: Buffer.from(tinyPngBase64, 'base64'), mimeType: 'image/png',
    }))
    const { app } = createTestApp({
      imageGenerationModelProviders: { [`openai-compatible:${model}`]: { generateImage } },
    })
    try {
      let upload = request(app).post('/api/references/upload')
      for (let index = 0; index < 16; index++) {
        upload = upload.attach('references', Buffer.from(`reference-${index}`), { filename: `ref-${index}.png`, contentType: 'image/png' })
      }
      const uploaded = await upload
      expect(uploaded.status).toBe(200)
      expect(uploaded.body.filenames).toHaveLength(16)
      const input = {
        key: 'gpt-16-references', provider: 'openai-compatible', model,
        prompt: '组合全部参考图', aspectRatio: 'auto', quality: 'high',
        referenceFilenames: uploaded.body.filenames,
      }
      const submitted = await request(app).post('/api/generation-tasks').send(input)
      expect(submitted.status).toBe(202)
      await vi.waitFor(async () => {
        const jobs = await request(app).get('/api/generation-tasks')
        expect(jobs.body.tasks.find((job: { id: string }) => job.id === submitted.body.id)?.status).toBe('completed')
      })
      expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
        referenceImages: Array.from({ length: 16 }, (_, index) => ({ mimeType: 'image/png', data: Buffer.from(`reference-${index}`) })),
      }))
      const saved = await request(app).post('/api/generate/save').send({ taskId: submitted.body.id, assetType: 'recipe' })
      expect(saved.status).toBe(200)
      expect(saved.body.generation.model).toBe(model)
      expect(saved.body.referenceImages).toEqual(uploaded.body.filenames)
      const tooMany = { ...input, key: 'gpt-17-references', referenceFilenames: [...input.referenceFilenames, 'extra.png'] }
      const rejected = await submit(app, tooMany)
      expect(rejected.status).toBe(400)
      expect(rejected.body.error).toContain('最多支持 16 张')
      expect(generateImage).toHaveBeenCalledTimes(1)
    } finally {
      await app.locals.stopTaskQueue()
    }
  })

  it('rejects retired Seedream models and 1.5K on the task API', async () => {
    const { app } = createTestApp()
    for (const [model, imageSize] of [['doubao-seedream-5-0-flash-260915', '2K'], ['doubao-seedream-5-5-261028', '1.5K']]) {
      const rejected = await submit(app, { provider: 'seedream', model, imageSize, prompt: 'test' })
      expect(rejected.status).toBe(400)
      expect(rejected.body.error).toContain('1K 或 2K')
    }
  })

  it('OpenAI 兼容渠道接受标准比例，并将实际比例保留到生成结果', async () => {
    const generateImage = vi.fn(async () => ({ buffer: Buffer.from(tinyPngBase64, 'base64'), mimeType: 'image/png' }))
    const { app } = createTestApp({ imageGenerationModelProviders: { 'openai-compatible:gpt-image-1': { generateImage } } })
    for (const aspectRatio of ['1:1', '2:3', '3:2']) {
      const input = { provider: 'openai-compatible', model: 'gpt-image-1', prompt: 'aspect ratio test', aspectRatio, quality: 'medium' }
      const result = await submit(app, input).expect(202)
      expect((await waitForTask(app, result.body.id)).result?.aspectRatio).toBe(aspectRatio)
      expect(generateImage).toHaveBeenLastCalledWith(expect.objectContaining({ aspectRatio }))
    }
    const rejected = await submit(app, { provider: 'openai-compatible', model: 'gpt-image-1', prompt: 'test', aspectRatio: '4:1' })
    expect(rejected.status).toBe(400)
    expect(generateImage).toHaveBeenCalledTimes(3)
  })

  it('OpenAI 兼容渠道 按模型路由并默认使用 High，不把质量当作 4K', async () => {
    const generateImage = vi.fn(async () => ({
      buffer: Buffer.from(tinyPngBase64, 'base64'),
      mimeType: 'image/png',
    }))
    const { app } = createTestApp({
      defaultImageGenerationProvider: 'seedream',
      imageGenerationModelProviders: {
        'openai-compatible:gpt-image-1': { generateImage },
      },
    })

    const response = await submit(app, {
        provider: 'openai-compatible',
        model: 'gpt-image-1',
        prompt: 'gpt image prompt',
        referenceFilenames: [],
      })

    expect(response.status).toBe(202)
    const job = await waitForTask(app, response.body.id)
    expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'gpt image prompt',
      aspectRatio: 'auto',
      quality: 'high',
    }))
    expect(generateImage.mock.calls[0]?.[0]).not.toHaveProperty('imageSize')
    expect(job.result).toEqual(expect.objectContaining({
      provider: 'openai-compatible',
      model: 'gpt-image-1',
      aspectRatio: 'auto',
      quality: 'high',
    }))
    expect(job.result).not.toHaveProperty('imageSize')
  })

  it('OpenAI 兼容渠道 拒绝无效比例、质量和超过 16 张参考图', async () => {
    const provider = {
      generateImage: vi.fn(async () => ({
        buffer: Buffer.from(tinyPngBase64, 'base64'),
        mimeType: 'image/png',
      })),
    }
    const { app } = createTestApp({
      imageGenerationModelProviders: {
        'openai-compatible:gpt-image-1': provider,
      },
    })
    const base = {
      provider: 'openai-compatible',
      model: 'gpt-image-1',
      prompt: 'banana',
      referenceFilenames: [],
      aspectRatio: '1:1',
    }

    const invalidAspect = await submit(app, { ...base, aspectRatio: '7:3' })
    expect(invalidAspect.status).toBe(400)
    expect(invalidAspect.body.error).toContain('不支持该比例')

    const invalidQuality = await submit(app, { ...base, quality: 'ultra' })
    expect(invalidQuality.status).toBe(400)
    expect(invalidQuality.body.error).toContain('不支持该质量')

    const tooManyReferences = await submit(app, {
        ...base,
        referenceFilenames: Array.from({ length: 17 }, (_, index) => `ref-${index}.png`),
      })
    expect(tooManyReferences.status).toBe(400)
    expect(tooManyReferences.body.error).toContain('最多支持 16 张')
    expect(provider.generateImage).not.toHaveBeenCalled()
  })

  it('Seedream 在请求 provider 前拒绝 4K 和超过 10 张参考图', async () => {
    const provider = {
      generateImage: vi.fn(async () => ({
        buffer: Buffer.from(tinyPngBase64, 'base64'),
        mimeType: 'image/png',
      })),
    }
    const { app } = createTestApp({
      defaultImageGenerationProvider: 'seedream',
      imageGenerationProviders: { seedream: provider },
    })

    const fourK = await submit(app, {
        provider: 'seedream',
        model: 'doubao-seedream-5-5-261028',
        prompt: 'banana',
        referenceFilenames: [],
        imageSize: '4K',
        aspectRatio: '1:1',
      })
    expect(fourK.status).toBe(400)
    expect(fourK.body.error).toContain('不支持该分辨率')

    const tooManyReferences = await submit(app, {
        provider: 'seedream',
        model: 'doubao-seedream-5-5-261028',
        prompt: 'banana',
        referenceFilenames: Array.from({ length: 11 }, (_, index) => `ref-${index}.png`),
        imageSize: '2K',
        aspectRatio: '1:1',
      })
    expect(tooManyReferences.status).toBe(400)
    expect(tooManyReferences.body.error).toContain('最多支持 10 张')
    expect(provider.generateImage).not.toHaveBeenCalled()
  })

  it('任务接口拒绝已下线的 Poe 模型', async () => {
    const { app } = createTestApp()
    await submit(app, { provider: 'poe', model: 'gpt-image-2', prompt: 'retired channel' }).expect(400)
  })

  it('不启动真实端口时也能响应运行时设置接口，且不会泄露本机凭证路径', async () => {
    const { app } = createTestApp({
      strategy: {
        mode: 'vertex',
        project: 'test-project',
        location: 'global',
        credentialPath: '/tmp/test-service-account.json',
      },
    })

    const response = await request(app)
      .get('/api/settings/runtime')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      showDeveloperDiagnostics: true,
      userAuthMode: 'local',
      userAuthLabel: '本地单人模式',
      aiAuthMode: 'vertex',
      aiAuthLabel: '服务账号（Vertex AI）',
      project: 'test-project',
      location: 'global',
      allowServerSideImport: false,
    })
    expect(response.body.credentialPath).toBeUndefined()
  })

  it('关闭开发者诊断时不返回 Gemini 与数据驱动等字段', async () => {
    const { app } = createTestApp({
      strategy: {
        mode: 'vertex',
        project: 'test-project',
        location: 'global',
        credentialPath: '/tmp/test-service-account.json',
      },
      showDeveloperDiagnostics: false,
      allowServerSideImport: false,
    })

    const response = await request(app)
      .get('/api/settings/runtime')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      showDeveloperDiagnostics: false,
      allowServerSideImport: false,
    })
    expect(response.body.project).toBeUndefined()
  })

  it('不启动真实端口时也能响应图片列表接口', async () => {
    const { app } = createTestApp()

    const response = await request(app).get('/api/images')

    expect(response.status).toBe(200)
    expect(response.body).toEqual([])
  })

  it('默认实现会从 JSON 读取图片并按 favorites 与 tag 筛选', async () => {
    const matched = createImage({
      id: 'favorite-banana',
      favorited: true,
      tags: ['banana', 'fruit'],
    })
    const unmatchedFavorite = createImage({
      id: 'favorite-other',
      filename: 'favorite-other.jpg',
      favorited: true,
      tags: ['other'],
    })
    const unmatchedTag = createImage({
      id: 'tag-only',
      filename: 'tag-only.jpg',
      favorited: false,
      tags: ['banana'],
    })
    const { app } = createTestApp({
      images: [matched, unmatchedFavorite, unmatchedTag],
    })

    const response = await request(app).get('/api/images').query({
      favorites: 'true',
      tag: 'banana',
    })

    expect(response.status).toBe(200)
    expect(response.body).toEqual([{ ...matched, workCode: '#DV8PJTRGHN' }])
  })

  it('默认实现会把图片更新写回 JSON', async () => {
    const original = createImage({
      favorited: false,
      tags: ['banana'],
    })
    const { app, dataFile } = createTestApp({
      images: [original],
    })

    const response = await request(app)
      .patch(`/api/images/${original.id}`)
      .send({ prompt: 'updated banana prompt', favorited: true, tags: ['banana', 'favorite'], sourceType: 'openai' })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      id: original.id,
      prompt: 'updated banana prompt',
      favorited: true,
      tags: ['banana', 'favorite'],
      sourceType: 'openai',
    })
    expect(readGalleryData(dataFile).images).toEqual([
      {
        ...original,
        prompt: 'updated banana prompt',
        favorited: true,
        tags: ['banana', 'favorite'],
        sourceType: 'openai',
        version: 1, updatedAt: expect.any(String),
      },
    ])
  })

  it('拒绝未知的图片来源', async () => {
    const original = createImage()
    const { app, dataFile } = createTestApp({ images: [original] })

    const response = await request(app)
      .patch(`/api/images/${original.id}`)
      .send({ sourceType: 'arbitrary-source' })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: '不支持的图片来源' })
    expect(readGalleryData(dataFile).images).toEqual([original])
  })

  it('默认实现会拒绝空提示词更新', async () => {
    const original = createImage()
    const { app, dataFile } = createTestApp({
      images: [original],
    })

    const response = await request(app)
      .patch(`/api/images/${original.id}`)
      .send({ prompt: '   ' })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: '提示词不能为空' })
    expect(readGalleryData(dataFile).images).toEqual([original])
  })

  it('永久删除回收站条目时同步清理独占文件', async () => {
    const image = createImage()
    const { app, dataFile, imagesDir, referencesDir } = createTestApp({
      images: [image],
    })

    fs.writeFileSync(path.join(imagesDir, image.filename), 'image-binary')
    for (const reference of image.referenceImages) {
      fs.writeFileSync(path.join(referencesDir, reference), `ref:${reference}`)
    }

    await request(app).delete(`/api/images/${image.id}`)
    const response = await request(app).delete(`/api/trash/${image.id}`).send({ confirm: true })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
    expect(readGalleryData(dataFile).images).toEqual([])
    expect(fs.existsSync(path.join(imagesDir, image.filename))).toBe(false)
    for (const reference of image.referenceImages) {
      expect(fs.existsSync(path.join(referencesDir, reference))).toBe(false)
    }
  })

  it('删除图片时会保留其他条目仍引用的共享图片文件与参考图文件', async () => {
    const sharedWork = createImage({
      id: 'shared-work',
      filename: 'shared-image.jpg',
      referenceImages: ['shared-ref.jpg'],
      assetType: 'work',
    })
    const sharedRecipe = createImage({
      ...sharedWork,
      id: 'shared-recipe',
      assetType: 'recipe',
      favorited: false,
    })
    const { app, dataFile, imagesDir, referencesDir } = createTestApp({
      images: [sharedRecipe, sharedWork],
    })

    fs.writeFileSync(path.join(imagesDir, sharedWork.filename), 'image-binary')
    fs.writeFileSync(path.join(referencesDir, sharedWork.referenceImages[0]), 'ref-binary')

    await request(app).delete('/api/images/shared-work')
    const response = await request(app).delete('/api/trash/shared-work').send({ confirm: true })

    expect(response.status).toBe(200)
    expect(readGalleryData(dataFile).images).toEqual([sharedRecipe])
    expect(fs.existsSync(path.join(imagesDir, sharedWork.filename))).toBe(true)
    expect(fs.existsSync(path.join(referencesDir, sharedWork.referenceImages[0]))).toBe(true)
  })

  it('createApp 会优先通过 GalleryRepository 抽象读取并筛选图片', async () => {
    const matched = createImage({
      id: 'repo-favorite',
      favorited: true,
      tags: ['banana', 'fruit'],
    })
    const repository = {
      listImages: async () => [
        matched,
        createImage({
          id: 'repo-other',
          filename: 'repo-other.jpg',
          favorited: true,
          tags: ['other'],
        }),
      ],
      saveImages: async (images: GalleryImage[]) => {
        void images
      },
    }
    const { app } = createTestApp({
      galleryRepository: repository,
    })

    const response = await request(app).get('/api/images').query({
      favorites: 'true',
      tag: 'banana',
    })

    expect(response.status).toBe(200)
    expect(response.body).toEqual([{ ...matched, workCode: '#NMM8B7TJTF' }])
  })

  it('createApp 会通过 GalleryRepository 抽象写回图片更新', async () => {
    let images = [
      createImage({
        id: 'repo-patch',
        favorited: false,
        tags: ['banana'],
      }),
    ]
    const repository = {
      listImages: async () => images,
      saveImages: async (nextImages: GalleryImage[]) => {
        images = nextImages
      },
    }
    const { app } = createTestApp({
      galleryRepository: repository,
    })

    const response = await request(app)
      .patch('/api/images/repo-patch')
      .send({ prompt: 'repo updated prompt', favorited: true, tags: ['banana', 'favorite'] })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      id: 'repo-patch',
      prompt: 'repo updated prompt',
      favorited: true,
      tags: ['banana', 'favorite'],
    })
    expect(images).toEqual([
      expect.objectContaining({
        id: 'repo-patch',
        prompt: 'repo updated prompt',
        favorited: true,
        tags: ['banana', 'favorite'],
      }),
    ])
  })

  it('createApp 会通过 AssetStorage 抽象删除图片与参考图', async () => {
    let images = [
      createImage({
        id: 'repo-delete',
        filename: 'repo-delete.jpg',
        referenceImages: ['repo-ref-1.jpg', 'repo-ref-2.png'],
      }),
    ]
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-gallery-storage-spy-'))
    tempRoots.push(root)
    const imagesDir = path.join(root, 'images')
    const referencesDir = path.join(root, 'references')
    const deletedImages: string[] = []
    const deletedReferences: string[][] = []
    const repository = {
      listImages: async () => images,
      saveImages: async (nextImages: GalleryImage[]) => {
        images = nextImages
      },
    }
    const assetStorage = {
      ensureDirectories: async () => {},
      getImagesDir: () => imagesDir,
      getReferencesDir: () => referencesDir,
      getImagePath: (filename: string) => path.join(imagesDir, filename),
      getReferencePath: (filename: string) => path.join(referencesDir, filename),
      copyImageFrom: async (sourcePath: string) => {
        void sourcePath
        return 'copied-image.jpg'
      },
      finalizeImage: async (filename: string) => {
        void filename
      },
      finalizeReferences: async (filenames: string[]) => {
        void filenames
      },
      deleteImage: async (filename: string) => {
        deletedImages.push(filename)
      },
      deleteReferences: async (filenames: string[]) => {
        deletedReferences.push(filenames)
      },
    }
    const { app } = createTestApp({
      galleryRepository: repository,
      assetStorage,
    })

    await request(app).delete('/api/images/repo-delete')
    const response = await request(app).delete('/api/trash/repo-delete').send({ confirm: true })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
    expect(images).toEqual([])
    expect(deletedImages).toEqual(['repo-delete.jpg'])
    expect(deletedReferences).toEqual([['repo-ref-1.jpg'], ['repo-ref-2.png']])
  })

  it('图片资源需要登录后才能访问，匿名静态路径不再暴露', async () => {
    const image = createImage({
      filename: 'protected-image.jpg',
      referenceImages: ['protected-ref.png'],
    })
    const { app, imagesDir, referencesDir } = createTestApp({
      images: [image],
    })

    fs.writeFileSync(path.join(imagesDir, image.filename), 'image-binary')
    fs.writeFileSync(path.join(referencesDir, image.referenceImages[0]), 'ref-binary')

    const { app: anonymousApp } = createTestApp({ anonymous: true, images: [image] })
    const anonymousAssetResponse = await request(anonymousApp).get(`/api/assets/images/${image.filename}`)
    expect(anonymousAssetResponse.status).toBe(401)

    const imageResponse = await request(app)
      .get(`/api/assets/images/${image.filename}`)
    expect(imageResponse.status).toBe(200)
    expect(Buffer.from(imageResponse.body).toString()).toBe('image-binary')

    const referenceResponse = await request(app)
      .get(`/api/assets/references/${image.referenceImages[0]}`)
    expect(referenceResponse.status).toBe(200)
    expect(Buffer.from(referenceResponse.body).toString()).toBe('ref-binary')

    const anonymousStaticResponse = await request(anonymousApp).get(`/images/${image.filename}`)
    expect(anonymousStaticResponse.status).toBe(404)
  })

  it('已保存的 gen_ 图片仅依赖画廊元数据即可访问（模拟服务重启后内存表为空）', async () => {
    const image = createImage({
      id: 'saved-gen-1',
      filename: 'gen_00000000-0000-4000-8000-000000000001.jpg',
      sourceFile: 'generated',
    })
    const { app, imagesDir } = createTestApp({
      images: [image],
    })

    fs.writeFileSync(path.join(imagesDir, image.filename), 'saved-gen-bytes')

    const response = await request(app)
      .get(`/api/assets/images/${image.filename}`)

    expect(response.status).toBe(200)
    expect(Buffer.from(response.body).toString()).toBe('saved-gen-bytes')
  })

  it('明确关闭后不允许服务器本机路径导入', async () => {
    const { app } = createTestApp({
      allowServerSideImport: false,
    })

    const response = await request(app)
      .post('/api/import')
      .send({
        markdownPath: '/tmp/sample.md',
        vaultImagesPath: '/tmp/vault',
      })

    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: '当前运行模式不允许读取服务器本机路径' })
  })
})

describe('Task 3 抽象实现回归测试', () => {
  it('JsonGalleryRepository 能读取现有 JSON 图片数据', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-gallery-repository-'))
    tempRoots.push(root)
    const dataFile = path.join(root, 'gallery-data.json')
    const images = [
      createImage({ id: 'repo-read-1' }),
      createImage({ id: 'repo-read-2', filename: 'repo-read-2.jpg', favorited: true }),
    ]
    writeGalleryData(dataFile, images)

    const { JsonGalleryRepository } = await importFromWorktree<{
      JsonGalleryRepository: new (dataFile: string) => { listImages(): Promise<GalleryImage[]> }
    }>('server/gallery/json-gallery-repository.ts')
    const repository = new JsonGalleryRepository(dataFile)

    await expect(repository.listImages()).resolves.toEqual(images)
  })

  it('JsonGalleryRepository 能把最新图片数据写回 JSON', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-gallery-repository-'))
    tempRoots.push(root)
    const dataFile = path.join(root, 'gallery-data.json')
    const original = [createImage({ id: 'repo-write-1' })]
    writeGalleryData(dataFile, original)

    const { JsonGalleryRepository } = await importFromWorktree<{
      JsonGalleryRepository: new (dataFile: string) => { saveImages(images: GalleryImage[]): Promise<void> }
    }>('server/gallery/json-gallery-repository.ts')
    const repository = new JsonGalleryRepository(dataFile)
    const updated = [
      {
        ...original[0],
        favorited: true,
        tags: ['banana', 'favorite'],
      },
    ]

    await repository.saveImages(updated)

    expect(readGalleryData(dataFile).images).toEqual(updated)
  })

  it('DiskAssetStorage 会复制导入图片并保留扩展名', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-gallery-storage-'))
    tempRoots.push(root)
    const imagesDir = path.join(root, 'images')
    const referencesDir = path.join(root, 'references')
    const vaultDir = path.join(root, 'vault-images')
    fs.mkdirSync(vaultDir, { recursive: true })
    const sourceFile = path.join(vaultDir, 'banana-source.png')
    fs.writeFileSync(sourceFile, 'png-binary')

    const { DiskAssetStorage } = await importFromWorktree<{
      DiskAssetStorage: new (options: {
        imagesDir: string
        referencesDir: string
      }) => { copyImageFrom(sourcePath: string): Promise<string> }
    }>('server/storage/disk-asset-storage.ts')
    const storage = new DiskAssetStorage({ imagesDir, referencesDir })
    const copiedFilename = await storage.copyImageFrom(sourceFile)

    expect(copiedFilename.endsWith('.png')).toBe(true)
    expect(fs.readFileSync(path.join(imagesDir, copiedFilename), 'utf-8')).toBe('png-binary')
  })

  it('DiskAssetStorage 会删除图片文件与参考图文件', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-gallery-storage-'))
    tempRoots.push(root)
    const imagesDir = path.join(root, 'images')
    const referencesDir = path.join(root, 'references')
    fs.mkdirSync(imagesDir, { recursive: true })
    fs.mkdirSync(referencesDir, { recursive: true })
    fs.writeFileSync(path.join(imagesDir, 'stored-image.jpg'), 'image-binary')
    fs.writeFileSync(path.join(referencesDir, 'stored-ref-1.jpg'), 'ref-1')
    fs.writeFileSync(path.join(referencesDir, 'stored-ref-2.png'), 'ref-2')

    const { DiskAssetStorage } = await importFromWorktree<{
      DiskAssetStorage: new (options: {
        imagesDir: string
        referencesDir: string
      }) => {
        deleteImage(filename: string): Promise<void>
        deleteReferences(filenames: string[]): Promise<void>
      }
    }>('server/storage/disk-asset-storage.ts')
    const storage = new DiskAssetStorage({ imagesDir, referencesDir })

    await storage.deleteImage('stored-image.jpg')
    await storage.deleteReferences(['stored-ref-1.jpg', 'stored-ref-2.png'])

    expect(fs.existsSync(path.join(imagesDir, 'stored-image.jpg'))).toBe(false)
    expect(fs.existsSync(path.join(referencesDir, 'stored-ref-1.jpg'))).toBe(false)
    expect(fs.existsSync(path.join(referencesDir, 'stored-ref-2.png'))).toBe(false)
  })
})
