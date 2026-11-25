import { canResumeResult, hasOriginalResult } from '../../src/lib/generation-task-actions.ts'
import { describeImageGenerationFailure, safeGenerationDetail } from '../ai/generation-failure.ts'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { GalleryResources, GenerationExecution, GenerationFailure, GenerationTask, GenerationTaskInput, GenerationTaskScope, GenerateResult } from '../../src/types'
import type { GalleryRepository, GalleryScope, ReadOnlyGalleryResources } from '../gallery/gallery-repository'
import { JsonGalleryRepository } from '../gallery/json-gallery-repository'
import type { GalleryWriteCoordinator } from '../gallery/write-coordinator'
import { createQwenExecution, createKreaExecution } from '../ai/qwen-execution.ts'
import { isImageGenerationProviderName, isLocalImageProvider } from '../../src/lib/image-generation-providers.ts'
const liveRunners = new Set<string>()
const DEFAULT_PROVIDER_CONCURRENCY = 3
const DEFAULT_ACTIVE_LIMIT = 20
export const LOCAL_ACTIVE_LIMIT = 100

type TaskErrorCode = 'QUEUE_FULL' | 'TASK_KEY_CONFLICT' | 'REFERENCE_UNAVAILABLE' | 'SOURCE_TASK_UNAVAILABLE'
export class TaskError extends Error {
  readonly status: number
  readonly uncertain: boolean
  readonly retryable: boolean
  readonly failure?: GenerationFailure
  readonly code?: TaskErrorCode
  readonly referenceFilenames?: string[]
  constructor(message: string, status = 400, uncertain = false, retryable = false, failure?: GenerationFailure, code?: TaskErrorCode, referenceFilenames?: string[]) {
    super(message)
    this.status = status
    this.uncertain = uncertain
    this.retryable = retryable
    this.failure = failure
    this.code = code
    this.referenceFilenames = referenceFilenames
  }
}
export interface TaskControl { signal: AbortSignal; onRequestStarted: (upstreamId?: string, execution?: GenerationExecution) => Promise<void>; onUpstreamTask: (id: string, execution?: GenerationExecution) => Promise<void> }
export interface GenerationReceipt {
  result: GenerateResult
  outputBytes: number
  completedAt: string
}
type ExecutionOutput = GenerateResult & { completedAt?: string; afterReceiptSaved?: () => Promise<void> }
interface RunningExecution {
  controller: AbortController
  timeout: ReturnType<typeof setTimeout>
}
interface Options {
  repository: GalleryRepository
  coordinator: GalleryWriteCoordinator
  execute: (job: GenerationTask, control: TaskControl) => Promise<ExecutionOutput>
  saveWork?: (job: GenerationTask) => Promise<string>
  resumable?: (job: GenerationTask) => boolean
  timeoutMs?: number
  maxConcurrentByProvider?: Partial<Record<GenerationTaskInput['provider'], number>>
  maxRetries?: number
  retryDelayMs?: (retryCount: number) => number
  readReceipt?: (job: GenerationTask) => Promise<GenerationReceipt | undefined>
  removeReceipt?: (id: string) => Promise<void>
}

