import type {
  AccountSummary,
  AppSession,
  GalleryAssetType,
  GalleryImage,
  GalleryImageGeneration,
  GalleryStateResponse,
  TrashItem,
  GenerationModelsResponse,
  GenerationProvidersResponse,
  GenerateResult,
  RuntimeSettings,
  UpdateCheckResult,
  UserAuthMode,
} from './types'
import type { ImageGenerationProviderName } from './lib/image-generation-providers'
import { notifySessionExpired } from './lib/thumbnail-loader'

const BASE = '/api'

/** API 非 2xx 响应：携带 HTTP 状态码，便于前端按状态展示文案 */
export class ApiHttpError extends Error {
  readonly status: number
  readonly code?: string
  readonly referenceFilenames?: string[]

  constructor(status: number, message: string, code?: string, referenceFilenames?: string[]) {
    super(message)
    this.name = 'ApiHttpError'
    this.status = status
    this.code = code
    this.referenceFilenames = referenceFilenames
  }
}

function isJson(response: Response) {
  return /^(?:application\/json|application\/[\w.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')
}

function accessRedirect(response: Response) {
  return response.type === 'opaqueredirect' ||
    (response.redirected && /(?:\.cloudflareaccess\.com\/|\/cdn-cgi\/access(?:\/|$))/i.test(response.url))
}

function checkAccess(response: Response) {
  if (response.status === 401 || accessRedirect(response)) {
    notifySessionExpired()
    throw new ApiHttpError(401, '登录已过期，请重新登录')
  }
}

async function assertOk(res: Response, fallbackMessage: string) {
  if (res.ok) return
  await readApiJson(res, fallbackMessage)
}

export class ApiConnectionError extends Error {}

export async function withApiResponse<T>(
  url: string, options: RequestInit, read: (response: Response) => Promise<T>, timeoutMs = 15_000,
): Promise<T> {
  const external = options.signal
  external?.throwIfAborted()
  const controller = new AbortController()
  const cancel = () => controller.abort(external?.reason)
  external?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(new ApiConnectionError('请求超时，请检查网络后重试')), timeoutMs)
  // The deadline covers response headers and body, not just fetch resolving.
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
  })
  try {
    const response = await Promise.race([aborted, fetch(url, { ...options, redirect: 'manual', signal: controller.signal })])
    return await Promise.race([aborted, read(response)])
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    if (error instanceof TypeError) throw new ApiConnectionError('网络连接失败，请检查网络后重试', { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', cancel)
  }
}

export async function readApiJson<T>(response: Response, fallback: string): Promise<T> {
  if ([502, 503, 504].includes(response.status)) {
    throw new ApiHttpError(response.status, '服务暂时不可用，请稍后重试')
  }
  checkAccess(response)
  if (response.status === 204) return undefined as T
  if (response.redirected || !isJson(response)) {
    throw new ApiHttpError(response.ok ? 502 : response.status, '服务返回了非预期页面，请稍后重试')
  }
  const data = await response.json().catch(() => {
    throw new ApiHttpError(response.ok ? 502 : response.status, '服务返回的数据不完整，请稍后重试')
  })
  if (!response.ok) {
    throw new ApiHttpError(
      response.status,
      typeof data?.error === 'string' ? data.error : fallback,
      typeof data?.code === 'string' ? data.code : undefined,
      Array.isArray(data?.referenceFilenames) ? data.referenceFilenames.filter((name: unknown) => typeof name === 'string') : undefined,
    )
  }
  return data as T
}

export function requestApiJson<T>(url: string, fallback: string, options: RequestInit = {}, timeoutMs?: number) {
  return withApiResponse(url, options, response => readApiJson<T>(response, fallback), timeoutMs)
}

export function imageAssetUrl(filename: string) {
  return `${BASE}/assets/images/${filename}`
}

export function referenceAssetUrl(filename: string) {
  return `${BASE}/assets/references/${filename}`
}

export async function fetchImages(filter?: { favorites?: boolean; tag?: string }) {
  const params = new URLSearchParams()
  if (filter?.favorites) params.set('favorites', 'true')
  if (filter?.tag) params.set('tag', filter.tag)
  return requestApiJson<GalleryImage[]>(`${BASE}/images?${params}`, '无法获取图片列表')
}

export interface GalleryStats { total: number; works: number; recipes: number; favorites: number; favoriteWorks: number; favoriteRecipes: number; tags: Record<string, number> }
export async function fetchGalleryPages(progress?: (images: GalleryImage[], total?: number, stats?: GalleryStats) => void, signal?: AbortSignal): Promise<GalleryImage[]> {
  // Restart only reads when a concurrent import invalidates the snapshot cursor.
  for (let attempt = 0; attempt < 3; attempt++) {
    let cursor: string | null = null
    const images = new Map<string, GalleryImage>()
    const seen = new Set<string>()
    let changed = false
    do {
      signal?.throwIfAborted()
      const params = new URLSearchParams({ limit: '120' }); if (cursor) params.set('cursor', cursor)
      const response = await fetch(`${BASE}/images?${params}`, { signal, redirect: 'manual' })
      if (response.status === 409) { changed = true; break }
      const page = await readApiJson<GalleryImage[] | {
        items: GalleryImage[]; nextCursor: string | null; total?: number; stats?: GalleryStats
      }>(response, '读取后续图库失败，请重试刷新')
      if (Array.isArray(page)) { progress?.(page, page.length); return page }
      for (const image of page.items as GalleryImage[]) images.set(image.id, image)
      progress?.([...images.values()], page.total, page.stats)
      cursor = page.nextCursor
      if (cursor && seen.has(cursor)) throw new Error('分页游标重复，请重试刷新')
      if (cursor) seen.add(cursor)
    } while (cursor)
    if (!changed) return [...images.values()]
  }
  throw new Error('图库持续变化，已显示部分条目，请稍后重试刷新')
}

export async function fetchImage(id: string, cache?: RequestCache) {
  return requestApiJson<GalleryImage>(`${BASE}/images/${encodeURIComponent(id)}`, '读取条目失败', { cache })
}

export async function patchImage(id: string, updates: Partial<GalleryImage>, expectedVersion?: number) {
  return requestApiJson<GalleryImage>(`${BASE}/images/${id}`, '更新图片失败', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...updates, ...(expectedVersion !== undefined ? { expectedVersion } : {}) }),
  })
}

