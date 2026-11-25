import type { AppSession, UserAuthMode } from '../types'

export type ThumbnailSize = 'standard' | 'preview'
export interface ThumbnailRequest { filename: string; version: string; size: ThumbnailSize; priority: 'foreground' | 'background' }
export interface ThumbnailLease { url: string; size: ThumbnailSize; release: () => void }
interface Entry { key: string; url: string; blob: Blob; size: ThumbnailSize; created: number; used: number; refs: number; revoked: boolean }
interface Job { request: ThumbnailRequest; controller: AbortController; consumers: Set<symbol>; started: boolean; promise: Promise<Entry>; resolve: (entry: Entry) => void; reject: (error: unknown) => void }
interface Options {
  storage?: CacheStorage | null; fetch?: typeof fetch; now?: () => number
  maxEntries?: number; maxBytes?: number; ttlMs?: number; onUnauthorized?: () => void
}
const PREFIX = 'banana-thumbnails-v1-'
const DISK_BATCH_MS = 1_000
const WEEK = 7 * 24 * 60 * 60 * 1000
export const thumbnailSessionTabId = Math.random().toString(36).slice(2)
const abortError = () => new DOMException('Thumbnail request cancelled', 'AbortError')
const cacheWrites = new Map<string, Promise<void>>()

export function thumbnailUrl(request: ThumbnailRequest): string {
  return `/api/assets/images/${encodeURIComponent(request.filename)}?thumbnail=true&size=${request.size}&v=${encodeURIComponent(request.version)}`
}

/** Authenticated, bounded cache. Only this loader's owned caches are ever deleted. */
export class ThumbnailLoader {
  readonly cacheName: string
  private storage: CacheStorage | null
  private cache?: Promise<Cache | null>
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private readonly options: Options
  private readonly memory = new Map<string, Entry>()
  private readonly jobs = new Map<string, Job>()
  private readonly metadata = new Map<string, { bytes: number; created: number; used: number }>()
  private readonly pendingEntries = new Map<string, Entry>()
  private writeTimer: ReturnType<typeof setTimeout> | undefined
  private writes: Promise<void> = Promise.resolve()
  private active = 0
  private background = 0
  private stopped = false
  latencyMs = 200

  constructor(scope: string, options: Options = {}) {
    this.cacheName = PREFIX + scope
    this.options = options
    this.storage = options.storage === undefined ? (typeof caches === 'undefined' ? null : caches) : options.storage
    this.fetcher = options.fetch || ((...args) => fetch(...args))
    this.now = options.now || Date.now
  }

  private key(request: ThumbnailRequest): string {
    return new URL(thumbnailUrl(request), typeof location === 'undefined' ? 'http://localhost' : location.origin).href
  }
  private check(job?: Job) { if (this.stopped || job?.controller.signal.aborted) throw abortError() }
  private getCache(): Promise<Cache | null> {
    if (!this.cache) this.cache = this.storage ? this.storage.open(this.cacheName).catch(() => { this.storage = null; return null }) : Promise.resolve(null)
    return this.cache
  }
  private revoke(entry: Entry) {
    if (!entry.refs && !entry.revoked) { URL.revokeObjectURL(entry.url); entry.revoked = true }
  }
  private trimMemory() {
    const unused = [...this.memory.values()].filter(entry => !entry.refs).sort((a,b) => a.used-b.used)
    let bytes = [...this.memory.values()].reduce((sum,entry) => sum+entry.blob.size,0)
    for (const entry of unused) {
      if (this.memory.size <= 128 && bytes <= 16*1024*1024) break
      const saved = this.metadata.get(entry.key)
      if (saved) saved.used = Math.max(saved.used, entry.used)
      this.memory.delete(entry.key); bytes -= entry.blob.size; this.revoke(entry)
    }
  }
  private memoryEntry(key: string): Entry | undefined {
    const entry = this.memory.get(key)
    if (!entry) return
    if (this.now()-entry.created >= (this.options.ttlMs ?? WEEK)) {
      this.memory.delete(key); this.revoke(entry); return
    }
    entry.used = this.now()
    return entry
  }
  private async cached(request: ThumbnailRequest, job: Job): Promise<Entry | undefined> {
    const key = this.key(request), memory = this.memoryEntry(key)
    if (memory) return memory
    try {
      const cache = await this.getCache(); this.check(job)
      const response = await cache?.match(key); this.check(job)
      if (!response) return
      const created = Number(response.headers.get('x-banana-created'))
      if (!created || this.now()-created >= (this.options.ttlMs ?? WEEK) || response.headers.get('content-type') !== 'image/webp') {
        await cache?.delete(key); this.metadata.delete(key); return
      }
      const blob = await response.blob(); this.check(job)
      return this.entry(key, blob, request.size, created)
    } catch (error) {
      this.check(job)
      void error
      this.storage = null; this.cache = Promise.resolve(null)
      return
    }
  }
  private entry(key: string, blob: Blob, size: ThumbnailSize, created = this.now()): Entry {
    const live=this.memoryEntry(key)
    if(live)return live
    const previous = this.memory.get(key)
    if (previous) { this.memory.delete(key); this.revoke(previous) }
    const entry = { key, blob, size, created, used: this.now(), refs: 0, url: URL.createObjectURL(blob), revoked: false }
    this.memory.set(key, entry)
    return entry
  }
  private persist(entry: Entry) {
    if (!this.storage || this.stopped) return
    this.pendingEntries.set(entry.key, entry)
    this.writeTimer ??= setTimeout(() => this.writeBatch(), DISK_BATCH_MS)
  }

