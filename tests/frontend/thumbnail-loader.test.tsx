// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => vi.restoreAllMocks())
const image = { filename: 'one.png', version: 'v1', size: 'standard' as const, priority: 'foreground' as const }
function storage() {
  const names = new Map<string, Map<string, Response>>()
  const put = vi.fn()
  const keys = vi.fn()
  return {
    names, put, keys,
    api: {
      open: async (name: string) => {
        if (!names.has(name)) names.set(name, new Map())
        const entries = names.get(name)!
        return {
          match: async (key: string | Request) => entries.get(typeof key === 'string' ? key : key.url)?.clone(),
          put: async (key: string | Request, response: Response) => { put(); entries.set(typeof key === 'string' ? key : key.url, response.clone()) },
          delete: async (key: string | Request) => entries.delete(typeof key === 'string' ? key : key.url),
          keys: async () => { keys(); return [...entries.keys()].map(key => new Request(key)) },
        }
      },
      keys: async () => [...names.keys()],
      delete: async (name: string) => names.delete(name),
    } as unknown as CacheStorage,
  }
}
async function moduleUnderTest() {
  const module = await import('../../src/lib/thumbnail-loader').catch(() => null)
  expect(module, 'the isolated thumbnail loader must be available').not.toBeNull()
  return module!
}
const png = () => new Response(new Blob(['thumbnail'], { type: 'image/webp' }), { headers: { 'content-type': 'image/webp' } })

it('deduplicates loads, reuses memory and persists across loader instances', async () => {
  const { ThumbnailLoader } = await moduleUnderTest(), disk = storage(), fetcher = vi.fn(async () => png())
  const loader = new ThumbnailLoader('scope-a', { storage: disk.api, fetch: fetcher })
  const [a, b] = await Promise.all([loader.acquire(image), loader.acquire(image)])
  expect(a.url).toBe(b.url); expect(fetcher).toHaveBeenCalledTimes(1)
  a.release(); b.release(); await loader.flush()
  const refreshed = new ThumbnailLoader('scope-a', { storage: disk.api, fetch: fetcher })
  const reused = await refreshed.acquire(image); reused.release()
  expect(fetcher).toHaveBeenCalledTimes(1)
  const changed = await refreshed.acquire({ ...image, version: 'v2' }); changed.release()
  expect(fetcher).toHaveBeenCalledTimes(2)
  await loader.dispose(); await refreshed.dispose()
})

it('separates account caches and never persists errors or an authentication redirect', async () => {
  const { ThumbnailLoader } = await moduleUnderTest(), disk = storage(), fetcher = vi.fn(async () => png())
  const a = new ThumbnailLoader('a', { storage: disk.api, fetch: fetcher }), b = new ThumbnailLoader('b', { storage: disk.api, fetch: fetcher })
  const first = await a.acquire(image); first.release(); await a.flush()
  const second = await b.acquire(image); second.release(); await b.flush()
  expect(fetcher).toHaveBeenCalledTimes(2)
  const unauthorized = vi.fn(), failed = new ThumbnailLoader('failed', { storage: disk.api, fetch: async () => new Response('login', { status: 401 }), onUnauthorized: unauthorized })
  await expect(failed.acquire(image)).rejects.toThrow(); await failed.flush()
  expect(unauthorized).toHaveBeenCalledTimes(1)
  expect([...(disk.names.get(failed.cacheName)?.keys() || [])]).toHaveLength(0)
  await a.dispose(); await b.dispose(); await failed.dispose()
})

it('enforces background and total concurrency and promotes a newly visible queued image', async () => {
  const { ThumbnailLoader } = await moduleUnderTest()
  const releases: Array<() => void> = [], order: string[] = []
  const loader = new ThumbnailLoader('queue', { storage: null, fetch: async url => { order.push(String(url)); await new Promise<void>(resolve => releases.push(resolve)); return png() } })
  const background = Array.from({ length: 8 }, (_, i) => loader.acquire({ ...image, filename: `background-${i}.png`, priority: 'background' }))
  await vi.waitFor(() => expect(order).toHaveLength(2))
  const visible = loader.acquire({ ...image, filename: 'visible.png' })
  await vi.waitFor(() => expect(order).toHaveLength(3))
  expect(order[2]).toContain('visible.png')
  for (let i = 0; i < 9; i++) { await vi.waitFor(() => expect(releases[i]).toBeTypeOf('function')); releases[i]() }
  for (const lease of await Promise.all([...background, visible])) lease.release()
  await loader.dispose()
})

