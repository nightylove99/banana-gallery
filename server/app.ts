import { isAvailableWork, withWorkCode, workCode } from './gallery/work-code'
import { normalizeCollections, preserveCollectionOwnership } from './gallery/collections'
import { ImageIntakeError, inspectIncomingImage, normalizeIncomingPngFiles } from './gallery/png-intake.js'
import { IMAGE_INPUT_LIMIT_MESSAGE, PNG_INPUT_MAX_BYTES } from '../src/lib/image-intake-policy.js'
import { describeImageGenerationFailure } from './ai/generation-failure.ts'
import { importCandidates, sha256 } from './gallery/import-duplicates'
import { ReferenceUploadReceipts } from './gallery/reference-upload-receipts.js'
import { boundReferenceUpload } from './gallery/reference-upload-intake.js'
import { readObsidianAttachment } from './gallery/obsidian-import.js'
import { createPreferencesRouter } from './routes/preferences'
import { captureStorageIndex, storageSummary } from './personal/storage-summary'
import { checkForAppUpdate } from './personal/update-check'
import { createReferenceLibraryRouter } from './routes/reference-library'
import { GenerationTaskQueue, LOCAL_ACTIVE_LIMIT, TaskError } from './generation/task-queue'
import { generationTaskReceipts } from './generation/task-receipts'
import { hasOriginalResult } from '../src/lib/generation-task-actions'
import { parseTaskInput } from './generation/task-input'
import {
  canBulkChangeGenerationTask, generationHistoryTabs, matchesGenerationHistorySearch, matchesGenerationHistoryTab,
  type GenerationBulkPreview,
} from '../src/lib/generation-task-bulk'
import { createGenerationTaskPage, limitGenerationHistory, generationTaskSummary, publicGenerationFailure } from './generation/task-query'
import { galleryImageSummary } from './gallery/image-summary'
import { resourceFiles } from './gallery/resource-files'
import { createOrganizationRouter } from './routes/organization'
import { ThumbnailCache, thumbnailVersion } from './storage/thumbnails'
import { createGalleryPage, GalleryPaginationCache, galleryStatistics } from './gallery/pagination'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { handleDiskUpload, uploadDiskStorage } from './storage/disk-upload.js'
import { version } from '../package.json' with { type: 'json' }
import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { createGoogleGenAI, type GenAIAuthStrategy } from './genai-auth.js'
import type { AppSession, GalleryImage, GenerationTask, GenerationTaskScope } from '../src/types'
import type { GalleryRepository, ReadOnlyGalleryResources } from './gallery/gallery-repository.js'
import { filterGalleryImages, galleryQueryFromParams } from '../src/lib/gallery-query.ts'
import { GalleryBackups, defaultBackupPolicy, type AutomaticBackupPolicy } from './personal/backups.js'
import { GalleryWriteCoordinator } from './gallery/write-coordinator.js'
import { JsonGalleryRepository } from './gallery/json-gallery-repository.js'
import { createRecipeFromImage, galleryEntryFromGenerateSave } from './gallery-normalize.ts'
import type { AssetStorage } from './storage/asset-storage.js'
import { DiskAssetStorage } from './storage/disk-asset-storage.js'
import type { CloudflareAccessVerifier } from './auth/cloudflare-access-verifier.js'
import { enforceAgentAccess } from './auth/agent-access'
import { createSessionAttacher } from './auth/session-middleware.js'
import { createSessionRouter } from './routes/session.js'
import { createImageReferencesRouter } from './routes/image-references.js'
import type { UserAuthMode } from './config/env.js'
import {
  GoogleGeminiImageGenerationProvider,
  type AppAI,
} from './ai/google-gemini-image-provider.ts'
import type { ImageGenerationProvider, ReferenceImageForGeneration } from './ai/image-generation-provider.ts'
import { createOpenAICompatibleRuntimeProvider } from './ai/openai-compatible-runtime.ts'
import type { ProviderConfig } from './personal/provider-config.ts'
import { createProviderConfigRouter } from './routes/provider-config.ts'
import { DemoImageGenerationProvider } from './ai/demo-image-provider.ts'
import {
  IMAGE_GENERATION_MODEL_DEFINITIONS,
  IMAGE_GENERATION_PROVIDER_DEFINITIONS,
  formatImageGenerationSource,
  defaultModelForProvider,
  RETIRED_GENERATION_PROVIDER_MESSAGE,
  imageGenerationModelKey,
  normalizeGenerationPreferences,
  resolveImageGenerationModel,
  isRetiredSeedreamRequest,
  isImageGenerationProviderName,
  type ImageGenerationModelDefinition,
  type ImageGenerationProviderName,
} from '../src/lib/image-generation-providers.ts'

type AppAIAuthStrategy =
  | GenAIAuthStrategy
  | {
      mode: 'seedream'
      model: string
    }
  | {
      mode: 'qwen'
      model: string
    }
  | {
      mode: 'kling'
      model: string
    }
  | {
      mode: 'openai-compatible' | 'demo'
      model: string
    }
  | {
      mode: 'googleUnavailable'
    }

const MAX_PROMPT_LENGTH = 20_000

interface CreateAppOptions {
  ai: AppAI
  strategy: AppAIAuthStrategy
  providerConfig?: ProviderConfig
  dataFile: string
  backupDir?: string
  imagesDir: string
  referencesDir: string
  userAuthMode?: UserAuthMode
  agentApiToken?: string
  localAuthSession?: AppSession
  cloudflareAccessVerifier?: Pick<CloudflareAccessVerifier, 'verify'>
  cloudflareAccessSession?: AppSession
  localAccessHost?: string
  localAccessPort?: number
  remoteAccessPort?: number
  galleryRepository?: GalleryRepository
  assetStorage?: AssetStorage
  corsAllowedOrigins?: string[]
  allowServerSideImport?: boolean
  /** false 时 /api/settings/runtime 不返回 Gemini/数据驱动等诊断字段 */
  showDeveloperDiagnostics?: boolean
  defaultImageGenerationProvider?: ImageGenerationProviderName
  defaultImageGenerationModel?: string
  enableDemoProvider?: boolean
  imageGenerationProvider?: ImageGenerationProvider
  imageGenerationProviders?: Partial<Record<ImageGenerationProviderName, ImageGenerationProvider>>
  imageGenerationModelProviders?: Record<string, ImageGenerationProvider>
  imageGenerationProviderAvailability?: Partial<Record<ImageGenerationProviderName, boolean>>
  imageGenerationProviderModels?: Partial<Record<ImageGenerationProviderName, string>>
  securityLimits?: Partial<Record<'generate' | 'upload', {
    windowMs: number
    max: number
  }>>
  thumbnailCache?: Pick<ThumbnailCache, 'get' | 'warm'>
  /** 本地 GPU 的实时可用状态；不改变其他供应商配置 */
  localQwenStatus?: () => Promise<{ available: boolean; reason?: string }>
  localKreaStatus?: () => Promise<{ available: boolean; reason?: string }>
  /** 生成任务自动重试的基础退避毫秒；默认 30s，测试可缩短 */
  generationRetryBaseDelayMs?: number
}