  private writeBatch() {
    clearTimeout(this.writeTimer)
    this.writeTimer = undefined
    if (!this.pendingEntries.size) return
    const entries = [...this.pendingEntries.values()]
    this.pendingEntries.clear()
    const write = async () => {
      if (this.stopped) return
      const cache = await this.getCache()
      if (!cache || this.stopped) return
      const keys = await cache.keys()
      const present = new Set(keys.map(key => key.url))
      for (const key of this.metadata.keys()) {
        if (!present.has(key)) this.metadata.delete(key)
      }
      const unknown = keys.filter(key => !this.metadata.has(key.url))
      for (let start = 0; start < unknown.length; start += 32) {
        await Promise.all(unknown.slice(start, start + 32).map(async key => {
          const response = await cache.match(key)
          if (response) this.metadata.set(key.url, {
            bytes: Number(response.headers.get('x-banana-bytes')) || 0,
            created: Number(response.headers.get('x-banana-created')) || 0,
            used: Number(response.headers.get('x-banana-used')) || 0,
          })
        }))
      }
      if (this.stopped) return
      const maxBytes = this.options.maxBytes ?? 128 * 1024 * 1024
      const maxEntries = this.options.maxEntries ?? 2000
      for (const entry of entries) {
        this.metadata.set(entry.key, { bytes: entry.blob.size, created: entry.created, used: entry.used })
      }
      let bytes = [...this.metadata.values()].reduce((sum, item) => sum + item.bytes, 0)
      const ttl = this.options.ttlMs ?? WEEK
      const now = this.now()
      const candidates = [...this.metadata].map(([key, item]) => ({
        key, ...item,
        used: Math.max(item.used, this.memory.get(key)?.used ?? 0),
        expired: now - item.created >= ttl,
      })).sort((a, b) => Number(b.expired) - Number(a.expired) || a.used - b.used)
      for (const item of candidates) {
        if (!item.expired && this.metadata.size <= maxEntries && bytes <= maxBytes) break
        if (present.has(item.key)) await cache.delete(item.key)
        this.metadata.delete(item.key)
        bytes -= item.bytes
      }
      for (const entry of entries) {
        if (this.stopped) return
        if (!this.metadata.has(entry.key)) continue
        await cache.put(entry.key, new Response(entry.blob, { headers: {
          'content-type': 'image/webp', 'x-banana-created': String(entry.created), 'x-banana-used': String(entry.used), 'x-banana-bytes': String(entry.blob.size),
        } }))
      }
    }
    const previous=cacheWrites.get(this.cacheName)||Promise.resolve()
    this.writes = previous.then(async()=>{
      if(typeof navigator!=='undefined' && navigator.locks)await navigator.locks.request(this.cacheName,write)
      else await write()
    }).catch(() => { this.storage = null; this.cache = Promise.resolve(null) })
    cacheWrites.set(this.cacheName,this.writes)
    const pending=this.writes
    void pending.then(()=>{if(cacheWrites.get(this.cacheName)===pending)cacheWrites.delete(this.cacheName)})
  }

  async acquire(request: ThumbnailRequest, signal?: AbortSignal): Promise<ThumbnailLease> {
    this.check()
    if (signal?.aborted) throw abortError()
    const key = this.key(request)
    let job = this.jobs.get(key)
    if (job?.controller.signal.aborted) { this.jobs.delete(key); job = undefined }
    if (!job) {
      let resolve!: (entry: Entry) => void, reject!: (error: unknown) => void
      const promise = new Promise<Entry>((onResolve,onReject) => { resolve=onResolve; reject=onReject })
      job = { request: { ...request }, controller: new AbortController(), consumers: new Set(), started: false, promise, resolve, reject }
      this.jobs.set(key,job)
    } else if (request.priority === 'foreground') job.request.priority = 'foreground'
    const consumer = Symbol(); job.consumers.add(consumer)
    let rejectAbort!: (error: unknown) => void
    const aborted = new Promise<never>((_resolve,reject) => { rejectAbort=reject })
    const cancel = () => { rejectAbort(abortError()); job!.consumers.delete(consumer); if (!job!.consumers.size) {
      job!.controller.abort()
      if (!job!.started) { this.jobs.delete(key); job!.reject(abortError()) }
    } }
    signal?.addEventListener('abort',cancel,{ once:true })
    this.pump()
    try {
      const entry = await Promise.race([job.promise,aborted]); this.check()
      if (signal?.aborted) throw abortError()
      entry.refs++; entry.used=this.now()
      let released=false
      return { url:entry.url, size:entry.size, release:()=>{
        if (released) return
        released=true; entry.refs--
        if (this.memory.get(entry.key)!==entry) this.revoke(entry)
        this.trimMemory()
      } }
    } finally { signal?.removeEventListener('abort',cancel); job.consumers.delete(consumer) }
  }

