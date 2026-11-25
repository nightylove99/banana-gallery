// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest'
import {fetchGalleryPages} from '../../src/api'
afterEach(()=>vi.unstubAllGlobals())
it('restarts changed snapshots and deduplicates IDs across the replacement pages',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json({items:[{id:'old'}],total:2,nextCursor:'old-cursor'})).mockResolvedValueOnce(Response.json({error:'changed'},{status:409})).mockResolvedValueOnce(Response.json({items:[{id:'new'}],total:2,nextCursor:'new-cursor'})).mockResolvedValueOnce(Response.json({items:[{id:'new'},{id:'last'}],total:2,nextCursor:null}))
 vi.stubGlobal('fetch',fetcher)
 expect((await fetchGalleryPages()).map(i=>i.id)).toEqual(['new','last'])
 expect(fetcher).toHaveBeenCalledTimes(4)
})
it('stops repeated cursors and exposes an error instead of endlessly loading',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({items:[{id:'one'}],total:2,nextCursor:'same'})))
 await expect(fetchGalleryPages()).rejects.toThrow('游标重复')
})

it('passes cancellation down to the active page fetch and does not fetch more pages', async () => {
 const controller=new AbortController()
 const fetcher=vi.fn(async (_url:string, init?:RequestInit)=>{
  expect(init?.signal).toBe(controller.signal)
  if(fetcher.mock.calls.length===1)return Response.json({items:[{id:'one'}],total:3,nextCursor:'two'})
  controller.abort()
  init?.signal?.throwIfAborted()
  return Response.json({items:[{id:'two'}],total:3,nextCursor:'three'})
 })
 vi.stubGlobal('fetch',fetcher)
 await expect(fetchGalleryPages(undefined,controller.signal)).rejects.toMatchObject({name:'AbortError'})
 expect(fetcher).toHaveBeenCalledTimes(2)
})