export function createApp({
  ai,
  strategy: initialStrategy,
  providerConfig,
  dataFile,
  backupDir = path.join(path.dirname(dataFile), 'backups'),
  imagesDir,
  referencesDir,
  userAuthMode = 'local',
  agentApiToken,
  localAuthSession,
  cloudflareAccessVerifier,
  cloudflareAccessSession,
  localAccessHost = '127.0.0.1',
  localAccessPort = 3333,
  remoteAccessPort = 3334,
  galleryRepository: injectedGalleryRepository,
  assetStorage: injectedAssetStorage,
  corsAllowedOrigins = [],
  allowServerSideImport: serverSideImportRequested = false,
  showDeveloperDiagnostics = false,
  defaultImageGenerationProvider: injectedDefaultImageGenerationProvider,
  defaultImageGenerationModel: injectedDefaultImageGenerationModel,
  enableDemoProvider = true,
  imageGenerationProvider: injectedImageGenerationProvider,
  imageGenerationProviders: injectedImageGenerationProviders,
  imageGenerationModelProviders: injectedImageGenerationModelProviders = {},
  imageGenerationProviderAvailability: initialAvailability = {},
  imageGenerationProviderModels: initialModels = {},
  securityLimits,
  thumbnailCache: injectedThumbnailCache,
  generationRetryBaseDelayMs,
  localQwenStatus,
  localKreaStatus,
}: CreateAppOptions) {
  // 通过注入仓储与存储抽象，把当前 JSON/磁盘行为和路由逻辑解耦。
  const galleryRepository =
    injectedGalleryRepository ?? new JsonGalleryRepository(dataFile)
  const jsonRepository = galleryRepository instanceof JsonGalleryRepository ? galleryRepository : undefined
  const assetStorage =
    injectedAssetStorage ?? new DiskAssetStorage({ imagesDir, referencesDir, backupDataFile: dataFile })
  const configuredProvider = injectedDefaultImageGenerationProvider ?? providerNameForStrategy(initialStrategy)
  function buildGenerationRuntime(config?: ReturnType<ProviderConfig['resolve']>) {
    const providers = { ...injectedImageGenerationProviders }
    const availability = { ...initialAvailability }
    const models = { ...initialModels }
    const modelProviders = { ...injectedImageGenerationModelProviders }
    let strategy = initialStrategy

    if (config) {
      delete providers.google
      delete providers['openai-compatible']
      for (const key of Object.keys(modelProviders)) {
        if (key.startsWith('google:') || key.startsWith('openai-compatible:')) delete modelProviders[key]
      }
      if (config.google) {
        providers.google = new GoogleGeminiImageGenerationProvider(createGoogleGenAI(config.google, config.credentials).ai)
      }
      const openai = createOpenAICompatibleRuntimeProvider(config.openai)
      if (openai) providers['openai-compatible'] = openai
      availability.google = Boolean(providers.google)
      availability['openai-compatible'] = Boolean(openai)
      models['openai-compatible'] = config.openai.openaiImageModel
    } else if (injectedImageGenerationProvider) {
      providers[configuredProvider] = injectedImageGenerationProvider
    } else if (!injectedImageGenerationProviders && strategy.mode !== 'googleUnavailable') {
      providers.google = new GoogleGeminiImageGenerationProvider(ai)
    }

    if (enableDemoProvider) providers.demo ??= new DemoImageGenerationProvider()
    else delete providers.demo

    const preferredProvider = configuredProvider === 'demo' && !enableDemoProvider ? 'google' : configuredProvider
    const defaultProvider = preferredProvider === 'google' &&
      (availability.google === false || !providers.google) && providers.demo && availability.demo !== false
      ? 'demo' : preferredProvider
    const defaultModel = resolveImageGenerationModel(
      defaultProvider,
      (defaultProvider === configuredProvider && !(config && defaultProvider === 'openai-compatible') ? injectedDefaultImageGenerationModel : undefined) ??
        models[defaultProvider] ?? defaultModelForProvider(defaultProvider),
    )
    if (config && defaultProvider === 'google') strategy = config.google ?? { mode: 'googleUnavailable' }
    if (config && defaultProvider === 'openai-compatible') strategy = { mode: defaultProvider, model: defaultModel }

    for (const [provider, generationProvider] of Object.entries(providers)) {
      if (!generationProvider || !isImageGenerationProviderName(provider)) continue
      const model = models[provider] ?? defaultModelForProvider(provider)
      modelProviders[imageGenerationModelKey(provider, model)] ??= generationProvider
    }
    const definitions = buildGenerationModelDefinitions(models)
      .filter(definition => enableDemoProvider || definition.provider !== 'demo')
    return { providers, availability, models, modelProviders, defaultProvider, defaultModel, definitions, strategy, providerStatus: config?.status }
  }

  let generation = buildGenerationRuntime(providerConfig?.resolve())

  assetStorage.ensureDirectories()

  const app = express()
  const allowServerSideImport = userAuthMode === 'local' && serverSideImportRequested
  const gallerySession = userAuthMode === 'local' ? localAuthSession : cloudflareAccessSession
  const sessionAttacher = createSessionAttacher({
    agent: agentApiToken && gallerySession ? { token: agentApiToken, session: gallerySession } : undefined,
    localAuthSession: userAuthMode === 'local' ? localAuthSession : undefined,
    cloudflareAccess: userAuthMode === 'cloudflare_access' && cloudflareAccessVerifier && cloudflareAccessSession
      ? {
          verifier: cloudflareAccessVerifier,
          localSession: cloudflareAccessSession,
          localAccessPort,
          remoteAccessPort,
        }
      : undefined,
  })
  function isLocalEntry(req: express.Request) {
    return userAuthMode === 'local' || (userAuthMode === 'cloudflare_access' && req.socket.localPort === localAccessPort)
  }

  function entryRateLimiter(kind: 'generate' | 'upload') {
    const createBucket = (max: number) => createInMemoryRateLimiter({
      windowMs: 60_000, max, ...securityLimits?.[kind],
      key: req => `${req.authSession?.user.id || req.ip}`,
      structuredError: true,
    })
    const local = createBucket(120)
    const remote = createBucket(20)
    const limiter: express.RequestHandler = (req, res, next) => (isLocalEntry(req) ? local : remote)(req, res, next)
    return limiter
  }
  const generateRateLimiter = entryRateLimiter('generate')
  const uploadRateLimiter = entryRateLimiter('upload')
  const writeCoordinator = new GalleryWriteCoordinator(path.resolve(dataFile), `${dataFile}.lock`)
  const mutations = Object.fromEntries(['post', 'patch', 'delete'].map(method => [method, (route: string, ...handlers: express.RequestHandler[]) => {
    const handler = handlers.pop()!
    const wrapped: express.RequestHandler = async (req, res, next) => {
      await writeCoordinator.run(() => handler(req, res, next))
    }
    app[method as 'post' | 'patch' | 'delete'](route, ...handlers, wrapped)
  }])) as Record<'post' | 'patch' | 'delete', (route: string, ...handlers: express.RequestHandler[]) => void>
  const referenceUploadReceipts = new ReferenceUploadReceipts(dataFile, assetStorage)

  app.set('trust proxy', true)
  app.use(cors(createCorsOptions(corsAllowedOrigins)))
  app.get(['/api/health', '/api/v1/health'], (_req, res) => {
    res.json({ status: 'ok', version, authMode: userAuthMode })
  })
  app.use(sessionAttacher)
  app.use(enforceAgentAccess)
  if (providerConfig) {
    app.use('/api/personal/provider-config', createProviderConfigRouter({
      store: providerConfig,
      canManage: isLocalEntry,
      status: () => ({
        ...generation.providerStatus!,
        demoEnabled: enableDemoProvider && generation.availability.demo !== false,
        envProviders: (['seedream', 'qwen', 'kling', 'qwen-local', 'krea-local'] as const)
          .filter(provider => generation.availability[provider] === true),
        apiBaseUrl: `http://${localAccessHost === '::1' ? '[::1]' : localAccessHost}:${localAccessPort}/api/v1`,
        agentTokenConfigured: Boolean(agentApiToken),
        skillPath: 'skills/banana-gallery',
      }),
      refresh: () => {
        generation = buildGenerationRuntime(providerConfig.resolve())
      },
    }))
  }
  app.use(express.json())
  app.use(createSessionRouter(userAuthMode))
  app.post('/api/generate', (_req, res) => {
    res.status(410).json({
      error: '同步生图接口已停用，请改用异步任务队列 /api/generation-tasks',
      code: 'SYNC_GENERATE_RETIRED',
    })
  })

  function requireSessionScope(req: express.Request, res: express.Response) {
    if (!req.authSession) {
      res.status(401).json({ error: 'UNAUTHORIZED' })
      return null
    }

    return sessionScope(req.authSession)
  }

  function sessionScope(session: AppSession) {
    return {
      workspaceId: session.workspace.id,
      ownerUserId: session.user.id,
      userId: session.user.id,
    }
  }

  const backups = new GalleryBackups({ dataFile, imagesDir, referencesDir, backupDir }, writeCoordinator)
  app.use('/api/personal/backups', (req, res, next) => {
    if (!req.authSession) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }
    // Access 的远程会话可看备份状态，变更只能从独立本机入口执行。
    if (req.method !== 'GET' && userAuthMode === 'cloudflare_access' && req.socket.localPort !== localAccessPort) {
      res.status(403).json({ error: '请在本机入口执行备份操作' }); return
    }
    next()
  })
  const personalMetadata = new JsonGalleryRepository(dataFile)
  const backupPolicy = (): AutomaticBackupPolicy => ({ ...defaultBackupPolicy, ...(personalMetadata.readMetadata().backupPolicy as Partial<AutomaticBackupPolicy> || {}) })
  let automaticBackupError: string | null = null
  let automaticBackupBusy = false
  const runAutomaticBackup = async () => {
    if (automaticBackupBusy) return
    automaticBackupBusy = true
    try { if (await backups.runAutomatic(backupPolicy())) automaticBackupError = null }
    catch (error) { automaticBackupError = error instanceof Error ? error.message : '自动备份失败' }
    finally { automaticBackupBusy = false }
  }
  app.locals.startAutomaticBackups = () => {
    void runAutomaticBackup()
    const timer = setInterval(() => { void runAutomaticBackup() }, 60_000); timer.unref()
    return () => clearInterval(timer)
  }
  app.get('/api/personal/backups', (req, res) => res.json({ backups: backups.list(), policy: backupPolicy(), automaticBackupError, automaticBackupBusy, canManage: userAuthMode === 'local' || req.socket.localPort === localAccessPort }))
  app.patch('/api/personal/backups/policy', async (req, res) => {
    const policy = req.body as AutomaticBackupPolicy
    if (typeof policy.enabled !== 'boolean' || !Number.isFinite(policy.intervalHours) || policy.intervalHours < 1 || policy.intervalHours > 168 || !Number.isInteger(policy.maxCount) || policy.maxCount < 1 || policy.maxCount > 100 || !Number.isSafeInteger(policy.maxBytes) || policy.maxBytes < 1024 ** 2 || policy.maxBytes > 1024 ** 4) return res.status(400).json({ error: '备份间隔须为 1–168 小时，数量 1–100，容量 1 MB–1 TB' })
    const normalized = { enabled: policy.enabled, intervalHours: policy.intervalHours, maxCount: policy.maxCount, maxBytes: policy.maxBytes }
    await writeCoordinator.run(() => personalMetadata.saveMetadata({ backupPolicy: normalized }))
    // 先持久化偏好再启动基线；失败可在设置中查看，保留之前的有效快照。
    await runAutomaticBackup()
    res.json({ policy: normalized, automaticBackupError })
  })
  app.post('/api/personal/backups', async (_req, res) => {
    try { res.status(201).json(await backups.create()) }
    catch (error) { res.status(422).json({ error: error instanceof Error ? error.message : '备份失败' }) }
  })
  app.get('/api/personal/update-check', async (req, res) => {
    if (!req.authSession) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }
    res.setHeader('Cache-Control', 'no-store')
    res.json(await checkForAppUpdate({ currentVersion: version }))
  })
  app.post('/api/personal/backups/:id/verify', async (req, res) => {
    try { res.json(await backups.verify(String(req.params.id))) }
    catch (error) { res.status(422).json({ error: error instanceof Error ? error.message : '备份校验失败' }) }
  })

  const storageRefreshes = new Map<string, ReturnType<typeof storageSummary>>()
  app.get('/api/personal/storage', async (req, res) => {
    const scope = requireSessionScope(req, res); if (!scope) return
    const key = jsonRepository ? '' : scope.workspaceId
    let refresh = storageRefreshes.get(key)
    if (!refresh) {
      refresh = writeCoordinator.run(async () => {
        const snapshot = jsonRepository?.readOnlySnapshot()
        return snapshot
          ? captureStorageIndex(snapshot.images, snapshot.resources)
          : captureStorageIndex(await galleryRepository.listImages(scope), await galleryRepository.readResources?.(scope) || {})
      }).then(index => storageSummary({
        imagesDir, referencesDir, cacheDir: path.join(path.dirname(dataFile), 'cache', 'thumbnails'), backupDir,
      }, index)).finally(() => storageRefreshes.delete(key))
      storageRefreshes.set(key, refresh)
    }
    res.json(await refresh)
  })
  mutations.post('/api/personal/storage/clear-cache', async (req, res) => {
    const scope = requireSessionScope(req, res); if (!scope) return
    if (req.body?.confirm !== true) return res.status(400).json({error:'请确认清理缩略图缓存'})
    await fs.promises.rm(path.join(path.dirname(dataFile),'cache','thumbnails'),{recursive:true,force:true})
    res.json({ok:true})
  })

  app.get('/api/settings/runtime', (_req, res) => {
    const scope = requireSessionScope(_req, res)
    if (!scope) return

    if (!showDeveloperDiagnostics) {
      res.json({
        showDeveloperDiagnostics: false,
        allowServerSideImport,
      })
      return
    }

    const { strategy, defaultProvider: defaultImageGenerationProvider, defaultModel: defaultImageGenerationModel } = generation
    if (strategy.mode === 'seedream') {
      res.json({
        showDeveloperDiagnostics: true,
        userAuthMode,
        userAuthLabel: userAuthModeLabel(userAuthMode),
        dataDriver: 'json',
        assetStorageDriver: 'disk',
        allowServerSideImport,
        aiAuthMode: 'seedream',
        aiAuthLabel: `Seedream API（${strategy.model}）`,
      })
      return
    }

    if (strategy.mode === 'qwen' || strategy.mode === 'kling') {
      const providerLabel = strategy.mode === 'qwen' ? 'Qwen' : 'Kling'
      res.json({
        showDeveloperDiagnostics: true,
        userAuthMode,
        userAuthLabel: userAuthModeLabel(userAuthMode),
        dataDriver: 'json',
        assetStorageDriver: 'disk',
        allowServerSideImport,
        aiAuthMode: strategy.mode,
        aiAuthLabel: `${providerLabel} API（${strategy.model}）`,
      })
      return
    }

    if (defaultImageGenerationProvider === 'demo' || strategy.mode === 'openai-compatible') {
      res.json({
        showDeveloperDiagnostics: true,
        userAuthMode,
        userAuthLabel: userAuthModeLabel(userAuthMode),
        dataDriver: 'json',
        assetStorageDriver: 'disk',
        allowServerSideImport,
        aiAuthMode: defaultImageGenerationProvider,
        aiAuthLabel: defaultImageGenerationProvider === 'demo'
          ? '免费演示（本地离线）'
          : `OpenAI 兼容 API（${defaultImageGenerationModel}）`,
      })
      return
    }

    if (strategy.mode === 'googleUnavailable') {
      res.json({
        showDeveloperDiagnostics: true,
        userAuthMode,
        userAuthLabel: userAuthModeLabel(userAuthMode),
        dataDriver: 'json',
        assetStorageDriver: 'disk',
        allowServerSideImport,
        aiAuthMode: 'googleUnavailable',
        aiAuthLabel: 'Google Gemini（未配置）',
      })
      return
    }

    if (strategy.mode === 'vertex') {
      res.json({
        showDeveloperDiagnostics: true,
        userAuthMode,
        userAuthLabel: userAuthModeLabel(userAuthMode),
        dataDriver: 'json',
        assetStorageDriver: 'disk',
        allowServerSideImport,
        aiAuthMode: 'vertex',
        aiAuthLabel: '服务账号（Vertex AI）',
        project: strategy.project,
        location: strategy.location,
      })
      return
    }

    res.json({
      showDeveloperDiagnostics: true,
      userAuthMode,
      userAuthLabel: userAuthModeLabel(userAuthMode),
      dataDriver: 'json',
      assetStorageDriver: 'disk',
      allowServerSideImport,
      aiAuthMode: 'apiKey',
      aiAuthLabel: 'API Key（Gemini Developer API）',
    })
  })

  app.get('/api/generation/providers', async (req, res) => {
    const scope = requireSessionScope(req, res)
    if (!scope) return

    res.json({
      defaultProvider: generation.defaultProvider,
      providers: Object.values(IMAGE_GENERATION_PROVIDER_DEFINITIONS).filter(definition => enableDemoProvider || definition.id !== 'demo').map(
        (definition) => ({
          ...definition,
          model: generation.models[definition.id] ?? defaultModelForProvider(definition.id),
          available: generation.availability[definition.id] ??
            Boolean(generation.providers[definition.id]),
        }),
      ),
    })
  })

  app.get(['/api/generation/models', '/api/v1/models'], async (req, res) => {
    const scope = requireSessionScope(req, res)
    if (!scope) return

    const storedPreferences = (await galleryRepository.readResources?.(scope))?.preferences
    const preferences = storedPreferences && normalizeGenerationPreferences(storedPreferences)
    const savedDefault = preferences?.defaultGeneration
    const order = preferences?.favoriteModels || []
    const localStatus = await localQwenStatus?.()
    const kreaStatus = await localKreaStatus?.()
    let defaultSettings = savedDefault?.provider === 'demo' && !enableDemoProvider ? undefined : savedDefault
    if (providerConfig && defaultSettings?.provider === 'openai-compatible') {
      // This channel exposes one configured model. Keep the user's choice of
      // provider and parameters rather than switching them to another service.
      defaultSettings = { ...defaultSettings, model: generation.models['openai-compatible'] ?? defaultSettings.model }
    }
    res.json({
      defaultSettings,
      defaultModel: defaultSettings ? { provider: defaultSettings.provider, model: defaultSettings.model } : {
        provider: generation.defaultProvider,
        model: generation.defaultModel,
      },
      models: [...generation.definitions].sort((a,b) => { const rank=(model:ImageGenerationModelDefinition) => { const index=order.indexOf(imageGenerationModelKey(model.provider,model.model));return index<0?order.length:index };return rank(a)-rank(b) }).map((definition) => ({
        ...definition,
        supportedResolutions: [...definition.supportedResolutions],
        supportedQualities: [...definition.supportedQualities],
        supportedAspectRatios: [...definition.supportedAspectRatios],
        ...(definition.provider === 'krea-local' && kreaStatus?.reason ? {unavailableReason:kreaStatus.reason} : definition.provider === 'qwen-local' && localStatus?.reason ? { unavailableReason: localStatus.reason } : {}),
        available:
          definition.provider === 'krea-local' && kreaStatus ? kreaStatus.available : definition.provider === 'qwen-local' && localStatus ? localStatus.available :
          generation.availability[definition.provider] !== false &&
          Boolean(generation.modelProviders[imageGenerationModelKey(definition.provider, definition.model)]),
      })),
    })
  })

  app.get('/api/account/summary', (req, res) => {
    if (!req.authSession) {
      res.status(401).json({ error: 'UNAUTHORIZED' })
      return
    }
    res.json({
      ...req.authSession,
      runtimeMode: isLocalEntry(req) ? 'personal-local' : 'personal-remote',
      // The CLI's ensure probe uses this marker to recognize a Gallery listener.
      plan: { id: 'personal' },
    })
  })

  function uniqueFilenames(filenames: string[]) {
    return Array.from(new Set(filenames))
  }

  function isImageFilenameReferenced(images: GalleryImage[], filename: string) {
    return images.some((image) => image.filename === filename)
  }

  function isReferenceFilenameReferenced(images: GalleryImage[], filename: string) {
    return images.some((image) => image.referenceImages.includes(filename))
  }

  async function verifyAssetOwnership(
    scope: NonNullable<ReturnType<typeof requireSessionScope>>,
    kind: 'images' | 'references',
    filename: string,
  ) {
    if (galleryRepository.hasAssetAccess) return galleryRepository.hasAssetAccess(scope, kind, filename)
    const resources = resourceFiles(await galleryRepository.readResources?.(scope))
    if (resources[kind].has(filename)) return true
    const images = await galleryRepository.listImages(scope)
    return kind === 'images'
      ? images.some((image) => image.filename === filename)
      : images.some((image) => image.referenceImages.includes(filename))
  }

  const thumbnailCache = injectedThumbnailCache ?? new ThumbnailCache(path.join(path.dirname(dataFile), 'cache', 'thumbnails'))
  const warmImageThumbnail = (filename:string) => {
    void thumbnailCache.warm(assetStorage.getImagePath(filename)).catch(() => {})
    void thumbnailCache.warm(assetStorage.getImagePath(filename), 'preview').catch(() => {})
  }
  async function withThumbnailVersions(images: readonly GalleryImage[], markMissing = false): Promise<GalleryImage[]> {
    const result: GalleryImage[] = []
    for (let start=0; start<images.length; start+=16) {
      result.push(...await Promise.all(images.slice(start,start+16).map(async image => {
        const { thumbnailVersion: _version, ...entry } = withWorkCode(image)
        void _version
        if (image.purgePending) return entry
        try {
          return { ...entry, thumbnailVersion: await thumbnailVersion(assetStorage.getImagePath(image.filename)) }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          return markMissing && (code === 'ENOENT' || code === 'ENOTDIR') ? { ...entry, originalMissing: true } : entry
        }
      })))
    }
    return result
  }
  app.locals.startThumbnailWarmup = () => {
    const controller = new AbortController()
    const { signal } = controller
    const pause = (ms: number) => delay(ms, undefined, { signal, ref: false })
    void (async () => {
      // Give the first foreground requests a head start and warm only one screen.
      await pause(400)
      const images = (await galleryRepository.listImages()).filter(image => !image.deletedAt)
      images.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      const filenames = [...new Set(images.map(image => image.filename))].slice(0, 24)
      for (const filename of filenames) {
        if (signal.aborted) return
        const source = assetStorage.getImagePath(filename)
        if (!fs.existsSync(source)) continue
        await thumbnailCache.warm(source, 'preview').catch(() => {})
        await pause(100)
        await thumbnailCache.warm(source).catch(() => {})
        await pause(100)
      }
    })().catch(error => {
      if (!signal.aborted) console.warn('[thumbnails] 启动预热失败', error)
    })
    return () => controller.abort()
  }

  async function sendThumbnail(res: express.Response, filePath: string, size?: 'preview' | 'standard') {
    const cached = await thumbnailCache.get(filePath, size)
    await new Promise<void>((resolve, reject) => {
      res.sendFile(cached, error => error ? reject(error) : resolve())
    })
  }

  async function sendProtectedAsset(
    req: express.Request,
    res: express.Response,
    kind: 'images' | 'references',
  ) {
    const scope = requireSessionScope(req, res)
    if (!scope) return

    const filename = sanitizeAssetFilename(String(req.params.filename))
    if (!filename) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const hasAccess = await verifyAssetOwnership(scope, kind, filename)
    if (!hasAccess) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    const filePath = kind === 'images'
      ? assetStorage.getImagePath(filename)
      : assetStorage.getReferencePath(filename)

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    res.setHeader('Cache-Control', 'private, no-store')
    if (req.query.thumbnail === 'true') {
      if (req.query.size !== undefined) {
        const size = req.query.size
        if (size !== 'preview' && size !== 'standard') return res.status(400).json({ error: '缩略图尺寸无效' })
        if (req.query.v !== undefined && req.query.v !== await thumbnailVersion(filePath)) return res.status(409).json({ error: '图片版本已变化，请刷新图库' })
        try { return await sendThumbnail(res, filePath, size) }
        catch (error) {
          if (res.headersSent || res.destroyed) throw error
          const busy = (error as NodeJS.ErrnoException).code === 'ENOENT'
            || error instanceof Error && /queue|superseded/i.test(error.message)
          if (busy) res.setHeader('Retry-After', '1')
          return res.status(busy ? 503 : 422).json({ error: busy ? '缩略图正在准备，请重试' : '图片无法生成缩略图' })
        }
      }
      try { return await sendThumbnail(res, filePath) } catch (error) {
        if (res.headersSent || res.destroyed) throw error
        // Original remains available when generation or cache delivery fails.
      }
    }
    res.sendFile(filePath)
  }

  function cleanupUploadedFiles(files: Array<string | undefined>) {
    for (const filePath of files) {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    }
  }

  app.get('/api/assets/images/:filename', async (req, res) => {
    await sendProtectedAsset(req, res, 'images')
  })

  app.get('/api/assets/references/:filename', async (req, res) => {
    await sendProtectedAsset(req, res, 'references')
  })

  app.use('/api/preferences', createPreferencesRouter(galleryRepository, writeCoordinator, () => generation.definitions))
  app.use('/api/reference-library', createReferenceLibraryRouter({ repository: galleryRepository, storage: assetStorage, coordinator: writeCoordinator, canAccess: async (scope, kind, filename) => {
    return (kind === 'references' && referenceUploadReceipts.canClaim(scope, filename)) || await verifyAssetOwnership({ ...scope, ownerUserId: scope.ownerUserId || scope.userId }, kind, filename)
  } }))
  app.use('/api', createOrganizationRouter(galleryRepository, writeCoordinator, assetStorage))

  async function computeGalleryState(images: readonly GalleryImage[]) {
    const versioned = await withThumbnailVersions(images)
    const trashCount = images.filter(image => image.deletedAt).length
    return {
      revision: createHash('sha256').update(JSON.stringify(versioned)).digest('hex'),
      count: images.length - trashCount,
      trashCount,
    }
  }
  type GalleryStateRefresh = {
    indexRevision: string
    directoryRevision: string
    expiresAt: number
    state: ReturnType<typeof computeGalleryState>
  }
  let galleryState: GalleryStateRefresh | undefined
  const galleryStateTtlMs = 60_000
  async function readDiskGalleryState(repository: JsonGalleryRepository) {
    const originalDirectory = path.dirname(assetStorage.getImagePath('gallery-state.png'))
    const directoryRevision = await fs.promises.stat(originalDirectory, { bigint: true })
      .then(stat => `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`)
      .catch(() => 'unavailable')
    const indexRevision = repository.snapshotRevision()
    if (galleryState?.indexRevision === indexRevision && galleryState.directoryRevision === directoryRevision &&
        Date.now() < galleryState.expiresAt) return galleryState.state

    const snapshot = repository.readOnlySnapshot()
    const refresh: GalleryStateRefresh = {
      indexRevision: snapshot.revision,
      directoryRevision,
      expiresAt: Infinity,
      state: computeGalleryState(snapshot.images),
    }
    galleryState = refresh
    try {
      const state = await refresh.state
      // An in-place original edit doesn't change the parent directory's mtime.
      refresh.expiresAt = Date.now() + galleryStateTtlMs
      return state
    } catch (error) {
      if (galleryState === refresh) galleryState = undefined
      throw error
    }
  }

  app.get('/api/gallery/state', async (req, res) => {
    const scope = requireSessionScope(req, res)
    if (!scope) return
    const state = jsonRepository && assetStorage instanceof DiskAssetStorage
      ? await readDiskGalleryState(jsonRepository)
      : await computeGalleryState(await galleryRepository.listImages(scope))
    res.setHeader('Cache-Control', 'no-store')
    res.json(state)
  })

  app.get('/api/gallery/stats', async (req, res) => {
    const scope = requireSessionScope(req, res); if (!scope) return
    res.setHeader('Cache-Control', 'no-store')
    let images = await galleryRepository.listImages(scope)
    if (typeof req.query.group === 'string' && req.query.group) {
      const group = normalizeCollections((await galleryRepository.readResources?.(scope))?.groups || [], images).find(group => group.id === req.query.group)
      images = images.filter(image => image.assetType === group?.assetType && group.imageIds.includes(image.id))
    }
    res.json(galleryStatistics(filterGalleryImages(images, galleryQueryFromParams(new URL(req.originalUrl, 'http://local').searchParams))))
  })
  const galleryPages = new GalleryPaginationCache()
  app.get(['/api/images', '/api/v1/works', '/api/v1/recipes'], async (req, res) => {
    const scope = requireSessionScope(req, res)
    if (!scope) return

    const groupId = typeof req.query.group === 'string' ? req.query.group : ''
    const activeImages = (images: readonly GalleryImage[], groups?: ReadOnlyGalleryResources['groups']) => {
      if (!groupId) return images.filter(image => !image.deletedAt)
      const group = normalizeCollections(groups || [], images).find(group => group.id === groupId)
      const ids = new Set(group?.imageIds)
      return images.filter(image => !image.deletedAt && image.assetType === group?.assetType && ids.has(image.id))
    }
    const listActiveImages = async () => activeImages(await galleryRepository.listImages(scope),
      groupId ? (await galleryRepository.readResources?.(scope))?.groups : undefined)
    const params = new URL(req.originalUrl, 'http://local').searchParams
    const v1 = isAgentApiV1(req)
    if (v1) {
      params.set('assetType', /^\/api\/v1\/works\/?$/i.test(req.path) ? 'work' : 'recipe')
      if (!params.has('pinFirst')) params.set('pinFirst', '0')
    }
    const project = v1
      ? (items: GalleryImage[]) => items.map(image => ({
          ...galleryImageSummary(image),
          ...(params.get('fields') === 'full' ? { prompt: image.prompt } : {}),
        }))
      : params.get('fields') === 'summary'
        ? (items: GalleryImage[]) => items.map(galleryImageSummary)
        : withThumbnailVersions
    if (v1 || req.query.limit !== undefined || req.query.cursor !== undefined) {
      const snapshot = jsonRepository?.readOnlySnapshot()
      const fallbackImages = snapshot ? [] : await listActiveImages()
      try {
        const page = snapshot
          ? galleryPages.page(snapshot.revision, JSON.stringify([scope.workspaceId, groupId]),
            () => activeImages(snapshot.images, snapshot.resources.groups), params)
          : createGalleryPage(fallbackImages, params)
        return res.json({ ...page, items: await project(page.items) })
      } catch (error) {
        const message = error instanceof Error ? error.message : '分页请求无效'
        return res.status(message.includes('图库已变化') ? 409 : 400).json({ error: message })
      }
    }
    let images = await listActiveImages()
    if (params.get('pinFirst') === '0' || ['q', 'assetType', 'sort', 'model', 'source', 'from', 'to', 'pinned', 'inbox', 'group'].some(key => req.query[key] !== undefined)) {
      return res.json(await project(filterGalleryImages(images, galleryQueryFromParams(params))))
    }
    const { tag, favorites } = req.query
    if (favorites === 'true') images = images.filter((image) => image.favorited)
    if (tag) images = images.filter((image) => image.tags.includes(tag as string))
    res.json(await project(images))
  })

  function assetUrl(kind: 'images' | 'references', filename: string) {
    return `/api/assets/${kind}/${encodeURIComponent(filename)}`
  }

  async function resolveAvailableWork(req: express.Request<{ code: string }>, res: express.Response) {
    res.setHeader('Cache-Control', 'private, no-store')
    const scope = requireSessionScope(req, res)
    if (!scope) return

    const code = '#' + req.params.code.replace(/^#/, '').toUpperCase()
    const works = (await galleryRepository.listImages(scope)).filter(isAvailableWork)
    const matches = works.filter(image => workCode(image.id) === code)
    if (!matches.length) { res.status(404).json({ error: '找不到该图片编号' }); return }
    if (matches.length > 1) { res.status(409).json({ error: '该图片编号对应多张作品' }); return }
    return { scope, image: matches[0], code, works }
  }

  app.get('/api/gallery/works/by-code/:code', async (req, res) => {
    const found = await resolveAvailableWork(req, res)
    if (found) res.json({ id: found.image.id, prompt: found.image.prompt })
  })

  app.get<{ code: string }>(['/api/gallery/works/by-code/:code/context', '/api/v1/works/:code/context'], async (req, res) => {
    const found = await resolveAvailableWork(req, res)
    if (!found) return
    const { scope, image, code, works } = found
    const jobs = (await taskQueue.list(scope)).filter(job => job.result)
    const linked = jobs.filter(job => job.workAssetId === image.id)
    const legacy = linked.length ? [] : jobs.filter(job => !job.workAssetId && job.result?.filename === image.filename)
    const matches = linked.length ? linked : legacy
    const ambiguous = matches.length > 1 || (legacy.length > 0 && works.some(work => work.id !== image.id && work.filename === image.filename))
    const job = !ambiguous && matches.length === 1 && !matches[0].purgePending ? matches[0] : undefined
    const input = job?.input
    res.json({
      id: image.id,
      workCode: code,
      prompt: image.prompt,
      imageUrl: assetUrl('images', image.filename),
      generationTask: job && input ? { id: job.id, input: publicGenerationInput(input) } : null,
      generationTaskIssue: job ? undefined : ambiguous ? 'ambiguous' : 'unavailable',
      references: (input?.referenceFilenames ?? image.referenceImages).map((filename, index) => ({
        filename,
        url: assetUrl('references', filename),
        note: (input ? input.referenceNotes : image.referenceNotes)?.[index],
      })),
    })
  })

  app.get('/api/images/:id', async (req, res) => {
    const scope = requireSessionScope(req, res)
    if (!scope) return
    const image = (await galleryRepository.listImages(scope)).find(image => image.id === req.params.id && !image.deletedAt)
    if (!image) return res.status(404).json({ error: '条目不存在或已移入回收站' })
    res.json((await withThumbnailVersions([image]))[0])
  })

  mutations.patch('/api/images/:id', async (req, res) => {
    const scope = requireSessionScope(req, res)
    if (!scope) return

    const images = await galleryRepository.listImages(scope)
    const index = images.findIndex((image) => image.id === req.params.id && !image.deletedAt)
    if (index === -1) return res.status(404).json({ error: 'Not found' })

    if (req.body?.expectedVersion !== undefined && (!Number.isInteger(req.body.expectedVersion) || req.body.expectedVersion < 0)) return res.status(400).json({ error: '版本号无效' })
    if (req.body?.expectedVersion !== undefined && req.body.expectedVersion !== (images[index].version || 0)) return res.status(409).json({ error: '条目已在其他窗口更新。你的草稿仍保留，请刷新条目后再决定如何保存。', current: images[index] })
    const pickedUpdates = pickGalleryImageUpdates(req.body)
    if (pickedUpdates.error) {
      return res.status(400).json({ error: pickedUpdates.error })
    }

    const nextImages = [...images]
    nextImages[index] = {
      ...nextImages[index],
      ...pickedUpdates.updates,
      version: (images[index].version || 0) + 1,
      updatedAt: new Date().toISOString(),
    }
    await galleryRepository.saveImages(nextImages, scope)
    res.json((await withThumbnailVersions([nextImages[index]]))[0])
  })

  mutations.delete('/api/images/:id', async (req, res) => {
    const scope = requireSessionScope(req, res)
    if (!scope) return
    const images = await galleryRepository.listImages(scope)
    const image = images.find(item => item.id === req.params.id)
    if (!image) return res.status(404).json({ error: 'Not found' })
    if (image.deletedAt) return res.json({ ok: true, version: image.version ?? 0, moved: false })
    const now = new Date().toISOString()
    const version = (image.version ?? 0) + 1
    await galleryRepository.saveImages(images.map(item => item.id === image.id ? { ...item, deletedAt: now, updatedAt: now, version } : item), scope)
    res.json({ ok: true, version, moved: true })
  })

  app.get('/api/trash', async (req, res) => {
    const scope = requireSessionScope(req, res)
    if (!scope) return
    const items = (await galleryRepository.listImages(scope)).flatMap(image => {
      if (!image.deletedAt) return []
      const time = Date.parse(image.deletedAt)
      return [{ item: { ...image, deletedAt: image.deletedAt, version: image.version ?? 0 }, time: Number.isFinite(time) ? time : -Infinity }]
    })
    items.sort((a, b) => {
      if (a.time !== b.time) return b.time - a.time
      return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0
    })
    res.setHeader('Cache-Control', 'no-store')
    res.json(await withThumbnailVersions(items.map(({ item }) => item), true))
  })

  function trashPrecondition(image: GalleryImage | undefined, expectedVersion: unknown) {
    if (expectedVersion === undefined) return
    if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      return { status: 400, error: '版本号无效' }
    }
    if (!image) return { status: 404, error: '条目不存在', code: 'TRASH_NOT_FOUND' }
    if (!image.deletedAt) return { status: 409, error: '条目已不在回收站', code: 'TRASH_NOT_DELETED' }
    if ((image.version ?? 0) !== expectedVersion) return { status: 409, error: '回收站条目已变化，请重新确认后再操作', code: 'TRASH_VERSION_CONFLICT' }
  }

  mutations.post('/api/trash/:id/restore', async (req, res) => {
    const scope = requireSessionScope(req, res)
    if (!scope) return
    const images = await galleryRepository.listImages(scope)
    const image = images.find(item => item.id === req.params.id)
    const conflict = trashPrecondition(image, req.body?.expectedVersion)
    if (conflict) {
      const { status, ...body } = conflict
      return res.status(status).json(body)
    }
    if (!image) return res.status(404).json({ error: '条目不存在' })
    if (image.purgePending) return res.status(409).json({ error: '已开始永久清理，请重试清理；如需恢复请使用备份', code: 'TRASH_PURGE_PENDING' })
    if (!image.deletedAt) return res.json((await withThumbnailVersions([image]))[0])
    const restored = { ...image, version: (image.version ?? 0) + 1, updatedAt: new Date().toISOString() }
    delete restored.deletedAt
    await galleryRepository.saveImages(images.map(item => item.id === image.id ? restored : item), scope)
    res.json((await withThumbnailVersions([restored]))[0])
  })

  mutations.delete('/api/trash/:id', async (req, res) => {
    const scope = requireSessionScope(req, res)
    if (!scope) return
    if (req.body?.confirm !== true) return res.status(400).json({ error: '请明确确认永久删除' })
    const images = await galleryRepository.listImages(scope)
    const image = images.find(item => item.id === req.params.id)
    const conflict = trashPrecondition(image, req.body?.expectedVersion)
    if (conflict) {
      const { status, ...body } = conflict
      return res.status(status).json(body)
    }
    if (!image) return res.json({ ok: true })
    if (!image.deletedAt) return res.status(409).json({ error: '请先将条目移入回收站' })
    await preserveCollectionOwnership(galleryRepository, images, scope)
    const remainingImages = images.filter(item => item.id !== image.id)
    const resourceReferences = resourceFiles(await galleryRepository.readResources?.(scope))
    // 持久化不可恢复状态后才开始清文件；失败保留条目，让用户看到并重试清理。
    if (!image.purgePending) {
      await galleryRepository.saveImages(images.map(item => item.id === image.id ? { ...item, purgePending: true, version: (item.version ?? 0) + 1, updatedAt: new Date().toISOString() } : item), scope)
    }
    if (!isImageFilenameReferenced(remainingImages, image.filename) && !resourceReferences.images.has(image.filename)) {
      await assetStorage.deleteImage(image.filename)
    }
    for (const filename of uniqueFilenames(image.referenceImages).filter(filename => !isReferenceFilenameReferenced(remainingImages, filename) && !resourceReferences.references.has(filename))) {
      await assetStorage.deleteReferences([filename])
    }
    await galleryRepository.saveImages(remainingImages, scope)
    res.json({ ok: true })
  })

  async function saveRecipeFromWork(res: express.Response, scope: GenerationTaskScope, workId: string, updates?: Partial<GalleryImage>) {
    const images = await galleryRepository.listImages(scope)
    const source = images.find((image) => image.id === workId && !image.deletedAt)
    if (!source) return res.status(404).json({ error: 'Not found' })
    if (source.assetType !== 'work') {
      return res.status(400).json({ error: 'Only works can be converted into recipes' })
    }

    const recipe = { ...createRecipeFromImage(source), ...updates }
    images.unshift(recipe)
    await galleryRepository.saveImages(images, scope)
    warmImageThumbnail(recipe.filename)
    res.json(updates ? publicRecipe(recipe) : recipe)
  }

  mutations.post('/api/images/:id/recipe', async (req, res) => {
    const scope = requireSessionScope(req, res)
    if (scope) await saveRecipeFromWork(res, scope, String(req.params.id))
  })

  // JSON copies an existing work; multipart saves a recipe directly.
  app.post('/api/v1/recipes', async (req, res, next) => {
    if (req.is('multipart/form-data')) return next()
    const scope = requireSessionScope(req, res)
    if (!scope) return
    const { workId, title, tags, sourceType } = req.body ?? {}
    if (typeof workId !== 'string' || !workId) return res.status(400).json({ error: 'workId is required' })
    const metadata = recipeMetadata(title, tags, sourceType)
    if (metadata.error) return res.status(400).json({ error: metadata.error })
    await writeCoordinator.run(() => saveRecipeFromWork(res, scope, workId, metadata.updates))
  })

  const uploadOptions = {
    // Busboy rejects at equality; the actual inclusive limit is checked after intake.
    limits: { fileSize: PNG_INPUT_MAX_BYTES + 1 },
    fileFilter: (_req: express.Request, file: Express.Multer.File, callback: multer.FileFilterCallback) => {
      if (!isSupportedImageMimeType(file.mimetype)) {
        callback(new Error('仅支持 JPG、PNG、WebP 图片'))
        return
      }

      callback(null, true)
    },
  }

  const imageFilename = (file: Express.Multer.File) => `${randomUUID()}${path.extname(file.originalname)}`
  const referenceFilename = (file: Express.Multer.File) => `ref_${imageFilename(file)}`
  const uploadImage = multer({
    storage: uploadDiskStorage(assetStorage.getImagesDir(), imageFilename),
    ...uploadOptions,
  })
  const uploadReferences = multer({
    storage: uploadDiskStorage(assetStorage.getReferencesDir(), referenceFilename),
    ...uploadOptions,
    limits: { ...uploadOptions.limits, fields: 2, fieldSize: 256, fieldNameSize: 32, parts: 19 },
  })
  const stageReferenceAppend = multer({
    storage: uploadDiskStorage(assetStorage.getReferencesDir(), () => `.append-${randomUUID()}.tmp`),
    ...uploadOptions,
  })
  const uploadGeminiImport = multer({
    storage: uploadDiskStorage(
      file => file.fieldname === 'references' ? assetStorage.getReferencesDir() : assetStorage.getImagesDir(),
      file => file.fieldname === 'references' ? referenceFilename(file) : imageFilename(file),
    ),
    ...uploadOptions,
  })

  function postUpload(
    route: string | string[],
    parse: express.RequestHandler,
    handle: (
      req: express.Request,
      res: express.Response,
      scope: ReturnType<typeof sessionScope>,
      keepFiles: () => void,
    ) => Promise<unknown>,
    localOnly = false,
  ) {
    app.post(route, (req, res, next) => {
      if (!requireSessionScope(req, res)) return
      if (localOnly && !isLocalEntry(req)) {
        res.status(401).json({ error: 'Gemini 网页扩展导入第一版仅支持 personal 本地入口' })
        return
      }
      next()
    }, uploadRateLimiter, handleDiskUpload(parse, (req, res, keepFiles) =>
      writeCoordinator.run(() => handle(req, res, sessionScope(req.authSession!), keepFiles)),
    ))
  }

  postUpload(['/api/images', '/api/v1/recipes'], uploadImage.single('image'), async (req, res, scope, keepFiles) => {
    if (!req.file) return res.status(400).json({ error: 'No image file' })
    const recipe = isAgentApiV1(req)
    const body = req.body ?? {}
    if (recipe && (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > MAX_PROMPT_LENGTH)) {
      return res.status(400).json({ error: 'A nonempty prompt of at most 20000 characters is required' })
    }
    const invalidField = ['prompt', 'title', 'category', 'tags', 'createdAt']
      .find(field => body[field] !== undefined && typeof body[field] !== 'string')
    if (invalidField) {
      return res.status(400).json({ error: `${invalidField} 必须是单个文本字段` })
    }
    const { prompt = '', tags: rawTags = '[]', createdAt } = body
    let tags: unknown
    try { tags = JSON.parse(rawTags) } catch { /* Invalid tags are rejected below. */ }
    if (!Array.isArray(tags) || !tags.every(tag => typeof tag === 'string')) {
      return res.status(400).json({ error: 'tags 必须是 JSON 字符串数组' })
    }
    const metadata = recipe ? recipeMetadata(body.title, tags, body.sourceType) : undefined
    if (metadata?.error) return res.status(400).json({ error: metadata.error })

    await normalizeIncomingPngFiles([req.file])
    const { width, height } = await inspectIncomingImage(req.file.path)

    const entry: GalleryImage = {
      id: randomUUID(),
      filename: req.file.filename,
      prompt,
      referenceImages: [],
      tags,
      favorited: false,
      createdAt: (!recipe && createdAt) || new Date().toISOString(),
      width,
      height,
      assetType: recipe ? 'recipe' : 'work',
      ...metadata?.updates,
    }

    const images = await galleryRepository.listImages(scope)
    await assetStorage.finalizeImage(req.file.filename)
    images.unshift(entry)
    await galleryRepository.saveImages(images, scope)
    keepFiles()
    warmImageThumbnail(entry.filename)
    res.json(recipe ? publicRecipe(entry) : withWorkCode(entry))
  })

  postUpload(
    '/api/external/gemini-web/import',
    uploadGeminiImport.fields([
      { name: 'image', maxCount: 1 },
      { name: 'references', maxCount: 14 },
    ]),
    async (req, res, scope, keepFiles) => {
      const files = req.files as Record<string, Express.Multer.File[]> | undefined
      const imageFile = files?.image?.[0]
      const referenceFiles = files?.references ?? []
      if (!imageFile) {
        return res.status(400).json({ error: 'No image file' })
      }

      const rawMetadata = req.body?.metadata
      if (rawMetadata !== undefined && typeof rawMetadata !== 'string') {
        return res.status(400).json({ error: 'metadata 必须是单个文本字段' })
      }
      const metadata = parseGeminiImportMetadata(rawMetadata)
      if (!metadata.prompt) {
        return res.status(400).json({ error: '请提供提示词' })
      }

      if ((metadata.sourceUrl && !isSafeSourceUrl(metadata.sourceUrl))
        || (metadata.capturedAt && !Number.isFinite(Date.parse(metadata.capturedAt)))) {
        return res.status(400).json({ error: '来源网址或采集时间无效' })
      }
      if (metadata.requestId && !/^[\w-]{1,128}$/.test(metadata.requestId)) {
        return res.status(400).json({ error: '导入请求标识无效' })
      }
      const images = await galleryRepository.listImages(scope)
      const originalContentHash = sha256(await fs.promises.readFile(imageFile.path))
      const originalReferenceHashes = await Promise.all(referenceFiles.map(async file => sha256(await fs.promises.readFile(file.path))))
      const importFingerprint = createHash('sha256').update(JSON.stringify({contentHash:originalContentHash,referenceHashes:originalReferenceHashes,prompt:metadata.prompt,assetType:metadata.assetType,tags:metadata.tags,sourceUrl:metadata.sourceUrl,capturedAt:metadata.capturedAt})).digest('hex')
      const previous = metadata.requestId ? images.find(image=>image.importRequestId===metadata.requestId) : metadata.capturedAt ? images.find(image=>image.importFingerprint===importFingerprint) : undefined
      if (previous) {
        if(previous.importFingerprint!==importFingerprint)return res.status(409).json({error:'同一导入标识对应不同内容，请重新打开保存面板'})
        if(previous.deletedAt)return res.status(409).json({error:'这次导入的记录已在回收站，请先恢复或重新打开面板另存'})
        return res.json(previous)
      }
      await normalizeIncomingPngFiles([imageFile, ...referenceFiles])
      const { width, height } = await inspectIncomingImage(imageFile.path)
      const contentHash = sha256(await fs.promises.readFile(imageFile.path))
      const referenceHashes = await Promise.all(referenceFiles.map(async file => sha256(await fs.promises.readFile(file.path))))
      if (metadata.checkDuplicates && !metadata.allowDuplicate) {
        const candidates = await importCandidates(images, { imageHash: contentHash, referenceHashes, prompt: metadata.prompt, sourceUrl: metadata.sourceUrl }, assetStorage)
        if (candidates.length) return res.json({ requiresConfirmation: true, candidates })
      }

      const referenceFilenames = referenceFiles.map((file) => file.filename)

      const entry: GalleryImage = {
        id: randomUUID(),
        filename: imageFile.filename,
        prompt: metadata.prompt,
        referenceImages: referenceFilenames,
        tags: metadata.tags,
        favorited: false,
        createdAt: metadata.capturedAt ? new Date(metadata.capturedAt).toISOString() : new Date().toISOString(),
        width,
        height,
        assetType: metadata.assetType,
        contentHash, referenceHashes, importFingerprint, ...(metadata.requestId ? {importRequestId:metadata.requestId} : {}),
        sourceFile: 'gemini-web', sourceType: 'gemini-web',
        ...(metadata.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
        capturedAt: metadata.capturedAt ? new Date(metadata.capturedAt).toISOString() : new Date().toISOString(),
      }

      await assetStorage.finalizeImage(imageFile.filename)
      await assetStorage.finalizeReferences(referenceFilenames)
      images.unshift(entry)
      await galleryRepository.saveImages(images, scope)
      keepFiles()
      warmImageThumbnail(entry.filename)
      res.json(withWorkCode(entry))
    },
    true,
  )

  app.use('/api/images', (req, res, next) => {
    if (req.method === 'PUT' && /^\/[^/]+\/references$/.test(req.path)) uploadRateLimiter(req, res, next)
    else next()
  }, createImageReferencesRouter({ galleryRepository, assetStorage, writeCoordinator }))

  postUpload('/api/images/:id/references', stageReferenceAppend.array('references', 10), async (req, res, scope, keepFiles) => {
    const uploadedFiles = (req.files ?? []) as Express.Multer.File[]
    const headerKey = req.get('x-idempotency-key')
    const formKey: unknown = req.body?.idempotencyKey
    const key = headerKey ?? formKey
    if ((key !== undefined && (typeof key !== 'string' || !/^[!-~]{1,128}$/.test(key)))
      || (headerKey !== undefined && formKey !== undefined && headerKey !== formKey)) {
      return res.status(400).json({ error: '幂等请求标识无效或不一致' })
    }

    type ReferenceAppendEntry = GalleryImage & { referenceAppendReceipts?: string[] }
    const images: ReferenceAppendEntry[] = await galleryRepository.listImages(scope)
    const index = images.findIndex(item => item.id === req.params.id)
    if (index === -1) {
      return res.status(404).json({ error: 'Not found' })
    }

    const { referenceAppendReceipts = [], ...image } = images[index]
    const receipt = typeof key === 'string' ? sha256(Buffer.from(JSON.stringify([image.id, key]))) : undefined
    // This handler runs under the write coordinator. Persist the receipt with the
    // append so a concurrent retry or a restart cannot publish the files again.
    if (receipt && referenceAppendReceipts.includes(receipt)) {
      return res.json(withWorkCode(image))
    }

    if (uploadedFiles.length === 0) return res.status(400).json({ error: 'No files' })
    for (const file of uploadedFiles) {
      const filename = referenceFilename(file)
      const target = assetStorage.getReferencePath(filename)
      await fs.promises.rename(file.path, target)
      Object.assign(file, { path: target, filename })
    }
    await normalizeIncomingPngFiles(uploadedFiles)
    const filenames = uploadedFiles.map(file => file.filename)
    const updated = { ...image, referenceImages: [...image.referenceImages, ...filenames] }
    images[index] = { ...images[index], ...updated }
    if (receipt) images[index].referenceAppendReceipts = [...referenceAppendReceipts, receipt]
    await assetStorage.finalizeReferences(filenames)
    await galleryRepository.saveImages(images, scope)
    keepFiles()
    res.json(withWorkCode(updated))
  })

  mutations.post('/api/import', async (req, res) => {
    const scope = requireSessionScope(req, res)
    if (!scope) return

    if (!allowServerSideImport) {
      return res.status(403).json({ error: '当前运行模式不允许读取服务器本机路径' })
    }

    const { markdownPath, vaultImagesPath } = req.body ?? {}
    if (typeof markdownPath !== 'string' || !markdownPath || typeof vaultImagesPath !== 'string' || !vaultImagesPath) {
      return res.status(400).json({ error: 'markdownPath and vaultImagesPath required' })
    }

    let note: string
    try {
      note = fs.realpathSync(markdownPath)
      if (!fs.statSync(note).isFile()) throw new Error('Not a file')
    } catch {
      return res.status(404).json({ error: `File not found: ${markdownPath}` })
    }
    let root: string
    try {
      root = fs.realpathSync(vaultImagesPath)
      if (!fs.statSync(root).isDirectory()) throw new Error('Not a directory')
    } catch {
      return res.status(400).json({ error: '附件目录不存在或不可用' })
    }

    const entries = parseObsidianMarkdown(fs.readFileSync(note, 'utf-8'))
    const images = await galleryRepository.listImages(scope)
    const sourceFile = path.basename(note)
    const known = new Set(images.map(image => image.importFingerprint))
    const legacyImages = images.filter(image => image.sourceFile === sourceFile && !image.importFingerprint)
    const legacyHashes = new Map<string, Set<string>>()
    const staged: Array<{ path: string; filename: string; mimetype: string; size: number }> = []
    const importedImages: GalleryImage[] = []

    try {
      for (const { prompt, imageFilename } of entries) {
        const attachment = await readObsidianAttachment(root, imageFilename)
        if (!attachment) continue
        const { buffer, width, height, format } = attachment
        const originalHash = sha256(buffer)
        const importFingerprint = sha256(Buffer.from(JSON.stringify(['obsidian', note, prompt, originalHash])))
        if (known.has(importFingerprint)) continue

        // Old imports recorded only the note's basename. Require the complete
        // prompt and matching stored bytes before treating one as a duplicate.
        let hashes = legacyHashes.get(prompt)
        if (!hashes) {
          hashes = new Set()
          for (const image of legacyImages.filter(image => image.prompt === prompt)) {
            const bytes = await fs.promises.readFile(assetStorage.getImagePath(image.filename)).catch(() => undefined)
            if (bytes) hashes.add(sha256(bytes))
          }
          legacyHashes.set(prompt, hashes)
        }
        if (hashes.has(originalHash)) continue

        const filename = `${randomUUID()}.${format === 'jpeg' ? 'jpg' : format}`
        const file = { filename, path: assetStorage.getImagePath(filename), mimetype: `image/${format}`, size: buffer.length }
        staged.push(file)
        await fs.promises.writeFile(file.path, buffer, { flag: 'wx' })
        await normalizeIncomingPngFiles([file])
        const contentHash = file.filename === filename ? originalHash : sha256(await fs.promises.readFile(file.path))
        if (hashes.has(contentHash)) {
          await fs.promises.rm(file.path, { force: true })
          staged.pop()
          continue
        }

        known.add(importFingerprint)
        importedImages.push({
          id: randomUUID(), filename: file.filename, prompt, referenceImages: [], tags: [], favorited: false,
          createdAt: new Date().toISOString(), width, height, assetType: 'recipe', sourceFile, contentHash, importFingerprint,
        })
      }
    } catch (error) {
      cleanupUploadedFiles(staged.map(file => file.path))
      throw error
    }

    if (staged.length) {
      try {
        for (const file of staged) await assetStorage.finalizeImage(file.filename)
        await galleryRepository.saveImages([...images, ...importedImages], scope)
      } catch (error) {
        await Promise.allSettled(staged.map(file => assetStorage.deleteImage(file.filename)))
        throw error
      }
      for (const file of staged) {
        warmImageThumbnail(file.filename)
      }
    }
    res.json({ imported: staged.length, skipped: entries.length - staged.length, total: entries.length })
  })

  async function collectExpiredReferenceUploads() {
    try {
      await referenceUploadReceipts.collectExpired(writeCoordinator, (scope, filename) =>
        verifyAssetOwnership({ ...scope, ownerUserId: scope.ownerUserId || scope.userId }, 'references', filename))
    } catch {
      console.warn('[reference-upload] 未能清理过期上传回执，将稍后重试')
    }
  }

  app.post(['/api/references/upload', '/api/v1/references/upload'], (req, res, next) => {
    if (requireSessionScope(req, res)) next()
  }, uploadRateLimiter, boundReferenceUpload(uploadReferences.array('references', 16)), async (req, res) => {
    const scope = requireSessionScope(req, res)
    if (!scope) return
    const uploadedFiles = (req.files ?? []) as Express.Multer.File[]
    const header = req.get('Idempotency-Key')
    const field: unknown = req.body?.uploadKey
    const key = header ?? field
    if ((key !== undefined && (typeof key !== 'string' || !/^[!-~]{1,128}$/.test(key))) ||
        (header !== undefined && field !== undefined && header !== field)) {
      cleanupUploadedFiles(uploadedFiles.map(file => file.path))
      return res.status(400).json({ error: '幂等请求标识无效或不一致' })
    }

    let filenames: string[] | undefined
    let published = false
    let finalizing = false
    try {
      filenames = referenceUploadReceipts.filenamesFor(scope, key)
      if (!filenames && uploadedFiles.length) {
        await normalizeIncomingPngFiles(uploadedFiles)
        const prepared = uploadedFiles.map(file => file.filename)
        finalizing = true
        await assetStorage.finalizeReferences(prepared)

        filenames = await writeCoordinator.run(async () => {
          // Concurrent retries can both finish intake; only one may publish.
          const previous = referenceUploadReceipts.filenamesFor(scope, key)
          if (previous) return previous
          referenceUploadReceipts.record(scope, key, prepared)
          published = true
          return prepared
        })
      }
    } finally {
      if (!published) {
        if (finalizing) await assetStorage.deleteReferences(uploadedFiles.map(file => file.filename))
        else cleanupUploadedFiles(uploadedFiles.map(file => file.path))
      }
    }
    await collectExpiredReferenceUploads()
    if (!filenames) return res.status(400).json({ error: 'No files' })
    res.json({ filenames })
  })

  const receipts = generationTaskReceipts(dataFile, assetStorage)
  const taskQueue = new GenerationTaskQueue({
    repository: galleryRepository, coordinator: writeCoordinator,
    readReceipt: receipts.read, removeReceipt: receipts.remove,
    maxConcurrentByProvider: { google: 1, demo: 1, 'qwen-local': 1, 'krea-local': 1 },
    resumable: hasOriginalResult,
    maxRetries: 3,
    retryDelayMs: retryCount => Math.min((generationRetryBaseDelayMs ?? 30_000) * 2 ** Math.max(0, retryCount - 1), 10 * 60_000),
    execute: async (job, control) => {
      const { input } = job
      if (isRetiredSeedreamRequest(input.provider, input.model, input.imageSize)) {
        throw new TaskError('此任务使用已下线的 Seedream 模型或分辨率，可另开草稿后提交 5.5')
      }
      if (!isImageGenerationProviderName(input.provider)) throw new TaskError(RETIRED_GENERATION_PROVIDER_MESSAGE)
      const { model, provider: providerName } = input
      const provider = providerName === 'demo' && !enableDemoProvider
        ? undefined
        : generation.modelProviders[imageGenerationModelKey(providerName, model)]
      if (!provider) throw new TaskError('服务器未配置该模型，请调整草稿后重新提交', 503, false, false, { category: 'auth', message: '服务器未配置该模型，请调整草稿后重新提交', retryable: false, uncertain: false })
      const references: ReferenceImageForGeneration[] = []
      // Legacy v1 source-size verification still needs its original reference; v2 has a frozen canvas.
      const recoveringOriginalResult = hasOriginalResult(job) && (input.provider !== 'qwen-local' || input.execution?.workflowVersion === 'qwen21-v2')
      for (const filename of recoveringOriginalResult ? [] : input.referenceFilenames) {
        try {
          const data = await fs.promises.readFile(assetStorage.getReferencePath(filename))
          const extension = path.extname(filename).toLowerCase()
          references.push({ data, mimeType: extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg' })
        } catch { throw new TaskError('任务参考图文件不可读，未提交新的生成请求', 404) }
      }
      try {
        const generated = await provider.generateImage({
          ...input, requestId: job.id, signal: control.signal, noAutomaticRetry: true, referenceImages: references, resumeTaskId: job.upstreamTaskId,
          onTaskSubmitted: control.onUpstreamTask, onRequestStarted: control.onRequestStarted,
          onRequestStartedWithUpstream: control.onRequestStarted,
        })
        control.signal.throwIfAborted()
        const filename = `gen_${job.id}${extensionForGeneratedImage(generated.mimeType)}`
        const filePath = assetStorage.getImagePath(filename)
        const temporary = path.join(path.dirname(filePath), `.${filename}.${randomUUID()}.tmp`)
        let receiptWritten = false
        let published = false
        try {
          await fs.promises.writeFile(temporary, generated.buffer, { flag: 'wx', signal: control.signal, flush: true })
          const { width, height } = await inspectIncomingImage(temporary)
          const result = { filename, width, height, ...(generated.execution ? { execution: generated.execution } : {}), prompt: input.prompt, provider: input.provider, model, aspectRatio: input.aspectRatio, imageSize: input.imageSize, quality: input.quality }
          const completedAt = new Date().toISOString()
          control.signal.throwIfAborted()
          receipts.write(job.id, { result, outputBytes: generated.buffer.length, completedAt })
          receiptWritten = true
          fs.renameSync(temporary, filePath)
          published = true
          await assetStorage.finalizeImage(filename)
          const onSaved = generated.onSaved
          return { ...result, completedAt, afterReceiptSaved: onSaved && (() => onSaved(filePath)) }
        } catch (error) {
          control.signal.throwIfAborted()
          const message = error instanceof ImageIntakeError
            ? '上游返回的图片已损坏或尺寸无效，未保存；未重新生成'
            : '图片已生成但未能保存，请检查存储空间和权限；未重新生成'
          throw new TaskError(message, 500, true, false, { category: 'storage', message, retryable: false, uncertain: true })
        } finally {
          if (!published) {
            if (receiptWritten) await receipts.remove(job.id).catch(() => {})
            await fs.promises.rm(temporary, { force: true }).catch(() => {})
          }
        }
      } catch (error) {
        if (error instanceof TaskError) throw error
        const failure = describeImageGenerationFailure(error)
        throw new TaskError(failure.message, failure.httpStatus || 500, failure.uncertain, failure.retryable, failure)
      }
    },
    saveWork: async job => {
      if (!job.result) throw new TaskError('生成结果尚未保存', 409)
      const images = await galleryRepository.listImages(job.scope)
      const existing = images.find(image => image.filename === job.result!.filename && image.assetType === 'work')
      if (existing) return existing.id
      const entry = galleryEntryFromGenerateSave({
        ...job.result, assetType: 'work', referenceFilenames: job.input.referenceFilenames,
        generation: { provider: job.input.provider, model: job.result.model, aspectRatio: job.input.aspectRatio, imageSize: job.input.imageSize, quality: job.input.quality, execution: job.result.execution ?? job.input.execution },
      })
      entry.sourceAssetId = job.input.sourceAssetId
      entry.sourceTaskId = job.input.sourceTaskId
      entry.referenceNotes = job.input.referenceNotes
      entry.createdAt = job.completedAt || job.createdAt
      images.unshift(entry)
      await galleryRepository.saveImages(images, job.scope)
      warmImageThumbnail(entry.filename)
      return entry.id
    },
  })
  app.locals.startTaskQueue = async () => {
    await collectExpiredReferenceUploads()
    await taskQueue.start()
  }
  app.locals.stopTaskQueue = () => taskQueue.stop()
  function publicGenerationInput(input: GenerationTask['input']) {
    const { prompt, provider, model, aspectRatio, imageSize, quality, referenceFilenames, referenceNotes, sourceAssetId, sourceTaskId } = input
    return { prompt, provider, model, aspectRatio, imageSize, quality, referenceFilenames, referenceNotes, sourceAssetId, sourceTaskId }
  }

  function generationWorkCodes(images: readonly GalleryImage[]) {
    const ids = new Set<string>()
    const idsByFilename = new Map<string, string | null>()
    for (const image of images.filter(isAvailableWork)) {
      ids.add(image.id)
      idsByFilename.set(image.filename, idsByFilename.has(image.filename) ? null : image.id)
    }
    const codes = new Map<string, string>()
    return (job: GenerationTask) => {
      if (!job.result) return undefined
      const id = job.workAssetId ? (ids.has(job.workAssetId) ? job.workAssetId : undefined) : idsByFilename.get(job.result.filename)
      if (id === undefined || id === null) return undefined
      const code = codes.get(id) ?? workCode(id)
      codes.set(id, code)
      return code
    }
  }

  const publicTaskResponse = (req: express.Request) => req.authKind === 'agent' || isAgentApiV1(req)

  function agentTask(job: GenerationTask, code?: string) {
    const summary = generationTaskSummary(job, code)
    return {
      ...summary,
      failure: agentGenerationFailure(job.failure),
      input: publicGenerationInput(job.input),
      deleted: job.deletedAt || job.purgePending ? true : undefined,
      workSavePending: job.workSavePending,
      workSaveError: job.workSaveError ? 'The generated image could not be saved as a work' : undefined,
      nextRetryAt: job.nextRetryAt,
      result: job.result && !job.deletedAt && !job.purgePending ? {
        imageUrl: assetUrl('images', job.result.filename), width: job.result.width, height: job.result.height,
      } : undefined,
    }
  }

  app.get<{ key: string }>(['/api/generation-tasks/by-key/:key', '/api/v1/tasks/by-key/:key'], async (req, res) => {
    const scope = requireSessionScope(req, res)
    if (!scope) return
    res.set('Cache-Control', 'private, no-store')
    const job = (await taskQueue.list(scope)).find(task => task.key === req.params.key)
    if (!job) return res.status(404).json({ error: '未找到该提交标识对应的任务', code: 'TASK_KEY_NOT_FOUND' })
    const code = job.result && generationWorkCodes(await galleryRepository.listImages(scope))(job)
    if (publicTaskResponse(req)) return res.json(agentTask(job, code))
    res.json({
      id: job.id,
      key: job.key,
      status: job.status,
      input: publicGenerationInput(job.input),
      deleted: job.deletedAt || job.purgePending ? true : undefined,
      workCode: code,
      failure: publicGenerationFailure(job.failure),
    })
  })

  app.get<{ id: string }>(['/api/generation-tasks/:id', '/api/v1/tasks/:id'], async (req, res) => {
    const scope = requireSessionScope(req, res)
    if (!scope) return
    res.set('Cache-Control', 'private, no-store')
    const job = (await taskQueue.list(scope)).find(task => task.id === req.params.id && !task.deletedAt && !task.purgePending)
    if (!job) return res.status(404).json({ error: '任务不存在或已移入回收站' })
    const result = job.result
    const code = result && generationWorkCodes(await galleryRepository.listImages(scope))(job)
    const cooldowns = await taskQueue.providerCooldowns(scope)
    const providerCooldownUntil = isImageGenerationProviderName(job.input.provider) ? cooldowns[job.input.provider] : undefined
    if (publicTaskResponse(req)) return res.json({ ...agentTask(job, code), providerCooldownUntil })
    res.json({
      id: job.id,
      status: job.status,
      error: job.error,
      nextRetryAt: job.nextRetryAt,
      providerCooldownUntil,
      workSavePending: job.workSavePending,
      workSaveError: job.workSaveError,
      workCode: code,
      failure: publicGenerationFailure(job.failure),
      result: result && { imageUrl: assetUrl('images', result.filename), width: result.width, height: result.height },
    })
  })

  let generationListCache: {
    revision: string
    workspaceId: string
    tasks: Array<GenerationTask & { workCode?: string }>
    digest?: string
  } | undefined
  app.get(['/api/generation-tasks', '/api/v1/tasks'], async (req, res) => {
    const scope = requireSessionScope(req, res); if (!scope) return
    const publicResponse = publicTaskResponse(req)
    res.set('Cache-Control', publicResponse ? 'private, no-store' : 'private, no-cache')
    if (publicResponse || req.query.view === 'summary') {
      const jobs = await taskQueue.list(scope)
      const params = new URL(req.originalUrl, 'http://local').searchParams
      let page
      try {
        page = createGenerationTaskPage(jobs, params, scope.workspaceId)
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : '分页请求无效' })
      }
      const codeFor = generationWorkCodes(page.items.some(job => job.result) ? await galleryRepository.listImages(scope) : [])
      return res.json({ ...page, items: page.items.map(job => ({
        ...generationTaskSummary(job, codeFor(job)),
        ...(publicResponse ? { failure: agentGenerationFailure(job.failure) } : {}),
      })) })
    }
    const rawLimit = req.query.limit
    let limit: number | undefined
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit) ||
          !Number.isSafeInteger(Number(rawLimit))) {
        return res.status(400).json({ error: 'limit 必须为非负整数' })
      }
      limit = Number(rawLimit)
    }
    const error = taskQueue.lastError
    let jobs: Array<GenerationTask & { workCode?: string }>
    let cooldowns: Awaited<ReturnType<GenerationTaskQueue['providerCooldowns']>>
    if (jsonRepository) {
      const snapshot = jsonRepository.readOnlySnapshot()
      if (generationListCache?.revision !== snapshot.revision || generationListCache.workspaceId !== scope.workspaceId) {
        const scoped = (snapshot.resources.generationTasks || []).filter(job => job.scope.workspaceId === scope.workspaceId)
        const codeFor = generationWorkCodes(scoped.some(job => job.result) ? snapshot.images : [])
        const tasks = scoped.map(job => ({ ...job, workCode: codeFor(job) }))
        generationListCache = {
          revision: snapshot.revision, workspaceId: scope.workspaceId, tasks,
        }
      }
      jobs = generationListCache.tasks
      const cooldown = snapshot.resources.generationProviderStates?.google?.cooldownUntil
      cooldowns = cooldown && Date.parse(cooldown) > Date.now() ? { google: new Date(cooldown).toISOString() } : {}
    } else {
      cooldowns = await taskQueue.providerCooldowns(scope)
      const scoped = await taskQueue.list(scope)
      const codeFor = generationWorkCodes(scoped.some(job => job.result) ? await galleryRepository.listImages(scope) : [])
      jobs = scoped.map(job => ({ ...job, workCode: codeFor(job) }))
    }
    const executing = new Set(jobs.filter(job => taskQueue.isExecuting(job.id)).map(job => job.id))
    if (limit === undefined && generationListCache) {
      const state = createHash('sha256').update(JSON.stringify([scope.workspaceId, error, cooldowns, [...executing]])).digest('hex')
      const digest = generationListCache.digest ??= createHash('sha256').update(JSON.stringify(jobs)).digest('hex')
      const etag = `"tasks-${digest}-${state}"`
      res.set('ETag', etag)
      // The polling client sends its validator explicitly, even when bypassing the browser cache.
      if (req.get('If-None-Match') === etag || req.fresh) return res.status(304).end()
    }
    const page = limit === undefined ? undefined : limitGenerationHistory(jobs, limit)
    const tasks = (page?.jobs ?? jobs).map(job => ({
      ...job,
      executing: executing.has(job.id) || undefined,
      providerCooldownUntil: isImageGenerationProviderName(job.input.provider) ? cooldowns[job.input.provider] : undefined,
    }))
    const body = { tasks, error, canPurge: true }
    if (!page) return res.json(body)
    const serialized = JSON.stringify({ ...body, total: page.total, hasMore: page.hasMore })
    const digest = createHash('sha256').update(JSON.stringify([scope.workspaceId, limit])).update(serialized).digest('hex')
    const etag = `"tasks-limited-${digest}"`
    res.set('ETag', etag)
    if (req.get('If-None-Match') === etag || req.fresh) return res.status(304).end()
    res.type('json').send(serialized)
  })
  app.post(['/api/generation-tasks', '/api/v1/tasks'], generateRateLimiter, async (req, res) => {
    const scope = requireSessionScope(req, res); if (!scope) return
    try {
      const input = parseTaskInput(req.body || {}, generation.definitions)
      const job = await taskQueue.submit(scope, req.body.key, input, {
        maxActive: isLocalEntry(req) ? LOCAL_ACTIVE_LIMIT : undefined,
        validateNew: async resources => {
          if (input.provider === 'openai-compatible' && !generation.modelProviders[imageGenerationModelKey(input.provider, input.model)]) {
            throw new TaskError('OpenAI 兼容渠道未配置，请在设置中填写 API Key，或配置 OPENAI_IMAGE_API_KEY。', 503)
          }
          if (providerConfig && input.provider === 'google' && !generation.availability.google) {
            throw new TaskError('Google Gemini 未配置，请在设置中配置 API Key 或服务账号。', 503)
          }
          const images = await galleryRepository.listImages(scope)
          const sourceTask = input.sourceTaskId ? resources.generationTasks?.find(job =>
            job.id === input.sourceTaskId && job.scope.workspaceId === scope.workspaceId && job.result,
          ) : undefined
          if (input.sourceTaskId && !sourceTask) throw new TaskError('来源历史不存在', 404, false, false, undefined, 'SOURCE_TASK_UNAVAILABLE')
          if (input.sourceAssetId && !images.some(image => image.id === input.sourceAssetId) && sourceTask?.input.sourceAssetId !== input.sourceAssetId) throw new TaskError('来源条目不存在', 404, false, false, undefined, 'SOURCE_TASK_UNAVAILABLE')
          const known = resourceFiles(resources).references
          for (const image of images) for (const filename of image.referenceImages) known.add(filename)
          const unavailable = input.referenceFilenames.filter(filename =>
            (!known.has(filename) && !referenceUploadReceipts.canClaim(scope, filename)) ||
            !fs.existsSync(assetStorage.getReferencePath(filename)),
          )
          if (unavailable.length) throw new TaskError('参考图缺失、已过期或无权访问，请重新上传', 404, false, false, undefined, 'REFERENCE_UNAVAILABLE', unavailable)
        },
      })
      const code = publicTaskResponse(req) && job.result ? generationWorkCodes(await galleryRepository.listImages(scope))(job) : undefined
      res.status(202).json(publicTaskResponse(req) ? agentTask(job, code) : job)
    } catch (error) {
      if (error instanceof TaskError) return res.status(error.status).json({ error: error.message, code: error.code, referenceFilenames: error.referenceFilenames })
      res.status(500).json({ error: '任务未能确认提交，请使用相同提交标识重试' })
    }
  })
  mutations.post('/api/generation-tasks/trash-all', async (req, res) => {
    const scope = requireSessionScope(req, res); if (!scope) return
    if (req.body?.confirm !== true) return res.status(400).json({error:'请确认将已结束的历史移入回收站，作品保持不变'})
    const resources = await galleryRepository.readResources?.(scope) || {}
    let moved = 0, skipped = 0
    const now = new Date().toISOString()
    for (const job of resources.generationTasks || []) {
      if (job.scope.workspaceId !== scope.workspaceId || job.deletedAt) continue
      if (['running','queued'].includes(job.status) || taskQueue.isExecuting(job.id) || job.purgePending) { skipped++; continue }
      job.deletedAt = now; job.updatedAt = now; moved++
    }
    if (moved) await galleryRepository.saveResources!({...resources}, scope)
    res.json({moved,skipped})
  })
  const purgeGenerationTask = async (scope: GenerationTaskScope, id: string) => {
    const resources = await galleryRepository.readResources?.(scope) || {}, jobs = resources.generationTasks || [], job = jobs.find(job => job.id === id && job.scope.workspaceId === scope.workspaceId)
    if (!job) return false
    if (!job.deletedAt || ['running','queued'].includes(job.status) || taskQueue.isExecuting(job.id) || job.workSavePending) throw new TaskError('请先完成或核对任务，并移入历史回收站',409)
    if (!job.purgePending) {
      job.purgePending = true
      await galleryRepository.saveResources!({ ...resources, generationTasks: jobs }, scope)
    }
    const remaining={...resources,generationTasks:jobs.filter(item=>item!==job)},protectedFiles=resourceFiles(remaining),images=await galleryRepository.listImages(scope)
    for (const image of images) {protectedFiles.images.add(image.filename);for(const ref of image.referenceImages)protectedFiles.references.add(ref)}
    if(job.result&&!protectedFiles.images.has(job.result.filename))await assetStorage.deleteImage(job.result.filename)
    for(const filename of new Set(job.input.referenceFilenames))if(!protectedFiles.references.has(filename))await assetStorage.deleteReferences([filename])
    await galleryRepository.saveResources!(remaining,scope)
    return true
  }
  const bulkPreviewLifetimeMs = 10 * 60_000
  const maxBulkPreviews = 128
  const bulkPreviews = new Map<string, {
    workspaceId: string
    preview: GenerationBulkPreview
    expiresAt: number
    targets: Map<string, string>
  }>()
  const bulkTargetState = (job: GenerationTask) => JSON.stringify([
    job.key, job.createdAt, job.updatedAt, job.status, job.deletedAt, job.acknowledgedAt,
    job.purgePending, job.workSavePending,
  ])

  app.post('/api/generation-tasks/bulk/preview', async (req, res) => {
    const scope = requireSessionScope(req, res)
    if (!scope) return
    const { operation, tab, search: rawSearch } = req.body || {}
    if (!generationHistoryTabs.includes(tab) ||
      (operation !== 'trash' && operation !== 'purge-failed') ||
      (operation === 'purge-failed') !== (tab === 'trash') ||
      (rawSearch !== undefined && typeof rawSearch !== 'string')) {
      return res.status(400).json({ error: '批量操作、标签或搜索词无效' })
    }
    const search: string = rawSearch?.trim() ?? ''
    const query = search.toLowerCase()
    const jobs = (await taskQueue.list(scope)).filter(job => matchesGenerationHistoryTab(job, tab))
    const codeFor = generationWorkCodes(query && jobs.some(job => job.result) ? await galleryRepository.listImages(scope) : [])
    const matched = jobs.filter(job => matchesGenerationHistorySearch(job, query, codeFor(job)))
    const eligible = matched.filter(job => canBulkChangeGenerationTask(job, operation, taskQueue.isExecuting(job.id)))
    const preview: GenerationBulkPreview = {
      token: eligible.length ? randomUUID() : null,
      operation, tab, search,
      matchedCount: matched.length,
      eligibleCount: eligible.length,
      skippedCount: matched.length - eligible.length,
      retryPurgeCount: eligible.filter(job => job.purgePending).length,
    }
    if (preview.token) {
      const now = Date.now()
      for (const [token, data] of bulkPreviews) {
        if (data.expiresAt <= now) bulkPreviews.delete(token)
      }
      if (bulkPreviews.size >= maxBulkPreviews) bulkPreviews.delete(bulkPreviews.keys().next().value!)
      bulkPreviews.set(preview.token, {
        workspaceId: scope.workspaceId, preview, expiresAt: now + bulkPreviewLifetimeMs,
        targets: new Map(eligible.map(job => [job.id, bulkTargetState(job)])),
      })
    }
    res.set('Cache-Control', 'private, no-store')
    res.json(preview)
  })

  mutations.post('/api/generation-tasks/bulk/commit', async (req, res) => {
    const scope = requireSessionScope(req, res)
    if (!scope) return
    const { token, confirm } = req.body || {}
    if (typeof token !== 'string' || !token || confirm !== true) {
      return res.status(400).json({ error: '请先预览并确认批量操作' })
    }
    const conflict = () => res.status(409).json({ error: '任务状态已变化，请刷新后重新确认' })
    const entry = bulkPreviews.get(token)
    if (!entry || entry.workspaceId !== scope.workspaceId) return conflict()
    if (entry.expiresAt <= Date.now()) {
      bulkPreviews.delete(token)
      return conflict()
    }

    const { operation, tab, search, skippedCount: skipped } = entry.preview
    const resources = await galleryRepository.readResources?.(scope) || {}
    const jobs = new Map((resources.generationTasks || [])
      .filter(job => job.scope.workspaceId === scope.workspaceId && entry.targets.has(job.id))
      .map(job => [job.id, job]))
    const codeFor = generationWorkCodes(search && [...jobs.values()].some(job => job.result)
      ? await galleryRepository.listImages(scope)
      : [])
    const query = search.toLowerCase()
    const targets: GenerationTask[] = []
    for (const [id, state] of entry.targets) {
      const job = jobs.get(id)
      if (!job || bulkTargetState(job) !== state || !matchesGenerationHistoryTab(job, tab) ||
        !canBulkChangeGenerationTask(job, operation, taskQueue.isExecuting(id)) ||
        !matchesGenerationHistorySearch(job, query, codeFor(job))) {
        bulkPreviews.delete(token)
        return conflict()
      }
      targets.push(job)
    }

    if (operation === 'trash') {
      const now = new Date().toISOString()
      for (const job of targets) {
        if (job.status === 'uncertain' && !job.acknowledgedAt) job.acknowledgedAt = now
        job.deletedAt = now
        job.updatedAt = now
      }
      await galleryRepository.saveResources!({ ...resources }, scope)
      bulkPreviews.delete(token)
      return res.json({ moved: targets.length, skipped })
    }

    let deleted = 0
    try {
      for (const job of targets) {
        if (!await purgeGenerationTask(scope, job.id)) throw new Error('任务记录已不存在')
        deleted++
      }
    } catch {
      bulkPreviews.delete(token)
      return res.status(500).json({
        deleted, skipped, remaining: targets.length - deleted,
        error: '清理中断，已保留尚未清理的记录，请重新确认后重试',
      })
    }
    bulkPreviews.delete(token)
    res.json({ deleted, skipped })
  })

  mutations.delete('/api/generation-tasks/failed', async (req, res) => {
    const scope = requireSessionScope(req, res); if (!scope) return
    if (req.body?.confirm !== true) return res.status(400).json({error:'请确认永久删除历史回收站中所有生成失败记录'})
    const failed = (await taskQueue.list(scope)).filter(job => job.deletedAt && job.status === 'failed')
    let deleted = 0, skipped = 0
    for (const job of failed) {
      if (taskQueue.isExecuting(job.id) || job.workSavePending) { skipped++; continue }
      try { if (await purgeGenerationTask(scope, job.id)) deleted++ }
      catch { return res.status(500).json({deleted,skipped,error:'清理中断，已保留尚未清理的记录，请重试'}) }
    }
    res.json({deleted,skipped})
  })
  mutations.delete('/api/generation-tasks/:id', async (req, res) => {
    const scope = requireSessionScope(req, res); if (!scope) return
    if (req.body?.confirm !== true) return res.status(400).json({error:'请确认永久清理这一项历史'})
    try { await purgeGenerationTask(scope, String(req.params.id)); res.json({ok:true}) }
    catch (error) { res.status(error instanceof TaskError ? error.status : 500).json({error:error instanceof TaskError ? error.message : '清理中断，请重试'}) }
  })
  app.post('/api/generation-tasks/:id/:action', async (req, res) => {
    const scope = requireSessionScope(req, res); if (!scope) return
    try {
      const id = String(req.params.id), action = req.params.action
      const job = action === 'resume-query' ? await taskQueue.resumeQuery(scope, id, req.body?.key, req.body?.expectedVersion)
        : action === 'cancel' ? await taskQueue.cancel(scope, id)
        : action === 'acknowledge' && req.body?.confirm === true ? await taskQueue.acknowledge(scope, id)
        : action === 'trash' ? await taskQueue.trash(scope, id, true)
        : action === 'restore' ? await taskQueue.trash(scope, id, false) : null
      if (!job) throw new TaskError('无效任务操作')
      res.json(job)
    } catch (error) { res.status(error instanceof TaskError ? error.status : 500).json({ error: error instanceof TaskError ? error.message : '任务更新失败' }) }
  })

  mutations.post('/api/generate/save', express.json(), async (req, res) => {
    const scope = requireSessionScope(req, res)
    if (!scope) return

    const fromTask = !!req.body.taskId
    let savedTaskId: string | undefined
    if (fromTask) {
      const job = (await taskQueue.list(scope)).find(item => item.id === req.body.taskId)
      if (!job?.result || job.status !== 'completed') return res.status(404).json({ error: '已完成任务不存在' })
      savedTaskId = job.id
      req.body = { ...job.result, sourceTaskId: job.input.sourceTaskId, referenceNotes: job.input.referenceNotes, generation: { provider: job.input.provider, model: job.input.model, aspectRatio: job.input.aspectRatio, imageSize: job.input.imageSize, quality: job.input.quality, execution: job.result.execution ?? job.input.execution }, referenceImages: job.input.referenceFilenames, referenceFilenames: job.input.referenceFilenames, sourceAssetId: job.input.sourceAssetId, assetType: req.body.assetType }
    }
    let entry: GalleryImage
    try {
      entry = galleryEntryFromGenerateSave(req.body as Record<string, unknown>)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid body'
      return res.status(400).json({ error: message })
    }

    const images = await galleryRepository.listImages(scope)
    if (req.body.sourceAssetId !== undefined) {
      if (typeof req.body.sourceAssetId !== 'string' || (!fromTask && !images.some(image => image.id === req.body.sourceAssetId))) return res.status(404).json({ error: '来源条目不存在或无权访问' })
      entry.sourceAssetId = req.body.sourceAssetId
    }
    if (fromTask) { entry.sourceTaskId = req.body.sourceTaskId; entry.referenceNotes = req.body.referenceNotes }
    const confirmWorkSave = async (saved: GalleryImage) => {
      if (!savedTaskId || saved.assetType !== 'work') return
      const resources = await galleryRepository.readResources?.(scope) || {}
      const task = resources.generationTasks?.find(job => job.id === savedTaskId && job.scope.workspaceId === scope.workspaceId)
      if (task?.status === 'completed' && task.result?.filename === saved.filename) {
        task.workAssetId = saved.id; task.workSavePending = false; delete task.workSaveError
        await galleryRepository.saveResources!(resources, scope)
      }
    }
    const existing = images.find(image => !image.deletedAt && image.filename === entry.filename && image.assetType === entry.assetType)
    if (existing) { await confirmWorkSave(existing); return res.json(withWorkCode(existing)) }

    if (!sanitizeAssetFilename(entry.filename) || !await verifyAssetOwnership(scope, 'images', entry.filename)) return res.status(404).json({ error: '生成结果不存在或无权访问' })
    for (const filename of entry.referenceImages) {
      if (!sanitizeAssetFilename(filename) || (!await verifyAssetOwnership(scope, 'references', filename) && !referenceUploadReceipts.canClaim(scope, filename))) return res.status(404).json({ error: '参考图不存在或无权访问' })
    }
    const imagePath = assetStorage.getImagePath(entry.filename)
    if (!fs.existsSync(imagePath)) return res.status(404).json({ error: '图片文件不存在' })

    images.unshift(entry)
    await galleryRepository.saveImages(images, scope)
    warmImageThumbnail(entry.filename)
    await confirmWorkSave(entry)
    res.json(withWorkCode(entry))
  })

  app.get('/api/tags', async (_req, res) => {
    const scope = requireSessionScope(_req, res)
    if (!scope) return

    const tagSet = new Set<string>()

    for (const image of await galleryRepository.listImages(scope)) {
      for (const tag of image.tags) tagSet.add(tag)
    }

    res.json([...tagSet].sort())
  })

  app.use('/api/v1', (_req, res) => res.status(404).json({ error: 'API endpoint not found', code: 'NOT_FOUND' }))

  app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof ImageIntakeError) {
      res.status(400).json({ error: error.message })
      return
    }
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({ error: IMAGE_INPUT_LIMIT_MESSAGE })
        return
      }
      if (['LIMIT_PART_COUNT', 'LIMIT_FILE_COUNT', 'LIMIT_FIELD_COUNT', 'LIMIT_FIELD_KEY', 'LIMIT_FIELD_VALUE'].includes(error.code)) {
        res.status(400).json({ error: '上传字段过多或过长' })
        return
      }
      if (error.code === 'LIMIT_UNEXPECTED_FILE') {
        res.status(400).json({ error: `不接受文件字段 ${error.field ?? ''}，或该字段的文件数量超出限制` })
        return
      }
    }

    if (error instanceof Error && error.message === '仅支持 JPG、PNG、WebP 图片') {
      res.status(400).json({ error: error.message })
      return
    }

    if (!res.headersSent && (isAgentApiV1(req) || req.authKind === 'agent')) {
      const status = (error as { status?: number } | null)?.status
      if (status === 400 || status === 413) {
        res.status(status).json({ error: status === 400 ? 'Invalid request body' : 'Request body too large' })
      } else {
        res.status(500).json({ error: 'Internal Gallery error' })
      }
      return
    }
    next(error)
  })

  return app
}