export class GenerationTaskQueue {
  private options: Options
  private runnerId = randomUUID()
  private scopes = new Map<string, GalleryScope>()
  private timer?: ReturnType<typeof setInterval>
  private retryWakeAt = Infinity
  private retryWake?: ReturnType<typeof setTimeout>
  private started?: Promise<void>
  private stopping?: Promise<void>
  private disposed = false
  private wakeFinished?: Promise<void>
  private wakeRequested = false
  private idleSnapshot?: { revision: string; nextWakeAt: number }
  private workSaveRetries = new Map<string, { failures: number; nextAt: number }>()
  private executing = new Map<string, RunningExecution>()
  private pendingWrites = new Map<string, () => Promise<void>>()
  lastError: string | null = null
  constructor(options: Options) { this.options = options }
  private async read(scope: GalleryScope): Promise<GalleryResources> {
    if (!this.options.repository.readResources) throw new TaskError('当前存储不支持生成历史', 503)
    return this.options.repository.readResources(scope)
  }
  private async save(scope: GalleryScope, resources: GalleryResources) {
    if (!this.options.repository.saveResources) throw new TaskError('当前存储不支持生成历史', 503)
    await this.options.repository.saveResources(resources, scope)
  }
  private ownerAlive(job: GenerationTask) {
    if (job.runnerPid === process.pid) return !!job.runnerId && liveRunners.has(job.runnerId)
    if (!job.runnerPid) return false
    try { process.kill(job.runnerPid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
  }
  start() {
    if (!this.started) this.started = (async () => {
      if (this.disposed) return
      liveRunners.add(this.runnerId)
      const repository = this.options.repository
      if (repository instanceof JsonGalleryRepository) {
        const snapshot = repository.readOnlySnapshot()
        this.discoverScopes(snapshot.resources)
        if (this.hasInterruptedTask(snapshot.resources)) await this.recover(this.jsonScopes())
      } else {
        for (const scope of await repository.listResourceScopes?.() || []) this.scopes.set(scope.workspaceId, scope)
        await this.recover()
      }
      if (this.disposed) return
      this.timer = setInterval(() => { this.schedule() }, 2000); this.timer.unref?.()
      this.schedule()
    })()
    return this.started
  }
  private discoverScopes(resources: ReadOnlyGalleryResources) {
    for (const job of resources.generationTasks || []) {
      if (!this.scopes.has(job.scope.workspaceId)) this.scopes.set(job.scope.workspaceId, { ...job.scope })
    }
  }
  private jsonScopes(): GalleryScope[] {
    const scope = this.scopes.values().next().value
    return scope ? [scope] : []
  }
  private hasInterruptedTask(resources: ReadOnlyGalleryResources) {
    return resources.generationTasks?.some(job => job.status === 'running' && !this.ownerAlive(job))
  }
  private async recover(scopes: Iterable<GalleryScope> = this.scopes.values()) {
    await this.options.coordinator.run(async () => {
      for (const scope of scopes) {
        const resources = await this.read(scope)
        let changed = false
        const recovered: string[] = []
        for (const job of resources.generationTasks || []) if (job.status === 'running' && !this.ownerAlive(job)) {
          changed = true
          job.updatedAt = new Date().toISOString()
          delete job.runnerId
          delete job.runnerPid
          const receipt = await this.options.readReceipt?.(job)
          if (receipt) {
            await this.applyCompletion(job, resources, receipt, job.attemptCount)
            recovered.push(job.id)
            continue
          }
          const resumable = !!job.upstreamTaskId && !!this.options.resumable?.(job)
          const attempt = job.attempts?.at(-1)
          const sent = !!job.requestStartedAt || attempt?.sent !== false
          const message = resumable ? '服务恢复，继续查询原上游任务'
            : sent ? '服务中断，上游可能仍在处理；如需重新生成请手动再试一次'
              : '服务在发送生成请求前中断；如需生成请手动再试一次'
          job.status = resumable ? 'queued' : 'failed'
          job.error = message
          job.failure = { category: 'network', message, retryable: resumable, uncertain: sent }
          if (attempt?.outcome === 'running' || attempt?.outcome === 'uncertain') {
            attempt.outcome = 'failed'
            attempt.endedAt = job.updatedAt
            attempt.failure = structuredClone(job.failure)
          }
        }
        if (changed) await this.save(scope, resources)
        for (const id of recovered) await this.removeReceipt(id)
      }
    })
  }
  async list(scope: GenerationTaskScope): Promise<GenerationTask[]> {
    const repository = this.options.repository
    const jobs = repository instanceof JsonGalleryRepository
      ? repository.readOnlySnapshot().resources.generationTasks
      : (await this.read(scope)).generationTasks
    const scoped = (jobs || []).filter(job => job.scope.workspaceId === scope.workspaceId)
    return repository instanceof JsonGalleryRepository ? structuredClone(scoped) : scoped
  }
  async submit(scope: GenerationTaskScope, key: string, input: GenerationTaskInput, {
    maxActive = DEFAULT_ACTIVE_LIMIT,
    validateNew,
  }: { maxActive?: number; validateNew?: (resources: GalleryResources) => Promise<void> } = {}) {
    await this.start()
    if (this.disposed) throw new TaskError('服务正在停止，请稍后重试', 503)
    if (typeof key !== 'string' || !key || key.length > 128 || !/^[\w-]+$/.test(key)) throw new TaskError('提交标识无效')
    this.scopes.set(scope.workspaceId, scope)
    const job = await this.options.coordinator.run(async () => {
      const resources = await this.read(scope), jobs = resources.generationTasks || []
      const existing = jobs.find(job => job.key === key && job.scope.workspaceId === scope.workspaceId)
      if (existing) {
        if (!isDeepStrictEqual({ ...existing.input, execution: undefined }, { ...input, execution: undefined })) {
          throw new TaskError('同一提交标识对应不同输入，请核对后重试', 409, false, false, undefined, 'TASK_KEY_CONFLICT')
        }
        return existing
      }
      await validateNew?.(resources)
      if (this.disposed) throw new TaskError('服务正在停止，请稍后重试', 503)
      const active = jobs.filter(job => job.status === 'queued' || job.status === 'running').length
      if (active >= maxActive) {
        throw new TaskError(`队列已有 ${maxActive} 项，请等待部分任务完成`, 429, false, false, undefined, 'QUEUE_FULL')
      }
      const frozenInput = structuredClone(input)
      if (input.provider === 'qwen-local') frozenInput.execution = createQwenExecution()
      if (input.provider === 'krea-local') frozenInput.execution = createKreaExecution()
      const now = new Date().toISOString()
      const next: GenerationTask = { id: randomUUID(), key, scope: { ...scope }, input: frozenInput, status: 'queued', createdAt: now, updatedAt: now }
      await this.save(scope, { ...resources, generationTasks: [...jobs, next] }); return next
    })
    this.schedule()
    return job
  }
  private async change(scope: GenerationTaskScope, id: string, update: (job: GenerationTask, resources: GalleryResources) => void | Promise<void>) {
    return this.options.coordinator.run(async () => {
      const resources = await this.read(scope), job = resources.generationTasks?.find(job => job.id === id && job.scope.workspaceId === scope.workspaceId)
      if (!job) throw new TaskError('任务不存在', 404)
      await update(job, resources); job.updatedAt = new Date().toISOString(); await this.save(scope, resources); return job
    })
  }
  async cancel(scope: GenerationTaskScope, id: string) {
    const job = await this.change(scope, id, job => { if (job.status === 'cancelled') return; if (job.status !== 'queued') throw new TaskError('任务已经开始，当前模型不支持可靠取消；请等待结果', 409); if (hasOriginalResult(job)) throw new TaskError('正在获取原结果，不会重新生成，不能通过取消排队撤销原任务', 409); job.status = 'cancelled' })
    return job
  }
  async resumeQuery(scope: GenerationTaskScope, id: string, key: string, expectedVersion: number) {
    if (this.disposed) throw new TaskError('服务正在停止，请稍后重试', 503)
    if (typeof key !== 'string' || !/^[\w-]{1,128}$/.test(key) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new TaskError('结果获取标识无效')
    let claimed = false
    const job = await this.change(scope, id, current => {
      if (this.disposed) throw new TaskError('服务正在停止，请稍后重试', 503)
      if (current.deletedAt || current.purgePending) throw new TaskError('请先恢复历史，清理中的记录不能获取结果', 409)
      if (!hasOriginalResult(current) || !this.options.resumable?.(current)) throw new TaskError('没有可继续获取的原任务，请核对结果后调整草稿', 409)
      if (current.manualResumeKey === key || current.status === 'completed' && current.result) return
      if ((current.manualResumeVersion ?? 0) !== expectedVersion) throw new TaskError('任务状态已变化，请刷新后核对', 409)
      if (['queued', 'running'].includes(current.status)) return
      if (this.isExecuting(id)) throw new TaskError('原请求尚在处理中，请等待原结果', 409)
      if (!canResumeResult(current)) throw new TaskError('原任务不能继续获取，请查看失败原因', 409)
      current.manualResumeKey = key
      current.manualResumeVersion = (current.manualResumeVersion ?? 0) + 1
      current.status = 'queued'
      current.retryCount = 0
      current.nextRetryAt = new Date(Math.max(Date.now(), Date.parse(current.nextRetryAt || '') || 0)).toISOString()
      delete current.runnerId; delete current.runnerPid
      claimed = true
    })
    if (claimed) { this.scopes.set(scope.workspaceId, scope); await this.start(); this.schedule() }
    return job
  }
  async acknowledge(scope: GenerationTaskScope, id: string) {
    const job = await this.change(scope, id, job => { job.acknowledgedAt = new Date().toISOString() })
    this.schedule(); return job
  }
  async trash(scope: GenerationTaskScope, id: string, deleted: boolean) {
    const job = await this.change(scope, id, job => {
      if (job.purgePending) throw new TaskError('已开始永久清理，请继续清理或使用备份恢复', 409)
      if (['queued', 'running'].includes(job.status) || this.isExecuting(id)) throw new TaskError('请先取消排队项或等待执行结束', 409)
      if (deleted) job.deletedAt = new Date().toISOString(); else delete job.deletedAt
    })
    this.schedule(); return job
  }
  isExecuting(id: string) { return this.executing.has(id) || this.pendingWrites.has(id) }
  async providerCooldowns(scope: GenerationTaskScope): Promise<Partial<Record<GenerationTaskInput['provider'], string>>> {
    this.scopes.set(scope.workspaceId, scope)
    const repository = this.options.repository
    if (repository instanceof JsonGalleryRepository) {
      const cooldown = repository.readOnlySnapshot().resources.generationProviderStates?.google?.cooldownUntil
      return cooldown && Date.parse(cooldown) > Date.now() ? { google: new Date(cooldown).toISOString() } : {}
    }
    let until = 0
    for (const entry of this.scopes.values()) until = Math.max(until, Date.parse((await this.read(entry)).generationProviderStates?.google?.cooldownUntil || '') || 0)
    return until > Date.now() ? { google: new Date(until).toISOString() } : {}
  }
  // Called only within the write coordinator, together with the task mutation.
  private async googleState(scope: GenerationTaskScope, resources: GalleryResources, failure?: GenerationFailure) {
    const sets: Array<{ scope: GalleryScope; resources: GalleryResources }> = [{ scope, resources }]
    if (!(this.options.repository instanceof JsonGalleryRepository)) {
      for (const other of this.scopes.values()) if (other.workspaceId !== scope.workspaceId) sets.push({ scope: other, resources: await this.read(other) })
    }
    const states = sets.map(s => s.resources.generationProviderStates?.google)
    const previousUntil = Math.max(0, ...states.map(s => Date.parse(s?.cooldownUntil || '') || 0))
    const count = failure ? Math.max(0, ...states.map(s => s?.consecutiveRateLimits || 0)) + 1 : 0
    const base = this.options.retryDelayMs?.(count) ?? Math.min(30_000 * 2 ** Math.min(Math.max(count - 1, 0), 5), 600_000)
    const delay = Math.max(base * (1 + Math.random() * .25), failure?.retryAfterMs || 0)
    const until = failure ? Math.max(previousUntil, Date.now() + delay) : previousUntil
    for (const set of sets) {
      set.resources.generationProviderStates = { ...set.resources.generationProviderStates, google: { cooldownUntil: new Date(until).toISOString(), consecutiveRateLimits: count } }
      if (set.resources !== resources) await this.save(set.scope, set.resources)
    }
    return until
  }
  private retryDelay(retryCount: number) {
    return this.options.retryDelayMs?.(retryCount) ?? Math.min(30_000 * 2 ** Math.max(0, retryCount - 1), 10 * 60_000)
  }
  private armRetryWake(delayMs: number) {
    if (this.disposed) return
    const deadline = Date.now() + Math.max(5, delayMs)
    if (deadline >= this.retryWakeAt) return
    this.retryWakeAt = deadline
    if (this.retryWake) clearTimeout(this.retryWake)
    this.retryWake = setTimeout(() => { this.retryWake = undefined; this.retryWakeAt = Infinity; this.schedule() }, Math.min(2_147_483_647, Math.max(5, delayMs)))
    this.retryWake.unref?.()
  }
  private nextClaim(jobs: readonly GenerationTask[], cooldownUntil: number) {
    const queued = jobs.filter(job => job.status === 'queued')
    if (queued.length === 0) return
    // A finished adapter waiting on storage does not occupy a provider slot.
    const running = jobs.filter(job => job.status === 'running' && !this.pendingWrites.has(job.id))
    const occupied = new Set(running.map(job => job.id))
    for (const id of this.executing.keys()) occupied.add(id)
    const occupiedJobs = jobs.filter(job => occupied.has(job.id))
    const providerCount = (provider: GenerationTask['input']['provider']) => occupiedJobs.filter(job => isLocalImageProvider(provider) ? isLocalImageProvider(job.input.provider) : job.input.provider === provider).length
    const now = Date.now()
    for (const job of queued) {
      const eligible = Math.max(Date.parse(job.nextRetryAt || '') || 0, job.input.provider === 'google' ? cooldownUntil : 0)
      if (eligible > now) this.armRetryWake(eligible - now)
    }
    const googleBlocked = cooldownUntil > now
    const concurrencyLimit = (provider: string) =>
      (isImageGenerationProviderName(provider) ? this.options.maxConcurrentByProvider?.[provider] : undefined) ?? DEFAULT_PROVIDER_CONCURRENCY
    return queued.filter(job => (job.input.provider !== 'google' || !googleBlocked) && providerCount(job.input.provider) < concurrencyLimit(job.input.provider) && !this.isExecuting(job.id) && (!job.nextRetryAt || Date.parse(job.nextRetryAt) <= now)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]
  }
  private async claim(sharedScope?: GalleryScope): Promise<GenerationTask | null> {
    return this.options.coordinator.run(async () => {
      if (this.disposed) return null
      const sets: Array<{ scope: GalleryScope; resources: GalleryResources }> = []
      for (const scope of sharedScope ? [sharedScope] : this.scopes.values()) sets.push({ scope, resources: await this.read(scope) })
      const jobs = [...new Map(sets.flatMap(set => set.resources.generationTasks || []).map(job => [job.id, job])).values()]
      const cooldownUntil = Math.max(0, ...sets.map(s => Date.parse(s.resources.generationProviderStates?.google?.cooldownUntil || '') || 0))
      const next = this.nextClaim(jobs, cooldownUntil)
      if (!next) return null
      const set = sharedScope ? sets[0] : sets.find(set => set.scope.workspaceId === next.scope.workspaceId)!
      const claimed = set.resources.generationTasks!.find(job => job.id === next.id)!
      if (!claimed.upstreamTaskId) delete claimed.requestStartedAt
      claimed.status = 'running'; claimed.runnerId = this.runnerId; claimed.runnerPid = process.pid; claimed.startedAt ||= new Date().toISOString(); claimed.updatedAt = new Date().toISOString()
      claimed.attemptCount = (claimed.attemptCount || 0) + 1
      claimed.attempts = [...(claimed.attempts || []), { sequence: claimed.attemptCount, startedAt: new Date().toISOString(), sent: false, outcome: 'running' as const }].slice(-8)
      delete claimed.nextRetryAt
      await this.save(set.scope, set.resources); return claimed
    })
  }
  private ownsAttempt(current: GenerationTask, job: GenerationTask) {
    return current.status === 'running' && current.runnerId === this.runnerId && current.attemptCount === job.attemptCount && !current.purgePending
  }
  private async applyCompletion(current: GenerationTask, resources: GalleryResources, receipt: Pick<GenerationReceipt, 'result' | 'completedAt'>, sequence?: number) {
    current.status = 'completed'
    current.result = receipt.result
    current.completedAt = receipt.completedAt
    current.workSavePending = !!this.options.saveWork
    delete current.error
    delete current.failure
    const attempt = current.attempts?.find(entry => entry.sequence === sequence)
    if (attempt) {
      attempt.outcome = 'completed'
      attempt.endedAt = receipt.completedAt
      delete attempt.failure
    }
    if (current.input.provider === 'google') await this.googleState(current.scope, resources)
  }
  private async removeReceipt(id: string) {
    try { await this.options.removeReceipt?.(id) }
    catch { console.warn('[generation] 已保存到图库索引，但未能清理落盘回执') }
  }
  private async complete(job: GenerationTask, output: ExecutionOutput) {
    const { afterReceiptSaved, completedAt = new Date().toISOString(), ...result } = output
    await this.change(job.scope, job.id, async (current, resources) => {
      if (!this.ownsAttempt(current, job)) throw new TaskError('任务所有者已变化', 409)
      await this.applyCompletion(current, resources, { result, completedAt }, job.attemptCount)
    })
    await this.removeReceipt(job.id)
    if (afterReceiptSaved) this.options.coordinator.detached(async () => {
      try { await afterReceiptSaved() } catch { console.warn('[local-image] Mac 图片已保存，远端副本清理未完成') }
    })
  }
  private workSaveDue(job: GenerationTask) {
    return job.status === 'completed' && job.workSavePending && (this.workSaveRetries.get(job.id)?.nextAt ?? 0) <= Date.now()
  }
  private async savePendingWorks(scopes: Iterable<GalleryScope> = this.scopes.values()) {
    if (!this.options.saveWork) return
    for (const scope of scopes) {
      await this.options.coordinator.run(async () => {
        const resources = await this.read(scope)
        let changed = false
        for (const job of resources.generationTasks || []) {
          if (!this.workSaveDue(job)) continue
          try {
            job.workAssetId = await this.options.saveWork!(job)
            job.workSavePending = false
            delete job.workSaveError
            this.workSaveRetries.delete(job.id)
            changed = true
          } catch (error) {
            const message = error instanceof Error ? error.message : '作品入库暂时失败'
            const failures = (this.workSaveRetries.get(job.id)?.failures ?? 0) + 1
            const delay = Math.min(5_000 * 2 ** Math.min(failures - 1, 6), 60_000)
            this.workSaveRetries.set(job.id, { failures, nextAt: Date.now() + delay })
            this.armRetryWake(delay)
            if (job.workSaveError !== message) {
              job.workSaveError = message
              changed = true
            }
          }
        }
        if (changed) await this.save(scope, resources)
      })
    }
  }
  private schedule() { this.options.coordinator.detached(() => { void this.wake().catch(() => {}) }) }
  private runTask(job: GenerationTask) {
    if (this.disposed) return
    const controller = new AbortController()
    const active = () => this.executing.get(job.id) === run && !controller.signal.aborted
    const settle = (write: () => Promise<void>) => {
      if (!active()) return
      clearTimeout(run.timeout)
      this.executing.delete(job.id)
      this.pendingWrites.set(job.id, write)
      this.schedule()
    }
    const timeout = setTimeout(() => {
      const error = new TaskError('等待生成结果超时', 504, true)
      settle(() => this.handleFailure(job, error))
      controller.abort(error)
    }, this.options.timeoutMs ?? 20 * 60_000)
    timeout.unref?.()
    const run = { controller, timeout }
    this.executing.set(job.id, run)
    const execution = Promise.resolve().then(() => {
      controller.signal.throwIfAborted()
      return this.options.execute(job, {
        signal: controller.signal,
        onRequestStarted: (upstreamId, snapshot) => this.change(job.scope, job.id, current => {
          if (!active() || !this.ownsAttempt(current, job)) throw new TaskError('任务所有者已变化，未发送请求', 409)
          const attempt = current.attempts?.find(a => a.sequence === job.attemptCount)
          if (!attempt?.requestStartedAt) current.requestStartedAt = new Date().toISOString()
          if (attempt) { attempt.sent = true; attempt.requestStartedAt ||= current.requestStartedAt }
          if (upstreamId) current.upstreamTaskId = upstreamId
          if (snapshot && isLocalImageProvider(current.input.provider)) current.input.execution = structuredClone(snapshot)
          delete current.error; delete current.failure
        }).then(() => {}, error => {
          if (error instanceof TaskError) throw error
          const message = '请求发送时间未能保存，未发送生成请求，请检查存储空间和权限'
          throw new TaskError(message, 500, false, false, { category: 'storage', message, retryable: false, uncertain: false })
        }),
        onUpstreamTask: (id, snapshot) => this.change(job.scope, job.id, current => {
          if (!active() || !this.ownsAttempt(current, job)) throw new TaskError('任务所有者已变化', 409, true)
          current.upstreamTaskId = id
          if (snapshot && isLocalImageProvider(current.input.provider)) current.input.execution = structuredClone(snapshot)
        }).then(() => {}),
      })
    })
    void execution.then(
      output => settle(() => this.complete(job, output)),
      error => settle(() => this.handleFailure(job, error)),
    )
  }
  private async handleFailure(job: GenerationTask, error: unknown) {
    await this.change(job.scope, job.id, async (current, resources) => {
      if (!this.ownsAttempt(current, job)) return
      const maxRetries = this.options.maxRetries ?? 3
      const retryCount = current.retryCount ?? 0
      const failure = error instanceof TaskError && error.failure
        ? { ...error.failure }
        : describeImageGenerationFailure(error)
      const attempt = current.attempts?.find(entry => entry.sequence === job.attemptCount)
      const resumable = !!current.upstreamTaskId && !!this.options.resumable?.(current)
      const transientQueryFailure = resumable && (
        failure.category === 'network' || failure.category === 'unavailable' ||
        failure.category === 'download' && (!failure.httpStatus || failure.httpStatus >= 500 || failure.httpStatus === 429) &&
        failure.providerCode !== 'UNTRUSTED_IMAGE_URL'
      )
      const rateLimited = failure.category === 'rate_limit'
      failure.retryable = rateLimited || transientQueryFailure
      if (transientQueryFailure) {
        failure.message = '原任务结果查询或取图暂时失败，不会重新生成'
      } else if (attempt?.sent && (failure.category === 'network' || failure.category === 'unavailable')) {
        const reason = failure.category === 'network' ? '请求超时或连接中断' : '生成服务返回错误'
        failure.message = `${reason}，上游可能仍在处理；如需重新生成请手动再试一次`
      } else if (error instanceof TaskError && !error.failure && !rateLimited) {
        failure.message = safeGenerationDetail(error.message)
        failure.uncertain = error.uncertain
      }
      current.failure = failure
      if (attempt) {
        attempt.outcome = 'failed'
        attempt.failure = structuredClone(failure)
        attempt.endedAt = new Date().toISOString()
      }
      if (current.input.provider === 'google' && rateLimited) {
        const until = await this.googleState(job.scope, resources, failure)
        this.armRetryWake(until - Date.now())
      }
      delete current.runnerId
      delete current.runnerPid
      if (failure.retryable && retryCount < maxRetries) {
        current.status = 'queued'
        current.retryCount = retryCount + 1
        const delay = Math.max(this.retryDelay(current.retryCount), failure.retryAfterMs ?? 0)
        current.nextRetryAt = new Date(Date.now() + delay).toISOString()
        current.error = `自动重试中（第 ${current.retryCount}/${maxRetries} 次）：${failure.message}`
        this.armRetryWake(delay)
        return
      }
      current.status = 'failed'
      current.error = failure.retryable ? `自动重试已用尽（${maxRetries} 次）：${failure.message}` : failure.message
    })
  }
  private async flushPendingWrites() {
    let failed = false
    for (const [id, write] of this.pendingWrites) {
      try {
        await write()
        if (this.pendingWrites.get(id) === write) this.pendingWrites.delete(id)
      } catch { failed = true }
    }
    return failed
  }
  private async wakeJson(repository: JsonGalleryRepository) {
    if (this.idleSnapshot && this.idleSnapshot.revision === repository.snapshotRevision() && Date.now() < this.idleSnapshot.nextWakeAt) return
    this.idleSnapshot = undefined
    let snapshot = repository.readOnlySnapshot()
    this.discoverScopes(snapshot.resources)
    if (this.workSaveRetries.size) {
      const pendingIds = new Set(snapshot.resources.generationTasks?.filter(job => job.status === 'completed' && job.workSavePending).map(job => job.id))
      for (const id of this.workSaveRetries.keys()) if (!pendingIds.has(id)) this.workSaveRetries.delete(id)
    }

    if (this.hasInterruptedTask(snapshot.resources)) {
      await this.recover(this.jsonScopes())
      snapshot = repository.readOnlySnapshot()
    }
    if (this.options.saveWork && snapshot.resources.generationTasks?.some(job => this.workSaveDue(job))) {
      await this.savePendingWorks(this.jsonScopes())
      snapshot = repository.readOnlySnapshot()
    }
    while (!this.disposed) {
      const jobs = snapshot.resources.generationTasks || []
      const cooldown = Date.parse(snapshot.resources.generationProviderStates?.google?.cooldownUntil || '') || 0
      const next = this.nextClaim(jobs, cooldown)
      if (!next) {
        // Running jobs must still be checked for a dead owner even if JSON didn't change.
        let nextWakeAt = Infinity
        for (const job of jobs) {
          if (job.status === 'queued' || job.status === 'running') return
          if (job.status === 'completed' && this.options.saveWork && job.workSavePending) {
            nextWakeAt = Math.min(nextWakeAt, this.workSaveRetries.get(job.id)?.nextAt ?? 0)
          }
        }
        this.idleSnapshot = { revision: snapshot.revision, nextWakeAt }
        return
      }
      const job = await this.claim(next.scope)
      if (!job) return
      this.runTask(job)
      snapshot = repository.readOnlySnapshot()
    }
  }
  private async wake() {
    if (this.disposed) return
    if (this.wakeFinished) { this.wakeRequested = true; return }
    let finish!: () => void
    this.wakeFinished = new Promise(resolve => { finish = resolve })
    try {
      const writeFailed = await this.flushPendingWrites()
      const repository = this.options.repository
      if (repository instanceof JsonGalleryRepository) await this.wakeJson(repository)
      else {
        await this.recover()
        await this.savePendingWorks()
        while (!this.disposed) {
          const job = await this.claim()
          if (!job) break
          this.runTask(job)
        }
      }
      this.lastError = writeFailed ? '部分任务结果暂未写入，将重试保存' : null
    } catch { this.lastError = '任务存储暂不可用，已暂停处理并保留现有任务' }
    finally {
      this.wakeFinished = undefined
      finish()
      if (this.wakeRequested) {
        this.wakeRequested = false
        this.schedule()
      }
    }
  }
  stop() {
    this.disposed = true
    this.stopping ??= this.drain()
    return this.stopping
  }
  private async drain() {
    clearInterval(this.timer)
    clearTimeout(this.retryWake)
    for (const { controller, timeout } of this.executing.values()) {
      clearTimeout(timeout)
      controller.abort()
    }
    this.executing.clear()
    try {
      await this.started
      await this.wakeFinished
      await this.flushPendingWrites()
      // Wait behind any already-admitted mutation before releasing task ownership.
      await this.options.coordinator.run(() => {})
    } finally {
      liveRunners.delete(this.runnerId)
    }
  }
}
