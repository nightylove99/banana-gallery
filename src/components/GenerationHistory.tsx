import { generationTaskDuration, generationTaskSettings } from '@/lib/generation-task-display'
import { formatImageGenerationSource } from '@/lib/image-generation-providers'
import { CopyWorkCodeButton } from './CopyWorkCodeButton'
import * as Dialog from '@radix-ui/react-dialog'
import {ChevronDown,ChevronRight,X} from 'lucide-react'
import {useCallback,useEffect,useId,useMemo,useRef,useState,type ReactNode} from 'react'
import {toast} from 'sonner'
import {canGenerateAgain,canResumeResult,hasOriginalResult,hasPriorGeneration,isQueryAttempt,historyRetryKey} from '@/lib/generation-task-actions'
import {ApiHttpError,imageAssetUrl,referenceAssetUrl} from '@/api'
import {BulkPurgeError,readGenerationHistory,taskRequest} from '@/lib/generation-tasks'
import {
 canBulkChangeGenerationTask, isGenerationHistoryFailure as isFailure, matchesGenerationHistorySearch,
 type GenerationBulkPreview, type GenerationBulkResult, type GenerationBulkScope, type GenerationHistoryTab,
} from '@/lib/generation-task-bulk'
import type {GenerationTask} from '@/types'
const labels:Record<GenerationTask['status'],string>={queued:'排队中',running:'执行中',completed:'已完成',failed:'失败',uncertain:'失败',cancelled:'已取消'}
const isActive=(status:GenerationTask['status']|undefined)=>status==='queued'||status==='running'
const dismissedFailuresKey='banana-dismissed-generation-failures'
function taskStatus(job:GenerationTask,now:number){
 if(job.status==='cancelled')return hasOriginalResult(job)?'原结果获取已停止':hasPriorGeneration(job)?'已停止自动重试':'已取消'
 if(job.status==='queued'){
  if(job.providerNetworkPaused)return '网络中断，恢复后自动继续'
  if(hasOriginalResult(job)){const due=Date.parse(job.nextRetryAt||'');return due>now?`结果暂未取回 · ${Math.ceil((due-now)/1000)} 秒后继续获取`:'等待获取原结果'}
  if(!job.retryCount&&!job.nextRetryAt)return '排队中'
  const due=Math.max(Date.parse(job.providerCooldownUntil||'')||0,Date.parse(job.nextRetryAt||'')||0)
  return due>now?`等待重试 · ${Math.ceil((due-now)/1000)} 秒后 · 第 ${job.retryCount||1}/3 次`:'等待重试'
 }
 if(job.status==='running'){
  const started=Date.parse(job.requestStartedAt||'')
  if(isQueryAttempt(job))return Number.isFinite(started)?`正在获取原结果 · 原请求已等待 ${Math.max(0,Math.floor((now-started)/1000))} 秒`:'正在获取原结果'
  return Number.isFinite(started)?`执行中${job.retryCount?` · 第 ${job.retryCount}/3 次重试执行中`:""} · 已等待 ${Math.max(0,Math.floor((now-started)/1000))} 秒`:(job.upstreamTaskId?'查询原任务':'准备请求')
 }
 if(job.status==='completed'){
  const duration = generationTaskDuration(job)
  return duration ? `已完成 · 请求用时 ${duration}` : '已完成 · 用时未知'
 }
 return labels[job.status]
}
function failureMessage(job:GenerationTask){
 if(!isFailure(job.status))return ''
 const message=job.failure?.message||job.error||''
 if(job.status==='uncertain')return message?`${message} · 请求结果未确认，未自动重试`:'请求超时或中断，未自动重试'
 const reason=message||'未记录失败原因'
 return job.retryCount?`${reason} · ${hasOriginalResult(job)?'自动获取已结束':'自动重试已结束'}`:reason
}
function FailureDetails({job}:{job:GenerationTask}){
 if(['running','completed','cancelled'].includes(job.status))return null
 if(!job.failure)return job.status==='queued'&&job.error?<details className="break-words text-xs text-zinc-400"><summary className="cursor-pointer">错误详情</summary><p className="mt-2 whitespace-pre-wrap">{job.error}</p></details>:null
 const failure=job.failure
 return <details className="break-words text-xs text-zinc-400"><summary className="cursor-pointer">错误详情</summary><div className="mt-2 space-y-1">
 {failure.httpStatus&&<p>状态码：{failure.httpStatus}</p>}{failure.providerCode&&<p>服务错误码：{failure.providerCode}</p>}{failure.requestId&&<p>请求编号：{failure.requestId}</p>}{failure.detail&&<p className="whitespace-pre-wrap">服务说明：{failure.detail}</p>}{failure.responseEvidence&&<pre className="whitespace-pre-wrap break-all">{JSON.stringify(failure.responseEvidence,null,2)}</pre>}
 </div></details>
}
function hasUsefulAttempts(job:GenerationTask){return !!job.attempts?.length&&((job.attemptCount||job.attempts.length)>1||job.attempts.some(a=>a.failure||a.outcome==='failed'||a.outcome==='uncertain')||!!job.failure)}
function AttemptDetails({job}:{job:GenerationTask}){
 if(!job.attempts?.length||!hasUsefulAttempts(job))return null
 return <details className="break-words text-xs text-zinc-400"><summary className="cursor-pointer">尝试记录 · {job.attemptCount||job.attempts.length} 次</summary><div className="mt-2 space-y-2">{job.attempts.map(a=><div key={a.sequence}>
 <p>第 {a.sequence} 次 · {a.sent?'已发送':'发送前'} · {labels[a.outcome]} {a.failure?.httpStatus||''}</p>
 <p>{new Date(a.startedAt).toLocaleString()}{a.endedAt?` → ${new Date(a.endedAt).toLocaleString()}`:''}</p>
 {a.failure&&<><p>{a.failure.message} {a.failure.providerCode} {a.failure.requestId}</p><p>{a.failure.detail}</p>{a.failure.responseEvidence&&<pre className="whitespace-pre-wrap break-all">{JSON.stringify(a.failure.responseEvidence,null,2)}</pre>}</>}
 </div>)}</div></details>
}
function HistoryPrompt({text}:{text:string}){
 const [expanded,setExpanded]=useState(false)
 const toggle=()=>setExpanded(value=>!value)
 return <div role="button" tabIndex={0} className="block w-full shrink-0 cursor-text text-left text-sm font-normal select-text"
  aria-expanded={expanded} aria-label={expanded?'收起完整提示词':'展开完整提示词'} title={expanded?'点击收起':'点击查看完整提示词'}
  onClick={event=>{
   const selection=window.getSelection()
   if(event.detail>0&&selection?.rangeCount&&!selection.isCollapsed&&selection.getRangeAt(0).intersectsNode(event.currentTarget))return
   toggle()
  }}
  onKeyDown={event=>{
   if(event.key!=='Enter'&&event.key!==' ')return
   event.preventDefault()
   if(!event.repeat)toggle()
  }}>
  <span style={expanded?undefined:{display:'-webkit-box',WebkitLineClamp:3,WebkitBoxOrient:'vertical',overflow:'hidden'}} className={expanded?'block whitespace-pre-wrap break-words':'break-words'}>{text}</span>
  {expanded&&<span className="mt-1 block cursor-pointer text-xs text-zinc-400 select-none">收起</span>}
 </div>
}
function CopyPromptButton({prompt}:{prompt:string}){
 const [copied,setCopied]=useState(false),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined)
 useEffect(()=>()=>clearTimeout(timer.current),[])
 return <button disabled={!prompt} title={copied?'已复制提示词':'复制完整提示词'} onClick={async()=>{
  try{await navigator.clipboard.writeText(prompt);setCopied(true);clearTimeout(timer.current);timer.current=setTimeout(()=>setCopied(false),2000)}
  catch{toast.error('复制失败，请展开提示词后手动复制')}
 }}>{copied?'已复制':'复制提示词'}</button>
}
const historyTabs = [
 { id: 'all', label: '全部' },
 { id: 'failed', label: '失败' },
 { id: 'completed', label: '已完成' },
 { id: 'cancelled', label: '已取消' },
 { id: 'trash', label: '历史回收站' },
] as const
const bulkTrashLabels = {
 all: '已结束任务', failed: '失败任务', completed: '已完成任务', cancelled: '已取消任务',
}
const HISTORY_PAGE_SIZE = 30
const REFERENCE_THUMB_LIMIT = 8