function isAgentApiV1(req: express.Request) {
  return /^\/api\/v1(?:\/|$)/i.test(req.path)
}

function agentGenerationFailure(failure: GenerationTask['failure']) {
  if (!failure) return undefined
  // Never include free-form provider messages, request IDs or debug evidence.
  const { category, retryable, uncertain } = failure
  return { category, retryable, uncertain }
}

function recipeMetadata(title: unknown, tags: unknown, sourceType: unknown) {
  if (tags !== undefined && (!Array.isArray(tags) || !tags.every(tag => typeof tag === 'string'))) {
    return { updates: {}, error: 'tags must be an array of strings' }
  }
  return pickGalleryImageUpdates({ title, tags, sourceType })
}

function publicRecipe(recipe: GalleryImage) {
  return {
    ...galleryImageSummary(recipe),
    prompt: recipe.prompt,
    filename: recipe.filename,
    referenceImages: recipe.referenceImages,
    sourceAssetId: recipe.sourceAssetId,
    favorited: recipe.favorited,
  }
}

function createCorsOptions(allowedOrigins: string[]) {
  return {
    origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
      if (!origin) {
        callback(null, true)
        return
      }

      callback(null, allowedOrigins.includes(origin))
    },
  }
}

function buildGenerationModelDefinitions(
  configuredModels: Partial<Record<ImageGenerationProviderName, string>>,
): ImageGenerationModelDefinition[] {
  const definitions = IMAGE_GENERATION_MODEL_DEFINITIONS.map((definition) => {
    const model = configuredModels[definition.provider]
    if (definition.provider !== 'openai-compatible' || !model) return { ...definition }
    return { ...definition, model, label: formatImageGenerationSource(definition.provider, model) }
  })

  for (const [provider, model] of Object.entries(configuredModels)) {
    if (!isImageGenerationProviderName(provider) || !model) continue
    if (
      definitions.some(
        (definition) =>
          definition.provider === provider && definition.model === model,
      )
    ) {
      continue
    }

    const providerDefinition = IMAGE_GENERATION_PROVIDER_DEFINITIONS[provider]
    definitions.push({
      provider,
      model,
      label: formatImageGenerationSource(provider, model),
      parameterMode: 'resolution',
      defaultAspectRatio: providerDefinition.supportedAspectRatios[0] ?? '1:1',
      maxReferenceImages: providerDefinition.maxReferenceImages,
      supportedResolutions: providerDefinition.supportedResolutions,
      supportedQualities: [],
      supportedAspectRatios: providerDefinition.supportedAspectRatios,
    })
  }

  return definitions
}

