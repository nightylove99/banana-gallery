// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {readPendingQueries,reconcileQueries,resumeResultQuery} from '../../src/lib/generation-query'
import type {GenerationTask} from '../../src/types'
const job={id:'original',status:'failed',manualResumeVersion:2} as GenerationTask
beforeEach(()=>window.localStorage.clear())
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()})
it('查询回执丢失和重新点击使用原key及版本，不创建新的生成提交',async()=>{
 const fetch=vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(Response.json({...job,status:'queued',manualResumeVersion:3}));vi.stubGlobal('fetch',fetch)
 await expect(resumeResultQuery('A',job)).rejects.toThrow('网络连接失败')
 const pending=readPendingQueries('A').original
 await resumeResultQuery('A',job)
 expect(fetch.mock.calls.map(c=>c[0])).toEqual(['/api/generation-tasks/original/resume-query','/api/generation-tasks/original/resume-query'])
 expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({key:pending.key,expectedVersion:2})
 expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[0][1].body);expect(readPendingQueries('A')).toEqual({})
})
it('重开后可用服务端确认的key核对，未接受的请求和其它workspace不被清除',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new TypeError('lost')))
 await expect(resumeResultQuery('A',job)).rejects.toThrow();const key=readPendingQueries('A').original.key
 expect(readPendingQueries('B')).toEqual({})
 expect(reconcileQueries('A',[job])).toEqual(['original'])
 expect(reconcileQueries('A',[{...job,manualResumeKey:key,manualResumeVersion:3}])).toEqual([])
})
it('明确拒绝后清除旧请求，500保留原请求以便核对',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(Response.json({error:'busy'},{status:500})).mockResolvedValueOnce(Response.json({error:'changed'},{status:409}));vi.stubGlobal('fetch',fetch)
 await expect(resumeResultQuery('A',job)).rejects.toThrow('busy');expect(readPendingQueries('A').original).toBeTruthy()
 await expect(resumeResultQuery('A',job)).rejects.toThrow('changed');expect(readPendingQueries('A')).toEqual({})
})
it('无法持久化key时不发恢复请求，也不覆盖损坏记录',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch)
 const write=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('quota')})
 await expect(resumeResultQuery('A',job)).rejects.toThrow('quota');expect(fetch).not.toHaveBeenCalled();write.mockRestore()
 window.localStorage.setItem('banana-pending-result-queries:v1:A','broken')
 await expect(resumeResultQuery('A',job)).rejects.toThrow();expect(window.localStorage.getItem('banana-pending-result-queries:v1:A')).toBe('broken')
})
