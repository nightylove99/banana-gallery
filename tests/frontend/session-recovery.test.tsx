// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest'
import {cleanup,fireEvent,render,screen} from '@testing-library/react'
import {SessionRecoveryPage} from '../../src/auth/SessionRecoveryPage'
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
it('Access 过期使用站内认证出口，普通连接错误仍重新加载',()=>{
 const assign=vi.fn(),reload=vi.fn()
 render(<SessionRecoveryPage cloudflareAccess />)
 vi.stubGlobal('window',{location:{assign,reload}})
 fireEvent.click(screen.getByRole('button',{name:'重新通过 Cloudflare 验证'}))
 expect(assign).toHaveBeenCalledWith('/cdn-cgi/access/logout');expect(reload).not.toHaveBeenCalled()
 cleanup();render(<SessionRecoveryPage cloudflareAccess={false} />)
 fireEvent.click(screen.getByRole('button',{name:'重新连接'}));expect(reload).toHaveBeenCalledOnce()
})
