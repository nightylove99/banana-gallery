// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest'
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {toast} from 'sonner'
import {GenerationHistory} from '../../src/components/GenerationHistory'
import type {GenerationTask} from '../../src/types'

afterEach(()=>{cleanup();sessionStorage.clear();vi.restoreAllMocks();vi.unstubAllGlobals()})
const uncertain:GenerationTask={id:'blocked',key:'blocked',scope:{workspaceId:'test',ownerUserId:'test',userId:'test'},input:{prompt:'旧请求',provider:'google',model:'gemini-3.1-flash-image',referenceFilenames:[]},status:'uncertain',createdAt:'2026-10-01T06:13:21Z',updatedAt:'2026-10-01T06:13:21Z',error:'上游 502'}
const retrying:GenerationTask={id:'retrying',key:'retrying',scope:{workspaceId:'test',ownerUserId:'test',userId:'test'},input:{prompt:'限流任务',provider:'google',model:'gemini-3.1-flash-image',referenceFilenames:[]},status:'queued',createdAt:'2026-10-01T06:14:00Z',updatedAt:'2026-10-01T06:14:00Z',error:'自动重试中（第 1/3 次）：rate limited',retryCount:1,nextRetryAt:new Date(Date.now()+30_000).toISOString()}
const completed:GenerationTask={id:'done',key:'done',scope:{workspaceId:'test',ownerUserId:'test',userId:'test'},input:{prompt:'已经出图',provider:'google',model:'gemini-3.1-flash-image',referenceFilenames:[]},status:'completed',createdAt:'2026-10-01T06:15:00Z',updatedAt:'2026-10-01T06:15:00Z',result:{filename:'done.png',prompt:'已经出图',width:1024,height:1024,provider:'google',model:'gemini-3.1-flash-image',aspectRatio:'1:1'}}
function setup(initial:GenerationTask[],handlers:{works?:React.ReactNode;hasWork?:(job:GenerationTask)=>boolean;onPreviewReference?:(filename:string,label:string)=>void;onResult?:(job:GenerationTask)=>void;onPreview?:(job:GenerationTask)=>void;onSaveRecipe?:(job:GenerationTask)=>Promise<void>;onRetryGeneration?:(job:GenerationTask)=>Promise<void>;onResumeResult?:(job:GenerationTask)=>Promise<void>;onRetrySave?:(job:GenerationTask)=>Promise<void>}={},expand=true){
 const tasks=structuredClone(initial)
 let bulkOperation:string,bulkTargets:GenerationTask[]=[]
 const fetch=vi.fn(async(url:string,init?:RequestInit)=>{
  if(url.endsWith('/bulk/preview')){
   const {operation,tab,search}=JSON.parse(String(init?.body))
   const matches=tasks.filter(job=>
    (tab==='trash'?!!job.deletedAt:!job.deletedAt&&(tab==='all'||job.status===tab||tab==='failed'&&job.status==='uncertain'))
     &&job.input.prompt.toLowerCase().includes(search.toLowerCase()))
   bulkTargets=matches.filter(job=>operation==='purge-failed'?job.status==='failed':job.status==='failed'||job.status==='completed')
   bulkOperation=operation
   return Response.json({token:'preview-token',operation,tab,search,matchedCount:matches.length,
    eligibleCount:bulkTargets.length,skippedCount:matches.length-bulkTargets.length,retryPurgeCount:bulkTargets.filter(job=>job.purgePending).length})
  }
  if(url.endsWith('/bulk/commit')){
   for(const job of bulkTargets){
    if(bulkOperation==='purge-failed')tasks.splice(tasks.indexOf(job),1)
    else job.deletedAt='2026-10-12'
   }
   return Response.json({[bulkOperation==='purge-failed'?'deleted':'moved']:bulkTargets.length,skipped:0})
  }
  if(init?.method==='POST'){
   const job=tasks.find(job=>url.includes(`/${job.id}/`))!
   job.acknowledgedAt='2026-10-04T00:00:00Z'
   if(url.endsWith('/trash'))job.deletedAt='2026-10-04T00:00:00Z'
   if(url.endsWith('/cancel'))job.status='cancelled'
   return Response.json(job)
  }
  return Response.json({tasks,error:null,canPurge:true})
 })
 vi.stubGlobal('fetch',fetch)
 render(<GenerationHistory works={handlers.works} hasWork={handlers.hasWork} onPreviewReference={handlers.onPreviewReference} revision={0} onResult={handlers.onResult??(()=>{})} onPreview={handlers.onPreview??(()=>{})} onDraft={()=>{}} onContinue={async()=>{}} onSaveRecipe={handlers.onSaveRecipe??(async()=>{})} onRetryGeneration={handlers.onRetryGeneration??(async()=>{})} onResumeResult={handlers.onResumeResult??(async()=>{})} onRetrySave={handlers.onRetrySave??(async()=>{})}/>)
 if(expand) fireEvent.click(screen.getByRole('button',{name:'展开生成历史'}))
 return {fetch,tasks,user:userEvent.setup()}
}
it.each([
 [0,'0 秒'],[999,'0 秒'],[59_999,'59 秒'],[60_000,'1 分 0 秒'],
 [83_900,'1 分 23 秒'],[3_599_999,'59 分 59 秒'],[3_600_000,'1 小时 0 分 0 秒'],[3_723_000,'1 小时 2 分 3 秒'],
])('完成记录显示成功请求发送至完成的固定请求用时：%i 毫秒',async(milliseconds,label)=>{
 const start=Date.parse(completed.createdAt)+8*60_000
 setup([{...completed,startedAt:completed.createdAt,requestStartedAt:new Date(start).toISOString(),retryCount:2,completedAt:new Date(start+milliseconds).toISOString()}])
 expect(await screen.findByText(new RegExp(`已完成 · 请求用时 ${label}`))).toBeTruthy()
})
it.each([
 {completedAt:undefined}, {completedAt:'invalid'}, {requestStartedAt:undefined}, {requestStartedAt:'invalid'},
 {requestStartedAt:''}, {completedAt:'2026-10-01T06:14:59Z'},
])('完成记录的时间缺失、非法或倒序时显示用时未知：%j',async(times)=>{
 setup([{...completed,requestStartedAt:completed.createdAt,completedAt:'2026-10-01T06:16:23Z',...times}])
 expect(await screen.findByText(/已完成 · 用时未知/)).toBeTruthy()
 expect(screen.queryByText(/总用时/)).toBeNull()
})
it('只统计成功的那次请求，排除之前失败请求、退避和排队',async()=>{
 setup([{...completed,requestStartedAt:'2026-10-01T06:23:00Z',completedAt:'2026-10-01T06:24:23Z',retryCount:1,attemptCount:2,attempts:[
  {sequence:1,startedAt:completed.createdAt,requestStartedAt:'2026-10-01T06:15:10Z',endedAt:'2026-10-01T06:16:00Z',sent:true,outcome:'failed'},
  {sequence:2,startedAt:'2026-10-01T06:22:58Z',requestStartedAt:'2026-10-01T06:23:00Z',endedAt:'2026-10-01T06:24:23Z',sent:true,outcome:'completed'},
 ]}])
 expect(await screen.findByText(/已完成 · 请求用时 1 分 23 秒/)).toBeTruthy()
 expect(screen.queryByText(/总用时/)).toBeNull()
})
it('恢复查询原任务时沿用原请求时间，不从本次查询开始计算',async()=>{
 setup([{...completed,upstreamTaskId:'original',requestStartedAt:'2026-10-01T06:23:00Z',completedAt:'2026-10-01T06:24:23Z',attemptCount:2,attempts:[
  {sequence:1,startedAt:'2026-10-01T06:23:00Z',requestStartedAt:'2026-10-01T06:23:00Z',sent:true,outcome:'failed'},
  {sequence:2,startedAt:'2026-10-01T06:24:20Z',sent:false,outcome:'completed'},
 ]}])
 expect(await screen.findByText(/已完成 · 请求用时 1 分 23 秒/)).toBeTruthy()
})
it('优先使用明确成功尝试的发送时间，不依赖任务级时间',async()=>{
 setup([{...completed,requestStartedAt:'invalid',completedAt:'2026-10-01T06:24:23Z',attemptCount:2,attempts:[
  {sequence:2,startedAt:'2026-10-01T06:22:58Z',requestStartedAt:'2026-10-01T06:23:00Z',sent:true,outcome:'completed'},
 ]}])
 expect(await screen.findByText(/已完成 · 请求用时 1 分 23 秒/)).toBeTruthy()
})
it.each([
 {sequence:1,startedAt:completed.createdAt,sent:true,outcome:'failed' as const},
 {sequence:1,startedAt:completed.createdAt,sent:true,outcome:'completed' as const},
 {sequence:1,startedAt:completed.createdAt,requestStartedAt:'invalid',sent:true,outcome:'completed' as const},
 {sequence:1,startedAt:completed.createdAt,sent:false,outcome:'completed' as const},
])('无法可靠对应成功请求时不猜测其他时间：%j',async(attempt)=>{
 setup([{...completed,requestStartedAt:completed.createdAt,completedAt:'2026-10-01T06:16:23Z',attemptCount:1,attempts:[attempt]}])
 expect(await screen.findByText(/已完成 · 用时未知/)).toBeTruthy()
})
it('旧记录只有可靠任务发送时间也能显示，创建和更新时间不参与计算',async()=>{
 setup([{...completed,createdAt:'invalid',updatedAt:'invalid',requestStartedAt:'2026-10-01T06:23:00Z',completedAt:'2026-10-01T06:24:23Z'}])
 expect(await screen.findByText(/已完成 · 请求用时 1 分 23 秒/)).toBeTruthy()
})
it('完成用时不随时间增长，刷新、回收站与重新打开页面后保持一致',async()=>{
 const clock=vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-11-01T12:00:00Z'))
 const job={...completed,requestStartedAt:completed.createdAt,completedAt:'2026-10-01T06:16:23Z'}
 const {user,fetch}=setup([job,{...job,id:'trashed',key:'trashed',deletedAt:'2026-10-02T00:00:00Z'}])
 await screen.findByText(/已完成 · 请求用时 1 分 23 秒/)
 clock.mockReturnValue(Date.parse('2026-11-01T14:00:00Z'))
 await user.click(screen.getByRole('button',{name:'刷新'}))
 await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2))
 expect(screen.getByText(/已完成 · 请求用时 1 分 23 秒/)).toBeTruthy()
 await user.click(screen.getByRole('button',{name:'历史回收站'}))
 expect(screen.getByText(/已完成 · 请求用时 1 分 23 秒/)).toBeTruthy()
 cleanup()
 setup([job])
 expect(await screen.findByText(/已完成 · 请求用时 1 分 23 秒/)).toBeTruthy()
})
it('点击条目左侧缩略图只打开大图预览，不替换顶部结果也不需要滚动',async()=>{
 const onResult=vi.fn(),onPreview=vi.fn()
 const {user}=setup([completed],{onResult,onPreview})
 await user.click(await screen.findByRole('button',{name:'查看大图'}))
 expect(onPreview).toHaveBeenCalledOnce()
 expect(onPreview.mock.calls[0][0].id).toBe('done')
 expect(onResult).not.toHaveBeenCalled()
})
it('历史操作按指定顺序显示，删除查看结果和下载，保存成功后防重复',async()=>{
 const onSaveRecipe=vi.fn(async(job:GenerationTask)=>{void job})
 const {user}=setup([completed],{onSaveRecipe})
 const card=(await screen.findAllByRole('article'))[0]
 expect(within(card).getAllByRole('button').filter(b=>b.textContent&&!b.hasAttribute('aria-expanded')).map(b=>b.textContent)).toEqual(['继续修改','存为配方','复制提示词','另开草稿','移入历史回收站'])
 expect(within(card).queryByRole('link',{name:'下载'})).toBeNull()
 await user.click(within(card).getByRole('button',{name:'存为配方'}))
 await waitFor(()=>expect(within(card).getByRole('button',{name:'已存为配方'})).toHaveProperty('disabled',true))
 expect(onSaveRecipe).toHaveBeenCalledOnce()
 expect(onSaveRecipe.mock.calls[0]?.[0]).toEqual(completed)
})
it('复制提示词写入提交时的完整原文，成功后短暂显示已复制且不请求后端',async()=>{
 const prompt='第一段\n\n  保留缩进\n最后一行'
 const {user,fetch}=setup([{...completed,input:{...completed.input,prompt}}])
 const card=await screen.findByRole('article')
 await user.click(within(card).getByRole('button',{name:'复制提示词'}))
 expect(await navigator.clipboard.readText()).toBe(prompt)
 expect(within(card).getByRole('button',{name:'已复制'})).toBeTruthy()
 expect(fetch.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0)
})
it('剪贴板失败时提示错误，不显示已复制',async()=>{
 const {user}=setup([completed])
 vi.spyOn(navigator.clipboard,'writeText').mockRejectedValue(new Error('denied'))
 const error=vi.spyOn(toast,'error')
 const card=await screen.findByRole('article')
 await user.click(within(card).getByRole('button',{name:'复制提示词'}))
 await waitFor(()=>expect(error).toHaveBeenCalledOnce())
 expect(within(card).queryByRole('button',{name:'已复制'})).toBeNull()
})
it('提示词就地全文展开、保留换行、再点收起',async()=>{
 const prompt='第一段\n第二段\n第三段'
 const {user}=setup([{...completed,input:{...completed.input,prompt}}])
 const button=await screen.findByRole('button',{name:'展开完整提示词'})
 expect(button.getAttribute('aria-expanded')).toBe('false')
 await user.click(button)
 expect(button.getAttribute('aria-expanded')).toBe('true')
 expect(button.textContent).toContain(prompt)
 await user.click(screen.getByRole('button',{name:'收起完整提示词'}))
 expect(button.getAttribute('aria-expanded')).toBe('false')
})
it('拖选提示词片段后保留选区和折叠状态',async()=>{
 setup([{...completed,input:{...completed.input,prompt:'可复制的提示词片段'}}])
 const toggle=await screen.findByRole('button',{name:'展开完整提示词'})
 const prompt=screen.getByText('可复制的提示词片段')
 const selection=window.getSelection()!
 const range=document.createRange()
 range.setStart(prompt.firstChild!,0)
 range.setEnd(prompt.firstChild!,4)
 selection.removeAllRanges()
 selection.addRange(range)
 try {
  act(()=>{prompt.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}))})
  expect(selection.toString()).toBe('可复制的')
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
 } finally {
  selection.removeAllRanges()
 }
})
it('历史和回收站最多预览三行，不给短提示词强制留白，仍可展开和收起',async()=>{
 const {user}=setup([completed,{...completed,id:'trashed',key:'trashed',deletedAt:'2026-11-06'}])
 for(const recycle of [false,true]){
  if(recycle)await user.click(screen.getByRole('button',{name:'历史回收站'}))
  const card=await screen.findByRole('article')
  const button=within(card).getByRole('button',{name:'展开完整提示词'})
  const preview=button.firstElementChild as HTMLElement
  expect(preview.style.webkitLineClamp).toBe('3')
  expect(preview.style.minHeight).toBe('')
  await user.click(button)
  expect(button.getAttribute('aria-expanded')).toBe('true')
  expect(preview.style.minHeight).toBe('')
  expect(preview.textContent).toBe(completed.input.prompt)
  await user.click(button)
  expect(preview.style.webkitLineClamp).toBe('3')
  expect(preview.style.minHeight).toBe('')
 }
})
it('uncertain 以失败显示任务和尝试，不再要求核对',async()=>{
 const attempt={sequence:1,startedAt:uncertain.createdAt,sent:true,outcome:'uncertain' as const}
 const {user}=setup([{...uncertain,attempts:[attempt]}])
 const card=await screen.findByRole('article')
 expect(within(card).getByText('失败')).toBeTruthy()
 expect(within(card).getByText('上游 502 · 请求结果未确认，未自动重试')).toBeTruthy()
 await user.click(within(card).getByText('尝试记录 · 1 次'))
 expect(within(card).getByText('第 1 次 · 已发送 · 失败')).toBeTruthy()
 expect(screen.queryByRole('region',{name:'结果待确认'})).toBeNull()
 expect(screen.queryByRole('button',{name:/已核对|已了解/})).toBeNull()
})
it('错误与尝试入口可同时展开收起，保留完整诊断和操作',async()=>{
 const failure={category:'network' as const,message:'连接失败',detail:'服务返回的完整说明',retryable:true,uncertain:false}
 const {user}=setup([{...completed,status:'failed',failure,attemptCount:1,attempts:[{sequence:1,startedAt:completed.createdAt,sent:true,outcome:'failed',failure}]}])
 const card=await screen.findByRole('article')
 for(const label of ['错误详情','尝试记录 · 1 次']){
  const summary=within(card).getByText(label)
  const details=summary.closest('details')!
  expect(details.open).toBe(false)
  await user.click(summary)
  expect(details.open).toBe(true)
  expect(details.textContent).toContain('服务返回的完整说明')
  await user.click(summary)
  expect(details.open).toBe(false)
 }
 expect(within(card).getByRole('button',{name:'另开草稿'})).toBeTruthy()
})
it('一次正常成功隐藏尝试记录，一次失败保留诊断',async()=>{
 const attempt={sequence:1,startedAt:completed.createdAt,sent:true,outcome:'completed' as const}
 setup([{...completed,attemptCount:1,attempts:[attempt]}, {...completed,id:'failed-once',input:{...completed.input,prompt:'只失败一次'},status:'failed',attemptCount:1,attempts:[{...attempt,outcome:'failed',failure:{category:'network',message:'网络错误',retryable:true,uncertain:false}}]}])
 const cards=await screen.findAllByRole('article')
 expect(within(cards[1]).queryByText(/尝试记录/)).toBeNull()
 expect(within(cards[0]).getByText(/尝试记录/)).toBeTruthy()
})
it('配方保存失败仍可重试，不把失败当作已保存',async()=>{
 const onSaveRecipe=vi.fn().mockRejectedValueOnce(new Error('写入失败')).mockResolvedValueOnce(undefined)
 const {user}=setup([completed],{onSaveRecipe})
 const button=await screen.findByRole('button',{name:'存为配方'})
 await user.click(button)
 await waitFor(()=>expect(button).toHaveProperty('disabled',false))
 expect(screen.queryByRole('button',{name:'已存为配方'})).toBeNull()
 await user.click(button)
 await screen.findByRole('button',{name:'已存为配方'})
 expect(onSaveRecipe).toHaveBeenCalledTimes(2)
})
it('回收站中的旧 uncertain 记录不会在生成页提示',async()=>{
 const {user}=setup([{...uncertain,deletedAt:'2026-10-02T00:00:00Z'}],{works:<div>作品网格</div>},false)
 await user.click(screen.getByRole('button',{name:'任务记录'}))
 await user.click(await screen.findByRole('tab',{name:'历史回收站 · 1'}))
 expect(within(await screen.findByRole('dialog')).getByText('旧请求')).toBeTruthy()
 await user.click(screen.getByRole('button',{name:'关闭任务记录'}))
 expect(screen.queryByRole('status')).toBeNull()
 expect(screen.queryByRole('region',{name:'结果待确认'})).toBeNull()
})
it.each([completed, {...uncertain,acknowledgedAt:'2026-10-04'}])('单条历史直接回收并可恢复：$status',async(job)=>{
 const {fetch,user}=setup([job])
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
 await user.click(await screen.findByRole('button',{name:'移入历史回收站'}))
 expect(confirm).not.toHaveBeenCalled()
 await waitFor(()=>expect(screen.queryByRole('article')).toBeNull())
 expect(fetch).toHaveBeenCalledWith(`/api/generation-tasks/${job.id}/trash`,expect.objectContaining({body:JSON.stringify({confirm:true})}))
 await user.click(screen.getByRole('button',{name:'历史回收站',exact:true}))
 expect(await screen.findByRole('button',{name:'恢复'})).toBeTruthy()
})
it('重试只在原条目出现一次，没有顶部蓝框',async()=>{
 setup([retrying])
 await screen.findByRole('article')
 expect(screen.queryByRole('region',{name:'自动重试中'})).toBeNull()
 expect(screen.getAllByText('限流任务')).toHaveLength(1)
 expect(screen.getByText(/等待重试/)).toBeTruthy()
})
it('在任务抽屉外展示最新失败，可重画、查看详情和按任务关闭',async()=>{
 const onRetryGeneration=vi.fn<(job:GenerationTask)=>Promise<void>>(async()=>{})
 const latest:GenerationTask={...uncertain,id:'latest',key:'latest',createdAt:completed.createdAt,error:undefined,
  failure:{category:'network',message:'响应中断',retryable:false,uncertain:true}}
 const {tasks,user}=setup([latest,uncertain],{works:<div>作品网格</div>,onRetryGeneration},false)
 const notice=await screen.findByRole('status')
 const summary='Google · Nano Banana 2 · 响应中断 · 请求结果未确认，未自动重试'
 expect(within(notice).getByTitle(summary)).toBeTruthy()
 await user.click(within(notice).getByRole('button',{name:'重新生成'}))
 expect(onRetryGeneration).toHaveBeenCalledWith(latest)
 await user.click(within(notice).getByRole('button',{name:'查看详情'}))
 const drawer=await screen.findByRole('dialog')
 expect(within(drawer).getByRole('tab',{name:'失败 · 2',selected:true})).toBeTruthy()
 await user.click(within(drawer).getByRole('button',{name:'关闭任务记录'}))
 await user.click(within(notice).getByRole('button',{name:'关闭失败提示'}))
 expect(screen.queryByRole('status')).toBeNull()
 expect(screen.getByRole('button',{name:'失败 2'})).toBeTruthy()

 tasks.push({...latest,id:'new-failure',createdAt:'2026-10-01T08:00:00Z',failure:undefined})
 fireEvent.focus(window)
 expect((await screen.findByRole('status')).textContent).toContain('请求超时或中断，未自动重试')

 cleanup()
 setup([latest,uncertain],{works:<div>作品网格</div>},false)
 await screen.findByRole('button',{name:'失败 2'})
 expect(screen.queryByRole('status')).toBeNull()
})