export async function fetchGalleryState(signal?: AbortSignal) {
  const res = await fetch(`${BASE}/gallery/state`, { signal })
  if (res.status === 404) return null
  if (res.redirected && !res.headers.get('content-type')?.includes('application/json')) notifySessionExpired()
  await assertOk(res, res.status === 401 ? '登录状态已过期，请刷新页面重新验证' : '无法检查图库更新，请重试')
  return res.json() as Promise<GalleryStateResponse>
}

export async function deleteImage(id: string) {
  const res = await fetch(`${BASE}/images/${encodeURIComponent(id)}`, { method: 'DELETE' })
  await assertOk(res, '删除图片失败')
  return res.json() as Promise<{ ok: true; version: number; moved: boolean }>
}

export async function fetchTrash(signal?: AbortSignal) {
  const res = await fetch(`${BASE}/trash`, { signal })
  await assertOk(res, '无法读取回收站，请重试')
  return res.json() as Promise<TrashItem[]>
}

export async function restoreImage(id: string, expectedVersion?: number) {
  const res = await fetch(`${BASE}/trash/${encodeURIComponent(id)}/restore`, {
    method: 'POST',
    ...(expectedVersion === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion }),
    }),
  })
  await assertOk(res, '恢复条目失败')
  return res.json() as Promise<GalleryImage>
}

