import type {
  ImageGenerationParameterMode,
  ImageGenerationProviderName,
  ImageGenerationQuality,
  RecordedImageGenerationProvider,
} from './lib/image-generation-providers'

export interface GenerationExecution {
  engine: 'comfyui'; workflowVersion: 'qwen21-v1' | 'qwen21-v2' | 'krea2-turbo-v1'; seed: number; steps: number; cfg: number; sampler: string; scheduler: string
  unetName?: string
  referenceResolution?: number
  referenceDimensions?: Array<{ width: number; height: number }>
  width?: number
  height?: number
}

export type GalleryAssetType = 'work' | 'recipe'

/** 配方 / 生成页保存时的生成参数快照 */
export interface GalleryImageGeneration {
  execution?: GenerationExecution
  aspectRatio: string
  imageSize?: string
  provider?: RecordedImageGenerationProvider
  model?: string
  quality?: ImageGenerationQuality
  /** @deprecated 新生成不再指定输出格式；旧记录保留该字段用于兼容 */
  outputFormat?: 'jpeg' | 'png'
  title?: string
  notes?: string
}

// assetType is absent only in legacy stored resources; /groups projects a fixed type.
export interface ResultGroup { assetType?: GalleryAssetType; id: string; name: string; imageIds: string[]; coverId?: string; bestId?: string; version: number; createdAt: string; updatedAt: string }
export interface GenerationTaskInput {
  execution?: GenerationExecution
  prompt: string
  referenceFilenames: string[]
  provider: ImageGenerationProviderName
  model: string
  aspectRatio: string
  imageSize?: string
  quality?: ImageGenerationQuality
  sourceTaskId?: string
  referenceNotes?: string[]
  sourceAssetId?: string
}
export interface GenerationTaskScope { workspaceId: string; userId: string; ownerUserId?: string }
export interface GenerationResponseEvidence {
  candidateCount: number; candidates: Array<Record<string, unknown>>; responseId?: string; blockReason?: string; blockMessage?: string; usage?: Record<string, number>; truncated?: boolean
}
export interface GenerationAttempt {
  sequence: number; startedAt: string; requestStartedAt?: string; endedAt?: string; sent: boolean; outcome: 'running' | 'failed' | 'uncertain' | 'completed'; failure?: GenerationFailure
}
export interface GenerationProviderState { cooldownUntil: string; consecutiveRateLimits: number }
export interface GenerationFailure {
  category: 'rate_limit' | 'quota' | 'auth' | 'invalid_input' | 'blocked' | 'unavailable' | 'no_image' | 'network' | 'download' | 'storage' | 'unknown'
  message: string; retryable: boolean; uncertain: boolean
  responseEvidence?: GenerationResponseEvidence
  httpStatus?: number; providerCode?: string; requestId?: string; detail?: string; retryAfterMs?: number
}
export interface GenerationTask {
  id: string; key: string; scope: GenerationTaskScope; input: Omit<GenerationTaskInput, 'provider'> & { provider: RecordedImageGenerationProvider }
  status: 'queued' | 'running' | 'completed' | 'failed' | 'uncertain' | 'cancelled'
  createdAt: string; updatedAt: string; startedAt?: string; completedAt?: string
  runnerId?: string; runnerPid?: number; upstreamTaskId?: string
  purgePending?: boolean
  result?: GenerateResult<RecordedImageGenerationProvider>; error?: string; deletedAt?: string; acknowledgedAt?: string
  /** Derived response field for an accessible saved work. */
  workCode?: string
  /** Derived history field for a task still finalizing in the local queue. */
  executing?: boolean
  workSavePending?: boolean; workSaveError?: string; workAssetId?: string
  requestStartedAt?: string
  attempts?: GenerationAttempt[]; attemptCount?: number; providerCooldownUntil?: string
  providerNetworkPaused?: boolean
  failure?: GenerationFailure
  retryCount?: number
  nextRetryAt?: string
  manualResumeKey?: string
  manualResumeVersion?: number
}
export interface ReferenceVersion { id: string; filename: string; sha256: string; createdAt: string }
export interface ReferenceAsset { id: string; name: string; tags: string[]; favorited: boolean; versions: ReferenceVersion[]; currentVersionId: string; version: number; createdAt: string; updatedAt: string; deletedAt?: string }
export interface ReferenceCombinationItem { assetId: string; versionId: string; note: string }
export interface ReferenceCombination { id: string; name: string; items: ReferenceCombinationItem[]; version: number; createdAt: string; updatedAt: string; deletedAt?: string }
export interface PersonalPreferences { version: number; defaultGeneration?: {provider: ImageGenerationProviderName;model:string;aspectRatio:string;imageSize?:string;quality?:ImageGenerationQuality}; favoriteModels: string[]; gallery?: {density:'compact'|'standard'|'roomy';fit:'cover'|'contain'} }
export interface GalleryResources { generationProviderStates?: Partial<Record<GenerationTaskInput['provider'], GenerationProviderState>>; preferences?: PersonalPreferences; groups?: ResultGroup[]; generationTasks?: GenerationTask[]; referenceAssets?: ReferenceAsset[]; referenceCombinations?: ReferenceCombination[] }