function userAuthModeLabel(mode: UserAuthMode) {
  if (mode === 'local') return '本地单人模式'
  return 'Cloudflare Access 私有模式'
}

function providerNameForStrategy(
  strategy: AppAIAuthStrategy,
): ImageGenerationProviderName {
  if (strategy.mode === 'seedream') return 'seedream'
  if (strategy.mode === 'qwen') return 'qwen'
  if (strategy.mode === 'kling') return 'kling'
  if (strategy.mode === 'openai-compatible' || strategy.mode === 'demo') return strategy.mode
  return 'google'
}

function extensionForGeneratedImage(mimeType: string) {
  if (mimeType === 'image/webp') return '.webp'
  return mimeType.includes('jpeg') || mimeType.includes('jpg') ? '.jpg' : '.png'
}

function isSupportedImageMimeType(mimeType: string) {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)
}

function parseGeminiImportMetadata(rawMetadata: unknown): {
  prompt: string
  assetType: 'work' | 'recipe'
  tags: string[]
  sourceUrl?: string
  capturedAt?: string
  requestId?: string
  checkDuplicates?: boolean
  allowDuplicate?: boolean
} {
  let parsed: Record<string, unknown> = {}
  if (typeof rawMetadata === 'string' && rawMetadata.trim()) {
    try {
      const value = JSON.parse(rawMetadata)
      if (value && typeof value === 'object') {
        parsed = value as Record<string, unknown>
      }
    } catch {
      parsed = {}
    }
  }

  const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : ''
  const assetType = parsed.assetType === 'recipe' ? 'recipe' : 'work'
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    : []
  const uniqueTags = Array.from(new Set(['gemini-web', ...tags.map((tag) => tag.trim())]))
  const sourceUrl = typeof parsed.sourceUrl === 'string' && parsed.sourceUrl.trim()
    ? parsed.sourceUrl.trim()
    : undefined
  const capturedAt = typeof parsed.capturedAt === 'string' && parsed.capturedAt.trim()
    ? parsed.capturedAt.trim()
    : undefined

  return {
    requestId: typeof parsed.requestId === 'string' ? parsed.requestId : undefined,
    checkDuplicates: parsed.checkDuplicates === true,
    allowDuplicate: parsed.allowDuplicate === true,
    prompt,
    assetType,
    tags: uniqueTags,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(capturedAt ? { capturedAt } : {}),
  }
}