export async function purgeTrashItem(id: string, expectedVersion: number) {
  const res = await fetch(`${BASE}/trash/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true, expectedVersion }),
  })
  await assertOk(res, '清理失败，请重试')
}

export async function createRecipeFromImage(id: string) {
  return requestApiJson<GalleryImage>(`${BASE}/images/${id}/recipe`, '提炼配方失败', { method: 'POST' })
}

export async function uploadImage(data: {
  image: File
  prompt: string
  tags?: string[]
}) {
  const form = new FormData()
  form.append('image', data.image)
  form.append('prompt', data.prompt)
  form.append('tags', JSON.stringify(data.tags ?? []))
  return requestApiJson<GalleryImage>(`${BASE}/images`, '上传图片失败', { method: 'POST', body: form }, 60_000)
}

export async function uploadReferences(imageId: string, files: File[], signal?: AbortSignal) {
  const form = new FormData()
  files.forEach((f) => form.append('references', f))
  return requestApiJson<GalleryImage>(`${BASE}/images/${imageId}/references`, '上传参考图失败', {
    method: 'POST',
    body: form, signal,
  }, 60_000)
}

/** 整组保存参考图；数字索引仅指向本次上传，旧图必须来自当前条目。 */
export async function saveImageReferences(imageId: string, references: Array<string | File>, baseReferences: string[], referenceNotes?: string[], expectedVersion?: number, signal?: AbortSignal) {
  const form = new FormData()
  let uploadIndex = 0
  const order = references.map(reference => {
    if (typeof reference === 'string') return { filename: reference }
    form.append('references', reference)
    return { upload: uploadIndex++ }
  })
  form.append('order', JSON.stringify(order))
  form.append('baseReferences', JSON.stringify(baseReferences))
  if (referenceNotes) form.append('referenceNotes', JSON.stringify(referenceNotes))
  if (expectedVersion !== undefined) form.append('expectedVersion', String(expectedVersion))
  return requestApiJson<GalleryImage>(`${BASE}/images/${imageId}/references`, '参考图片保存失败', { method: 'PUT', body: form, signal }, 60_000)
}

export async function fetchTags() {
  return requestApiJson<string[]>(`${BASE}/tags`, '无法获取标签')
}

export async function fetchRuntimeSettings() {
  return requestApiJson<RuntimeSettings>(`${BASE}/settings/runtime`, '无法获取运行时设置')
}

export async function fetchGenerationProviders() {
  return requestApiJson<GenerationProvidersResponse>(`${BASE}/generation/providers`, '无法获取图片生成供应商')
}

export async function fetchGenerationModels(signal?: AbortSignal) {
  return requestApiJson<GenerationModelsResponse>(`${BASE}/generation/models`, '无法获取图片生成模型', { signal })
}

export async function fetchSession() {
  return withApiResponse(`${BASE}/session`, {}, async response => {
    if (accessRedirect(response) && ![502, 503, 504].includes(response.status)) {
      return { session: null, authMode: 'cloudflare_access' as const }
    }
    if (response.status === 401) {
      const body = isJson(response) ? await response.json().catch(() => null) as { authMode?: unknown } | null : null
      return { session: null, authMode: isUserAuthMode(body?.authMode) ? body.authMode : null }
    }
    const mode = response.headers.get('X-Auth-Mode')
    return {
      session: await readApiJson<AppSession>(response, '获取登录状态失败'),
      authMode: isUserAuthMode(mode) ? mode : null,
    }
  })
}

function isUserAuthMode(value: unknown): value is UserAuthMode {
  return value === 'local' || value === 'cloudflare_access'
}

export async function logoutSession() {
  return await requestApiJson<{ logoutUrl?: string } | undefined>(`${BASE}/logout`, '退出登录失败', { method: 'POST' }) ?? {}
}

export async function fetchAccountSummary() {
  return requestApiJson<AccountSummary>(`${BASE}/account/summary`, '获取账户摘要失败')
}

export async function checkAppUpdate() {
  const res = await fetch(`${BASE}/personal/update-check`, { cache: 'no-store' })
  await assertOk(res, '检查更新失败')
  return res.json() as Promise<UpdateCheckResult>
}

export async function importMarkdown(markdownPath: string, vaultImagesPath: string) {
  return requestApiJson<{ imported: number; skipped: number; total: number }>(`${BASE}/import`, '导入 Markdown 失败', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdownPath, vaultImagesPath }),
  })
}

// ─── 图片生成 API ────────────────────────────────────────────

/** 上传参考图（独立于画廊条目），返回服务器文件名列表 */
export async function uploadGenerateRefs(files: File[], { uploadKey, signal }: { uploadKey?: string; signal?: AbortSignal } = {}) {
  const form = new FormData()
  files.forEach((f) => form.append('references', f))
  return requestApiJson<{ filenames: string[] }>(`${BASE}/references/upload`, '上传生成参考图失败', {
    method: 'POST', body: form, signal,
    headers: uploadKey ? { 'Idempotency-Key': uploadKey } : undefined,
  }, 60_000)
}

/** 调用 Gemini 生成图片 */
export async function generateImage(data: {
  prompt: string
  referenceFilenames: string[]
  aspectRatio: string
  imageSize?: string
  provider: ImageGenerationProviderName
  model: string
  quality?: GalleryImageGeneration['quality']
}) {
  return requestApiJson<GenerateResult>(`${BASE}/generate`, '生成失败', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }, 180_000)
}

/** 将生成的临时图片保存到画廊 */
export async function saveGeneratedToGallery(data: {
  taskId?: string
  sourceAssetId?: string
  filename: string
  prompt: string
  width: number
  height: number
  referenceFilenames: string[]
  assetType?: GalleryAssetType
  generation?: GalleryImageGeneration
}) {
  return requestApiJson<GalleryImage>(`${BASE}/generate/save`, '保存到画廊失败', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}
