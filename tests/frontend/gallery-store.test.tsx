// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import type { GalleryImage } from '../../src/types'
const image = (id: string): GalleryImage => ({ id, filename: `${id}.png`, prompt: id, referenceImages: [], tags: [], favorited: false, assetType: 'recipe', createdAt: '2026-09-11', width: 1, height: 1 })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
it('shares one initial fetch and automatically displays imported items', async () => {
  const { GalleryStore } = await import('../../src/lib/gallery-store')
  let images = [image('one')]; let revision = 'a'
  const load = vi.fn(async () => [...images])
  const store = new GalleryStore({ load, state: async () => ({ revision: revision, count: 0, trashCount: 0 }) })
  const unsubscribeA = store.subscribe(() => {}); const unsubscribeB = store.subscribe(() => {})
  try {
    await waitFor(() => expect(store.getSnapshot().loading).toBe(false))
    expect(load).toHaveBeenCalledOnce()
    images = [image('two'), ...images]; revision = 'b'
    await store.checkForChanges()
    expect(store.getSnapshot().allImages.map(image => image.id)).toEqual(['two', 'one'])
    expect(store.getSnapshot().total).toBe(2)
    expect(store.getSnapshot().pendingImages).toBeNull()
    expect(store.getSnapshot().pendingCount).toBe(0)
  } finally { unsubscribeA(); unsubscribeB() }
})
it('automatically adds imports while keeping existing edits and deletions pending', async () => {
  const { GalleryStore } = await import('../../src/lib/gallery-store')
  let images = [image('one'), image('removed')]; let revision = 'a'
  const store = new GalleryStore({ load: async () => images, state: async () => ({ revision: revision, count: 0, trashCount: 0 }) })
  await store.reload()
  const existing = store.getSnapshot().allImages[0]
  images = [image('two'), { ...image('one'), prompt: 'edited elsewhere' }]; revision = 'b'
  await store.checkForChanges(true)
  expect(store.getSnapshot().allImages.map(image => image.id)).toEqual(['two', 'one', 'removed'])
  expect(store.getSnapshot().allImages[1]).toBe(existing)
  expect(store.getSnapshot().total).toBe(3)
  expect(store.getSnapshot().pendingCount).toBe(0)
  expect(store.getSnapshot().pendingImages).toEqual(images)
  images = [image('three'), ...images]; revision = 'c'
  await store.checkForChanges(true)
  expect(store.getSnapshot().allImages.map(image => image.id)).toEqual(['three', 'two', 'one', 'removed'])
  store.applyPending()
  expect(store.getSnapshot().allImages).toEqual(images)
})
it('loads imports on the foreground timer and on return from a hidden tab', async () => {
  const { GalleryStore } = await import('../../src/lib/gallery-store')
  vi.useFakeTimers()
  let images = [image('one')]; let revision = 'a'
  const load = vi.fn(async () => images)
  const store = new GalleryStore({ load, state: async () => ({ revision: revision, count: 0, trashCount: 0 }) })
  await store.reload()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const unsubscribe = store.subscribe(() => {})
  try {
    await vi.advanceTimersByTimeAsync(0)
    images = [image('two'), ...images]; revision = 'b'
    await vi.advanceTimersByTimeAsync(10_000)
    expect(store.getSnapshot().allImages).toEqual(images)
    visibility.mockReturnValue('hidden')
    images = [image('three'), ...images]; revision = 'c'
    await vi.advanceTimersByTimeAsync(10_000)
    expect(load).toHaveBeenCalledTimes(2)
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot().allImages).toEqual(images)
    expect(load).toHaveBeenCalledTimes(3)
  } finally { unsubscribe() }
})
it('keeps content on refresh errors and cannot replace a local edit with an older in-flight refresh', async () => {
  const { GalleryStore } = await import('../../src/lib/gallery-store')
  let revision = 'a'
  const load = vi.fn(async () => [image('one')])
  const store = new GalleryStore({ load, state: async () => ({ revision: revision, count: 0, trashCount: 0 }) })
  const unsubscribe = store.subscribe(() => {})
  try {
    await waitFor(() => expect(store.getSnapshot().loading).toBe(false))
    load.mockRejectedValueOnce(new Error('offline')); revision = 'b'
    await store.checkForChanges()
    expect(store.getSnapshot().allImages).toHaveLength(1)
    expect(store.getSnapshot().error).toContain('offline')
    let finish!: (images: GalleryImage[]) => void
    load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const refresh = store.checkForChanges(true)
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    store.replace({ ...image('one'), prompt: 'new local edit', version: 2 })
    finish([image('one')]); await refresh
    expect(store.getSnapshot().allImages[0].prompt).toBe('new local edit')
    expect(store.getSnapshot().pendingImages).toBeNull()
  } finally { unsubscribe() }
})
it('publishes the first page while later pages are pending without overwriting local edits', async () => {
 const { GalleryStore } = await import('../../src/lib/gallery-store')
 let finish!: (images: GalleryImage[]) => void
 const store = new GalleryStore({ state: async () => ({ revision: 'r1', count: 0, trashCount: 0 }), load: async progress=> {progress?.([image('a')]);return new Promise(resolve=>{finish=resolve})} })
 const loading=store.reload(); await new Promise(resolve=>setTimeout(resolve,0))
 expect(store.getSnapshot().allImages.map(i=>i.id)).toEqual(['a'])
 expect(store.getSnapshot().loading).toBe(false)
 store.replace({...image('a'),title:'local edit'})
 finish([image('a'),image('b')]);await loading
 expect(store.getSnapshot().allImages[0].title).toBe('local edit')
 expect(store.getSnapshot().allImages.map(i=>i.id)).toContain('b')
})

