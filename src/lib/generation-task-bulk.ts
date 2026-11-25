import type { GenerationTask } from '../types'
import { formatImageGenerationSource } from './image-generation-providers'

export const generationHistoryTabs = ['all', 'failed', 'completed', 'cancelled', 'trash'] as const
export type GenerationHistoryTab = (typeof generationHistoryTabs)[number]
export type GenerationBulkOperation = 'trash' | 'purge-failed'

export interface GenerationBulkScope {
  operation: GenerationBulkOperation
  tab: GenerationHistoryTab
  search: string
}

export interface GenerationBulkPreview extends GenerationBulkScope {
  token: string | null
  matchedCount: number
  eligibleCount: number
  skippedCount: number
  retryPurgeCount: number
}

export type GenerationBulkResult = { skipped: number } & ({ moved: number } | { deleted: number })

export function isGenerationHistoryFailure(status: GenerationTask['status']) {
  return status === 'failed' || status === 'uncertain'
}

export function matchesGenerationHistoryTab(job: GenerationTask, tab: GenerationHistoryTab) {
  if (tab === 'trash') return !!job.deletedAt
  return !job.deletedAt && (tab === 'all' || (tab === 'failed' ? isGenerationHistoryFailure(job.status) : job.status === tab))
}

export function matchesGenerationHistorySearch(job: GenerationTask, query: string, workCode = job.workCode) {
  if (!query) return true
  const { prompt, provider, model } = job.input
  return [prompt, workCode, provider, model, formatImageGenerationSource(provider, model)]
    .some(value => value?.toLowerCase().includes(query))
}

export function canBulkChangeGenerationTask(job: GenerationTask, operation: GenerationBulkOperation, executing: boolean) {
  if (job.status === 'queued' || job.status === 'running' || executing || job.workSavePending) return false
  if (operation === 'purge-failed') return !!job.deletedAt && isGenerationHistoryFailure(job.status)
  return !job.deletedAt && !job.purgePending
}
