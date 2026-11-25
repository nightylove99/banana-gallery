import fs from 'node:fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ProviderConfig } from './personal/provider-config.ts'
import { createApp } from './app.js'
import { assertAuthModeSupported, loadAppEnv } from './config/env.js'
import { configureHttpProxy } from './config/http-proxy.js'
import { loadProjectEnvFile } from './config/load-env.js'
import { resolveRuntimePaths } from './config/runtime-paths.ts'
import { JsonGalleryRepository } from './gallery/json-gallery-repository.js'
import { CloudflareAccessVerifier } from './auth/cloudflare-access-verifier.js'
import { inspectGalleryDiskAssets } from './gallery/disk-asset-integrity.js'
import { generationTasksFileFor, readGenerationTaskIndex } from './gallery/generation-task-storage.js'
import { DEFAULT_GEMINI_IMAGE_MODEL } from './ai/google-gemini-image-provider.ts'
import type { ImageGenerationProvider } from './ai/image-generation-provider.ts'
import { createSeedreamRuntimeProvider } from './ai/seedream-runtime.ts'
import { createDashscopeRuntimeProviders } from './ai/dashscope-runtime.ts'
import { ComfyUIRuntime } from './ai/comfyui-runtime.ts'
import type { ImageGenerationProviderName } from './config/env.ts'
import { DEMO_IMAGE_MODEL, imageGenerationModelKey } from '../src/lib/image-generation-providers.ts'
import { attachStaticApp } from './static-app.js'
import { startRuntimeListeners } from './runtime-listeners.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
loadProjectEnvFile({
  projectRoot: ROOT,
  fileName: process.env.BANANA_GALLERY_ENV_FILE || '.env',
})
const {
  backupDir: BACKUP_DIR, dataFile: DATA_FILE, imagesDir: IMAGES_DIR,
  referencesDir: REFS_DIR, distDir: DIST_DIR,
} = resolveRuntimePaths(ROOT)

const runtimeEnv = loadAppEnv()
assertAuthModeSupported(runtimeEnv)
const PORT = Number.parseInt(process.env.PORT || '3333', 10) || 3333

// ─── HTTP 代理（须在 .env 加载后、API 调用前） ───────────────────────────────────
const proxyDispatcher = configureHttpProxy()

