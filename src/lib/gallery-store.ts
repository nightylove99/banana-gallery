import { fetchGroups } from './organization'
import type { ResultGroup, GalleryImage, GalleryStateResponse } from '../types'
import { fetchGalleryPages, fetchGalleryState, type GalleryStats } from '../api'
interface GalleryState { trashCount?: number; groups: ResultGroup[]; groupsLoading: boolean; groupsError: string; allImages: GalleryImage[]; loading: boolean; error: string | null; pendingImages: GalleryImage[] | null; pendingCount: number; total: number; loadingMore: boolean; stats: GalleryStats | null }
interface GalleryLoader {
  load: typeof fetchGalleryPages
  state: (signal?: AbortSignal) => Promise<GalleryStateResponse | null>
}
export class GalleryStore {
  private state: GalleryState = { groups: [], groupsLoading: true, groupsError: '', allImages: [], loading: true, error: null, pendingImages: null, pendingCount: 0, total: 0, loadingMore: false, stats: null }
  private listeners = new Set<() => void>()
  private loader: GalleryLoader
  private revision: string | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private activeLoad?: AbortController
  private epoch = 0
  private mutations = new Map<string, { epoch: number; image: GalleryImage | null }>()
  private failures = 0
  private nextCheck = 0
  private groupRequest = 0
  private stateRequest = 0
  private queuedCountRefresh?: Promise<void>
  constructor(loader: GalleryLoader = { load: fetchGalleryPages, state: fetchGalleryState }) { this.loader = loader }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      void this.reloadGroups().catch(() => {})
      if (!this.activeLoad && (this.state.loading || this.state.loadingMore)) void this.reload().catch(() => {})
      else void this.checkForChanges(true)
      this.timer = setInterval(() => { void this.checkForChanges() }, 10_000)
      window.addEventListener('focus', this.onFocus)
      document.addEventListener('visibilitychange', this.onVisibility)
      window.addEventListener('banana-thumbnail-version-changed', this.onThumbnailVersion)
    }
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) {
        clearInterval(this.timer)
        this.activeLoad?.abort()
        this.activeLoad = undefined
        window.removeEventListener('focus', this.onFocus)
        document.removeEventListener('visibilitychange', this.onVisibility)
        window.removeEventListener('banana-thumbnail-version-changed', this.onThumbnailVersion)
      }
    }
  }
  private onFocus = () => { void this.checkForChanges(true); void this.reloadGroups().catch(() => {}) }
  private onThumbnailVersion = () => { if (!this.activeLoad && !this.state.loadingMore && !this.state.loading) void this.reload().catch(() => {}) }
  private onVisibility = () => { if (document.visibilityState !== 'hidden') this.onFocus() }
  private publish(updates: Partial<GalleryState>) {
    this.state = { ...this.state, ...updates }
    const currentIds = new Set(this.state.allImages.map(image => image.id))
    this.state.pendingCount = this.state.pendingImages?.filter(image => !currentIds.has(image.id)).length || 0
    for (const listener of this.listeners) listener()
  }
  reloadGroups = async () => {
    const request = ++this.groupRequest
    try {
      const groups = await fetchGroups()
      if (!Array.isArray(groups)) throw new Error('收藏夹响应无效')
      if (request === this.groupRequest) this.publish({ groups, groupsError: '', groupsLoading: false })
    } catch (error) {
      if (request === this.groupRequest) this.publish({ groupsError: '收藏夹暂时无法读取，请重试', groupsLoading: false })
      throw error
    }
  }
  setGroups = (update: ResultGroup[] | ((groups: ResultGroup[]) => ResultGroup[])) => {
    // A completed local edit takes precedence over an older collection read.
    this.groupRequest++
    this.publish({ groups: typeof update === 'function' ? update(this.state.groups) : update, groupsLoading: false, groupsError: '' })
  }
  private async readServerState(signal?: AbortSignal) {
    const request = ++this.stateRequest
    const state = await this.loader.state(signal)
    if (!signal?.aborted && request === this.stateRequest &&
        typeof state?.trashCount === 'number' && state.trashCount !== this.state.trashCount) {
      this.publish({ trashCount: state.trashCount })
    }
    return typeof state?.revision === 'string' ? state.revision : null
  }
  refreshTrashCount = () => {
    // Batch mutations can publish several deletes in the same turn.
    this.queuedCountRefresh ??= Promise.resolve().then(async () => {
      this.queuedCountRefresh = undefined
      await this.readServerState().catch(() => null)
    })
    return this.queuedCountRefresh
  }
  async reload() {
    this.activeLoad?.abort()
    const controller = new AbortController()
    this.activeLoad = controller
    const { signal } = controller
    const epoch = this.epoch
    const initialLoad = this.state.loading || this.state.loadingMore || this.state.allImages.length === 0
    try {
      // Revision before list avoids missing an import that arrives between these requests.
      const revision = await this.readServerState(signal).catch(() => null)
      if (signal.aborted) return
      const merge = (incoming: GalleryImage[]) => {
        const values = new Map(incoming.map(image => [image.id, image]))
        for (const [id, mutation] of this.mutations) if (mutation.epoch > epoch) { if (mutation.image) values.set(id, mutation.image); else values.delete(id) }
        return [...values.values()]
      }
      const images = await this.loader.load((partial, total, stats) => {
        if (!signal.aborted && initialLoad) this.publish({ allImages: merge(partial), stats: stats ?? null, total: total ?? partial.length, loading: false, loadingMore: true })
      }, signal)
      if (signal.aborted) return
      this.revision = revision; this.failures = 0; this.nextCheck = 0
      const allImages = merge(images)
      this.publish({ allImages, total: allImages.length, loadingMore: false, loading: false, error: null, pendingImages: null, pendingCount: 0 })
    } catch (error) {
      if (signal.aborted) return
      this.publish({ loading: false, loadingMore: false, error: error instanceof Error ? error.message : '无法读取图库' })
      throw error
    } finally {
      if (this.activeLoad === controller) this.activeLoad = undefined
    }
  }
  async checkForChanges(force = false) {
    if (this.activeLoad || this.state.loading || this.state.loadingMore || document.visibilityState === 'hidden' || (!force && Date.now() < this.nextCheck)) return
    const controller = new AbortController()
    this.activeLoad = controller
    const { signal } = controller
    const epoch = this.epoch
    try {
      const revision = await this.readServerState(signal)
      if (signal.aborted) return
      if (revision && revision === this.revision) { this.failures = 0; this.nextCheck = 0; if (this.state.error) this.publish({ error: null }); return }
      const incoming = await this.loader.load(undefined, signal)
      if (signal.aborted || epoch !== this.epoch) return
      this.revision = revision; this.failures = 0; this.nextCheck = 0
      if (JSON.stringify(incoming) === JSON.stringify(this.state.allImages)) this.publish({ error: null, pendingImages: null, pendingCount: 0 })
      else {
        const currentIds = new Set(this.state.allImages.map(image => image.id))
        const additions = incoming.filter(image => !currentIds.has(image.id))
        // Imports can appear immediately without replacing entries being edited or viewed.
        const allImages = additions.length ? [...additions, ...this.state.allImages] : this.state.allImages
        const incomingById = new Map(incoming.map(image => [image.id, image]))
        const hasExistingChanges = this.state.allImages.some(image => JSON.stringify(image) !== JSON.stringify(incomingById.get(image.id)))
        this.publish({ error: null, allImages, total: allImages.length, pendingImages: hasExistingChanges ? incoming : null, pendingCount: 0 })
      }
    } catch (error) {
      if (signal.aborted) return
      this.failures++; this.nextCheck = Date.now() + Math.min(60_000, 10_000 * 2 ** this.failures)
      this.publish({ error: error instanceof Error ? error.message : '刷新失败，仍显示之前的图库' })
    } finally {
      if (this.activeLoad === controller) this.activeLoad = undefined
    }
  }
  applyPending = () => {
    if (this.state.pendingImages) this.publish({ allImages: this.state.pendingImages, total: this.state.pendingImages.length, pendingImages: null, pendingCount: 0 })
  }
  replace = (image: GalleryImage) => {
    const previous = this.state.allImages.find(item => item.id === image.id)
    if (image.thumbnailVersion === undefined && previous?.filename === image.filename && previous.thumbnailVersion !== undefined) {
      image = { ...image, thumbnailVersion: previous.thumbnailVersion }
    }
    this.epoch++
    this.mutations.set(image.id, { epoch: this.epoch, image })
    this.publish({ allImages: this.state.allImages.map(item => item.id === image.id ? image : item), pendingImages: this.state.pendingImages?.map(item => item.id === image.id ? image : item) || null })
  }
  add = (image: GalleryImage) => {
    this.epoch++
    this.mutations.set(image.id, { epoch: this.epoch, image })
    this.publish({ allImages: [image, ...this.state.allImages.filter(item => item.id !== image.id)], pendingImages: this.state.pendingImages ? [image, ...this.state.pendingImages.filter(item => item.id !== image.id)] : null })
  }
  remove = (id: string) => {
    this.epoch++
    this.mutations.set(id, { epoch: this.epoch, image: null })
    this.publish({ allImages: this.state.allImages.filter(image => image.id !== id), pendingImages: this.state.pendingImages?.filter(image => image.id !== id) || null })
  }
}