it('falls back to memory after storage failure and evicts expired or least recently used entries', async () => {
  const { ThumbnailLoader } = await moduleUnderTest(), disk = storage(), fetcher = vi.fn(async () => png())
  let now = 100
  const loader = new ThumbnailLoader('limits', { storage: disk.api, fetch: fetcher, now: () => now, maxEntries: 2, ttlMs: 100 })
  for (const filename of ['one.png', 'two.png', 'three.png']) { now++; const lease = await loader.acquire({ ...image, filename }); lease.release(); await loader.flush() }
  const keys = [...disk.names.get(loader.cacheName)!.keys()]
  expect(keys).toHaveLength(2); expect(keys.some(key => key.includes('one.png'))).toBe(false)
  now = 500
  const expired = await loader.acquire({ ...image, filename: 'three.png' }); expired.release(); await loader.flush()
  expect(fetcher).toHaveBeenCalledTimes(4)
  const denied = new ThumbnailLoader('denied', { storage: { open: async () => { throw new Error('quota') } } as unknown as CacheStorage, fetch: fetcher })
  const a = await denied.acquire(image); a.release(); const b = await denied.acquire(image); b.release()
  expect(fetcher).toHaveBeenCalledTimes(5)
  await loader.dispose(); await denied.dispose()
})

it('cancels obsolete work and cannot persist late bytes after logout', async () => {
  const { ThumbnailLoader } = await moduleUnderTest(), disk = storage()
  let finish!: () => void
  const loader = new ThumbnailLoader('logout', { storage: disk.api, fetch: async () => { await new Promise<void>(resolve => { finish = resolve }); return png() } })
  const controller = new AbortController()
  const pending = loader.acquire(image, controller.signal).catch(error => error)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  controller.abort(); await loader.dispose(true); finish()
  expect((await pending).name).toBe('AbortError')
  await loader.flush(); expect(disk.names.has(loader.cacheName)).toBe(false)
})

it('uses a cached standard image during fast scrolling rather than fetching a preview', async () => {
  const { ThumbnailLoader } = await moduleUnderTest(), fetcher = vi.fn(async () => png())
  const loader = new ThumbnailLoader('preview', { storage: null, fetch: fetcher })
  const standard = await loader.acquire(image); standard.release()
  const preview = await loader.acquire({ ...image, size: 'preview' }); preview.release()
  expect(preview.size).toBe('standard'); expect(fetcher).toHaveBeenCalledTimes(1)
  await loader.dispose()
})

it('shares one live object URL when preview and standard reads hit the same disk entry concurrently', async () => {
  const { ThumbnailLoader }=await moduleUnderTest(),disk=storage(),fetcher=vi.fn(async()=>png())
  const original=new ThumbnailLoader('race',{storage:disk.api,fetch:fetcher})
  const first=await original.acquire(image);first.release();await original.flush();await original.dispose()
  const loader=new ThumbnailLoader('race',{storage:disk.api,fetch:fetcher})
  const [standard,preview]=await Promise.all([loader.acquire(image),loader.acquire({...image,size:'preview'})])
  expect(standard.url).toBe(preview.url)
  expect(fetcher).toHaveBeenCalledTimes(1)
  standard.release();preview.release();await loader.dispose()
})

it('applies the entry limit to a shared cache across independent tab loaders',async()=>{
 const {ThumbnailLoader}=await moduleUnderTest(),disk=storage(),fetcher=vi.fn(async()=>png())
 const a=new ThumbnailLoader('shared',{storage:disk.api,fetch:fetcher,maxEntries:2}),b=new ThumbnailLoader('shared',{storage:disk.api,fetch:fetcher,maxEntries:2})
 for(const[loader,filename]of [[a,'one.png'],[b,'two.png'],[a,'three.png']] as const){const lease=await loader.acquire({...image,filename});lease.release();await loader.flush()}
 expect(disk.names.get(a.cacheName)?.size).toBe(2)
 await a.dispose();await b.dispose()
})


it('does not scan Cache Storage or rewrite WebP on repeated memory hits', async () => {
  const { ThumbnailLoader } = await moduleUnderTest(), disk = storage()
  const loader = new ThumbnailLoader('memory-hits', { storage: disk.api, fetch: async () => png() })
  try {
    (await loader.acquire(image)).release()
    await loader.flush()
    disk.put.mockClear()
    disk.keys.mockClear()
    for (let i = 0; i < 3; i++) (await loader.acquire(image)).release()
    await loader.flush()
    expect(disk.keys).not.toHaveBeenCalled()
    expect(disk.put).not.toHaveBeenCalled()
  } finally { await loader.dispose() }
})
