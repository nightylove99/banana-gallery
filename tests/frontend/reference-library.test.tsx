// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest'
import {cleanup,render,screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {ReferenceLibraryModal} from '../../src/components/ReferenceLibraryModal'
const library={assets:['a','b'].map(id=>({id,name:`素材 ${id}`,tags:[],favorited:false,currentVersionId:`${id}1`,versions:[{id:`${id}1`,filename:`${id}.png`,sha256:id,createdAt:'2026-09-11'}],version:0,createdAt:'2026-09-11',updatedAt:'2026-09-11'})),combinations:[]}
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
it('selects references in explicit order, retains purpose notes, and distinguishes append from replace',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json(library)))
 const use=vi.fn(()=>false),close=vi.fn(),user=userEvent.setup()
 render(<ReferenceLibraryModal images={[]} onClose={close} onUse={use}/>)
 await user.click(await screen.findByAltText('选择素材 素材 b'));await user.click(screen.getByAltText('选择素材 素材 a'))
 await user.type(screen.getByLabelText('参考图 1 用途'),'角色');await user.type(screen.getByLabelText('参考图 2 用途'),'风格')
 await user.click(screen.getByRole('button',{name:'追加到参考图'}))
 expect(use).toHaveBeenLastCalledWith([{filename:'b.png',note:'角色'},{filename:'a.png',note:'风格'}],'append');expect(close).not.toHaveBeenCalled()
 await user.click(screen.getByRole('button',{name:'上移参考图 2'}));await user.click(screen.getByRole('button',{name:'替换当前参考图'}))
 expect(use).toHaveBeenLastCalledWith([{filename:'a.png',note:'风格'},{filename:'b.png',note:'角色'}],'replace')
})

it('shows loading, retryable failure and empty as distinct states', async () => {
 let finish!: (response: Response) => void
 const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
   .mockResolvedValueOnce(Response.json({ assets: [], combinations: [] }))
 vi.stubGlobal('fetch', fetch)
 render(<ReferenceLibraryModal images={[]} onClose={() => {}} />)
 expect(screen.getByText('正在加载素材…')).toBeTruthy()
 expect(screen.queryByText('素材库为空')).toBeNull()
 finish(new Response('<html>bad gateway</html>', { status: 502 }))
 const retry = await screen.findByRole('button', { name: '重试', exact: true })
 expect(screen.queryByText('素材库为空')).toBeNull()
 await userEvent.setup().click(retry)
 expect(await screen.findByText('素材库为空')).toBeTruthy()
})