it('aborts a superseded page chain and publishes only the replacement load', async () => {
  const { GalleryStore } = await import('../../src/lib/gallery-store')
  const signals: Array<AbortSignal | undefined> = []
  const load: (progress?: unknown, signal?: AbortSignal) => Promise<GalleryImage[]> = async (_progress, signal) => {
    signals.push(signal)
    if (signals.length > 1) return [image('new')]
    return new Promise(resolve => signal?.addEventListener('abort', () => resolve([image('old')]), { once: true }))
  }
  const store = new GalleryStore({ load, state: async () => ({ revision: 'a', count: 0, trashCount: 0 }) })
  const first = store.reload()
  await waitFor(() => expect(signals).toHaveLength(1))
  await store.reload()
  expect(signals[0]?.aborted).toBe(true)
  await first
  expect(store.getSnapshot().allImages).toEqual([image('new')])
})


it('gives a manual refresh priority over polling and background thumbnail refresh', async () => {
  const { GalleryStore } = await import('../../src/lib/gallery-store')
  let finish!: (images: GalleryImage[]) => void
  const load = vi.fn(async () => [image('one')])
  const store = new GalleryStore({ load, state: async () => ({ revision: 'revision', count: 0, trashCount: 0 }) })
  await store.reload()
  const unsubscribe = store.subscribe(() => {})
  try {
    await store.checkForChanges(true)
    load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const refresh = store.reload()
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    await store.checkForChanges(true)
    window.dispatchEvent(new Event('banana-thumbnail-version-changed'))
    const updated = { ...image('one'), prompt: 'manual refresh' }
    finish([updated])
    await refresh
    expect(store.getSnapshot().allImages).toEqual([updated])
    expect(store.getSnapshot().pendingImages).toBeNull()
    expect(load).toHaveBeenCalledTimes(2)
  } finally { unsubscribe() }
})

it('retains the thumbnail version for metadata-only updates', async () => {
  const { GalleryStore } = await import('../../src/lib/gallery-store')
  const store = new GalleryStore({ load: async () => [{ ...image('one'), thumbnailVersion: 'cached' }], state: async () => ({ revision: 'a', count: 0, trashCount: 0 }) })
  await store.reload()
  store.replace({ ...image('one'), prompt: 'new prompt' })
  expect(store.getSnapshot().allImages[0].thumbnailVersion).toBe('cached')
  store.replace({ ...image('one'), filename: 'replacement.png' })
  expect(store.getSnapshot().allImages[0].thumbnailVersion).toBeUndefined()
})

it('refreshes the server trash badge without replacing the active gallery', async () => {
  const { GalleryStore } = await import('../../src/lib/gallery-store')
  let trashCount = 2
  const load = vi.fn(async () => [image('one')])
  const store = new GalleryStore({ load, state: async () => ({ revision: 'a', count: 1, trashCount }) })
  await store.reload()
  expect(store.getSnapshot().trashCount).toBe(2)
  trashCount = 3
  await store.refreshTrashCount()
  expect(store.getSnapshot().trashCount).toBe(3)
  expect(load).toHaveBeenCalledOnce()
})
