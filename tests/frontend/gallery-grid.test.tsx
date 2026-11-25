// @vitest-environment jsdom
import { act,cleanup,fireEvent,render,screen } from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {createRef} from 'react'
import {GalleryGrid,type GalleryGridHandle} from '../../src/components/GalleryGrid'
import type {GalleryImage} from '../../src/types'
afterEach(()=>{cleanup();vi.restoreAllMocks()})
function galleryImages(count:number):GalleryImage[]{
 return Array.from({length:count},(_,i)=>({id:String(i),filename:`${i}.png`,prompt:`fixture ${i}`,referenceImages:[],tags:[],favorited:false,assetType:'recipe',createdAt:'2026-09-11',width:100,height:100}))
}
it('bounds mounted cards in a 5000-entry gallery and can jump to an unmounted anchor',()=>{
 const images=galleryImages(5000)
 const ref=createRef<GalleryGridHandle>()
 const view=render(<div data-testid="scroll"><GalleryGrid ref={ref} collections={Array.from({length:7},(_,i)=>({group:{id:`group-${i}`,name:`收藏夹 ${i}`,imageIds:[],version:0,createdAt:'2026-09-12',updatedAt:'2026-09-12'},count:0,assetType:'recipe' as const}))} images={images} loading={false} emptyTitle="empty" emptyDescription="" onOpen={()=>{}} onToggleFavorite={()=>{}}/></div>)
 expect(view.container.querySelectorAll('[data-asset-id]').length).toBeLessThanOrEqual(120)
 expect(view.container.querySelector('img')?.src).toContain('thumbnail=true')
 act(()=>{ref.current!.scrollToImage('4900')})
 expect(view.container.querySelector('#asset-4900')).not.toBeNull()
 expect(view.container.querySelectorAll('[data-asset-id]').length).toBeLessThanOrEqual(120)
})

it('loads the visible viewport eagerly before the forward preparation window',()=>{
 const view=render(<div><GalleryGrid images={galleryImages(5000)} loading={false} emptyTitle="empty" emptyDescription="" onOpen={()=>{}} onToggleFavorite={()=>{}}/></div>)
 const visible=view.container.querySelector<HTMLImageElement>('#asset-0 img')!
 const prepared=view.container.querySelector<HTMLImageElement>('#asset-20 img')!
 expect(visible.getAttribute('loading')).toBe('eager')
 expect(visible.getAttribute('fetchpriority')).toBe('high')
 expect(prepared.getAttribute('loading')).toBe('eager')
 expect(prepared.getAttribute('fetchpriority')).toBe('low')
})

it('moves the larger preparation window above the viewport after reversing upward',()=>{
 const ref=createRef<GalleryGridHandle>()
 const view=render(<div><GalleryGrid ref={ref} images={galleryImages(5000)} loading={false} emptyTitle="empty" emptyDescription="" onOpen={()=>{}} onToggleFavorite={()=>{}}/></div>)
 act(()=>{ref.current!.scrollToImage('3200');ref.current!.scrollToImage('2400')})
 const mounted=Array.from(view.container.querySelectorAll<HTMLElement>('[data-asset-id]'),element=>Number(element.dataset.assetId))
 const behind=mounted.filter(id=>id<2400).length
 const ahead=mounted.filter(id=>id>2403).length
 expect(behind).toBeGreaterThan(ahead)
})

it('coalesces repeated scroll measurements into one animation frame',()=>{
 const frames:FrameRequestCallback[]=[]
 vi.spyOn(window,'requestAnimationFrame').mockImplementation(callback=>{frames.push(callback);return frames.length})
 vi.spyOn(window,'cancelAnimationFrame').mockImplementation(()=>{})
 const view=render(<div data-testid="scroll"><GalleryGrid images={galleryImages(5000)} loading={false} emptyTitle="empty" emptyDescription="" onOpen={()=>{}} onToggleFavorite={()=>{}}/></div>)
 const container=screen.getByTestId('scroll')
 container.scrollTop=10000;fireEvent.scroll(container)
 container.scrollTop=20000;fireEvent.scroll(container)
 expect(frames).toHaveLength(1)
 expect(view.container.querySelector('#asset-0')).not.toBeNull()
 act(()=>{frames[0](16)})
 expect(view.container.querySelector('#asset-0')).toBeNull()
})

it('does not replay the cold-load fade after a loaded thumbnail is remounted',()=>{
 const ref=createRef<GalleryGridHandle>()
 const view=render(<div><GalleryGrid ref={ref} images={galleryImages(5000)} loading={false} emptyTitle="empty" emptyDescription="" onOpen={()=>{}} onToggleFavorite={()=>{}}/></div>)
 fireEvent.load(view.container.querySelector<HTMLImageElement>('#asset-0 img')!)
 expect(view.container.querySelector('#asset-0 img')?.classList.contains('opacity-100')).toBe(true)
 act(()=>{ref.current!.scrollToImage('3000')})
 expect(view.container.querySelector('#asset-0')).toBeNull()
 act(()=>{ref.current!.scrollToImage('0')})
 expect(view.container.querySelector('#asset-0 img')?.classList.contains('opacity-100')).toBe(true)
})

it('keeps the first cold-load fade brief',()=>{
 const view=render(<div><GalleryGrid images={galleryImages(1)} loading={false} emptyTitle="empty" emptyDescription="" onOpen={()=>{}} onToggleFavorite={()=>{}}/></div>)
 const image=view.container.querySelector<HTMLImageElement>('#asset-0 img')!
 expect(image.classList.contains('duration-150')).toBe(true)
 expect(image.classList.contains('duration-500')).toBe(false)
})

it('temporarily expands the forward preparation window for a large jump without exceeding the card cap',()=>{
 const ref=createRef<GalleryGridHandle>()
 const view=render(<div><GalleryGrid ref={ref} images={galleryImages(5000)} loading={false} emptyTitle="empty" emptyDescription="" onOpen={()=>{}} onToggleFavorite={()=>{}}/></div>)
 act(()=>{ref.current!.scrollToImage('2000')})
 const mounted=view.container.querySelectorAll('[data-asset-id]').length
 expect(mounted).toBeGreaterThan(48)
 expect(mounted).toBeLessThanOrEqual(120)
})