function ReferenceThumbnails({input,onPreview}:{input:GenerationTask['input'];onPreview?:Props['onPreviewReference']}){
 const [expanded,setExpanded]=useState(false)
 const filenames=input.referenceFilenames
 const hiddenCount=filenames.length-REFERENCE_THUMB_LIMIT
 return <div className="flex max-w-full items-center gap-1 border-l border-zinc-800 pl-2">
  <div className="flex min-w-0 gap-1 overflow-x-auto p-0.5">
   {(expanded?filenames:filenames.slice(0,REFERENCE_THUMB_LIMIT)).map((filename,index)=>{
    const label=`参考图 ${index+1}`
    const note=input.referenceNotes?.[index]
    return <button key={index} type="button" aria-label={`查看${label}`} title={note?`${label}：${note}`:label}
     className="shrink-0 rounded focus-visible:outline-2 focus-visible:outline-indigo-400"
     onClick={()=>onPreview?.(filename,label)}>
     <img src={referenceAssetUrl(filename)+'?thumbnail=true'} alt="" loading="lazy" className="h-9 w-9 rounded border border-zinc-700/80 bg-zinc-950/80 object-cover"/>
    </button>
   })}
  </div>
  {hiddenCount>0&&<button type="button" aria-expanded={expanded} aria-label={expanded?'收起参考图':undefined}
   onClick={()=>setExpanded(value=>!value)} className="h-9 shrink-0 rounded border border-zinc-700 px-2 text-xs text-zinc-300 hover:bg-zinc-800">
   {expanded?'收起':`+${hiddenCount}`}
  </button>}
 </div>
}

export interface GenerationHistoryMeta {
 hasMore: boolean
 total?: number
 loadingFull: boolean
 fullError: string
}

function mergeHistoryTasks(full: GenerationTask[] | null, recent: GenerationTask[], hasMore: boolean) {
 if (!full || !hasMore) return recent
 const merged = new Map(full.map(job => [job.id, job]))
 for (const job of recent) merged.set(job.id, job)
 return [...merged.values()]
}

