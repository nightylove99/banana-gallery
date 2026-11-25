import type { GenerationTask } from '@/types'

function completedRequestStart(job:GenerationTask){
 if(!job.attempts?.length)return job.requestStartedAt
 const completed=[...job.attempts].reverse().find(attempt=>attempt.outcome==='completed')
 if(completed?.sent)return completed.requestStartedAt
 // Resuming an upstream job only polls it; the task retains its original send time.
 if(completed&&!completed.sent&&job.upstreamTaskId)return job.requestStartedAt
 return undefined
}
export function generationTaskSettings(input: GenerationTask['input']) {
 const ratio = input.aspectRatio === 'source' ? '跟随参考图'
  : input.aspectRatio === 'auto' ? '自动比例' : input.aspectRatio
 return [input.imageSize || input.quality, ratio].filter(Boolean).join(' · ')
}

export function generationTaskDuration(job: GenerationTask) {
 const elapsed = Date.parse(job.completedAt || '') - Date.parse(completedRequestStart(job) || '')
 if (!Number.isFinite(elapsed) || elapsed < 0) return ''
 const seconds = Math.floor(elapsed / 1000)
 const minutes = Math.floor(seconds / 60)
 const hours = Math.floor(minutes / 60)
 return hours > 0 ? `${hours} 小时 ${minutes % 60} 分 ${seconds % 60} 秒`
  : minutes > 0 ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`
}
