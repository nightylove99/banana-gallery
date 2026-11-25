import { OPENAI_IMAGE_DEFAULT_BASE_URL } from '../ai/openai-compatible-image-provider.ts'
import type { ImageGenerationProviderName } from '../../src/lib/image-generation-providers.ts'
import { OPENAI_IMAGE_DEFAULT_MODEL, SEEDREAM_5_5_IMAGE_MODEL } from '../../src/lib/image-generation-providers.ts'

export type UserAuthMode = 'local' | 'cloudflare_access'
export type { ImageGenerationProviderName } from '../../src/lib/image-generation-providers.ts'

export interface AppEnv {
  authMode: UserAuthMode
  agentApiToken?: string
  cloudflareAccessTeamDomain?: string
  cloudflareAccessAudience?: string
  authAllowedEmails: string[]
  remoteAccessPort: number
  bindHost: string
  defaultUserId: string
  defaultUserEmail: string
  defaultWorkspaceId: string
  defaultWorkspaceName: string
  corsAllowedOrigins: string[]
  allowServerSideImport: boolean
  /** 是否在 /api/settings/runtime 中返回开发者诊断字段（默认 false，需 SHOW_DEVELOPER_DIAGNOSTICS=true） */
  showDeveloperDiagnostics: boolean
  /** 默认图片生成供应商；默认 Google Gemini，生成页仍可逐次切换 */
  imageGenerationProvider: ImageGenerationProviderName
  seedreamApiKey?: string
  seedreamImageModel: string
  dashscopeApiKey?: string
  /** 本地 GPU 的 SSH 别名；配置后启用共用 ComfyUI 的 Qwen/Krea 供应商 */
  qwenLocalSshHost?: string
  /** 远端 ComfyUI 端口，默认 8188 */
  qwenLocalRemotePort: number
  /** 经 SSH 按需拉起远端 ComfyUI 的命令；未配置时只报告可用性，不尝试拉起 */
  qwenLocalStartCmd?: string
  qwenLocalOutputHelperCmd?: string
  /** 限定 /system_stats 设备名的正则（不区分大小写）；未配置时接受任意 CUDA 设备 */
  qwenLocalGpuPattern?: string
  /** 扩散模型 GGUF 文件名；未配置时沿用模板内的默认量化 */
  qwenLocalUnet?: string
  /** 等待远端 ComfyUI 就绪的上限（毫秒），默认 180000 */
  qwenLocalStartTimeoutMs: number
  qwenImageModel: string
  qwenImageEndpoint: string
  klingImageModel: string
  klingImageEndpoint: string
  dashscopeTaskEndpoint: string
  dashscopeUploadEndpoint: string
  openaiImageApiKey?: string
  openaiImageBaseUrl: string
  openaiImageModel: string
  enableDemoProvider: boolean
}

function readDriver<T extends string>(
  value: string | undefined,
  fallback: T,
  allowed: readonly T[],
): T {
  if (!value) return fallback
  if (allowed.includes(value as T)) return value as T
  throw new Error(`不支持的驱动配置：${value}`)
}