it.each([
 ['running','failed','上游 502'],
 ['running','uncertain','上游 502 · 请求结果未确认，未自动重试'],
 ['queued','failed','上游 502'],
] as const)('%s 转成 %s 时仅提醒一次，首次历史失败不弹出',async(from,to,reason)=>{
 const notify=vi.spyOn(toast,'error').mockImplementation(()=>1)
 const running={...uncertain,id:'active',key:'active',status:from}
 const {tasks,user}=setup([uncertain,running],{works:<div>作品网格</div>},false)
 await screen.findByRole('button',{name:'失败 1'})
 expect(notify).not.toHaveBeenCalled()

 tasks[1].status=to
 await act(async()=>{fireEvent.focus(window)})
 expect(notify).toHaveBeenCalledExactlyOnceWith(`Google · Nano Banana 2 生成失败：${reason}`,{
  action:{label:'查看',onClick:expect.any(Function)},
 })
 await user.click(screen.getByRole('button',{name:'刷新'}))
 await act(async()=>{fireEvent.focus(window)})
 expect(notify).toHaveBeenCalledOnce()
 const view=notify.mock.calls[0][1]!.action as {onClick:()=>void}
 act(()=>view.onClick())
 expect(within(await screen.findByRole('dialog')).getByRole('tab',{name:'失败 · 2',selected:true})).toBeTruthy()
})

