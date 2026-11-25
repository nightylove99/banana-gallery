import { createHash } from 'node:crypto'
import type { GenerationFailure, GenerationTask } from '../../src/types'
import { safeGenerationDetail } from '../ai/generation-failure'

type Status = GenerationTask['status']
const statuses: ReadonlySet<string> = new Set<Status>(['queued', 'running', 'completed', 'failed', 'uncertain', 'cancelled'])
const rfc3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/

interface Timestamp {
  second: number
  fraction: string
}

function parseTimestamp(value: string): Timestamp | undefined {
  const match = rfc3339.exec(value)
  if (!match) return
  const [, year, month, day, hour, minute, second, fraction = '', zone] = match
  const date = `${year}-${month}-${day}`
  const midnight = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date || Number(hour) > 23) return
  const time = Date.parse(`${date}T${hour}:${minute}:${second}${zone}`)
  if (Number.isFinite(time)) return { second: time / 1000, fraction: fraction.replace(/0+$/, '') }
}

function readDateFilter(params: URLSearchParams, name: 'from' | 'to') {
  const value = params.get(name)
  if (value === null) return undefined
  const timestamp = parseTimestamp(value)
  if (!timestamp) throw new Error(`${name} 必须为 RFC3339 时间`)
  return timestamp
}

const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const compareTime = (a: Timestamp, b: Timestamp) => a.second - b.second || compareText(a.fraction, b.fraction)

function taskTimestamp(value: string): Timestamp {
  // Older records may not include an explicit time or timezone.
  const timestamp = parseTimestamp(value)
  if (timestamp) return timestamp
  const milliseconds = Date.parse(value) || 0
  const second = Math.floor(milliseconds / 1000)
  const fraction = String(milliseconds - second * 1000).padStart(3, '0').replace(/0+$/, '')
  return { second, fraction }
}

function comparePosition(a: { time: Timestamp; id: string }, b: { time: Timestamp; id: string }) {
  return compareTime(b.time, a.time) || compareText(a.id, b.id)
}

function readCursor(cursor: string, signature: string) {
  try {
    const bytes = Buffer.from(cursor, 'base64url')
    if (bytes.toString('base64url') !== cursor) throw new Error()
    const { filters, second, fraction, id }: Partial<Record<'filters' | 'second' | 'fraction' | 'id', unknown>> = JSON.parse(bytes.toString())
    if (filters !== signature || typeof second !== 'number' || !Number.isSafeInteger(second) || typeof fraction !== 'string' || !/^\d*$/.test(fraction) || typeof id !== 'string' || !id) throw new Error()
    return { time: { second, fraction }, id }
  } catch {
    throw new Error('分页游标无效或筛选条件已变化')
  }
}

export function limitGenerationHistory<T extends GenerationTask>(jobs: T[], limit: number) {
  const active: T[] = []
  const history: Array<{ job: T; time: Timestamp; id: string }> = []
  for (const job of jobs) {
    if (job.status === 'queued' || job.status === 'running' || job.workSavePending) active.push(job)
    else history.push({ job, time: taskTimestamp(job.createdAt), id: job.id })
  }
  history.sort(comparePosition)
  return {
    jobs: [...active, ...history.slice(0, limit).map(row => row.job)],
    total: jobs.length,
    hasMore: history.length > limit,
  }
}

export function createGenerationTaskPage(jobs: GenerationTask[], params: URLSearchParams, workspaceId: string) {
  const rawLimit = params.get('limit') ?? '20'
  const limit = Number(rawLimit)
  if (!/^\d+$/.test(rawLimit) || limit < 1 || limit > 100) throw new Error('每页数量必须为 1–100')

  const status = [...new Set(params.getAll('status'))].sort()
  if (status.some(value => !statuses.has(value))) throw new Error('任务状态无效')
  const provider = params.get('provider') || undefined
  const from = readDateFilter(params, 'from')
  const to = readDateFilter(params, 'to')
  const signature = createHash('sha256').update(JSON.stringify([workspaceId, status, provider, from, to])).digest('hex')
  const cursor = params.get('cursor')
  const position = cursor === null ? undefined : readCursor(cursor, signature)

  const matching = jobs
    .filter(job => !job.deletedAt && !job.purgePending && (!status.length || status.includes(job.status)) && (!provider || job.input.provider === provider))
    .map(job => ({ job, time: taskTimestamp(job.createdAt), id: job.id }))
    .filter(({ time }) => (!from || compareTime(time, from) >= 0) && (!to || compareTime(time, to) < 0))
  const page = (position ? matching.filter(row => comparePosition(row, position) > 0) : matching)
    .sort(comparePosition)
    .slice(0, limit + 1)
  const items = page.slice(0, limit).map(row => row.job)
  const last = page[limit - 1]
  const nextCursor = page.length > limit
    ? Buffer.from(JSON.stringify({ filters: signature, ...last.time, id: last.id })).toString('base64url')
    : null
  return { items, total: matching.length, nextCursor }
}

export function publicGenerationFailure(failure?: GenerationFailure) {
  if (!failure) return undefined
  const { category, message, retryable, uncertain, httpStatus, providerCode, requestId } = failure
  return {
    category, retryable, uncertain, httpStatus: httpStatus ?? undefined,
    message: message ? safeGenerationDetail(message) : undefined,
    providerCode: providerCode ? safeGenerationDetail(providerCode) : undefined,
    requestId: requestId ? safeGenerationDetail(requestId) : undefined,
  }
}

export function generationTaskSummary(job: GenerationTask, workCode?: string) {
  const { id, key, status, createdAt, updatedAt, input: { provider, model } } = job
  return { id, key, status, createdAt, updatedAt, provider, model, workCode, failure: publicGenerationFailure(job.failure) }
}
