// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionProvider, useSession } from '../../src/auth/useSession'
import { fetchSession, logoutSession } from '../../src/api'
import { clearThumbnailSession, getThumbnailLoader } from '../../src/lib/thumbnail-loader'
vi.mock('../../src/api', () => ({ fetchSession: vi.fn(), logoutSession: vi.fn() }))
const session = { user: { id:'one',email:'one@example.test' },workspace:{ id:'workspace',name:'Test' } }
afterEach(async()=>{cleanup();await clearThumbnailSession(false);vi.resetAllMocks();vi.unstubAllGlobals()})
function Consumer(){const context=useSession();return <><span>{context.loading?'loading':context.session?.user.email||'signed-out'}</span><button onClick={()=>void context.signOut()}>logout</button><button onClick={()=>void context.refresh()}>refresh</button></>}
it('activates the scoped loader only after login verification and clears it on authentication expiry',async()=>{
 vi.mocked(fetchSession).mockResolvedValue({session,authMode:'cloudflare_access'})
 render(<SessionProvider><Consumer/></SessionProvider>)
 await screen.findByText(session.user.email)
 expect(getThumbnailLoader()).not.toBeNull()
 window.dispatchEvent(new Event('banana-session-expired'))
 await screen.findByText('signed-out')
 expect(getThumbnailLoader()).toBeNull()
})
it('clears owned caches at logout and leaves unrelated application caches untouched',async()=>{
 const names=new Set(['banana-thumbnails-v1-old','other-application']),remove=vi.fn(async(name:string)=>names.delete(name))
 vi.stubGlobal('caches',{keys:async()=>[...names],delete:remove})
 vi.mocked(fetchSession).mockResolvedValueOnce({session,authMode:'cloudflare_access'}).mockResolvedValue({session:null,authMode:'cloudflare_access'})
 vi.mocked(logoutSession).mockResolvedValue({})
 render(<SessionProvider><Consumer/></SessionProvider>);await screen.findByText(session.user.email)
 const name=getThumbnailLoader()!.cacheName;names.add(name)
 fireEvent.click(screen.getByText('logout'))
 await screen.findByText('signed-out')
 expect(names.has(name)).toBe(false);expect(names.has('other-application')).toBe(true)
})
it('responds to another tab logout without trusting a stale in-flight session response',async()=>{
 let complete!: (value:Awaited<ReturnType<typeof fetchSession>>)=>void
 vi.mocked(fetchSession).mockImplementation(()=>new Promise(resolve=>{complete=resolve}))
 render(<SessionProvider><Consumer/></SessionProvider>)
 await waitFor(()=>expect(complete).toBeTypeOf('function'))
 window.dispatchEvent(new StorageEvent('storage',{key:'banana-thumbnail-session-reset',newValue:'other-tab'}))
 complete({session,authMode:'cloudflare_access'})
 await screen.findByText('signed-out')
 expect(getThumbnailLoader()).toBeNull()
})

it('does not invalidate its own verified session when broadcasting a scope change',async()=>{
 const channels: Array<{onmessage:((event:{data:unknown})=>void)|null}> = []
 class Channel {
  onmessage:((event:{data:unknown})=>void)|null=null
  constructor(){channels.push(this)}
  postMessage(data:unknown){for(const channel of channels)if(channel!==this)channel.onmessage?.({data})}
  close(){const index=channels.indexOf(this);if(index>=0)channels.splice(index,1)}
 }
 vi.stubGlobal('BroadcastChannel',Channel)
 vi.mocked(fetchSession).mockResolvedValueOnce({session,authMode:'cloudflare_access'}).mockResolvedValue({session:{...session,user:{...session.user,email:'two@example.test'},workspace:{id:'two',name:'Second'}},authMode:'cloudflare_access'})
 render(<SessionProvider><Consumer/></SessionProvider>);await screen.findByText(session.user.email)
 fireEvent.click(screen.getByText('refresh'))
 await screen.findByText('two@example.test')
 expect(getThumbnailLoader()).not.toBeNull()
})

it('preserves the verified Access session and thumbnail cache if refreshing it fails', async () => {
 vi.mocked(fetchSession)
  .mockResolvedValueOnce({ session, authMode: 'cloudflare_access' })
  .mockRejectedValueOnce(new Error('服务暂时不可用'))
 render(<SessionProvider><Consumer/></SessionProvider>)
 await screen.findByText(session.user.email)
 const loader = getThumbnailLoader()
 fireEvent.click(screen.getByText('refresh'))
 await screen.findByText(session.user.email)
 expect(getThumbnailLoader()).toBe(loader)
})