it('两次轮询间创建并失败的任务也会提醒，迟到的旧记录不会提醒',async()=>{
 const notify=vi.spyOn(toast,'error').mockImplementation(()=>1)
 const {tasks}=setup([uncertain],{works:<div>作品网格</div>},false)
 await screen.findByRole('button',{name:'失败 1'})

 tasks.push({...uncertain,id:'old-import',status:'failed'})
 tasks.push({...uncertain,id:'fast-failure',status:'failed',error:'新任务失败',createdAt:new Date().toISOString()})
 await act(async()=>{fireEvent.focus(window)})
 expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('新任务失败'),expect.objectContaining({action:expect.anything()}))
})

const failed: GenerationTask = {...uncertain,status:'failed'}
const previewPath='/api/generation-tasks/bulk/preview'
const commitPath='/api/generation-tasks/bulk/commit'

it('失败标签批量回收先预览，取消默认获得焦点，提交只发送确认令牌', async () => {
 const {fetch,user}=setup([failed,completed],{works:<div/>},false)
 await user.click(await screen.findByRole('button',{name:'失败 1'}))
 const bulk=await screen.findByRole('button',{name:'移入历史回收站：失败任务 1 条'})
 await user.click(bulk)
 const confirmation=within(await screen.findByRole('dialog',{name:'确认移入历史回收站'}))
 expect(confirmation.getByText(/「失败」标签.*1 条/)).toBeTruthy()
 expect(confirmation.getByText(/图库里的作品和配方不删除/)).toBeTruthy()
 expect(document.activeElement).toBe(confirmation.getByRole('button',{name:'取消'}))
 expect(fetch).toHaveBeenCalledWith(previewPath,expect.objectContaining({body:JSON.stringify({operation:'trash',tab:'failed',search:''})}))
 await user.keyboard('{Enter}')
 await waitFor(()=>expect(screen.queryByRole('dialog',{name:'确认移入历史回收站'})).toBeNull())
 expect(fetch.mock.calls.some(([url])=>url===commitPath)).toBe(false)
 expect(screen.getByText('旧请求')).toBeTruthy()
 await user.click(bulk)
 await user.click(within(await screen.findByRole('dialog',{name:'确认移入历史回收站'})).getByRole('button',{name:'移入历史回收站（1 条）'}))
 expect(fetch).toHaveBeenCalledWith(commitPath,expect.objectContaining({body:JSON.stringify({token:'preview-token',confirm:true})}))
 await screen.findByText('没有任务记录')
})