export interface GalleryImage {
  /** Derived response field for an accessible work. */
  workCode?: string
  /** Derived response field; never persisted in the gallery index. */
  thumbnailVersion?: string
  contentHash?: string
  referenceHashes?: string[]
  importRequestId?: string
  importFingerprint?: string
  sourceUrl?: string
  sourceType?: string
  capturedAt?: string
  sourceTaskId?: string
  referenceNotes?: string[]
  sourceAssetId?: string
  title?: string
  notes?: string
  pinned?: boolean
  updatedAt?: string
  version?: number
  deletedAt?: string
  purgePending?: boolean
  id: string
  filename: string
  prompt: string
  referenceImages: string[]
  tags: string[]
  favorited: boolean
  createdAt: string
  width: number
  height: number
  /** 作品（生成/上传）或配方（导入等） */
  assetType: GalleryAssetType
  /** 主要对 recipe 与「带参数保存」的 work 有意义 */
  generation?: GalleryImageGeneration
  sourceFile?: string
}

export interface TrashItem extends GalleryImage {
  deletedAt: string
  version: number
  /** Derived from the original file; not a property of the stored entry. */
  originalMissing?: boolean
}

export interface GalleryStateResponse {
  revision: string
  count: number
  trashCount: number
}

export type ViewFilter = 'all' | 'favorites' | `tag:${string}`

// ─── 图片生成相关类型 ─────────────────────────────────────

export interface GenerateRequest {
  prompt: string
  aspectRatio: string
  imageSize?: string
  provider: ImageGenerationProviderName
  model?: string
  quality?: ImageGenerationQuality
  /** 已存在于服务器上的参考图文件名（从画廊转入） */
  existingRefs?: string[]
}

export interface GenerateResult<Provider extends RecordedImageGenerationProvider = ImageGenerationProviderName> {
  execution?: GenerationExecution
  filename: string
  width: number
  height: number
  prompt: string
  provider: Provider
  model: string
  aspectRatio: string
  imageSize?: string
  quality?: ImageGenerationQuality
  /** @deprecated 服务端不再返回模型附带的说明文字 */
  text?: string
}

/** 从画廊 DetailModal 跳转到生成页时携带的 state */
export interface GeneratePageState {
  sourceTaskId?: string
  referenceNotes?: string[]
  sourceAssetId?: string
  prompt: string
  referenceImages: string[]
  aspectRatio: string
  imageSize?: string
  provider?: RecordedImageGenerationProvider
  model?: string
  quality?: ImageGenerationQuality
  /** @deprecated 新生成页不再使用格式设置 */
  outputFormat?: 'jpeg' | 'png'
}

export interface RuntimeSettings {
  /** false 时仅含 allowServerSideImport，不含下方诊断字段 */
  showDeveloperDiagnostics: boolean
  allowServerSideImport: boolean
  userAuthMode?: UserAuthMode
  userAuthLabel?: string
  aiAuthMode?:
    | 'vertex'
    | 'apiKey'
    | 'seedream'
    | 'qwen'
    | 'kling'
    | 'openai-compatible'
    | 'demo'
    | 'googleUnavailable'
  aiAuthLabel?: string
  dataDriver?: 'json'
  assetStorageDriver?: 'disk'
  project?: string
  location?: string
}

export type UserAuthMode = 'local' | 'cloudflare_access'

export interface GenerationProviderStatus {
  id: ImageGenerationProviderName
  label: string
  model?: string
  available: boolean
  maxReferenceImages: number
  supportedResolutions: string[]
  supportedAspectRatios: string[]
}

export interface GenerationProvidersResponse {
  defaultProvider: ImageGenerationProviderName
  providers: GenerationProviderStatus[]
}

export interface GenerationModelStatus {
  defaultResolution?: string
  referenceAspectRatioMode?: 'source' | 'source-or-preset'
  unavailableReason?: string
  provider: ImageGenerationProviderName
  model: string
  label: string
  parameterMode: ImageGenerationParameterMode
  fixedQuality?: ImageGenerationQuality
  defaultAspectRatio?: string
  available: boolean
  maxReferenceImages: number
  supportedResolutions: string[]
  supportedQualities: ImageGenerationQuality[]
  supportedAspectRatios: string[]
}

export interface GenerationModelsResponse {
  defaultModel: {
    provider: ImageGenerationProviderName
    model: string
  }
  models: GenerationModelStatus[]
  defaultSettings?: PersonalPreferences['defaultGeneration']
}

export interface AppSession {
  user: {
    id: string
    email: string
  }
  workspace: {
    id: string
    name: string
  }
}

export type UpdateCheckStatus =
  | 'up-to-date'
  | 'update-available'
  | 'unconfigured'
  | 'no-release'
  | 'error'

export interface UpdateCheckResult {
  status: UpdateCheckStatus
  currentVersion: string
  checkedAt: string
  repo?: string
  latestVersion?: string
  releaseName?: string
  releaseUrl?: string
  releasesUrl?: string
  publishedAt?: string
  releaseNotes?: string
  message: string
}

export interface AccountSummary extends AppSession {
  runtimeMode: 'personal-local' | 'personal-remote'
  plan: { id: 'personal' }
}

type CredentialSource = 'ui' | 'env' | 'none'

export interface ProviderConfigStatus {
  google: {
    apiKeyConfigured: boolean
    apiKeyMasked?: string
    apiKeySource: CredentialSource
    serviceAccountConfigured: boolean
    serviceAccountSource: CredentialSource
    projectId?: string
    clientEmail?: string
    location: string
    activeMode: 'vertex' | 'apiKey' | 'none'
  }
  openaiCompatible: {
    configured: boolean
    source: CredentialSource
    apiKeyConfigured: boolean
    apiKeyMasked?: string
    baseUrl: string
    model: string
  }
  demoEnabled: boolean
  envProviders: ImageGenerationProviderName[]
  canManage: boolean
  apiBaseUrl: string
  agentTokenConfigured: boolean
  skillPath: 'skills/banana-gallery'
}
