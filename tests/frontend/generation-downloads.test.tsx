// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { GenerationDownloads } from '../../src/lib/generation-downloads'
import type { GenerationTask } from '../../src/types'

const job=(id:string,status:GenerationTask['status']='completed',extra:Partial<GenerationTask>={})=>({id,status,result:status==='completed'?{filename:`${id}.png`}:undefined,...extra} as GenerationTask)
function setup(){const values=new Map<string,string>();const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)}};const download=vi.fn();const observer=(scope='workspace')=>new GenerationDownloads(scope,{storage:()=>storage,download});return{values,storage,download,observer}}

it('首次历史快照不下载旧完成记录，新出现的成功结果只触发一次',async()=>{
 const {observer,download}=setup();const d=observer();await d.observe([job('old')]);expect(download).not.toHaveBeenCalled()
 await d.observe([job('old'),job('new')]);await d.observe([job('old'),job('new')]);expect(download.mock.calls).toEqual([['new.png']])
})
it('打开页面时仍在排队的任务成功后下载，失败和取消不下载',async()=>{
 const {observer,download}=setup();const d=observer();await d.observe([job('pending','queued'),job('failure','running'),job('cancel','queued')]);await d.observe([job('pending'),job('failure','failed'),job('cancel','cancelled')]);expect(download.mock.calls).toEqual([['pending.png']])
})
it('快速提交成功即使早于首次历史读取仍会下载，其他旧结果不补下载',async()=>{
 const {observer,download}=setup();const d=observer();await d.watch('fast');await d.observe([job('old'),job('fast')]);expect(download.mock.calls).toEqual([['fast.png']])
})
it('等待中的任务刷新后成功会下载，已触发的结果重开后不重复',async()=>{
 const {observer,download}=setup();await observer().observe([job('resume','queued')]);await observer().observe([job('resume')]);await observer().observe([job('resume')]);expect(download.mock.calls).toEqual([['resume.png']])
})
it('账户与workspace隔离，回收站里的任务不自动下载',async()=>{
 const {observer,download}=setup();await observer('A').watch('same');await observer('B').observe([job('same')]);expect(download).not.toHaveBeenCalled();await observer('A').observe([job('same', 'completed',{deletedAt:'2026-11-04'})]);expect(download).not.toHaveBeenCalled()
})
it('共享锁让两个页面只触发一次，触发前已持久记录',async()=>{
 const {storage,download}=setup();let queue=Promise.resolve();const lock=(_name:string,work:()=>void)=>{const next=queue.then(work);queue=next;return next};
 const a=new GenerationDownloads('A',{storage:()=>storage,download,lock}),b=new GenerationDownloads('A',{storage:()=>storage,download,lock});await a.watch('once');await Promise.all([a.observe([job('once')]),b.observe([job('once')])]);expect(download).toHaveBeenCalledOnce();const state=JSON.parse(storage.getItem('banana-generation-downloads:v1:A')!);expect(state.triggered).toEqual(['once'])
})
it('下载动作抛错保留待下载状态，下次成功后不再重复',async()=>{
 const {observer,download}=setup();const d=observer();await d.watch('retry');download.mockImplementationOnce(()=>{throw new Error('dispatch failed')});await expect(d.observe([job('retry')])).rejects.toThrow('dispatch failed');await d.observe([job('retry')]);await d.observe([job('retry')]);expect(download).toHaveBeenCalledTimes(2)
})
it('无法写入去重记录时不触发下载，避免刷新重复下载',async()=>{
 const {observer,storage,download}=setup();const d=observer();await d.watch('safe');storage.setItem=()=>{throw new Error('quota')};await expect(d.observe([job('safe')])).rejects.toThrow('quota');expect(download).not.toHaveBeenCalled()
})
it('损坏的下载记录不静默覆盖，也不补下载历史',async()=>{
 const {observer,values,download}=setup();values.set('banana-generation-downloads:v1:workspace','{"pending":null}');await expect(observer().observe([job('old')])).rejects.toThrow();expect(download).not.toHaveBeenCalled();expect(values.get('banana-generation-downloads:v1:workspace')).toBe('{"pending":null}')
})

it('does not mark a download triggered before the browser dispatch succeeds', async () => {
 const {observer,storage,download}=setup()
 const downloads=observer()
 await downloads.watch('dispatch')
 download.mockImplementation(() => {
  expect(JSON.parse(storage.getItem('banana-generation-downloads:v1:workspace')!).triggered).toEqual([])
 })
 await downloads.observe([job('dispatch')])
 expect(JSON.parse(storage.getItem('banana-generation-downloads:v1:workspace')!).triggered).toEqual(['dispatch'])
})