it.each([
 ['trash','全部 · 2','移入历史回收站：匹配的已结束任务 1 条','确认移入历史回收站','移入历史回收站（1 条）'],
 ['purge-failed','历史回收站 · 2','永久删除匹配的失败记录 1 条','确认永久删除','永久删除（1 条）'],
] as const)('搜索限制批量 %s 的作用域，无匹配时没有批量按钮', async (operation,tabLabel,buttonLabel,title,confirmLabel) => {
 const deletedAt=operation==='purge-failed'?'2026-10-12':undefined
 const {fetch,user,tasks}=setup([
  {...failed,deletedAt,purgePending:!!deletedAt}, {...completed,deletedAt},
 ],{works:<div/>},false)
 await user.click(await screen.findByRole('button',{name:'任务记录'}))
 const drawer=within(await screen.findByRole('dialog',{name:'任务记录'}))
 await user.click(drawer.getByRole('tab',{name:tabLabel}))
 const search=drawer.getByRole('searchbox')
 await user.type(search,'没有匹配')
 expect(drawer.queryByRole('button',{name:/移入历史回收站：|永久删除.*失败记录/})).toBeNull()
 await user.clear(search)
 await user.type(search,'  旧请求  ')
 await user.click(drawer.getByRole('button',{name:buttonLabel}))
 const confirmation=within(await screen.findByRole('dialog',{name:title}))
 expect(confirmation.getByText(/搜索词「旧请求」/)).toBeTruthy()
 if(deletedAt){
  expect(confirmation.getByText(/1 条为重试清理/)).toBeTruthy()
  expect(confirmation.getByText(/共享文件保留。此操作不可撤销/)).toBeTruthy()
 }
 expect(fetch).toHaveBeenCalledWith(previewPath,expect.objectContaining({body:JSON.stringify({
  operation,tab:deletedAt?'trash':'all',search:'旧请求',
 })}))
 await user.click(confirmation.getByRole('button',{name:confirmLabel}))
 await waitFor(()=>expect(screen.queryByRole('dialog',{name:title})).toBeNull())
 expect(fetch).toHaveBeenCalledWith(commitPath,expect.objectContaining({body:JSON.stringify({token:'preview-token',confirm:true})}))
 expect(tasks.find(job=>job.id===completed.id)?.deletedAt).toBe(deletedAt)
})

it.each([
 [409, {error:'任务状态已变化'}, '任务状态已变化，请刷新后重新确认'],
 [500, {error:'清理中断',deleted:1,skipped:0,remaining:1}, '已删除 1 条失败记录，尚有 1 条未清理。请刷新后重新确认。'],
] as const)('批量提交返回 %i 时关闭对话框、提示并刷新', async (status,body,message) => {
 const deletedAt='2026-10-12'
 const {fetch,user}=setup([{...failed,deletedAt},{...failed,id:'second',deletedAt}])
 const toastError=vi.spyOn(toast,'error')
 await user.click(await screen.findByRole('button',{name:'历史回收站'}))
 await user.click(await screen.findByRole('button',{name:'永久删除失败记录 2 条'}))
 const confirm=await screen.findByRole('button',{name:'永久删除（2 条）'})
 fetch.mockResolvedValueOnce(Response.json(body,{status}))
 await user.click(confirm)
 await waitFor(()=>expect(screen.queryByRole('dialog',{name:'确认永久删除'})).toBeNull())
 expect(toastError).toHaveBeenCalledWith(message)
 expect(fetch.mock.calls.filter(([url])=>url==='/api/generation-tasks?limit=60')).toHaveLength(2)
})

