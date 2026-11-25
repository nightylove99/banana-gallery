import { ApiConnectionError, ApiHttpError, readApiJson, requestApiJson, withApiResponse } from '@/api'
import type { GenerationTask, GenerationTaskInput, GalleryImage } from '@/types'
export class BulkPurgeError extends ApiHttpError {
 readonly deleted: number
 readonly remaining: number

 constructor(message: string, deleted: number, remaining: number) {
  super(500, message)
  this.deleted = deleted
  this.remaining = remaining
 }
}

const TASKS_URL = '/api/generation-tasks'

export function taskRequest<T>(path = '', body?: unknown, { signal, method }: { signal?: AbortSignal; method?: string } = {}): Promise<T> {
  const init: RequestInit = {
    signal,
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  }
  const timeoutMs = !path && body !== undefined ? 30_000 : 15_000
  if (path !== '/bulk/commit') {
    return requestApiJson<T>(TASKS_URL + path, '任务操作失败', init, timeoutMs)
  }
  return withApiResponse(TASKS_URL + path, init, async response => {
    if (response.status === 500) {
      const data = await response.clone().json().catch(() => null) as { error?: unknown; deleted?: unknown; remaining?: unknown } | null
      if (data && typeof data.deleted === 'number' && typeof data.remaining === 'number') {
        throw new BulkPurgeError(typeof data.error === 'string' && data.error ? data.error : '清理中断', data.deleted, data.remaining)
      }
    }
    return readApiJson<T>(response, '任务操作失败')
  }, timeoutMs)
}

interface GenerationHistoryResponse {
  tasks: GenerationTask[]
  error: string | null
  canPurge?: boolean
  hasMore?: boolean
  total?: number
}

export function readGenerationHistory(etag?: string, signal?: AbortSignal, full = false) {
  return withApiResponse(full ? TASKS_URL : TASKS_URL + '?limit=60', {
    cache: 'no-store', signal,
    headers: etag ? { 'If-None-Match': etag } : undefined,
  }, async response => {
    if (response.status === 304 && !response.redirected) return null
    const data = await readApiJson<GenerationHistoryResponse>(response, '读取历史失败')
    return { ...data, etag: response.headers.get('ETag') ?? undefined }
  })
}

export const isSubmissionUnconfirmed = (error: unknown) => error instanceof ApiConnectionError ||
  error instanceof ApiHttpError && (error.status >= 500 || error.status === 408)

export async function withSubmissionLock<T>(scope: string, key: string, work: () => Promise<T>, signal?: AbortSignal) {
  // Without Web Locks, the server's task and upload keys still arbitrate writes.
  return navigator.locks
    ? await navigator.locks.request(`banana-generation-submission:${scope}:${key}`, { signal }, work)
    : work()
}

export async function readSubmission(key: string, signal?: AbortSignal) {
  try {
    const task = await taskRequest<Pick<GenerationTask, 'id' | 'key'>>(`/by-key/${encodeURIComponent(key)}`, undefined, { signal })
    if (!task?.id || task.key !== key) throw new Error('提交回执不完整，请稍后再次核对')
    return task
  } catch (error) {
    if (error instanceof ApiHttpError && error.status === 404 && error.code === 'TASK_KEY_NOT_FOUND') return null
    throw error
  }
}

export interface PendingSubmission {
 key: string
 input: GenerationTaskInput
 historyTaskId?: string
 conflicted?: boolean
 localReferenceIds?: Record<string, string>
}
const legacyStorageKey = (scope: string) => `banana-pending-generation:v1:${scope}`
const receiptPrefix = (scope: string) => `banana-pending-generation:v2:${encodeURIComponent(scope)}:`

function parseReceipt(raw: string): PendingSubmission {
 const pending = JSON.parse(raw)
 if (typeof pending?.key !== 'string' || typeof pending.input?.prompt !== 'string') {
   throw new Error('待核对的提交记录无法读取，请保留浏览器数据并检查生成历史')
 }
 return pending
}

export function readPendingSubmissions(scope: string): PendingSubmission[] {
 const storage = window.localStorage
 const receipts = new Map<string, PendingSubmission>()
 const legacy = storage.getItem(legacyStorageKey(scope))
 if (legacy) {
   const receipt = parseReceipt(legacy)
   receipts.set(receipt.key, receipt)
 }
 const prefix = receiptPrefix(scope)
 for (let index = 0; index < storage.length; index++) {
   const key = storage.key(index)
   if (!key?.startsWith(prefix)) continue
   const raw = storage.getItem(key)
   if (!raw) continue
   const receipt = parseReceipt(raw)
   receipts.set(receipt.key, receipt)
 }
 return [...receipts.values()]
}

export function persistSubmission(scope: string, pending: PendingSubmission) {
 window.localStorage.setItem(receiptPrefix(scope) + pending.key, JSON.stringify(pending))
}

export function clearSubmission(scope: string, key: string) {
 const storage = window.localStorage
 storage.removeItem(receiptPrefix(scope) + key)
 const legacyKey = legacyStorageKey(scope)
 const legacy = storage.getItem(legacyKey)
 if (legacy && parseReceipt(legacy).key === key) storage.removeItem(legacyKey)
}
export function taskAsImage(job:GenerationTask):GalleryImage {
 const result=job.result!
 return {...result,id:job.id,assetType:'work',referenceImages:job.input.referenceFilenames,referenceNotes:job.input.referenceNotes,tags:[],favorited:false,createdAt:job.completedAt||job.createdAt,generation:{execution:result.execution ?? job.input.execution,provider:job.input.provider,model:job.input.model,aspectRatio:job.input.aspectRatio,imageSize:job.input.imageSize,quality:job.input.quality}}
}
