import { imageAssetUrl, readApiJson, withApiResponse } from '@/api'
import type { GenerationTask } from '@/types'

/** Use the same original-image URL and filename as the manual download action. */
export function downloadGenerationResult(filename: string, src = imageAssetUrl(filename)) {
  if (!filename || /[/\\]/.test(filename)) throw new Error('图片文件名无效，无法下载')
  const anchor = document.createElement('a')
  anchor.href = src
  anchor.download = filename
  anchor.click()
}

async function dispatchAutomaticDownload(filename: string) {
  const src = imageAssetUrl(filename)
  await withApiResponse(src, { method: 'HEAD', cache: 'no-store' }, async response => {
    if (!response.ok || response.redirected || !response.headers.get('Content-Type')?.startsWith('image/')) {
      await readApiJson(response, '原图暂不可下载')
      throw new Error('原图暂不可下载')
    }
  })
  downloadGenerationResult(filename, src)
}

type DownloadState = { pending: string[]; triggered: string[] }
type DownloadTask = Pick<GenerationTask, 'id' | 'status' | 'deletedAt' | 'result'>
type Options = {
  storage: () => Pick<Storage, 'getItem' | 'setItem'>
  download?: (filename: string) => void | Promise<void>
  lock?: (name: string, work: () => void | Promise<void>) => Promise<void>
}

/** A page observes new work; an initial snapshot never downloads old successes. */
export class GenerationDownloads {
  private seen: Set<string> | null = null
  private dispatched = new Set<string>()
  private queue: Promise<void> = Promise.resolve()
  private readonly key: string

  private readonly options: Options

  constructor(scope: string, options: Options) {
    this.options = options
    this.key = `banana-generation-downloads:v1:${scope}`
  }

  private read(): DownloadState {
    const raw = this.options.storage().getItem(this.key)
    if (!raw) return { pending: [], triggered: [] }
    const value = JSON.parse(raw) as DownloadState
    if (!Array.isArray(value.pending) || !Array.isArray(value.triggered) ||
      ![...value.pending, ...value.triggered].every(id => typeof id === 'string')) {
      throw new Error('自动下载记录无法读取，请在结果区手动下载')
    }
    return value
  }

  private write(state: DownloadState, force = false) {
    const storage = this.options.storage(), encoded = JSON.stringify(state)
    if (force || storage.getItem(this.key) !== encoded) storage.setItem(this.key, encoded)
  }

  private run(work: () => void | Promise<void>) {
    const next = this.queue.catch(() => {}).then(() => this.options.lock
      ? this.options.lock(this.key, work)
      : work())
    this.queue = next
    return next
  }

  watch(id: string) {
    return this.run(() => {
      const state = this.read()
      if (!state.pending.includes(id) && !state.triggered.includes(id)) {
        state.pending.push(id)
        this.write(state)
      }
    })
  }

  observe(tasks: DownloadTask[]) {
    // Poll data must remain a snapshot even if a caller later mutates its list.
    const snapshot = tasks.map(job => ({ id: job.id, status: job.status, deletedAt: job.deletedAt, filename: job.result?.filename }))
    return this.run(async () => {
      const state = this.read()
      const pending = new Set(state.pending), triggered = new Set(state.triggered)
      const previous = this.seen
      this.seen = new Set(snapshot.map(job => job.id))
      for (const job of snapshot) {
        if (job.deletedAt || job.status === 'cancelled' || job.status === 'failed') {
          pending.delete(job.id)
          continue
        }
        if (!triggered.has(job.id) && (job.status === 'queued' || job.status === 'running' || previous && !previous.has(job.id))) pending.add(job.id)
      }
      this.write({ pending: [...pending], triggered: [...triggered] })
      let failure: unknown
      for (const job of snapshot) {
        if (job.deletedAt || job.status !== 'completed' || !job.filename || !pending.has(job.id) || triggered.has(job.id)) continue
        // Check storage before dispatch without writing a false "triggered" receipt.
        this.write({ pending: [...pending], triggered: [...triggered] }, true)
        try {
          if (!this.dispatched.has(job.id)) {
            await (this.options.download ?? dispatchAutomaticDownload)(job.filename)
            this.dispatched.add(job.id)
          }
        }
        catch (error) { failure ??= error; continue }
        pending.delete(job.id)
        triggered.add(job.id)
        this.write({ pending: [...pending], triggered: [...triggered] })
        this.dispatched.delete(job.id)
      }
      if (failure) throw failure
    })
  }
}