  private pump() {
    if (this.stopped) return
    while (this.active<6) {
      const waiting = [...this.jobs.values()].filter(job => !job.started && !job.controller.signal.aborted)
      const job = waiting.find(job=>job.request.priority==='foreground') || (this.background<2 ? waiting[0] : undefined)
      if (!job) break
      job.started=true; this.active++
      const background=job.request.priority==='background'; if(background)this.background++
      void this.load(job).then(job.resolve,job.reject).finally(()=>{
        if(this.jobs.get(this.key(job.request))===job)this.jobs.delete(this.key(job.request))
        this.active--; if(background)this.background--; this.pump()
      })
    }
  }
  private async load(job: Job): Promise<Entry> {
    if(job.request.size==='preview') {
      const standard=await this.cached({ ...job.request,size:'standard' },job)
      if(standard)return standard
    }
    const cached=await this.cached(job.request,job)
    if(cached)return cached
    this.check(job)
    const start=performance.now()
    const response=await this.fetcher(thumbnailUrl(job.request),{ signal:job.controller.signal, credentials:'same-origin', cache:'no-store' })
    this.check(job)
    if (response.status === 401 || (response.redirected &&
      /(?:\.cloudflareaccess\.com\/|\/cdn-cgi\/access(?:\/|$))/i.test(response.url) &&
      ![502, 503, 504].includes(response.status))) this.options.onUnauthorized?.()
    if(response.status===409 && typeof window!=='undefined')window.dispatchEvent(new Event('banana-thumbnail-version-changed'))
    if(!response.ok || response.headers.get('content-type')?.split(';')[0]!=='image/webp')throw new Error(response.status===409 ? '图片版本已变化，请刷新图库' : `缩略图加载失败 (${response.status})`)
    const blob=await response.blob(); this.check(job)
    this.latencyMs=this.latencyMs*0.8+(performance.now()-start)*0.2
    const entry=this.entry(this.key(job.request),blob,job.request.size)
    this.persist(entry)
    return entry
  }
  async flush(): Promise<void> {
    this.writeBatch()
    await this.writes
  }
  async dispose(clearDisk=false): Promise<void> {
    this.stopped=true
    clearTimeout(this.writeTimer)
    this.writeTimer = undefined
    this.pendingEntries.clear()
    for(const job of this.jobs.values()) { job.controller.abort(); job.reject(abortError()) }
    this.jobs.clear()
    for(const entry of this.memory.values())this.revoke(entry)
    this.memory.clear()
    await this.flush()
    if(clearDisk)await this.storage?.delete(this.cacheName).catch(()=>false)
  }
}

let current: ThumbnailLoader | null = null
let currentScope: string | null = null
let scopeEpoch = 0
let cleanup: Promise<void> = Promise.resolve()
export function getThumbnailLoader(): ThumbnailLoader | null { return current }
export function notifySessionExpired() { if(typeof window!=='undefined')window.dispatchEvent(new Event('banana-session-expired')) }
export async function clearThumbnailSession(broadcast=true): Promise<void> {
  scopeEpoch++
  const previous=current; current=null; currentScope=null
  const disposing=previous?.dispose(true)
  cleanup=cleanup.then(async()=>{
    await disposing
    if(typeof caches!=='undefined')try{for(const name of await caches.keys())if(name.startsWith(PREFIX))await caches.delete(name)}catch{ /* Browser storage can be unavailable. */ }
  })
  if(broadcast && typeof window!=='undefined') {
    try { const channel=new BroadcastChannel('banana-thumbnail-session'); channel.postMessage({ type:'clear',source:thumbnailSessionTabId }); channel.close() }catch{ /* Storage events cover browsers without BroadcastChannel. */ }
    try { localStorage.setItem('banana-thumbnail-session-reset',String(Date.now())+Math.random()); localStorage.removeItem('banana-thumbnail-session-reset') }catch{ /* The current tab is already cleared. */ }
  }
  await cleanup
}
export async function activateThumbnailSession(mode: UserAuthMode, session: AppSession): Promise<void> {
  const scope=JSON.stringify([mode,session.user.id,session.user.email.trim().toLowerCase(),session.workspace.id])
  if(current && currentScope===scope)return
  if(current)await clearThumbnailSession()
  const epoch=scopeEpoch
  await cleanup
  const bytes=new TextEncoder().encode(scope)
  const digest=globalThis.crypto?.subtle ? await crypto.subtle.digest('SHA-256',bytes) : null
  const name=digest ? [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('') : encodeURIComponent(scope)
  if(epoch!==scopeEpoch)return
  if(typeof caches!=='undefined')try{for(const existing of await caches.keys())if(existing.startsWith(PREFIX) && existing!==PREFIX+name)await caches.delete(existing)}catch{ /* Memory-only mode remains available. */ }
  if(epoch!==scopeEpoch)return
  currentScope=scope; current=new ThumbnailLoader(name,{ onUnauthorized:notifySessionExpired })
}
