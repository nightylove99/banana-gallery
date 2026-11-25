import { isTrustedGenerationResultUrl } from './generation-result-url'
import type { GenerationTask } from '../types'
import { isRetiredGenerationProvider, isRetiredSeedreamRequest } from './image-generation-providers'

/** An existing resumable upstream job must never become a fresh generation. */
export function hasOriginalResult(job: GenerationTask) {
  const { upstreamTaskId, input: { provider } } = job
  if (!upstreamTaskId) return false
  if (provider === 'qwen') return isTrustedGenerationResultUrl(upstreamTaskId)
  return provider === 'kling' || provider === 'qwen-local' || provider === 'krea-local'
}
export function canResumeResult(job: GenerationTask) {
  return hasOriginalResult(job) && !job.deletedAt && !job.purgePending && !job.result &&
    ['failed', 'uncertain', 'cancelled'].includes(job.status) &&
    !['blocked', 'invalid_input', 'no_image'].includes(job.failure?.category ?? '')
}
export function canGenerateAgain(job: GenerationTask) {
  if (isRetiredGenerationProvider(job.input.provider)) return false
  if (isRetiredSeedreamRequest(job.input.provider, job.input.model, job.input.imageSize)) return false
  if (!/^[\w-]{1,110}$/.test(job.id) || job.deletedAt || job.purgePending || job.result || job.upstreamTaskId) return false
  // An explicit retry uses a new submission key; an existing upstream job can only be queried.
  if (job.status === 'uncertain') return true
  if (job.status === 'cancelled') return true
  return job.status === 'failed' && !!job.failure &&
    (['rate_limit', 'network', 'unavailable'].includes(job.failure.category) || job.failure.retryable) &&
    !['quota', 'auth', 'invalid_input', 'blocked', 'no_image', 'storage', 'unknown'].includes(job.failure.category)
}
export function hasPriorGeneration(job: GenerationTask) {
  return !!job.retryCount || !!job.requestStartedAt || !!job.attempts?.some(attempt => attempt.sent)
}
export function isQueryAttempt(job: GenerationTask) {
  return hasOriginalResult(job) && (!!job.manualResumeVersion || !!job.retryCount || job.attempts?.at(-1)?.sent === false)
}

/** One explicit retry per source record; a newly failed record has its own identity. */
export function historyRetryKey(job: Pick<GenerationTask,'id'>) { return `history-retry-${job.id}` }