function readNumber(value: string | undefined, fallback: number) {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function readStringList(value: string | undefined, fallback: string[]) {
  if (!value) return fallback
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

/** 默认关闭（含本地开发）；需显式 SHOW_DEVELOPER_DIAGNOSTICS=true 才展示诊断区 */
function readShowDeveloperDiagnostics(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SHOW_DEVELOPER_DIAGNOSTICS?.trim().toLowerCase()
  if (raw === 'true' || raw === '1' || raw === 'yes') return true
  if (raw === 'false' || raw === '0' || raw === 'no') return false
  return false
}

export function loadAppEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  const authMode = readDriver(env.AUTH_MODE, 'local', ['local', 'cloudflare_access'])
  const defaultUserId = env.BANANA_GALLERY_DEFAULT_USER_ID || 'local-user'
  const defaultWorkspaceId = env.BANANA_GALLERY_DEFAULT_WORKSPACE_ID || 'local-workspace'

  return {
    authMode,
    agentApiToken: env.BANANA_GALLERY_API_TOKEN?.trim() || undefined,
    cloudflareAccessTeamDomain: env.CF_ACCESS_TEAM_DOMAIN?.trim() || undefined,
    cloudflareAccessAudience: env.CF_ACCESS_AUDIENCE?.trim() || undefined,
    authAllowedEmails: readStringList(env.AUTH_ALLOWED_EMAILS, [])
      .map((email) => email.toLowerCase()),
    remoteAccessPort: readNumber(env.REMOTE_ACCESS_PORT, 3334),
    bindHost: env.BIND_HOST?.trim() || '127.0.0.1',
    defaultUserId,
    defaultUserEmail: env.BANANA_GALLERY_DEFAULT_USER_EMAIL || `${defaultUserId}@banana.gallery`,
    defaultWorkspaceId,
    defaultWorkspaceName: env.BANANA_GALLERY_DEFAULT_WORKSPACE_NAME || 'Local Workspace',
    corsAllowedOrigins: readStringList(env.CORS_ALLOWED_ORIGINS, [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]),
    allowServerSideImport: authMode === 'local' && env.ALLOW_SERVER_SIDE_IMPORT?.trim().toLowerCase() === 'true',
    showDeveloperDiagnostics: readShowDeveloperDiagnostics(env),
    imageGenerationProvider: readDriver<ImageGenerationProviderName>(
      env.IMAGE_GENERATION_PROVIDER?.trim() === 'poe' ? undefined : env.IMAGE_GENERATION_PROVIDER,
      'google',
      ['google', 'seedream', 'qwen-local', 'krea-local', 'qwen', 'kling', 'openai-compatible', 'demo'],
    ),
    seedreamApiKey: env.VOLCENGINE_DOUBAO_API_KEY?.trim() || undefined,
    seedreamImageModel:
      SEEDREAM_5_5_IMAGE_MODEL,
    dashscopeApiKey: env.DASHSCOPE_API_KEY?.trim() || undefined,
    qwenLocalSshHost: env.QWEN_LOCAL_SSH_HOST?.trim() || undefined,
    qwenLocalRemotePort: readNumber(env.QWEN_LOCAL_REMOTE_PORT, 8188),
    qwenLocalStartCmd: env.QWEN_LOCAL_START_CMD?.trim() || undefined,
    qwenLocalOutputHelperCmd: env.QWEN_LOCAL_OUTPUT_HELPER_CMD?.trim() || undefined,
    qwenLocalGpuPattern: env.QWEN_LOCAL_GPU_PATTERN?.trim() || undefined,
    qwenLocalUnet: env.QWEN_LOCAL_UNET?.trim() || undefined,
    qwenLocalStartTimeoutMs: readNumber(env.QWEN_LOCAL_START_TIMEOUT_MS, 180_000),
    qwenImageModel: env.QWEN_IMAGE_MODEL?.trim() || 'qwen-image-3.0-pro',
    qwenImageEndpoint:
      env.QWEN_IMAGE_ENDPOINT?.trim() ||
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    klingImageModel:
      env.KLING_IMAGE_MODEL?.trim() ||
      'kling/kling-v3-omni-image-generation',
    klingImageEndpoint:
      env.KLING_IMAGE_ENDPOINT?.trim() ||
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation',
    dashscopeTaskEndpoint:
      env.DASHSCOPE_TASK_ENDPOINT?.trim() ||
      'https://dashscope.aliyuncs.com/api/v1/tasks',
    dashscopeUploadEndpoint:
      env.DASHSCOPE_UPLOAD_ENDPOINT?.trim() ||
      'https://dashscope.aliyuncs.com/api/v1/uploads',
    openaiImageApiKey: env.OPENAI_IMAGE_API_KEY?.trim() || undefined,
    openaiImageBaseUrl: env.OPENAI_IMAGE_BASE_URL?.trim() || OPENAI_IMAGE_DEFAULT_BASE_URL,
    openaiImageModel: env.OPENAI_IMAGE_MODEL?.trim() || OPENAI_IMAGE_DEFAULT_MODEL,
    enableDemoProvider: env.ENABLE_DEMO_PROVIDER?.trim().toLowerCase() !== 'false',
  }
}

export function assertLoopbackBind(authMode: UserAuthMode, bindHost: string) {
  if (bindHost === '127.0.0.1' || bindHost === '::1' || bindHost === 'localhost') return

  const mode = authMode === 'local' ? 'AUTH_MODE=local 的 BIND_HOST' : 'Cloudflare Access 模式'
  throw new Error(`${mode}只能监听回环地址（127.0.0.1、::1 或 localhost）`)
}

export function assertAuthModeSupported(env: AppEnv) {
  assertLoopbackBind(env.authMode, env.bindHost)

  if (
    env.authMode === 'cloudflare_access'
    && (
      !env.cloudflareAccessTeamDomain
      || !env.cloudflareAccessAudience
      || env.authAllowedEmails.length === 0
    )
  ) {
    throw new Error(
      'AUTH_MODE=cloudflare_access 时必须提供 CF_ACCESS_TEAM_DOMAIN、CF_ACCESS_AUDIENCE 和 AUTH_ALLOWED_EMAILS',
    )
  }
}