function isSafeSourceUrl(value: string) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password } catch { return false }
}

function sanitizeAssetFilename(filename: string) {
  const trimmed = filename.trim()
  if (!trimmed || trimmed !== path.basename(trimmed)) {
    return null
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    return null
  }

  return trimmed
}

function pickGalleryImageUpdates(body: unknown): {
  updates: Partial<GalleryImage>
  error?: string
} {
  if (!body || typeof body !== 'object') {
    return { updates: {} }
  }

  const source = body as Record<string, unknown>
  const updates: Partial<GalleryImage> = {}

  if (typeof source.prompt === 'string') {
    const prompt = source.prompt.trim()
    if (!prompt) {
      return { updates, error: '提示词不能为空' }
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return { updates, error: `提示词不能超过 ${MAX_PROMPT_LENGTH} 个字符` }
    }
    updates.prompt = prompt
  }

  for (const field of ['title', 'notes'] as const) {
    if (source[field] !== undefined) {
      if (typeof source[field] !== 'string' || source[field].length > (field === 'title' ? 200 : 10000)) return { updates, error: field === 'title' ? '标题须为 200 字以内文本' : '备注须为 10000 字以内文本' }
      updates[field] = source[field].trim()
    }
  }
  if (typeof source.pinned === 'boolean') updates.pinned = source.pinned
  if (typeof source.favorited === 'boolean') {
    updates.favorited = source.favorited
  }

  if (Array.isArray(source.tags) && source.tags.every((tag) => typeof tag === 'string')) {
    updates.tags = source.tags
  }

  if (source.sourceType !== undefined) {
    if (source.sourceType !== 'openai' && source.sourceType !== 'gemini-web' && source.sourceType !== 'seedream') {
      return { updates, error: '不支持的图片来源' }
    }
    updates.sourceType = source.sourceType
  }

  return { updates }
}