it('服务端预览没有合格任务时不打开确认弹窗并刷新', async () => {
 const {fetch,user}=setup([failed])
 const toastInfo=vi.spyOn(toast,'info')
 const bulk=await screen.findByRole('button',{name:'移入历史回收站：已结束任务 1 条'})
 fetch.mockResolvedValueOnce(Response.json({
  token:null,operation:'trash',tab:'all',search:'',matchedCount:1,eligibleCount:0,skippedCount:1,retryPurgeCount:0,
 }))
 await user.click(bulk)
 await waitFor(()=>expect(toastInfo).toHaveBeenCalledWith('当前没有可移入的记录'))
 expect(screen.queryByRole('dialog')).toBeNull()
 expect(fetch.mock.calls.filter(([url])=>url==='/api/generation-tasks?limit=60')).toHaveLength(2)
})

it('超时失败任务可直接回收与批量回收，清理中的任务不能恢复', async () => {
 const {user}=setup([uncertain,{...failed,id:'purging',deletedAt:'2026-10-12',purgePending:true}])
 const card=await screen.findByRole('article')
 expect(within(card).getByRole('button',{name:'移入历史回收站'})).toBeTruthy()
 expect(screen.getByRole('button',{name:'移入历史回收站：已结束任务 1 条'})).toBeTruthy()
 await user.click(screen.getByRole('button',{name:'历史回收站'}))
 const trashed=await screen.findByRole('article')
 expect(within(trashed).queryByRole('button',{name:'恢复'})).toBeNull()
 expect(within(trashed).getByRole('button',{name:'永久清理此历史'})).toBeTruthy()
})

it('独立模式仅展开时提供批量操作，按当前列表无搜索地预览', async () => {
 const {fetch,user}=setup([failed,{...failed,id:'deleted',deletedAt:'2026-10-12'}],{},false)
 await waitFor(()=>expect(screen.getByRole('button',{name:'展开生成历史'}).textContent).toContain('1'))
 expect(screen.queryByRole('button',{name:/移入历史回收站：|永久删除.*失败记录/})).toBeNull()
 await user.click(screen.getByRole('button',{name:'展开生成历史'}))
 await user.click(screen.getByRole('button',{name:'移入历史回收站：已结束任务 1 条'}))
 expect(fetch).toHaveBeenCalledWith(previewPath,expect.objectContaining({body:JSON.stringify({operation:'trash',tab:'all',search:''})}))
 await user.click(await screen.findByRole('button',{name:'取消'}))
 await user.click(screen.getByRole('button',{name:'历史回收站'}))
 await user.click(screen.getByRole('button',{name:'永久删除失败记录 1 条'}))
 expect(fetch).toHaveBeenCalledWith(previewPath,expect.objectContaining({body:JSON.stringify({operation:'purge-failed',tab:'trash',search:''})}))
 await user.click(await screen.findByRole('button',{name:'取消'}))
 await user.click(screen.getByRole('button',{name:'收起生成历史'}))
 expect(screen.queryByRole('button',{name:'永久删除失败记录 1 条'})).toBeNull()
})

it('uses actual request time rather than creation time and restores completed labels',async()=>{
 const now=Date.now()
 setup([{...uncertain,id:'running',status:'running',retryCount:1,error:undefined,createdAt:new Date(now-90_000).toISOString(),requestStartedAt:new Date(now-5_000).toISOString()}, {...uncertain,id:'done',status:'completed',retryCount:1,error:undefined}])
 await screen.findByText(/已等待 5 秒/)
 expect(screen.queryByText(/已等待 90 秒/)).toBeNull()
 expect(screen.getByText(/已完成/)).toBeTruthy()
})
it('distinguishes preparation and retry waiting from active generation',async()=>{
 setup([{...uncertain,id:'preparing',status:'running',error:undefined}, {...retrying,nextRetryAt:new Date(Date.now()-1000).toISOString()}])
 await screen.findByText(/准备请求/)
 expect(screen.getAllByText(/等待重试/).length).toBeGreaterThan(0)
 expect(screen.queryByText(/已等待/)).toBeNull()
})

it('updates elapsed seconds locally every second without polling the server each second',async()=>{
 const now=Date.now()
 vi.useFakeTimers()
 try{
  const {fetch}=setup([{...uncertain,status:'running',error:undefined,requestStartedAt:new Date(now-5000).toISOString()}])
  await act(async()=>{})
  expect(screen.getByText(/已等待 5 秒/)).toBeTruthy()
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000)})
  expect(screen.getByText(/已等待 6 秒/)).toBeTruthy()
  expect(fetch).toHaveBeenCalledTimes(1)
 }finally{cleanup();vi.useRealTimers()}
})
it('shows the cause and next action with expandable provider details',async()=>{
 const {user}=setup([{...retrying,failure:{category:'rate_limit',message:'请求频率或资源用量受限',retryable:true,uncertain:false,httpStatus:429,providerCode:'Throttling',requestId:'safe-id',detail:'Too many requests'}}])
 const card=(await screen.findAllByRole('article'))[0]
 expect(card.textContent).toContain('等待重试')
 expect(card.textContent).not.toContain('其他请求照常执行')
 const details=within(card).getByText('错误详情').closest('details')!
 expect(details.open).toBe(false)
 await user.click(within(card).getByText('错误详情'))
 expect(details.open).toBe(true)
 expect(card.textContent).toContain('429');expect(card.textContent).toContain('safe-id')
})
it('Google 只有实际重试项显示倒计时，未发送排队项保持排队中，成功后保留重试证据',async()=>{
 setup([{...retrying,providerCooldownUntil:new Date(Date.now()+120000).toISOString()}, {...retrying,id:'not-sent',input:{...retrying.input,prompt:'尚未发送'},retryCount:0,nextRetryAt:undefined,failure:undefined,error:undefined,providerCooldownUntil:new Date(Date.now()+120000).toISOString()}, {...completed,attempts:[{sequence:1,startedAt:'2026-11-01T15:00:00Z',endedAt:'2026-11-01T15:00:01Z',sent:true,outcome:'failed',failure:{category:'rate_limit',message:'rate limited',retryable:true,uncertain:false,httpStatus:429}},{sequence:2,startedAt:'2026-11-01T15:01:00Z',sent:true,outcome:'completed'}]}])
 await screen.findByText(/等待重试/);expect(screen.getAllByText(/等待重试/)).toHaveLength(1)
 expect(screen.getByText('排队中', {exact:true})).toBeTruthy()
 expect(screen.queryByRole('region',{name:'自动重试中'})).toBeNull()
 expect(screen.getAllByText(/尝试记录/).length).toBeGreaterThan(0)
 expect(screen.getByText(/第 1 次.*429/)).toBeTruthy()
})
it('任务退避比渠道冷却更长时，显示更晚的可尝试时间',async()=>{
 const clock=vi.spyOn(Date,'now').mockReturnValue(1800000000000)
 try{
  setup([{...retrying,nextRetryAt:new Date(Date.now()+120000).toISOString(),providerCooldownUntil:new Date(Date.now()+30000).toISOString()}])
  expect((await screen.findAllByText(/等待重试 · 120 秒后/)).length).toBeGreaterThan(0)
 }finally{clock.mockRestore()}
})
it('只有旧error字段的重试记录仍可展开原始错误，主列表不铺长说明',async()=>{
 const {user}=setup([retrying])
 const card=(await screen.findAllByRole('article'))[0]
 const summary=within(card).getByText('错误详情')
 const details=summary.closest('details')!
 expect(details.open).toBe(false)
 await user.click(summary)
 expect(details.open).toBe(true)
 expect(details.textContent).toContain(retrying.error)
})

