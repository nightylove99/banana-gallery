import { ApiHttpError } from '@/api'
import type { GenerationTask } from '@/types'
import { taskRequest } from './generation-tasks'

interface PendingQuery { key: string; expectedVersion: number }
type Queries = Record<string, PendingQuery>
const storageKey=(scope:string)=>`banana-pending-result-queries:v1:${scope}`
export function readPendingQueries(scope:string):Queries {
  const raw=window.localStorage.getItem(storageKey(scope))
  if(!raw)return {}
  const value:unknown=JSON.parse(raw)
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.values(value).some(p=>!p||typeof p.key!=='string'||!Number.isSafeInteger(p.expectedVersion)||p.expectedVersion<0))throw new Error('结果获取记录无法读取，请保留浏览器数据')
  return value as Queries
}
function write(scope:string,pending:Queries){
  if(Object.keys(pending).length)window.localStorage.setItem(storageKey(scope),JSON.stringify(pending))
  else window.localStorage.removeItem(storageKey(scope))
}
function clear(scope:string,id:string,key:string){const pending=readPendingQueries(scope);if(pending[id]?.key===key){delete pending[id];write(scope,pending)}}
export function reconcileQueries(scope:string,tasks:GenerationTask[]){
  const pending=readPendingQueries(scope)
  let changed=false
  for(const job of tasks){const request=pending[job.id];if(request&&(job.manualResumeKey===request.key||job.status==='completed'&&job.result)){delete pending[job.id];changed=true}}
  if(changed)write(scope,pending)
  return Object.keys(pending)
}
export async function resumeResultQuery(scope:string,job:GenerationTask,signal?:AbortSignal){
  const pending=readPendingQueries(scope)
  const request=pending[job.id]??{key:crypto.randomUUID(),expectedVersion:job.manualResumeVersion??0}
  pending[job.id]=request;write(scope,pending)
  try{
    const result=await taskRequest<GenerationTask>(`/${encodeURIComponent(job.id)}/resume-query`,request,{signal})
    clear(scope,job.id,request.key)
    return result
  }catch(error){
    if(error instanceof ApiHttpError&&error.status>=400&&error.status<500&&![401,408,429].includes(error.status))clear(scope,job.id,request.key)
    throw error
  }
}
