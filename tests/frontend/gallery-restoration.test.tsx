// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { SessionProvider } from '../../src/auth/useSession'
import { GalleryProvider } from '../../src/hooks/GalleryProvider'
import { RequireAuth } from '../../src/auth/RequireAuth'
import GalleryPage from '../../src/pages/GalleryPage'
import TrashPage from '../../src/pages/TrashPage'
import type { GalleryImage } from '../../src/types'
const prefix = 'banana-gallery-view:["positions","positions"]'
const query = 'view=all&assetType=recipe'
const images: GalleryImage[] = Array.from({length:240},(_,i)=>({id:String(i),filename:`${i}.png`,prompt:`image ${i}`,referenceImages:[],tags:[],favorited:false,assetType:'recipe',createdAt:new Date(Date.parse('2026-11-04')-i*1000).toISOString(),width:100,height:150}))
let nextPage: (()=>void) | undefined
let delayPages = false
const values = new Map<string,string>()
beforeEach(()=>{
  delayPages=false;nextPage=undefined;values.clear()
  vi.stubGlobal('localStorage',{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v)})
  vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
    const container=this.closest('[data-gallery-grid]')?.parentElement
    let top=0
    if(this.dataset.assetId || this.dataset.collectionId){
      const siblings=Array.from(this.parentElement!.children)
      top=parseFloat(this.parentElement!.style.top)+Math.floor(siblings.indexOf(this)/4)*358.5-(container?.scrollTop||0)
    }
    return {top,bottom:top+351,left:0,right:1000,width:1000,height:351,x:0,y:top,toJSON:()=>({})} as DOMRect
  })
  vi.stubGlobal('fetch',async(url:string)=>{
    if(url==='/api/session')return Response.json({user:{id:'positions',email:'test@local'},workspace:{id:'positions',name:'Test'}})
    if(url==='/api/trash')return Response.json([])
    if(url==='/api/gallery/state')return Response.json({revision:'r1',count:240,trashCount:0})
    if(url==='/api/groups')return Response.json([{id:'earth',name:'地球',imageIds:images.map(i=>i.id),version:0,createdAt:'2026-11-04',updatedAt:'2026-11-04'}])
    if(url.startsWith('/api/images?')){
      if(!delayPages)return Response.json(images)
      if(url.includes('cursor=')){await new Promise<void>(resolve=>{nextPage=resolve});return Response.json({items:images.slice(120),nextCursor:null,total:240})}
      return Response.json({items:images.slice(0,120),nextCursor:'next',total:240})
    }
    return Response.json({}, {status:404})
  })
})
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks()})
function Probe(){return <span data-testid="url">{useLocation().search}</span>}
function mount(search=query){return render(<MemoryRouter initialEntries={['/?'+search]}><SessionProvider><RequireAuth><GalleryProvider><GalleryPage/><Probe/></GalleryProvider></RequireAuth></SessionProvider></MemoryRouter>)}
it('waits for remaining pages before restoring an anchor near a partial page boundary',async()=>{
  delayPages=true
  values.set(prefix+':query',JSON.stringify(query))
  values.set(prefix+':anchor',JSON.stringify({id:'119',offset:0}))
  values.set(prefix+':position:'+query,JSON.stringify({id:'119',offset:0,index:119,kind:'image'}))
  const view=mount()
  await waitFor(()=>expect(nextPage).toBeTypeOf('function'))
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30))})
  const container=view.container.querySelector('[data-gallery-grid]')!.parentElement!
  expect(container.scrollTop).toBe(0)
  await act(async()=>{nextPage!()})
  await waitFor(()=>expect(container.scrollTop).toBe(20+29*358.5))
})
it('remembers a scroll immediately and restores independent positions after changing collections',async()=>{
  const view=mount('view=all&group=earth&assetType=recipe')
  await screen.findByRole('button',{name:'管理收藏夹'})
  await waitFor(()=>expect(view.container.querySelector('#asset-0')).toBeTruthy())
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30))})
  const c=view.container.querySelector('[data-gallery-grid]')!.parentElement!
  act(()=>{c.scrollTop=358.50;fireEvent.scroll(c)})
  const key=prefix+':position:view=all&group=earth&assetType=recipe'
  expect(JSON.parse(values.get(key)||'null')).toMatchObject({id:expect.any(String)})
  const saved=JSON.parse(values.get(key)!)
  await userEvent.setup().click(screen.getByRole('button',{name:/^全部配方\s*240$/}))
  await waitFor(()=>expect(c.scrollTop).toBe(0))
  await userEvent.setup().click(screen.getByRole('button',{name:/^地球\s*240$/}))
  await waitFor(()=>expect(c.scrollTop).toBe(20+Math.floor(Number(saved.id)/4)*358.5-saved.offset))
})

function Back() {
  const navigate = useNavigate()
  return <button onClick={() => navigate(-1)}>浏览器返回</button>
}

it.each(['sidebar', 'back'])('restores the filtered gallery and scroll anchor after returning from trash via %s', async method => {
  const search = 'view=all&group=earth&q=image&assetType=recipe'
  const view = render(<MemoryRouter initialEntries={['/?' + search]}>
    <SessionProvider><RequireAuth><GalleryProvider>
      <Routes><Route path="/" element={<GalleryPage />} /><Route path="/trash" element={<TrashPage />} /></Routes>
      <Probe /><Back />
    </GalleryProvider></RequireAuth></SessionProvider>
  </MemoryRouter>)
  const user = userEvent.setup()
  const trash = await screen.findByRole('button', { name: /^回收站\s*0$/ })
  await screen.findByRole('button', { name: '管理收藏夹' })
  await waitFor(() => expect(view.container.querySelector('#asset-0')).toBeTruthy())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  const getScroller = () => view.container.querySelector('[data-gallery-grid]')?.parentElement
  const scroller = getScroller()!
  act(() => { scroller.scrollTop = 358.5; fireEvent.scroll(scroller) })
  const saved = JSON.parse(values.get(prefix + ':position:' + search) || 'null')
  expect(saved).toMatchObject({ id: expect.any(String) })
  await user.click(trash)
  await screen.findByRole('heading', { name: '回收站' })
  await user.click(screen.getByRole('button', { name: method === 'sidebar' ? /^配方\s*240$/ : '浏览器返回' }))
  await screen.findByRole('button', { name: '管理收藏夹' })
  expect(screen.getByTestId('url').textContent).toBe('?' + search)
  await waitFor(() => expect(getScroller()?.scrollTop).toBe(20 + Math.floor(Number(saved.id) / 4) * 358.5 - saved.offset))
})