it('等待重新生成时可以停止自动重试，普通排队仍叫取消排队',async()=>{
 const {user}=setup([retrying,{...retrying,id:'first',retryCount:0,nextRetryAt:undefined,input:{...retrying.input,prompt:'首次排队'}}])
 await screen.findByRole('button',{name:'停止自动重试'})
 expect(screen.getByRole('button',{name:'取消排队'})).toBeTruthy()
 await user.click(screen.getByRole('button',{name:'停止自动重试'}))
 await screen.findByText(/^已停止自动重试/)
})
it('已有原任务的等待是获取结果，不出现停止查询或取消排队',async()=>{
 setup([{...retrying,upstreamTaskId:'remote',input:{...retrying.input,provider:'kling',model:'kling/kling-v3-omni-image-generation'}}])
 await screen.findByText(/结果暂未取回/)
 expect(screen.queryByRole('button',{name:/取消排队|停止自动/})).toBeNull()
})
it('临时失败和结果未确认可手动重新生成，输入拒绝和已有原任务不可重投',async()=>{
 const onRetryGeneration=vi.fn<(job:GenerationTask)=>Promise<void>>(async()=>{})
 const failed={...completed,result:undefined,status:'failed' as const,failure:{category:'network' as const,message:'连接暂时失败',retryable:true,uncertain:false}}
 const {user}=setup([
  failed,
  {...failed,id:'invalid',failure:{...failed.failure,category:'invalid_input'}},
  {...uncertain,id:'existing-upstream',upstreamTaskId:'remote'},
  uncertain,
 ],{onRetryGeneration})
 const buttons=await screen.findAllByRole('button',{name:'重新生成',exact:true})
 expect(buttons).toHaveLength(2)
 for(const button of buttons)await user.click(button)
 expect(onRetryGeneration.mock.calls.map(([job])=>job.id)).toEqual(['done','blocked'])
})
it('取消过的首次排队可重新排队，旧版取消的原任务可继续获取结果',async()=>{
 setup([{...completed,status:'cancelled',result:undefined},{...retrying,id:'recover',status:'cancelled',upstreamTaskId:'remote',input:{...retrying.input,provider:'kling',model:'kling/kling-v3-omni-image-generation'}}])
 await screen.findByRole('button',{name:'重新排队'})
 expect(screen.getByRole('button',{name:'继续获取结果'})).toBeTruthy()
})
it('保存某一条配方不禁用其它条目的草稿操作',async()=>{
 let finish!:()=>void
 const onSaveRecipe=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve}))
 const {user}=setup([completed,{...completed,id:'other'}],{onSaveRecipe})
 const cards=await screen.findAllByRole('article')
 await user.click(within(cards[0]).getByRole('button',{name:'存为配方'}))
 expect(within(cards[1]).getByRole('button',{name:'另开草稿'}).closest('fieldset')).toHaveProperty('disabled',false)
 await act(async()=>finish())
})
it('图片存在但入作品失败时只重试保存，不重新生成',async()=>{
 const onRetrySave=vi.fn(async(job:GenerationTask)=>{void job})
 const {user}=setup([{...completed,workSavePending:true,workSaveError:'空间不足'}],{onRetrySave})
 await user.click(await screen.findByRole('button',{name:'重试保存'}))
 expect(onRetrySave).toHaveBeenCalledOnce()
 expect(screen.queryByRole('button',{name:'重新生成'})).toBeNull()
})
it('取消撞上执行时刷新真实状态，不错误显示取消成功',async()=>{
 const {fetch,tasks,user}=setup([{...completed,status:'queued',result:undefined}])
 await screen.findByRole('button',{name:'取消排队'})
 fetch.mockImplementation(async(_url,init)=>{if(init?.method==='POST'){tasks[0].status='running';return Response.json({error:'任务已开始，未取消'},{status:409})}return Response.json({tasks,error:null})})
 await user.click(screen.getByRole('button',{name:'取消排队'}))
 await screen.findByText(/准备请求|生成中|执行中/)
 expect(screen.queryByRole('button',{name:'取消排队'})).toBeNull()
 expect(screen.queryByText(/^已取消/)).toBeNull()
})
it('取消回执和刷新均丢失时提供核对状态，恢复连接后显示真实取消结果',async()=>{
 const {fetch,tasks,user}=setup([{...completed,status:'queued',result:undefined}])
 await screen.findByRole('button',{name:'取消排队'})
 fetch.mockImplementation(async()=>{throw new TypeError('offline')})
 await user.click(screen.getByRole('button',{name:'取消排队'}))
 const verify=await screen.findByRole('button',{name:'核对状态'})
 expect(screen.queryByText(/^已取消/)).toBeNull()
 tasks[0].status='cancelled';fetch.mockImplementation(async()=>Response.json({tasks,error:null}))
 await user.click(verify)
 await screen.findByText(/^已取消/)
})

it('copies the work code separately from the prompt, between the timestamp and model', async () => {
 const workCode = '#F75G25XX80'
 const {user} = setup([{...completed,workCode}])
 const writeText = vi.spyOn(navigator.clipboard, 'writeText')
 const button = await screen.findByRole('button', {name:'复制图片编号 #F75G25XX80'})
 const summary = button.closest('p')
 expect([...summary!.children].slice(1).map(item => item.textContent)).toEqual([
  `· ${new Date(completed.createdAt).toLocaleString()}`, `· ${workCode}`, `· ${completed.input.provider}/${completed.input.model}`,
 ])
 await user.click(button)
 expect(writeText).toHaveBeenLastCalledWith(workCode)
 await user.click(screen.getByRole('button', {name:'复制提示词'}))
 expect(writeText).toHaveBeenLastCalledWith(completed.input.prompt)
})

it('历史默认收起，只显示排队等活跃任务', async () => {
 const {user} = setup([completed, uncertain, retrying], {}, false)
 await screen.findByText('限流任务')
 expect(screen.queryByText('已经出图')).toBeNull()
 expect(screen.queryByText('旧请求')).toBeNull()
 await user.click(screen.getByRole('button', {name: '展开生成历史'}))
 expect(screen.getByText('已经出图')).toBeTruthy()
 await user.click(screen.getByRole('button', {name: '收起生成历史'}))
 expect(screen.queryByText('已经出图')).toBeNull()
 expect(screen.getByText('限流任务')).toBeTruthy()
})

