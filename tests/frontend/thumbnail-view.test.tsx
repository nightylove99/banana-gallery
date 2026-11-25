// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { GalleryGrid, type GalleryGridHandle } from '../../src/components/GalleryGrid'
import { ImageCard } from '../../src/components/ImageCard'
import { activateThumbnailSession, clearThumbnailSession } from '../../src/lib/thumbnail-loader'
import type { GalleryImage } from '../../src/types'

const image=(id:string):GalleryImage=>({id,filename:`${id}.png`,thumbnailVersion:'v1',prompt:`fixture ${id}`,referenceImages:[],tags:[],favorited:false,assetType:'work',createdAt:'2026-10-12',width:100,height:150})
afterEach(async()=>{cleanup();await clearThumbnailSession(false);vi.unstubAllGlobals();vi.restoreAllMocks()})
async function login(){
 Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=>`blob:thumbnail-${Math.random()}`)})
 Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()})
 await activateThumbnailSession('local',{user:{id:'one',email:'one@local'},workspace:{id:'one',name:'Local'}})
}
it('loads gallery images through scoped blobs and reuses them after remount',async()=>{
 const fetcher=vi.fn(async()=>new Response('thumbnail',{headers:{'content-type':'image/webp'}}));vi.stubGlobal('fetch',fetcher)
 await login()
 const props={images:[image('one')],loading:false,emptyTitle:'empty',emptyDescription:'',onOpen:()=>{},onToggleFavorite:()=>{}}
 const view=render(<div><GalleryGrid {...props}/></div>)
 await waitFor(()=>expect(view.container.querySelector('img')?.src).toMatch(/^blob:/))
 expect(fetcher).toHaveBeenCalledTimes(1)
 view.unmount();const second=render(<div><GalleryGrid {...props}/></div>)
 await waitFor(()=>expect(second.container.querySelector('img')?.src).toMatch(/^blob:/))
 expect(fetcher).toHaveBeenCalledTimes(1)
})
it('shows previews after a fast jump and upgrades visible cards when scrolling settles',async()=>{
 const calls:string[]=[]
 vi.stubGlobal('fetch',async(url:string)=>{calls.push(url);return new Response('thumbnail',{headers:{'content-type':'image/webp'}})})
 await login()
 const ref=createRef<GalleryGridHandle>()
 const view=render(<div><GalleryGrid ref={ref} images={Array.from({length:5000},(_,i)=>image(String(i)))} loading={false} emptyTitle="empty" emptyDescription="" onOpen={()=>{}} onToggleFavorite={()=>{}}/></div>)
 await waitFor(()=>expect(view.container.querySelector('#asset-0 img')?.src).toMatch(/^blob:/))
 act(()=>{ref.current!.scrollToImage('2000')})
 await waitFor(()=>expect(calls.some(url=>url.includes('/2000.png?')&&url.includes('size=preview'))).toBe(true))
 await waitFor(()=>expect(calls.some(url=>url.includes('/2000.png?')&&url.includes('size=standard'))).toBe(true))
 expect(view.container.querySelectorAll('[data-asset-id]').length).toBeLessThanOrEqual(120)
})
it('shows a recoverable thumbnail failure without requesting the original',async()=>{
 const fetcher=vi.fn(async()=>new Response('busy',{status:503}));vi.stubGlobal('fetch',fetcher);await login()
 render(<div><GalleryGrid images={[image('one')]} loading={false} emptyTitle="empty" emptyDescription="" onOpen={()=>{}} onToggleFavorite={()=>{}}/></div>)
 await screen.findByRole('button',{name:'重试加载'})
 expect(fetcher.mock.calls[0][0]).toContain('size=standard')
})

it('keeps a visible preview in flight while upgrading, and never downgrades a standard image',async()=>{
 let finishPreview!:(response:Response)=>void,finishStandard!:(response:Response)=>void
 vi.stubGlobal('fetch',async(url:string)=>{
  if(url.includes('/2000.png?'))return new Promise<Response>(resolve=>{if(url.includes('size=preview'))finishPreview=resolve;else finishStandard=resolve})
  return new Response('thumbnail',{headers:{'content-type':'image/webp'}})
 })
 await login();const ref=createRef<GalleryGridHandle>()
 const view=render(<div><GalleryGrid ref={ref} images={Array.from({length:5000},(_,i)=>image(String(i)))} loading={false} emptyTitle="empty" emptyDescription="" onOpen={()=>{}} onToggleFavorite={()=>{}}/></div>)
 act(()=>ref.current!.scrollToImage('2000'))
 await waitFor(()=>expect(finishPreview).toBeTypeOf('function'))
 await waitFor(()=>expect(finishStandard).toBeTypeOf('function'))
 finishPreview(new Response('preview',{headers:{'content-type':'image/webp'}}))
 await waitFor(()=>expect(view.container.querySelector('#asset-2000 img')?.getAttribute('data-thumbnail-size')).toBe('preview'))
 finishStandard(new Response('standard',{headers:{'content-type':'image/webp'}}))
 await waitFor(()=>expect(view.container.querySelector('#asset-2000 img')?.getAttribute('data-thumbnail-size')).toBe('standard'))
})

it('keeps a preview visible and offers a retry when its clear-image upgrade fails',async()=>{
 vi.stubGlobal('fetch',async(url:string)=>url.includes('size=preview') ? new Response('preview',{headers:{'content-type':'image/webp'}}) : new Response('busy',{status:503}))
 await login();const props={image:image('one'),onOpen:()=>{},onToggleFavorite:()=>{}}
 const view=render(<ImageCard {...props} preview />)
 await waitFor(()=>expect(view.container.querySelector('img')?.src).toMatch(/^blob:/))
 view.rerender(<ImageCard {...props} preview={false}/>)
 await screen.findByRole('button',{name:'重试清晰图'})
 expect(view.container.querySelector('img')?.src).toMatch(/^blob:/)
})

it('ignores a failed old preview after a clear image has already succeeded',async()=>{
 let failPreview!:(response:Response)=>void
 vi.stubGlobal('fetch',async(url:string)=>{
  if(url.includes('size=preview'))return new Promise<Response>(resolve=>{failPreview=resolve})
  return new Response('standard',{headers:{'content-type':'image/webp'}})
 })
 await login()
 const props={image:image('late-preview'),onOpen:()=>{},onToggleFavorite:()=>{}}
 const view=render(<ImageCard {...props} preview/>)
 await waitFor(()=>expect(failPreview).toBeTypeOf('function'))
 view.rerender(<ImageCard {...props} preview={false}/>)
 await waitFor(()=>expect(view.container.querySelector('img')?.getAttribute('data-thumbnail-size')).toBe('standard'))
 await act(async()=>{failPreview(new Response('obsolete preview failed',{status:422}))})
 expect(screen.queryByRole('button',{name:'重试清晰图'})).toBeNull()
 expect(view.container.querySelector('img')?.getAttribute('data-thumbnail-size')).toBe('standard')
})