type Props={works?:ReactNode;hasWork?:(job:GenerationTask)=>boolean;revision:number;requestFull?:boolean;fullRetryKey?:number;onHistoryMeta?:(meta:GenerationHistoryMeta)=>void;onResult:(job:GenerationTask)=>void;onPreview:(job:GenerationTask)=>void;onPreviewReference?:(filename:string,label:string)=>void;onDraft:(job:GenerationTask)=>void;onContinue:(job:GenerationTask)=>Promise<void>;onSaveRecipe:(job:GenerationTask)=>Promise<void>;onTasks?:(tasks:GenerationTask[],options?:{fullHistory?:boolean})=>void;onRetryGeneration?:(job:GenerationTask)=>Promise<void>;onResumeResult?:(job:GenerationTask)=>Promise<void>;onRetrySave?:(job:GenerationTask)=>Promise<void>;pendingQueryIds?:string[];pendingRetryId?:string}
export function GenerationHistory({works,hasWork,revision,requestFull=false,fullRetryKey=0,onHistoryMeta,onResult,onPreview,onPreviewReference,onDraft,onContinue,onSaveRecipe,onTasks,onRetryGeneration,onResumeResult,onRetrySave,pendingQueryIds=[],pendingRetryId}:Props){
 const [expanded,setExpanded]=useState(false)
 const listId=useId()
 const standalone=works===undefined
 const [drawerOpen,setDrawerOpen]=useState(false)
 const [activeTab,setActiveTab]=useState<GenerationHistoryTab>('all')
 const [search,setSearch]=useState('')
 const [limit,setLimit]=useState(HISTORY_PAGE_SIZE)
 const historyToggle=useRef<HTMLButtonElement>(null)
 const searchInput=useRef<HTMLInputElement>(null)
 const taskRecordButton=useRef<HTMLButtonElement>(null)
 const [bulkBusy,setBulkBusy]=useState(false),bulkRef=useRef(false)
 const [bulkPreview,setBulkPreview]=useState<GenerationBulkPreview|null>(null)
 const bulkOpener=useRef<HTMLButtonElement>(null)
 const bulkCancel=useRef<HTMLButtonElement>(null)
 const drawerOpener=useRef<HTMLButtonElement>(null)
 const drawerList=useRef<HTMLDivElement|null>(null)
 const [drawerListEl,setDrawerListEl]=useState<HTMLDivElement|null>(null)
 const [loadMoreEl,setLoadMoreEl]=useState<HTMLButtonElement|null>(null)
 const setDrawerListRef=useCallback((node:HTMLDivElement|null)=>{
  drawerList.current=node
  setDrawerListEl(node)
 },[])
 const selectTab=useCallback((tab:GenerationHistoryTab)=>{
  setActiveTab(tab)
  setLimit(HISTORY_PAGE_SIZE)
  if(drawerList.current)drawerList.current.scrollTop=0
 },[])
 const openDrawer=useCallback((tab:GenerationHistoryTab,opener=taskRecordButton.current)=>{
  if(bulkRef.current)return
  setBulkPreview(null)
  drawerOpener.current=opener
  selectTab(tab)
  setSearch('')
  setDrawerOpen(true)
 },[selectTab])
 const onTasksRef=useRef(onTasks);onTasksRef.current=onTasks
 const onHistoryMetaRef=useRef(onHistoryMeta);onHistoryMetaRef.current=onHistoryMeta
 const [savedRecipes,setSavedRecipes]=useState<string[]>([]),[recentTasks,setRecentTasks]=useState<GenerationTask[]>([])
 const recentTasksRef=useRef<GenerationTask[]>([])
 const lastRead=useRef<{startedAt:number;statuses:Map<string,GenerationTask['status']>}|null>(null)
 const [dismissedFailures,setDismissedFailures]=useState<Set<string>>(()=>{
  try{return new Set<string>(JSON.parse(sessionStorage.getItem(dismissedFailuresKey)||'[]'))}
  catch{return new Set()}
 })
 const [error,setError]=useState(''),[trash,setTrash]=useState(false),[refresh,setRefresh]=useState(0),[canPurge,setCanPurge]=useState(false)
 const [rowBusy,setRowBusy]=useState<Record<string,string>>({}),busyRef=useRef(new Map<string,string>())
 const [cancelUnknown,setCancelUnknown]=useState<Record<string,boolean>>({})
 const [,tickClock]=useState(0),now=Date.now()
 const [serverHasMore,setServerHasMore]=useState(false)
 const [serverTotal,setServerTotal]=useState<number|undefined>(undefined)
 const [requestedFull,setRequestedFull]=useState(false)
 const [fullTasks,setFullTasks]=useState<GenerationTask[]|null>(null)
 const fullTasksRef=useRef<GenerationTask[]|null>(null)
 const [fullError,setFullError]=useState('')
 const wantsFull=serverHasMore && (requestedFull || requestFull || ((standalone ? expanded : drawerOpen) && !!search.trim()))
 const incompleteHistory=serverHasMore&&(!fullTasks||!!fullError)
 const loadingFull=wantsFull&&!fullTasks&&!fullError
 const tasks=useMemo(()=>mergeHistoryTasks(fullTasks,recentTasks,serverHasMore),[fullTasks,recentTasks,serverHasMore])
 useEffect(()=>{
  onHistoryMetaRef.current?.({
   hasMore: incompleteHistory,
   total: serverTotal ?? (tasks.length || undefined),
   loadingFull,
   fullError,
  })
 },[incompleteHistory,serverTotal,tasks.length,loadingFull,fullError])
 useEffect(()=>{
  if(!wantsFull)return
  const controller=new AbortController()
  setFullError('')
  void readGenerationHistory(undefined,controller.signal,true).then(data=>{
   if(!controller.signal.aborted&&data){
    fullTasksRef.current=data.tasks
    setFullTasks(data.tasks)
    setServerTotal(data.tasks.length)
    onTasksRef.current?.(mergeHistoryTasks(data.tasks,recentTasksRef.current,true),{fullHistory:true})
   }
  }).catch(cause=>{
   if(!controller.signal.aborted)setFullError(cause instanceof Error?cause.message:'读取完整历史失败')
  })
  return()=>controller.abort()
 },[wantsFull,revision,refresh,fullRetryKey])
 const clockActive=tasks.some(job=>job.status==='running'&&!!job.requestStartedAt||job.status==='queued'&&(!!job.nextRetryAt||!!job.retryCount))
 useEffect(()=>{if(!clockActive)return;const timer=setInterval(()=>tickClock(n=>n+1),1000);return()=>clearInterval(timer)},[clockActive])
 useEffect(()=>{
  let current:AbortController|undefined, timer:ReturnType<typeof setTimeout>|undefined
  let etag:string|undefined, failures=0, serverError=''
  const read=async()=>{
   clearTimeout(timer)
   current?.abort()
   const controller=new AbortController()
   current=controller
   const startedAt=Date.now()
   try {
    const data=await readGenerationHistory(etag,controller.signal)
    if(controller.signal.aborted)return
    failures=0
    const previous=lastRead.current
    if(!data){
     if(previous)lastRead.current={...previous,startedAt}
     setError(serverError)
     return
    }
    lastRead.current={startedAt,statuses:new Map(data.tasks.map(job=>[job.id,job.status]))}
    if(previous){
     for(const job of data.tasks){
      if(job.deletedAt||!isFailure(job.status))continue
      const previousStatus=previous.statuses.get(job.id)
      // A task can be created and finished between two reads, without exposing an active snapshot.
      const finishedBetweenReads=previousStatus===undefined&&Date.parse(job.createdAt)>=previous.startedAt
      if(!isActive(previousStatus)&&!finishedBetweenReads)continue
      const source=formatImageGenerationSource(job.input.provider,job.input.model)
      const reason=failureMessage(job).replace(/\s+/g,' ')
      toast.error(`${source} 生成失败：${reason.length>100?`${reason.slice(0,100)}…`:reason}`,{
       action:{label:'查看',onClick:()=>{
        if(!standalone)openDrawer('failed')
        else{setTrash(false);setExpanded(true)}
       }},
      })
     }
    }
    if(data){
     etag=data.etag
     serverError=data.error||''
     recentTasksRef.current=data.tasks
     setRecentTasks(data.tasks)
     const nextHasMore=!!data.hasMore
     setServerHasMore(nextHasMore)
     setServerTotal(typeof data.total==='number'?data.total:(!nextHasMore?data.tasks.length:undefined))
     if(!nextHasMore){
      fullTasksRef.current=null
      setFullTasks(null)
     }
     setCanPurge(!!data.canPurge)
     setCancelUnknown({})
     onTasksRef.current?.(mergeHistoryTasks(fullTasksRef.current,data.tasks,nextHasMore))
    }
    setError(serverError)
   } catch(cause) {
    if(controller.signal.aborted)return
    failures++
    setError(cause instanceof Error?cause.message:'读取历史失败')
   } finally {
    if(!controller.signal.aborted&&!document.hidden){
     timer=setTimeout(read,Math.min(30_000,2000*2**Math.max(0,failures-1)))
    }
   }
  }
  const onVisible=()=>{
   if(document.hidden){clearTimeout(timer);current?.abort()}
   else void read()
  }
  const onOnline=()=>{void read()}
  void read()
  document.addEventListener('visibilitychange',onVisible)
  window.addEventListener('online',onOnline)
  window.addEventListener('focus',onOnline)
  return()=>{
   current?.abort()
   clearTimeout(timer)
   document.removeEventListener('visibilitychange',onVisible)
   window.removeEventListener('online',onOnline)
   window.removeEventListener('focus',onOnline)
  }
 },[revision,refresh,standalone,openDrawer])
 const runJob=async(job:GenerationTask,type:string,work:()=>Promise<unknown>)=>{
  if(bulkRef.current||busyRef.current.has(job.id))return
  busyRef.current.set(job.id,type);setRowBusy(previous=>({...previous,[job.id]:type}))
  try{await work()}
  catch(cause){
   if(type==='cancel'&&(!(cause instanceof ApiHttpError)||cause.status>=500||cause.status===408))setCancelUnknown(previous=>({...previous,[job.id]:true}))
   toast.error(cause instanceof Error?cause.message:'操作失败')
  }finally{busyRef.current.delete(job.id);setRowBusy(previous=>{const next={...previous};delete next[job.id];return next});setRefresh(n=>n+1)}
 }
 const action=(job:GenerationTask,type:string)=>runJob(job,type,()=>taskRequest(`/${job.id}/${type}`,{confirm:true}))
 const purge=async(job:GenerationTask)=>{
  if(!window.confirm('永久清理这一项历史。没有其他记录引用的结果和参考图将被删除；此操作不能撤销，也不等于取消上游请求。'))return
  await runJob(job,'purge',()=>taskRequest(`/${job.id}`,{confirm:true},{method:'DELETE'}))
 }
 const orderedTasks=useMemo(()=>[...tasks].reverse().sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)),[tasks])
 const history=useMemo(()=>{
  const groups:Record<GenerationHistoryTab,GenerationTask[]>={all:[],failed:[],completed:[],cancelled:[],trash:[]}
  for(const job of orderedTasks){
   if(job.deletedAt){groups.trash.push(job);continue}
   groups.all.push(job)
   if(isFailure(job.status))groups.failed.push(job)
   else if(job.status==='completed'||job.status==='cancelled')groups[job.status].push(job)
  }
  return groups
 },[orderedTasks])
 const visible=history[trash?'trash':'all']
 const latestFailure=history.failed[0]
 const failureNotice=!standalone&&latestFailure&&!dismissedFailures.has(latestFailure.id)?latestFailure:null
 const failureSummary=failureNotice
  ? `${formatImageGenerationSource(failureNotice.input.provider,failureNotice.input.model)} · ${failureMessage(failureNotice)}`
  : ''
 const dismissFailure=(id:string)=>{
  const next=new Set(dismissedFailures).add(id)
  setDismissedFailures(next)
  try{sessionStorage.setItem(dismissedFailuresKey,JSON.stringify([...next]))}catch{/* Keep the dismissal in memory when storage is unavailable. */}
 }
 const displayed=standalone
  ? expanded?visible:visible.filter(job=>isActive(job.status))
  : history.all.filter(job=>isActive(job.status)||(job.result&&job.workSavePending&&!hasWork?.(job)))
 const bulkTab = standalone ? (trash ? 'trash' : 'all') : activeTab
 const bulkSearch = drawerOpen ? search.trim() : ''
 const query = bulkSearch.toLowerCase()
 const matching = useMemo(()=>query ? history[bulkTab].filter(job=>matchesGenerationHistorySearch(job,query)) : history[bulkTab],
  [history,bulkTab,query])
 const bulkOperation = bulkTab==='trash' ? 'purge-failed' : 'trash'
 const eligibleCount = useMemo(()=>matching.filter(job=>canBulkChangeGenerationTask(job,bulkOperation,!!job.executing)).length,
  [matching,bulkOperation])
 const canAutoLoadDrawer=drawerOpen&&(matching.length>limit||(serverHasMore&&!fullTasks&&!wantsFull&&!fullError))
 useEffect(()=>{
  if(!canAutoLoadDrawer||!drawerListEl||!loadMoreEl||typeof IntersectionObserver!=='function')return
  const observer=new IntersectionObserver(entries=>{
   if(!entries.some(entry=>entry.isIntersecting))return
   if(matching.length>limit){
    setLimit(count=>count+HISTORY_PAGE_SIZE)
   }else if(serverHasMore&&!fullTasks&&!wantsFull){
    setRequestedFull(true)
    setLimit(count=>count+HISTORY_PAGE_SIZE)
   }
  },{root:drawerListEl,rootMargin:'200px'})
  observer.observe(loadMoreEl)
  return()=>observer.disconnect()
 },[canAutoLoadDrawer,drawerListEl,loadMoreEl,matching.length,limit,serverHasMore,fullTasks,wantsFull,activeTab,query])
 const runBulk=async(work:()=>Promise<void>)=>{
  if(bulkRef.current||busyRef.current.size)return
  bulkRef.current=true
  setBulkBusy(true)
  try { await work() }
  catch(cause){
   if(cause instanceof BulkPurgeError){
    toast.error(`已删除 ${cause.deleted} 条失败记录，尚有 ${cause.remaining} 条未清理。请刷新后重新确认。`)
   }else if(cause instanceof ApiHttpError && cause.status===409){
    toast.error('任务状态已变化，请刷新后重新确认')
   }else{
    toast.error(cause instanceof Error?cause.message:'操作失败')
   }
   setRefresh(n=>n+1)
  }finally{
   bulkRef.current=false
   setBulkBusy(false)
  }
 }
 const previewBulk=(opener:HTMLButtonElement)=>runBulk(async()=>{
  bulkOpener.current=opener
  const scope: GenerationBulkScope = {operation:bulkOperation,tab:bulkTab,search:bulkSearch}
  const preview=await taskRequest<GenerationBulkPreview>('/bulk/preview',scope)
  if(!preview.eligibleCount||!preview.token){
   toast.info(preview.operation==='trash'?'当前没有可移入的记录':'当前没有可永久删除的失败记录')
   setRefresh(n=>n+1)
   return
  }
  setBulkPreview(preview)
 })
 const commitBulk=()=>runBulk(async()=>{
  if(!bulkPreview?.token)return
  try {
   const result=await taskRequest<GenerationBulkResult>('/bulk/commit',{token:bulkPreview.token,confirm:true})
   if('moved' in result){
    toast.success(`已移入 ${result.moved} 条任务记录${result.skipped?`，保留 ${result.skipped} 条待处理任务`:''}`)
   }else{
    toast.success(`已删除 ${result.deleted} 条失败记录`)
   }
   setRefresh(n=>n+1)
  }finally{
   setBulkPreview(null)
  }
 })
 const anyBusy=bulkBusy||Object.keys(rowBusy).length>0
 const submittedKeys=new Set(tasks.map(job=>job.key))
 const renderRetryButton=(job:GenerationTask)=>{
  if(!onRetryGeneration||!canGenerateAgain(job))return null
  const pending=pendingRetryId===job.id
  const submitted=submittedKeys.has(historyRetryKey(job))
  const label=rowBusy[job.id]==='retry'?'提交中…':pending?'核对原提交':submitted?'已重新提交':
   job.status==='cancelled'&&!hasPriorGeneration(job)?'重新排队':'重新生成'
  return <button type="button" disabled={bulkBusy||!!rowBusy[job.id]||(!pending&&submitted)}
   onClick={()=>void runJob(job,'retry',()=>onRetryGeneration(job))}>{label}</button>
 }
 const renderCard=(job:GenerationTask,inDrawer=false)=>{
  const reason=failureMessage(job)
  const sourceTask=job.input.sourceTaskId?tasks.find(parent=>parent.id===job.input.sourceTaskId):undefined
  const leaveDrawer=(work:()=>void)=>{
   if(inDrawer)setDrawerOpen(false)
   work()
  }
  return <article key={job.id} data-task-id={job.id} className="space-y-2 rounded-lg bg-zinc-900/70 p-3">
 <div className="flex gap-3">
 {job.result&&<button onClick={()=>onPreview(job)} className="shrink-0" aria-label="查看大图" title="查看大图"><img src={imageAssetUrl(job.result.filename)+'?thumbnail=true'} alt="生成结果缩略图" loading="lazy" className="h-32 w-24 object-contain sm:h-36 sm:w-28"/></button>}
 <div className="flex min-w-0 flex-1 flex-col gap-2"><p className="flex flex-wrap items-baseline gap-x-1 gap-y-1 break-words text-xs text-zinc-400">
   <span className="min-w-0">{taskStatus(job, now)}</span>
   <span className="min-w-0">· {new Date(job.createdAt).toLocaleString()}</span>
   {job.workCode && <span>· <CopyWorkCodeButton code={job.workCode} className="align-baseline text-zinc-300 hover:text-white" /></span>}
   <span className="min-w-0">· {standalone
    ? `${job.input.provider}/${job.input.model}`
    : [formatImageGenerationSource(job.input.provider, job.input.model), generationTaskSettings(job.input)].filter(Boolean).join(' · ')}</span>
 </p>
 <HistoryPrompt text={job.input.prompt}/>{job.purgePending&&<p className="text-amber-300">已开始永久清理，请重试清理；恢复需使用备份。</p>}{reason&&<p className="break-words text-xs text-amber-300">{reason}</p>}{((!['running','completed','cancelled'].includes(job.status)&&(job.failure||(job.status==='queued'&&job.error)))||hasUsefulAttempts(job))&&<div className="flex flex-wrap items-start gap-3 [&>details]:min-w-0 [&>details]:max-w-full"><FailureDetails job={job}/><AttemptDetails job={job}/></div>}
 {job.workSavePending&&<p role="status" className="text-xs text-amber-300">{job.workSaveError?'作品尚未入库，稍后自动重试':'正在存入作品…'}</p>}
 {cancelUnknown[job.id]&&<p className="text-xs text-amber-300">取消结果尚未确认 <button className="underline" onClick={()=>setRefresh(n=>n+1)}>核对状态</button></p>}

 </div></div>
 <div className="flex flex-wrap items-center gap-2">
 <fieldset disabled={bulkBusy||!!rowBusy[job.id]} className="flex min-w-0 max-w-full flex-wrap gap-1.5 text-xs sm:gap-2 [&>button]:rounded-md [&>button]:border [&>button]:border-zinc-700 [&>button]:px-2 sm:[&>button]:px-2.5 [&>button]:py-1 [&>button]:text-zinc-300 [&>button:hover]:bg-zinc-800 [&>button:disabled]:opacity-50">
 {!job.purgePending&&<>
 {job.result&&<><button onClick={()=>leaveDrawer(()=>void runJob(job,'continue',()=>onContinue(job)))}>{rowBusy[job.id]==='continue'?'打开中…':'继续修改'}</button><button disabled={savedRecipes.includes(job.id)} onClick={()=>void runJob(job,'recipe',async()=>{await onSaveRecipe(job);setSavedRecipes(ids=>[...ids,job.id])})}>{rowBusy[job.id]==='recipe'?'保存中…':savedRecipes.includes(job.id)?'已存为配方':'存为配方'}</button></>}
 <CopyPromptButton prompt={job.input.prompt}/><button onClick={()=>leaveDrawer(()=>onDraft(job))}>另开草稿</button>{sourceTask?.result&&<button onClick={()=>leaveDrawer(()=>onResult(sourceTask))}>查看来源结果</button>}
 {job.status==='queued'&&!hasOriginalResult(job)&&<button onClick={()=>void action(job,'cancel')}>{rowBusy[job.id]==='cancel'?'取消中…':hasPriorGeneration(job)?'停止自动重试':'取消排队'}</button>}
 {renderRetryButton(job)}
 {!job.deletedAt&&(canResumeResult(job)||pendingQueryIds.includes(job.id))&&onResumeResult&&<button onClick={()=>void runJob(job,'resume',()=>onResumeResult(job))}>{rowBusy[job.id]==='resume'?'核对中…':pendingQueryIds.includes(job.id)?'核对获取请求':'继续获取结果'}</button>}
 {job.result&&job.workSavePending&&job.workSaveError&&onRetrySave&&<button onClick={()=>void runJob(job,'save-work',()=>onRetrySave(job))}>{rowBusy[job.id]==='save-work'?'保存中…':'重试保存'}</button>}
 {!isActive(job.status)&&!job.executing&&<button onClick={()=>void action(job,job.deletedAt?'restore':'trash')}>{job.deletedAt?'恢复':'移入历史回收站'}</button>}
 </>}
 {job.deletedAt&&canPurge&&<button onClick={()=>void purge(job)}>永久清理此历史</button>}
 </fieldset>
 {job.input.referenceFilenames.length>0&&<ReferenceThumbnails input={job.input} onPreview={onPreviewReference}/>}
 </div></article>
 }
 const refreshButton=<button type="button" disabled={bulkBusy} onClick={()=>setRefresh(n=>n+1)}>刷新</button>
 const bulkCount=incompleteHistory?'':` ${eligibleCount} 条`
 const bulkLabel = bulkTab==='trash'
  ? `永久删除${query?'匹配的':''}失败记录${bulkCount}`
  : `移入历史回收站：${query?'匹配的':''}${bulkTrashLabels[bulkTab]}${bulkCount}`
 const bulkAction = (standalone?expanded:drawerOpen)&&(bulkTab!=='trash'||canPurge)&&(
  (incompleteHistory||eligibleCount>0)
   ? <button type="button" disabled={anyBusy} className={bulkTab==='trash'?'text-red-400':undefined} onClick={event=>void previewBulk(event.currentTarget)}>{bulkLabel}</button>
   : (query||matching.length>0)&&<span className="text-zinc-400">{bulkTab==='trash'?'当前没有可永久删除的失败记录':'当前没有可移入的记录'}</span>
 )
 const previewIsPurge = bulkPreview?.operation==='purge-failed'
 const previewTabLabel = historyTabs.find(tab=>tab.id===bulkPreview?.tab)?.label
 return <section aria-label={standalone?"生成历史":undefined} className={standalone?"space-y-3 rounded-xl border border-zinc-800 p-3 text-sm sm:p-4":"space-y-3 py-3 text-sm"}>
 {standalone
  ? <div className="flex flex-wrap items-center gap-3">
   <h2 className="font-medium"><button ref={historyToggle} type="button" aria-expanded={expanded} aria-controls={listId} aria-label={expanded?'收起生成历史':'展开生成历史'} disabled={bulkBusy} onClick={()=>setExpanded(value=>!value)} className="flex items-center gap-1.5 rounded text-zinc-200 hover:text-white">
    {expanded?<ChevronDown size={14}/>:<ChevronRight size={14}/>} {trash?'历史回收站':'生成历史'} · {visible.length}{incompleteHistory&&!trash&&typeof serverTotal==='number'?` / ${serverTotal}`:incompleteHistory?'+':''}
   </button></h2>
   <button type="button" disabled={bulkBusy} onClick={()=>{setTrash(!trash);setExpanded(true)}}>{trash?'返回历史':'历史回收站'}</button>
   {refreshButton}{bulkAction}
  </div>
  : <div className="flex flex-wrap items-center gap-3">
   <button ref={taskRecordButton} type="button" aria-haspopup="dialog" className="rounded-md border border-zinc-700 px-3 py-1.5 font-medium text-zinc-200 hover:bg-zinc-800" onClick={event=>openDrawer('all',event.currentTarget)}>任务记录</button>
   {history.failed.length>0&&<button type="button" aria-haspopup="dialog" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-300 hover:bg-amber-500/20" onClick={event=>openDrawer('failed',event.currentTarget)}>失败 {history.failed.length}</button>}
   {refreshButton}
  </div>}
 {failureNotice&&<div role="status" className="flex items-center gap-2 rounded-md border border-red-400/20 bg-red-950/30 px-2.5 py-1 text-xs text-red-200">
  <span className="min-w-0 flex-1 truncate" title={failureSummary}>{failureSummary}</span>
  <div className="flex shrink-0 items-center gap-2 whitespace-nowrap text-zinc-300 [&>button]:rounded [&>button]:px-1 [&>button]:py-1 [&>button:hover]:bg-white/10 [&>button:disabled]:opacity-50">
   {renderRetryButton(failureNotice)}
   <button type="button" aria-haspopup="dialog" onClick={event=>openDrawer('failed',event.currentTarget)}>查看详情</button>
   <button type="button" aria-label="关闭失败提示" onClick={()=>dismissFailure(failureNotice.id)}><X size={14} aria-hidden="true"/></button>
  </div>
 </div>}
 {error&&<p role="alert" className="text-amber-300">{error}</p>}
 <div id={listId} className="space-y-3">
  {standalone&&expanded&&!visible.length&&!error&&<p className="text-zinc-500">{trash?'历史回收站为空':'尚无生成任务'}</p>}
  {displayed.map(job=>renderCard(job))}
  {standalone&&expanded&&serverHasMore&&!fullTasks&&<button disabled={wantsFull&&!fullError} onClick={()=>{setRequestedFull(true);if(fullError)setRefresh(n=>n+1)}}>加载更多历史{typeof serverTotal==='number'?`（共 ${serverTotal} 条）`:''}</button>}
  {standalone&&wantsFull&&fullError&&<p role="alert">{fullError} <button onClick={()=>setRefresh(n=>n+1)}>重试读取完整历史</button></p>}
 </div>
 {!standalone&&<>
  {works}
  <Dialog.Root open={drawerOpen} onOpenChange={open=>{if(!bulkRef.current)setDrawerOpen(open)}}>
   <Dialog.Portal>
    <Dialog.Overlay data-history-overlay="" className="fixed inset-0 z-50 bg-black/60"/>
    <Dialog.Content aria-modal="true" aria-label="任务记录" aria-describedby={undefined}
     onCloseAutoFocus={event=>{
      event.preventDefault()
      const opener=drawerOpener.current?.isConnected?drawerOpener.current:taskRecordButton.current
      if(document.activeElement===document.body)opener?.focus({preventScroll:true})
     }}
     className="task-history-drawer fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-zinc-800 bg-zinc-950 text-sm text-zinc-100 shadow-2xl">
     <header className="space-y-3 border-b border-zinc-800 p-4">
      <div className="flex items-center gap-3">
       <Dialog.Title className="mr-auto text-base font-semibold">任务记录</Dialog.Title>
       {refreshButton}
       <Dialog.Close disabled={bulkBusy} aria-label="关闭任务记录" className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"><X size={18}/></Dialog.Close>
      </div>
      <div role="tablist" aria-label="任务状态" className="flex flex-wrap gap-1"
       onKeyDown={event=>{
        if(bulkRef.current)return
        const index=historyTabs.findIndex(tab=>tab.id===activeTab)
        const last=historyTabs.length-1
        const next=event.key==='ArrowRight'?(index+1)%historyTabs.length
         :event.key==='ArrowLeft'?(index+last)%historyTabs.length
         :event.key==='Home'?0:event.key==='End'?last:-1
        if(next<0)return
        event.preventDefault()
        selectTab(historyTabs[next].id)
        event.currentTarget.querySelectorAll('button')[next]?.focus()
       }}>
       {historyTabs.map(({id,label})=><button key={id} type="button" role="tab" disabled={bulkBusy} id={`${listId}-${id}`}
        aria-selected={activeTab===id} aria-controls={`${listId}-panel`} tabIndex={activeTab===id?0:-1}
        className="rounded-md px-2.5 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900 aria-selected:bg-zinc-800 aria-selected:text-white"
        onClick={()=>selectTab(id)}>{label} · {history[id].length}{incompleteHistory?'+':''}</button>)}
      </div>
      {incompleteHistory&&<div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-1.5 text-xs text-zinc-400">
       <span>当前已加载最近 {recentTasks.length} 条{typeof serverTotal==='number'?`，共 ${serverTotal} 条记录`:''}</span>
       <button type="button" disabled={bulkBusy||loadingFull}
        onClick={()=>{setRequestedFull(true);if(fullError)setRefresh(n=>n+1)}}
        className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
        {loadingFull?'正在加载全部…':'加载全部历史'}
       </button>
      </div>}
      <input ref={searchInput} type="search" disabled={bulkBusy} aria-label="搜索任务记录" placeholder="搜索提示词、#作品编号、渠道或模型…" value={search}
       onChange={event=>{
        setSearch(event.target.value)
        setLimit(HISTORY_PAGE_SIZE)
        if(drawerList.current)drawerList.current.scrollTop=0
       }} className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 placeholder:text-zinc-500"/>
      {bulkAction&&<div className="text-xs text-zinc-300">{bulkAction}</div>}
     </header>
     <div ref={setDrawerListRef} id={`${listId}-panel`} role="tabpanel" aria-labelledby={`${listId}-${activeTab}`} tabIndex={0}
      className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4">
      {error&&<p role="alert" className="text-amber-300">{error}</p>}
      {wantsFull&&!fullTasks&&!fullError&&<p role="status">正在读取完整历史…</p>}
      {wantsFull&&fullError&&<p role="alert">{fullError} <button onClick={()=>setRefresh(n=>n+1)}>重试读取完整历史</button></p>}
      {!matching.length&&!error&&!(wantsFull&&!fullTasks)&&<p className="text-zinc-500">{query?'没有匹配的任务':activeTab==='trash'?'历史回收站为空':'没有任务记录'}</p>}
      {matching.slice(0,limit).map(job=>renderCard(job,true))}
      {(matching.length>limit||serverHasMore&&!fullTasks&&!wantsFull)&&<button ref={setLoadMoreEl} type="button" className="w-full rounded-md border border-zinc-800 p-2 text-zinc-300 hover:bg-zinc-900"
       onClick={()=>{setRequestedFull(true);setLimit(count=>count+HISTORY_PAGE_SIZE)}}>加载更多{matching.length>limit&&(!serverHasMore||fullTasks)?`（还有 ${matching.length-limit} 条）`:''}</button>}
     </div>
    </Dialog.Content>
   </Dialog.Portal>
  </Dialog.Root>
 </>}
 <Dialog.Root open={!!bulkPreview} onOpenChange={open=>{if(!open&&!bulkRef.current)setBulkPreview(null)}}>
  {bulkPreview&&<Dialog.Portal>
   <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/70"/>
   <Dialog.Content
    onOpenAutoFocus={event=>{event.preventDefault();bulkCancel.current?.focus()}}
    onCloseAutoFocus={event=>{
     event.preventDefault()
     const opener=bulkOpener.current?.isConnected?bulkOpener.current:searchInput.current??historyToggle.current
     opener?.focus({preventScroll:true})
    }}
    className="fixed left-1/2 top-1/2 z-[60] max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 space-y-4 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-950 p-5 text-sm text-zinc-100 shadow-2xl">
    <Dialog.Title className="text-base font-semibold">{previewIsPurge?'确认永久删除':'确认移入历史回收站'}</Dialog.Title>
    <Dialog.Description asChild>
     <div className="space-y-2 break-words text-zinc-300">
      <p>「{previewTabLabel}」标签{bulkPreview.search&&<>，搜索词「{bulkPreview.search}」</>}：{bulkPreview.eligibleCount} 条{previewIsPurge?'失败记录':'任务记录'}（含未滚动展开的匹配记录）。</p>
      {previewIsPurge?<>
       {bulkPreview.retryPurgeCount>0&&<p>其中 {bulkPreview.retryPurgeCount} 条为重试清理。</p>}
       {bulkPreview.skippedCount>0&&<p>另有 {bulkPreview.skippedCount} 条匹配记录不在本次删除范围内。</p>}
       <p>回收站里的记录已在生成页隐藏，图库里的作品和配方不受影响。</p>
       <p>这些历史和没有其它引用的结果、参考图将被永久删除，其它记录及共享文件保留。此操作不可撤销。</p>
      </>:<>
       <p>对应卡片将从生成页的「生成记录」隐藏；图库里的作品和配方不删除，可在历史回收站恢复。</p>
       {bulkPreview.skippedCount>0&&<p>保留 {bulkPreview.skippedCount} 条待处理任务。</p>}
      </>}
     </div>
    </Dialog.Description>
    <div className="flex flex-wrap justify-end gap-2">
     <Dialog.Close type="button" ref={bulkCancel} disabled={bulkBusy} className="rounded-md border border-zinc-700 px-3 py-2 hover:bg-zinc-800">取消</Dialog.Close>
     <button type="button" disabled={bulkBusy} onClick={()=>void commitBulk()}
      className={`rounded-md px-3 py-2 font-medium text-white disabled:opacity-50 ${previewIsPurge?'bg-red-700 hover:bg-red-600':'bg-indigo-700 hover:bg-indigo-600'}`}>
      {bulkBusy?'处理中…':`${previewIsPurge?'永久删除':'移入历史回收站'}（${bulkPreview.eligibleCount} 条）`}
     </button>
    </div>
   </Dialog.Content>
  </Dialog.Portal>}
 </Dialog.Root>
 </section>
}