function createInMemoryRateLimiter(options: {
  windowMs: number
  max: number
  key: (req: express.Request) => string
  structuredError?: boolean
}) {
  const hits = new Map<string, { count: number; expiresAt: number }>()

  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const now = Date.now()
    const key = options.key(req)
    const existing = hits.get(key)

    if (!existing || existing.expiresAt <= now) {
      hits.set(key, { count: 1, expiresAt: now + options.windowMs })
      next()
      return
    }

    if (existing.count >= options.max) {
      if (options.structuredError) res.set('Retry-After', String(Math.ceil((existing.expiresAt - now) / 1000)))
      res.status(429).json({ error: '请求过于频繁，请稍后再试', code: options.structuredError ? 'RATE_LIMITED' : undefined })
      return
    }

    existing.count += 1
    next()
  }
}

function parseObsidianMarkdown(content: string) {
  const results: Array<{ prompt: string; imageFilename: string }> = []
  const re = /```[\s\S]*?\n([\s\S]*?)```\s*\n!\[\[([^\]]+)\]\]/g
  let match: RegExpExecArray | null

  while ((match = re.exec(content)) !== null) {
    const prompt = match[1].trim()
    const imageFilename = match[2].trim()
    if (prompt && imageFilename) {
      results.push({ prompt, imageFilename })
    }
  }

  return results
}