function envFlagTrue(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

/** JSON + 磁盘：启动时检查元数据与 public 下文件是否一致，便于尽早发现「只恢复了 json、没拷图片」等问题 */
if (fs.existsSync(DATA_FILE) || fs.existsSync(generationTasksFileFor(DATA_FILE))) {
  const raw: unknown = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : { images: [] }
  try {
    const { missing } = inspectGalleryDiskAssets(raw, IMAGES_DIR, REFS_DIR, readGenerationTaskIndex(DATA_FILE))
    if (missing.length > 0) {
      const preview = missing.slice(0, 12)
        .map(({ kind, filename, ownerId }) => `  · ${kind} ${filename} (条目 ${ownerId})`).join('\n')
      const more = missing.length > 12 ? `\n  … 另有 ${missing.length - 12} 条` : ''
      throw new Error(`${missing.length} 个索引引用的资源在磁盘上不存在\n${preview}${more}`)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (envFlagTrue(process.env.GALLERY_FAIL_ON_MISSING_ASSETS)) {
      throw new Error(`GALLERY_FAIL_ON_MISSING_ASSETS：${detail}，拒绝启动。`, { cause: error })
    }
    console.warn(`[gallery-integrity] ${detail}\n提示：执行 npm run verify:gallery-assets；设置 GALLERY_FAIL_ON_MISSING_ASSETS=true 可在启动时直接失败。`)
  }
}

// ─── 图片生成 API 初始化 ───────────────────────────────────────────────────────

// Retain the provider factories' existing interfaces without consulting a private secret store.
const noLegacySecretLookup = () => ''

const seedreamRuntime = createSeedreamRuntimeProvider(runtimeEnv, {
  readAgentSecret: noLegacySecretLookup,
  warn: (message) => console.warn(`[seedream] ${message}`),
})
const dashscopeRuntime = createDashscopeRuntimeProviders(runtimeEnv, {
  readAgentSecret: noLegacySecretLookup,
  warn: (message) => console.warn(`[dashscope] ${message}`),
})
const providerConfig = new ProviderConfig(DATA_FILE)

const localGallery = new JsonGalleryRepository(DATA_FILE)
const localQwenRuntime = new ComfyUIRuntime({
  cleanupDir: path.join(path.dirname(DATA_FILE), '.qwen-output-cleanup'),
  hasPersistedResult: async (localPath) =>
    path.dirname(localPath) === path.resolve(IMAGES_DIR) &&
    localGallery.hasAssetAccess(undefined, 'images', path.basename(localPath)),
  host: runtimeEnv.qwenLocalSshHost,
  remotePort: runtimeEnv.qwenLocalRemotePort,
  startCmd: runtimeEnv.qwenLocalStartCmd,
  outputHelperCommand: runtimeEnv.qwenLocalOutputHelperCmd,
  gpuPattern: runtimeEnv.qwenLocalGpuPattern,
  unetName: runtimeEnv.qwenLocalUnet,
  startTimeoutMs: runtimeEnv.qwenLocalStartTimeoutMs,
  warn: message => console.warn(`[local-image] ${message}`),
})
const imageGenerationProviders = {
  ...(runtimeEnv.qwenLocalSshHost ? { 'qwen-local': localQwenRuntime.provider, 'krea-local': localQwenRuntime.kreaProvider } : {}),
  seedream: seedreamRuntime.imageGenerationProvider,
  qwen: dashscopeRuntime.qwenProvider,
  kling: dashscopeRuntime.klingProvider,
}
const imageGenerationProviderAvailability = {
  'qwen-local': Boolean(runtimeEnv.qwenLocalSshHost),
  'krea-local': Boolean(runtimeEnv.qwenLocalSshHost),
  seedream: seedreamRuntime.available,
  qwen: dashscopeRuntime.available,
  kling: dashscopeRuntime.available,
  demo: runtimeEnv.enableDemoProvider,
}
const imageGenerationProviderModels: Partial<
  Record<ImageGenerationProviderName, string>
> = {
  seedream: runtimeEnv.seedreamImageModel,
  google: DEFAULT_GEMINI_IMAGE_MODEL,
  'qwen-local': 'qwen-image-2.1-UC-Q8_0',
  'krea-local': 'krea-2-turbo',
  qwen: runtimeEnv.qwenImageModel,
  kling: runtimeEnv.klingImageModel,
  demo: DEMO_IMAGE_MODEL,
}
const imageGenerationModelProviders: Record<string, ImageGenerationProvider> = {
  ...Object.fromEntries(
    Object.entries(seedreamRuntime.imageGenerationModels).map(([model, provider]) => [
      imageGenerationModelKey('seedream', model),
      provider,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(dashscopeRuntime.qwenProviders).map(([model, provider]) => [
      imageGenerationModelKey('qwen', model),
      provider,
    ]),
  ),
  [imageGenerationModelKey('kling', runtimeEnv.klingImageModel)]:
    dashscopeRuntime.klingProvider,
}
const defaultImageGenerationProvider = runtimeEnv.imageGenerationProvider
const defaultImageGenerationModel = imageGenerationProviderModels[defaultImageGenerationProvider]
const strategy: Parameters<typeof createApp>[0]['strategy'] =
  defaultImageGenerationProvider === 'seedream'
    ? seedreamRuntime.strategy
    : defaultImageGenerationProvider === 'qwen'
      ? dashscopeRuntime.qwenStrategy
      : defaultImageGenerationProvider === 'kling'
        ? dashscopeRuntime.klingStrategy
        : { mode: 'googleUnavailable' }

const singleUserSession = {
  user: {
    id: runtimeEnv.defaultUserId,
    email: runtimeEnv.defaultUserEmail,
  },
  workspace: {
    id: runtimeEnv.defaultWorkspaceId,
    name: runtimeEnv.defaultWorkspaceName,
  },
}
const localAuthSession = runtimeEnv.authMode === 'local' ? singleUserSession : undefined
const cloudflareAccessSession = runtimeEnv.authMode === 'cloudflare_access'
  ? singleUserSession
  : undefined
const cloudflareAccessVerifier = runtimeEnv.authMode === 'cloudflare_access'
  ? new CloudflareAccessVerifier({
      teamDomain: runtimeEnv.cloudflareAccessTeamDomain!,
      audience: runtimeEnv.cloudflareAccessAudience!,
      allowedEmails: runtimeEnv.authAllowedEmails,
    })
  : undefined

const app = createApp({
  // Managed instances create the Google client from the current config instead.
  ai: { models: { generateContent: async () => { throw new Error('GOOGLE_IMAGE_PROVIDER_NOT_CONFIGURED') } } },
  strategy,
  providerConfig,
  dataFile: DATA_FILE,
  backupDir: BACKUP_DIR,
  imagesDir: IMAGES_DIR,
  referencesDir: REFS_DIR,
  userAuthMode: runtimeEnv.authMode,
  agentApiToken: runtimeEnv.agentApiToken,
  localAuthSession,
  cloudflareAccessVerifier,
  cloudflareAccessSession,
  localAccessHost: runtimeEnv.bindHost === 'localhost' ? '127.0.0.1' : runtimeEnv.bindHost,
  localAccessPort: PORT,
  remoteAccessPort: runtimeEnv.remoteAccessPort,
  galleryRepository: localGallery,
  corsAllowedOrigins: runtimeEnv.corsAllowedOrigins,
  allowServerSideImport: runtimeEnv.allowServerSideImport,
  showDeveloperDiagnostics: runtimeEnv.showDeveloperDiagnostics,
  defaultImageGenerationProvider,
  enableDemoProvider: runtimeEnv.enableDemoProvider,
  defaultImageGenerationModel,
  imageGenerationProviders,
  imageGenerationModelProviders,
  imageGenerationProviderAvailability,
  imageGenerationProviderModels,
  localQwenStatus: () => localQwenRuntime.status(),
  localKreaStatus: () => localQwenRuntime.kreaStatus(),
})

// ─── Start ────────────────────────────────────────────────────────────────────

if (runtimeEnv.authMode === 'cloudflare_access' || process.env.BANANA_GALLERY_SERVE_STATIC === 'true') {
  attachStaticApp(app, DIST_DIR)
}

localQwenRuntime.start()
app.locals.startAutomaticBackups()
const stopThumbnailWarmup = app.locals.startThumbnailWarmup()
await app.locals.startTaskQueue()

const runtimeServers = startRuntimeListeners({
  app,
  authMode: runtimeEnv.authMode,
  localPort: PORT,
  remoteAccessPort: runtimeEnv.remoteAccessPort,
  bindHost: runtimeEnv.bindHost,
})

export async function shutdownRuntime() {
  await app.locals.stopTaskQueue()
  localQwenRuntime.stop()
  stopThumbnailWarmup()
  await Promise.all(runtimeServers.map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeIdleConnections?.()
  })))
  await proxyDispatcher?.destroy()
}

let shuttingDown = false
const handleShutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  await shutdownRuntime()
  process.exit(0)
}
process.on('SIGINT', handleShutdown)
process.on('SIGTERM', handleShutdown)