it('轮询使用上次的 ETag，304 后保留已读取的历史', async () => {
 vi.useFakeTimers()
 try {
  const {fetch} = setup([completed])
  fetch.mockResolvedValueOnce(Response.json({tasks:[completed],error:null}, {headers:{ETag:'"tasks-test-0"'}}))
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  fetch.mockResolvedValueOnce(new Response(null, {status:304}))
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(fetch).toHaveBeenLastCalledWith('/api/generation-tasks?limit=60', expect.objectContaining({headers:{'If-None-Match':'"tasks-test-0"'}}))
  expect(screen.getByText('已经出图')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
 } finally { cleanup();vi.useRealTimers() }
})

it('排队遇到 Google 断网时显示探测恢复，而不是限流倒计时', async () => {
  setup([{ ...retrying, providerNetworkPaused: true }])
  expect(await screen.findByText('网络中断，恢复后自动继续')).toBeTruthy()
  expect(screen.queryByText(/等待重试/)).toBeNull()
})

it('执行中卡片和抽屉历史在操作组之后按上传顺序显示参考图，支持展开、预览和收起', async () => {
 const filenames=['z.png','a.png','m.png','b.png','y.png','c.png','x.png','d.png','w.png','e.png']
 const input={...completed.input,referenceFilenames:filenames,referenceNotes:['面容']}
 const onPreviewReference=vi.fn()
 const {user}=setup([{...completed,input},{...retrying,input}],{works:<div>作品网格</div>,onPreviewReference},false)
 const assertReferences=async (card:HTMLElement)=>{
  const buttons=()=>within(card).getAllByRole('button',{name:/^查看参考图 /})
  const sources=()=>buttons().map(button=>button.querySelector('img')?.getAttribute('src'))
  expect(sources()).toEqual(filenames.slice(0,8).map(filename=>`/api/assets/references/${filename}?thumbnail=true`))
  expect(card.querySelector('fieldset')!.nextElementSibling).toContain(buttons()[0])
  expect(buttons()[0].title).toBe('参考图 1：面容')
  expect(buttons()[0].querySelector('img')?.getAttribute('loading')).toBe('lazy')
  await user.click(within(card).getByRole('button',{name:'+2'}))
  expect(sources()).toEqual(filenames.map(filename=>`/api/assets/references/${filename}?thumbnail=true`))
  await user.click(within(card).getByRole('button',{name:'查看参考图 10'}))
  expect(onPreviewReference).toHaveBeenLastCalledWith('e.png','参考图 10')
  await user.click(within(card).getByRole('button',{name:'收起参考图'}))
  expect(buttons()).toHaveLength(8)
 }
 await assertReferences(await screen.findByRole('article'))
 await user.click(screen.getByRole('button',{name:'任务记录'}))
 const history=within(await screen.findByRole('dialog',{name:'任务记录'}))
 await user.click(history.getByRole('tab',{name:/已完成/}))
 await assertReferences(history.getByRole('article'))
})

it('任务记录抽屉包括已入库作品，按状态和搜索过滤，每批最多显示 30 条', async () => {
 const jobs=Array.from({length:32},(_,index)=>({
  ...completed,id:`done-${index}`,key:`done-${index}`,
  createdAt:new Date(Date.parse(completed.createdAt)+index*1000).toISOString(),
  workCode:index===0?'#OldWork':undefined,
 }))
 const failed:GenerationTask={...retrying,status:'failed',input:{...retrying.input,prompt:'UnIqUe prompt'}}
 const cancelled:GenerationTask={...retrying,id:'cancelled',key:'cancelled',status:'cancelled',input:{...retrying.input,provider:'poe',model:'nano-banana-2'}}
 const deleted={...failed,id:'deleted',key:'deleted',deletedAt:'2026-11-06'}
 const {user}=setup([jobs[31],...jobs.slice(0,31),failed,cancelled,deleted],{works:<div>作品网格</div>,hasWork:()=>true},false)
 const works=screen.getByText('作品网格')
 expect(screen.queryByRole('article')).toBeNull()
 await user.click(await screen.findByRole('button',{name:'失败 1'}))
 const dialog=await screen.findByRole('dialog',{name:'任务记录'})
 const drawer=within(dialog)
 expect(drawer.getByRole('tab',{name:'失败 · 1'}).getAttribute('aria-selected')).toBe('true')
 expect(drawer.getAllByRole('article').map(card=>card.dataset.taskId)).toEqual([failed.id])
 expect(screen.getByText('作品网格')).toBe(works)
 await user.click(drawer.getByRole('tab',{name:'全部 · 34'}))
 expect(drawer.getAllByRole('article')).toHaveLength(30)
 expect(drawer.getAllByRole('article')[0].dataset.taskId).toBe('done-31')
 await user.click(drawer.getByRole('button',{name:'加载更多（还有 4 条）'}))
 expect(drawer.getAllByRole('article')).toHaveLength(34)
 const search=drawer.getByRole('searchbox')
 await user.type(search,'已经出图')
 expect(drawer.getAllByRole('article')).toHaveLength(30)
 expect(drawer.getByRole('button',{name:'加载更多（还有 2 条）'})).toBeTruthy()
 await user.clear(search)
 await user.click(drawer.getByRole('tab',{name:'已完成 · 32'}))
 expect(drawer.getAllByRole('article')).toHaveLength(30)
 await user.type(search,'#oldwork')
 expect(drawer.getAllByRole('article').map(card=>card.dataset.taskId)).toEqual(['done-0'])
 await user.clear(search)
 expect(drawer.getAllByRole('article')).toHaveLength(30)
 await user.click(drawer.getByRole('tab',{name:'已取消 · 1'}))
 for(const query of ['POE','nano-banana-2','Nano Banana 2']){
  await user.clear(search)
  await user.type(search,query)
  expect(drawer.getAllByRole('article').map(card=>card.dataset.taskId)).toEqual([cancelled.id])
 }
 await user.clear(search)
 await user.type(search,'unique PROMPT')
 expect(drawer.queryByRole('article')).toBeNull()
 await user.click(drawer.getByRole('tab',{name:'历史回收站 · 1'}))
 expect(drawer.getAllByRole('article').map(card=>card.dataset.taskId)).toEqual(['deleted'])
 expect(drawer.getByRole('button',{name:'永久删除匹配的失败记录 1 条'})).toBeTruthy()
 await user.keyboard('{Escape}')
 expect(screen.queryByRole('dialog',{name:'任务记录'})).toBeNull()
 await user.click(screen.getByRole('button',{name:'任务记录'}))
 expect(screen.getByRole('tab',{name:'全部 · 34'}).getAttribute('aria-selected')).toBe('true')
 await user.click(document.querySelector<HTMLElement>('[data-history-overlay]')!)
 expect(screen.queryByRole('dialog',{name:'任务记录'})).toBeNull()
 expect(screen.getByText('作品网格')).toBe(works)
})

it('任务记录抽屉滚动到底部时通过 IntersectionObserver 自动加载下一批', async () => {
 const originalObserver=globalThis.IntersectionObserver
 let trigger:((entries:Partial<IntersectionObserverEntry>[])=>void)|undefined
 globalThis.IntersectionObserver=class {
  constructor(callback:IntersectionObserverCallback){trigger=entries=>callback(entries as IntersectionObserverEntry[],this as unknown as IntersectionObserver)}
  observe(){}
  disconnect(){}
  unobserve(){}
  takeRecords(){return []}
 } as unknown as typeof IntersectionObserver
 try {
  const jobs=Array.from({length:35},(_,index)=>({
   ...completed,id:`auto-${index}`,key:`auto-${index}`,
   createdAt:new Date(Date.parse(completed.createdAt)+index*1000).toISOString(),
  }))
  const {user}=setup(jobs,{works:<div>作品网格</div>,hasWork:()=>true},false)
  await user.click(await screen.findByRole('button',{name:'任务记录'}))
  const drawer=within(await screen.findByRole('dialog',{name:'任务记录'}))
  expect(drawer.getAllByRole('article')).toHaveLength(30)
  await waitFor(()=>expect(trigger).toBeTypeOf('function'))
  await act(async()=>{trigger!([{isIntersecting:true}])})
  await waitFor(()=>expect(drawer.getAllByRole('article')).toHaveLength(35))
 } finally {
  globalThis.IntersectionObserver=originalObserver
 }
})

it('aborts a stuck poll on refresh, backs off failures, and refreshes on visibility', async () => {
 vi.useFakeTimers()
 try {
  const fetch = vi.fn()
   .mockImplementationOnce(() => new Promise(() => {}))
   .mockRejectedValueOnce(new TypeError('offline'))
   .mockRejectedValueOnce(new TypeError('offline'))
   .mockImplementation(async () => Response.json({ tasks: [], error: null }))
  vi.stubGlobal('fetch', fetch)
  render(<GenerationHistory revision={0} onResult={()=>{}} onPreview={()=>{}} onDraft={()=>{}} onContinue={async()=>{}} onSaveRecipe={async()=>{}}/>)
  const signal: AbortSignal = fetch.mock.calls[0][1].signal
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新' })) })
  expect(signal.aborted).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(fetch).toHaveBeenCalledTimes(3)
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(fetch).toHaveBeenCalledTimes(3)
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(fetch).toHaveBeenCalledTimes(4)
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(fetch).toHaveBeenCalledTimes(5)
 } finally { vi.useRealTimers() }
})

it('fetches full history only when a search needs older records', async () => {
 const fetch = vi.fn(async (url: string) => url.endsWith('?limit=60')
  ? Response.json({ tasks: [completed], error: null, hasMore: true })
  : Response.json({ tasks: [completed, { ...completed, id: 'older', input: { ...completed.input, prompt: '旧历史检索词' } }], error: null }))
 vi.stubGlobal('fetch', fetch)
 render(<GenerationHistory works={<div/>} revision={0} onResult={()=>{}} onPreview={()=>{}} onDraft={()=>{}} onContinue={async()=>{}} onSaveRecipe={async()=>{}}/>)
 const user = userEvent.setup()
 await user.click(screen.getByRole('button', { name: '任务记录' }))
 await screen.findByText(completed.input.prompt)
 expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/generation-tasks?limit=60'])
 await user.type(screen.getByRole('searchbox', { name: '搜索任务记录' }), '旧历史')
 expect(await screen.findByText('旧历史检索词')).toBeTruthy()
 expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/generation-tasks?limit=60', '/api/generation-tasks'])
})

it('shows total count hint when truncated, loads full history on drawer scroll or button click, and keeps full list synced to onTasks', async () => {
 const older = { ...completed, id: 'older-1', createdAt: '2026-04-01T00:00:00.000Z', input: { ...completed.input, prompt: '更早的历史记录' } }
 const fetch = vi.fn(async (url: string) => url.endsWith('?limit=60')
  ? Response.json({ tasks: [completed], error: null, hasMore: true, total: 2940 })
  : Response.json({ tasks: [completed, older], error: null }))
 vi.stubGlobal('fetch', fetch)
 const onTasks = vi.fn()
 const onHistoryMeta = vi.fn()
 render(<GenerationHistory works={<div/>} revision={0} onTasks={onTasks} onHistoryMeta={onHistoryMeta} onResult={()=>{}} onPreview={()=>{}} onDraft={()=>{}} onContinue={async()=>{}} onSaveRecipe={async()=>{}}/>)
 const user = userEvent.setup()
 await user.click(screen.getByRole('button', { name: '任务记录' }))
 const drawer = within(await screen.findByRole('dialog', { name: '任务记录' }))
 expect(await drawer.findByText('当前已加载最近 1 条，共 2940 条记录')).toBeTruthy()
 expect(drawer.getByRole('tab', { name: '全部 · 1+' })).toBeTruthy()
 expect(onHistoryMeta).toHaveBeenLastCalledWith(expect.objectContaining({ hasMore: true, total: 2940, loadingFull: false }))

 await user.click(drawer.getByRole('button', { name: '加载全部历史' }))
 expect(await drawer.findByText('更早的历史记录')).toBeTruthy()
 expect(drawer.getByRole('tab', { name: '全部 · 2' })).toBeTruthy()
 expect(onTasks).toHaveBeenLastCalledWith([completed, older], { fullHistory: true })

 // Subsequent lightweight refresh must preserve the merged full list instead of truncating back to 60.
 await user.click(drawer.getByRole('button', { name: '刷新' }))
 await waitFor(() => {
  expect(fetch.mock.calls.filter(([url]) => url === '/api/generation-tasks?limit=60').length).toBeGreaterThanOrEqual(2)
 })
 const lastTasksCall = onTasks.mock.calls[onTasks.mock.calls.length - 1]
 expect(lastTasksCall?.[0]).toHaveLength(2)
})

it('passes only the recent response as recentTasks on scheduled polls after loading full history', async () => {
 vi.useFakeTimers()
 try {
  const older = { ...completed, id: 'older', createdAt: '2026-04-01T00:00:00.000Z' }
  const latest = { ...completed, id: 'latest', createdAt: '2026-11-01T00:00:00.000Z' }
  const fetch = vi.fn()
   .mockResolvedValueOnce(Response.json({ tasks: [completed], error: null, hasMore: true }))
   .mockResolvedValueOnce(Response.json({ tasks: [completed, older], error: null }))
   .mockResolvedValueOnce(Response.json({ tasks: [latest, completed], error: null, hasMore: true }))
  vi.stubGlobal('fetch', fetch)
  const onTasks = vi.fn()
  render(<GenerationHistory works={<div/>} revision={0} requestFull onTasks={onTasks} onResult={()=>{}} onPreview={()=>{}} onDraft={()=>{}} onContinue={async()=>{}} onSaveRecipe={async()=>{}}/>)

  await act(async () => {})
  expect(onTasks).toHaveBeenLastCalledWith([completed, older], { fullHistory: true })

  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(fetch).toHaveBeenLastCalledWith('/api/generation-tasks?limit=60', expect.anything())
  expect(onTasks).toHaveBeenLastCalledWith([completed, older, latest], { recentTasks: [latest, completed] })
 } finally { cleanup();vi.useRealTimers() }
})

it('loads full history when requestFull is enabled externally for GeneratePage infinite scroll', async () => {
 const older = { ...completed, id: 'older-2', createdAt: '2026-04-01T00:00:00.000Z', input: { ...completed.input, prompt: '外部触发加载的旧记录' } }
 const fetch = vi.fn(async (url: string) => url.endsWith('?limit=60')
  ? Response.json({ tasks: [completed], error: null, hasMore: true, total: 120 })
  : Response.json({ tasks: [completed, older], error: null }))
 vi.stubGlobal('fetch', fetch)
 const onTasks = vi.fn()
 const { rerender } = render(
  <GenerationHistory works={<div/>} revision={0} requestFull={false} onTasks={onTasks} onResult={()=>{}} onPreview={()=>{}} onDraft={()=>{}} onContinue={async()=>{}} onSaveRecipe={async()=>{}}/>
 )
 await waitFor(() => expect(onTasks).toHaveBeenCalledTimes(1))
 expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/generation-tasks?limit=60'])

 rerender(
  <GenerationHistory works={<div/>} revision={0} requestFull={true} onTasks={onTasks} onResult={()=>{}} onPreview={()=>{}} onDraft={()=>{}} onContinue={async()=>{}} onSaveRecipe={async()=>{}}/>
 )
 await waitFor(() => {
  expect(onTasks).toHaveBeenLastCalledWith([completed, older], { fullHistory: true })
 })
 expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/generation-tasks?limit=60', '/api/generation-tasks'])
})
