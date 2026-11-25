import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach,expect,it,vi} from 'vitest'
import {JsonGalleryRepository} from '../../server/gallery/json-gallery-repository'
import {GalleryWriteCoordinator} from '../../server/gallery/write-coordinator'
import {GenerationTaskQueue,TaskError} from '../../server/generation/task-queue'
const roots:string[]=[]
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})})
const scope={workspaceId:'test',ownerUserId:'test',userId:'test'}
const input={prompt:'frozen prompt',referenceFilenames:[],provider:'google' as const,model:'gemini-nano-banana-2.1',aspectRatio:'1:1',imageSize:'2K'}
it('limits local GPU jobs without blocking other providers and freezes its execution seed',async()=>{
 const {repo,coordinator}=fixture()
 const execute=vi.fn(()=>new Promise<never>(()=>{}))
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute,maxConcurrentByProvider:{'qwen-local':1}})
 const local={...input,provider:'qwen-local' as const,model:'qwen-image-2.1-UC-Q8_0'}
 try{
  const a=await queue.submit(scope,'gpu-a',local)
  const b=await queue.submit(scope,'gpu-b',local)
  await queue.submit(scope,'cloud',input)
  await vi.waitFor(()=>expect(execute).toHaveBeenCalledTimes(2))
  const jobs=await queue.list(scope)
  expect(jobs.find(j=>j.id===b.id)?.status).toBe('queued')
  expect(jobs.find(j=>j.id===a.id)?.input.execution?.seed).toBeTypeOf('number')
  expect((await queue.submit(scope,'gpu-a',local)).input.execution).toEqual(jobs.find(j=>j.id===a.id)?.input.execution)
 }finally{await queue.stop()}
})
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'banana-tasks-'));roots.push(root);const file=path.join(root,'gallery.json');fs.writeFileSync(file,JSON.stringify({images:[]}));return {repo:new JsonGalleryRepository(file),coordinator:new GalleryWriteCoordinator(file)}}
it('persists inputs, returns the same id for duplicate submission, and cancels queued work without provider calls',async()=>{
 const {repo,coordinator}=fixture();const finishes=new Map<string,(value:unknown)=>void>()
 const execute=vi.fn((job:import('../../src/types').GenerationTask)=>new Promise(resolve=>{finishes.set(job.key,resolve)}))
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute:execute as never})
 try{
 const first=await queue.submit(scope,'same-key',input)
 expect((await queue.submit(scope,'same-key',input)).id).toBe(first.id)
 await vi.waitFor(()=>expect(execute).toHaveBeenCalledTimes(1))
 for(let index=2;index<=3;index++) await queue.submit(scope,`active-${index}`,{...input,prompt:`active ${index}`})
 await vi.waitFor(()=>expect(execute).toHaveBeenCalledTimes(3))
 const second=await queue.submit(scope,'second-key',{...input,prompt:'next'})
 await queue.cancel(scope,second.id)
 finishes.get('same-key')!({filename:'result.png',width:1,height:1,...input})
 await vi.waitFor(async()=>expect((await queue.list(scope)).find(j=>j.id===first.id)?.status).toBe('completed'))
 expect(execute).toHaveBeenCalledTimes(3)
 expect((await repo.readResources()).generationTasks?.[0].input.prompt).toBe('frozen prompt')
 }finally{await queue.stop()}
})
it('starts three requests per channel and starts the fourth when a channel slot frees',async()=>{
 const {repo,coordinator}=fixture();const finishes=new Map<string,(value:unknown)=>void>()
 const execute=vi.fn((job:import('../../src/types').GenerationTask)=>new Promise(resolve=>{finishes.set(job.key,resolve)}))
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute:execute as never})
 try{
  for(let index=1;index<=4;index++) await queue.submit(scope,`parallel-${index}`,{...input,prompt:`prompt ${index}`})
  await vi.waitFor(()=>expect(execute).toHaveBeenCalledTimes(3))
  expect((await queue.list(scope)).filter(job=>job.status==='running')).toHaveLength(3)
  expect((await queue.list(scope)).find(job=>job.key==='parallel-4')?.status).toBe('queued')
  finishes.get('parallel-1')!({filename:'result.png',width:1,height:1,...input})
  await vi.waitFor(()=>expect(execute).toHaveBeenCalledTimes(4))
  expect((await queue.list(scope)).find(job=>job.key==='parallel-4')?.status).toBe('running')
 }finally{await queue.stop()}
})
it('aborts a timed-out adapter and releases its slot even when the adapter ignores abort', async () => {
 const {repo,coordinator}=fixture()
 let finish!: (result: import('../../src/types').GenerateResult) => void
 let aborted = false
 const queue = new GenerationTaskQueue({repository:repo,coordinator,maxConcurrentByProvider:{google:1},
  execute: async (job, control) => {
   if (job.key === 'slow') {
    control.signal?.addEventListener('abort', () => { aborted = true })
    return new Promise(resolve => { finish = resolve })
   }
   return {...input,filename:'next.png',width:1,height:1}
  },
 })
 vi.useFakeTimers()
 try {
  await queue.submit(scope,'slow',input)
  await queue.submit(scope,'next',input)
  await vi.advanceTimersByTimeAsync(20 * 60_000 - 1)
  expect(aborted).toBe(false)
  expect((await queue.list(scope)).find(job=>job.key==='next')?.status).toBe('queued')
  await vi.advanceTimersByTimeAsync(1)
  await vi.waitFor(async()=>expect((await queue.list(scope)).find(job=>job.key==='next')?.status).toBe('completed'))
  expect(aborted).toBe(true)
  finish({...input,filename:'late.png',width:1,height:1})
  await vi.waitFor(async()=>expect((await queue.list(scope)).find(job=>job.key==='slow')).toMatchObject({status:'failed'}))
  expect((await queue.list(scope)).find(job=>job.key==='slow')?.result).toBeUndefined()
 } finally { await queue.stop(); vi.useRealTimers() }
})
it('Google cooldown frees its channel, retry waits for that channel, and other channels keep executing',async()=>{
 const {repo,coordinator}=fixture(),finishes=new Map<string,()=>void>(),attempts=new Map<string,number>()
 const execute=async(job:import('../../src/types').GenerationTask)=>{
  const attempt=(attempts.get(job.key)??0)+1;attempts.set(job.key,attempt)
  if(job.key==='limited'&&attempt===1)throw new TaskError('rate limited',429,false,true)
  await new Promise<void>(resolve=>finishes.set(job.key,resolve))
  return {filename:`${job.key}.png`,width:1,height:1,...input}
 }
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute,maxConcurrentByProvider:{google:1},retryDelayMs:()=>200})
 try{
  const limited=await queue.submit(scope,'limited',input)
  await vi.waitFor(async()=>expect((await queue.list(scope)).find(j=>j.id===limited.id)?.nextRetryAt).toBeTruthy())
  const retryAt=Date.parse((await queue.list(scope)).find(j=>j.id===limited.id)!.nextRetryAt!)
  await queue.submit(scope,'replacement',input)
  await queue.submit(scope,'other',{...input,provider:'seedream'})
  await vi.waitFor(()=>expect([...finishes.keys()]).toEqual(['other']))
  await vi.waitFor(()=>expect(Date.now()).toBeGreaterThanOrEqual(retryAt))
  await vi.waitFor(()=>expect(attempts.get('limited')).toBe(2))
  expect((await queue.list(scope)).find(j=>j.key==='other')?.status).toBe('running')
  finishes.get('limited')!()
  await vi.waitFor(async()=>expect((await queue.list(scope)).find(j=>j.id===limited.id)?.status).toBe('completed'))
 }finally{await queue.stop()}
})
it('auto-retries temporary failures with backoff and does not block later tasks',async()=>{
 const {repo,coordinator}=fixture()
 let attempts=0
 const execute=vi.fn(async()=>{
  attempts++
  if(attempts===1)throw new TaskError('rate limited',429,false,true)
  return {filename:'retried.png',width:1,height:1,...input}
 })
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute:execute as never,retryDelayMs:()=>10,maxRetries:3})
 try{
  const first=await queue.submit(scope,'retry-key',input)
  await vi.waitFor(async()=>expect((await queue.list(scope)).find(j=>j.id===first.id)?.status).toBe('completed'))
  const retried=await queue.list(scope)
  expect(execute).toHaveBeenCalledTimes(2)
  expect(retried.find(j=>j.id===first.id)?.retryCount).toBe(1)
  expect(retried.find(j=>j.id===first.id)?.result?.filename).toBe('retried.png')
 }finally{await queue.stop()}
})
it('never resends a generation after an upstream 503',async()=>{
 const {repo,coordinator}=fixture()
 const execute=vi.fn(async (_job: unknown, control: import('../../server/generation/task-queue').TaskControl)=>{await control.onRequestStarted(); throw new TaskError('upstream unavailable',503,true,true)})
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute:execute as never,retryDelayMs:()=>5,maxRetries:2})
 try{
  const first=await queue.submit(scope,'fail-key',{...input,prompt:'first'})
  await vi.waitFor(async()=>expect((await queue.list(scope)).find(j=>j.id===first.id)?.status).toBe('failed'))
  expect(execute).toHaveBeenCalledTimes(1)
  const second=await queue.submit(scope,'later-key',{...input,prompt:'later'})
  await vi.waitFor(()=>expect(execute.mock.calls.length).toBe(2))
  expect((await queue.list(scope)).find(j=>j.id===second.id)?.status).not.toBe('cancelled')
 }finally{await queue.stop()}
})
it('keeps completed results through restart and marks an interrupted request failed without resubmitting',async()=>{
 const {repo,coordinator}=fixture();const execute=vi.fn(async()=>({filename:'persisted.png',width:1,height:1,...input}))
 const first=new GenerationTaskQueue({repository:repo,coordinator,execute});const job=await first.submit(scope,'completed-key',input)
 await vi.waitFor(async()=>expect((await first.list(scope))[0].status).toBe('completed'));await first.stop()
 const resources=await repo.readResources();resources.generationTasks!.push({...resources.generationTasks![0],id:'interrupted',key:'lost-key',status:'running',result:undefined,runnerId:'old-runner',runnerPid:process.pid});await repo.saveResources(resources)
 const second=new GenerationTaskQueue({repository:repo,coordinator,execute})
 try{await second.start();const jobs=await second.list(scope);expect(jobs.find(j=>j.id===job.id)?.result?.filename).toBe('persisted.png');expect(jobs.find(j=>j.id==='interrupted')?.status).toBe('failed');expect(execute).toHaveBeenCalledTimes(1)}finally{await second.stop()}
})
it('continues polling the original upstream job on restart and lets later tasks run after a timeout',async()=>{
 const {repo,coordinator}=fixture()
 await repo.saveResources({generationTasks:[{id:'resume',key:'resume-key',scope,input:{...input,provider:'kling'},status:'running',runnerPid:process.pid,runnerId:'expired',upstreamTaskId:'upstream-original',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}]})
 const execute=vi.fn(async(job:import('../../src/types').GenerationTask)=>{expect(job.upstreamTaskId).toBe('upstream-original');return {filename:'resumed.png',width:1,height:1,...input}})
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute,resumable:()=>true})
 try{await queue.start();await vi.waitFor(async()=>expect((await queue.list(scope))[0].status).toBe('completed'));expect(execute).toHaveBeenCalledTimes(1)}finally{await queue.stop()}
 const slow=vi.fn((job:import('../../src/types').GenerationTask)=>job.key==='timeout'?new Promise<never>(()=>{}):Promise.resolve({filename:'later.png',width:1,height:1,...input}))
 const timeoutQueue=new GenerationTaskQueue({repository:repo,coordinator,execute:slow as never,timeoutMs:10})
 try{
  await timeoutQueue.submit(scope,'timeout',input)
  await vi.waitFor(async()=>expect((await timeoutQueue.list(scope)).at(-1)?.status).toBe('failed'))
  const next=await timeoutQueue.submit(scope,'after-timeout',input)
  await vi.waitFor(()=>expect(slow).toHaveBeenCalledTimes(2))
  expect((await timeoutQueue.list(scope)).find(job=>job.id===next.id)?.status).not.toBe('queued')
 }finally{await timeoutQueue.stop()}
})

it('keeps completed results pending for library saving without blocking the next generation',async()=>{
 const {repo,coordinator}=fixture()
 const execute=vi.fn(async()=>({filename:'result.png',width:1,height:1,...input}))
 const saveWork=vi.fn(async()=>{throw new Error('library unavailable')})
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute,saveWork})
 try{
  await queue.submit(scope,'save-first',input)
  await vi.waitFor(async()=>expect((await queue.list(scope))[0].workSaveError).toContain('library unavailable'))
  await queue.submit(scope,'save-next',input)
  await vi.waitFor(()=>expect(execute).toHaveBeenCalledTimes(2))
  await vi.waitFor(async()=>expect((await queue.list(scope)).every(job=>job.status==='completed')).toBe(true))
  expect((await queue.list(scope)).every(job=>job.workSavePending)).toBe(true)
 }finally{await queue.stop()}
})

it('keeps preparation uncounted, persists send time, and leaves other work running during provider cooldown',async()=>{
 const {repo,coordinator}=fixture()
 let send!:()=>Promise<void>
 const execute=vi.fn(async(job:import('../../src/types').GenerationTask,control:import('../../server/generation/task-queue').TaskControl)=>{
  if(job.key==='cooldown'){
   await new Promise<void>(resolve=>{send=async()=>{await control.onRequestStarted();resolve()}})
   throw Object.assign(new Error('rate limited'),{status:429,retryAfterMs:120000})
  }
  await control.onRequestStarted()
  return {filename:'other.png',width:1,height:1,...input}
 })
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute,retryDelayMs:()=>10})
 try{
  const first=await queue.submit(scope,'cooldown',input)
  await vi.waitFor(()=>expect(send).toBeTypeOf('function'))
  expect((await queue.list(scope))[0].requestStartedAt).toBeUndefined()
  await send()
  await vi.waitFor(async()=>expect((await queue.list(scope))[0].nextRetryAt).toBeTruthy())
  const failed=(await queue.list(scope))[0]
  expect(failed.requestStartedAt).toBeTruthy()
  expect(Date.parse(failed.nextRetryAt!)-Date.parse(failed.updatedAt)).toBeGreaterThanOrEqual(119000)
  await queue.submit(scope,'other',{...input,provider:'seedream'})
  await vi.waitFor(async()=>expect((await queue.list(scope)).find(j=>j.key==='other')?.status).toBe('completed'))
  expect((await queue.list(scope)).find(j=>j.id===first.id)?.retryCount).toBe(1)
  expect(execute).toHaveBeenCalledTimes(2)
 }finally{await queue.stop()}
})
it('re-queries a resumable job after network failure without resetting request time',async()=>{
 const {repo,coordinator}=fixture()
 const started='2026-10-01T01:00:00.000Z'
 await repo.saveResources({generationTasks:[{id:'resume-clock',key:'resume-clock',scope,input:{...input,provider:'kling'},status:'running',runnerId:'expired',runnerPid:process.pid,upstreamTaskId:'original',requestStartedAt:started,createdAt:started,updatedAt:started}]})
 const execute=vi.fn(async(job:import('../../src/types').GenerationTask)=>{
  expect(job.upstreamTaskId).toBe('original');expect(job.requestStartedAt).toBe(started)
  if(execute.mock.calls.length===1)throw new Error('fetch failed')
  return {filename:'resumed.png',width:1,height:1,...input}
 })
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute,resumable:()=>true,retryDelayMs:()=>5})
 try{
  await queue.start()
  await vi.waitFor(async()=>expect((await queue.list(scope))[0].status).toBe('completed'),{timeout:5000})
  expect(execute).toHaveBeenCalledTimes(2)
  expect((await queue.list(scope))[0].requestStartedAt).toBe(started)
 }finally{await queue.stop()}
})
it('does not submit when the send marker cannot be persisted',async()=>{
 const {repo,coordinator}=fixture()
 const save=repo.saveResources.bind(repo)
 vi.spyOn(repo,'saveResources').mockImplementation(async(resources,...args)=>{
  if(resources.generationTasks?.some(j=>j.requestStartedAt))throw new Error('disk full')
  return save(resources,...args)
 })
 const submitted=vi.fn()
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute:async(_job,control)=>{
  await control.onRequestStarted();submitted()
  return {filename:'never.png',width:1,height:1,...input}
 }})
 try{
  await queue.submit(scope,'marker-fails',input)
  await vi.waitFor(async()=>expect((await queue.list(scope))[0].status).toBe('failed'))
  expect(submitted).not.toHaveBeenCalled()
 }finally{await queue.stop()}
})
it('stops after the default three extra retries for a confirmed rate limit',async()=>{
 const {repo,coordinator}=fixture()
 const execute=vi.fn(async()=>{throw Object.assign(new Error('limited'),{status:429})})
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute,retryDelayMs:()=>10})
 try{
  await queue.submit(scope,'three-extra',input)
  await vi.waitFor(async()=>expect((await queue.list(scope))[0].status).toBe('failed'),{timeout:5000})
  expect(execute).toHaveBeenCalledTimes(4)
  expect((await queue.list(scope))[0].retryCount).toBe(3)
 }finally{await queue.stop()}
})
it('re-queries a timed-out resumable task without waiting for a late rejection', async () => {
 const {repo,coordinator}=fixture()
 let rejectOriginal!: (error:Error)=>void
 const execute=vi.fn(async(job:import('../../src/types').GenerationTask,control:import('../../server/generation/task-queue').TaskControl)=>{
  if(execute.mock.calls.length===1){
   await control.onRequestStarted()
   await control.onUpstreamTask('original-after-timeout')
   return new Promise<never>((_resolve,reject)=>{rejectOriginal=reject})
  }
  expect(job.upstreamTaskId).toBe('original-after-timeout')
  return {...input,filename:'recovered.png',width:1,height:1}
 })
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute,resumable:()=>true,timeoutMs:80,retryDelayMs:()=>10})
 try {
  await queue.submit(scope,'late-network-failure',{...input,provider:'kling'})
  await vi.waitFor(async()=>expect((await queue.list(scope))[0].status).toBe('completed'))
  rejectOriginal(new Error('fetch failed'))
  const job = (await queue.list(scope))[0]
  expect(job).toMatchObject({status:'completed',upstreamTaskId:'original-after-timeout',attemptCount:2})
  expect(job.requestStartedAt).toBe(job.attempts?.[0].requestStartedAt)
  expect(execute).toHaveBeenCalledTimes(2)
 } finally {await queue.stop()}
})

it('Google 429 cools all Google jobs, persists across restart and retains failed attempts after success',async()=>{
 const {repo,coordinator}=fixture(),calls:string[]=[]
 const execute=async(job:import('../../src/types').GenerationTask,control:import('../../server/generation/task-queue').TaskControl)=>{
  await control.onRequestStarted();calls.push(job.key)
  if(job.key==='limited')throw new TaskError('limited',429,false,true)
  return {filename:'ok.png',width:1,height:1,...input}
 }
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute,maxConcurrentByProvider:{google:1},retryDelayMs:()=>10000,maxRetries:0})
 try{
  await queue.submit(scope,'limited',input)
  await vi.waitFor(async()=>expect((await queue.list(scope))[0].status).toBe('failed'))
  await queue.submit(scope,'new-google',input)
  await queue.submit(scope,'seedream-during-cooldown',{...input,provider:'seedream'})
  await vi.waitFor(()=>expect(calls).toContain('seedream-during-cooldown'))
  expect(calls).not.toContain('new-google')
  expect((await repo.readResources()).generationProviderStates?.google?.consecutiveRateLimits).toBe(1)
 }finally{await queue.stop()}
 const resumed=new GenerationTaskQueue({repository:repo,coordinator,execute,maxConcurrentByProvider:{google:1}})
 try{
  await resumed.start();await resumed.submit(scope,'seedream-after-restart',{...input,provider:'seedream'})
  await vi.waitFor(()=>expect(calls).toContain('seedream-after-restart'))
  expect(calls).not.toContain('new-google')
  const resources=await repo.readResources();resources.generationProviderStates!.google!.cooldownUntil=new Date(Date.now()-1).toISOString();await repo.saveResources(resources)
  await resumed.submit(scope,'wake',{...input,provider:'seedream'})
  await vi.waitFor(()=>expect(calls).toContain('new-google'))
  expect((await resumed.list(scope))[0].attempts?.[0]).toMatchObject({outcome:'failed',failure:{httpStatus:429},sent:true})
  expect((await repo.readResources()).generationProviderStates?.google?.consecutiveRateLimits).toBe(0)
 }finally{await resumed.stop()}
})
it('successful retry retains both attempt outcomes instead of erasing its first error',async()=>{
 const {repo,coordinator}=fixture();let count=0
 const queue=new GenerationTaskQueue({repository:repo,coordinator,retryDelayMs:()=>5,execute:async(_job,control)=>{
  await control.onRequestStarted();if(++count===1)throw new TaskError('limited',429,false,true)
  return {filename:'ok.png',width:1,height:1,...input}
 }})
 try{
  await queue.submit(scope,'attempt-history',input)
  await vi.waitFor(async()=>expect((await queue.list(scope))[0].status).toBe('completed'))
  expect((await queue.list(scope))[0].attempts?.map(a=>a.outcome)).toEqual(['failed','completed'])
 }finally{await queue.stop()}
})
it.each([[0,0,0,30000],[0,1,0,37500],[10,0,0,600000],[1,0,900000,900000]] as const)('Google channel backoff count=%i jitter=%i server=%i yields %i ms',async(previous,random,server,expected)=>{
 const {repo,coordinator}=fixture(),now=Date.now()
 const clock=vi.spyOn(Date,'now').mockReturnValue(now),rng=vi.spyOn(Math,'random').mockReturnValue(random)
 await repo.saveResources({generationProviderStates:{google:{consecutiveRateLimits:previous,cooldownUntil:new Date(0).toISOString()}}})
 const queue=new GenerationTaskQueue({repository:repo,coordinator,maxRetries:0,execute:async()=>{throw new TaskError('limited',429,false,true,{category:'rate_limit',message:'limited',retryable:true,uncertain:false,retryAfterMs:server})}})
 try{
  await queue.submit(scope,'backoff-boundary',input)
  await vi.waitFor(async()=>expect((await queue.list(scope))[0].status).toBe('failed'))
  const state=(await repo.readResources()).generationProviderStates!.google!
  expect(Date.parse(state.cooldownUntil)-now).toBe(expected)
  expect(state.consecutiveRateLimits).toBe(previous+1)
 }finally{await queue.stop();clock.mockRestore();rng.mockRestore()}
})
it('attempt history stays bounded while the total count survives',async()=>{
 const {repo,coordinator}=fixture();let finish!:(v:import('../../src/types').GenerateResult)=>void
 const queue=new GenerationTaskQueue({repository:repo,coordinator,timeoutMs:10,execute:async(_job,control)=>{
  await control.onRequestStarted();return new Promise(resolve=>{finish=resolve})
 }})
 try{
  const job=await queue.submit(scope,'late-attempt',input)
  await vi.waitFor(async()=>expect((await queue.list(scope))[0].status).toBe('failed'))
  finish({filename:'late.png',width:1,height:1,...input})
  expect((await queue.list(scope))[0].attempts).toHaveLength(1)
  expect((await queue.list(scope))[0].attempts![0].outcome).toBe('failed')
  const resources=await repo.readResources(),stored=resources.generationTasks!.find(j=>j.id===job.id)!
  stored.attemptCount=12;stored.attempts=Array.from({length:8},(_,i)=>({...stored.attempts![0],sequence:i+5}));stored.status='queued';delete stored.result
  await repo.saveResources(resources)
  await queue.submit(scope,'wake-bound',{...input,provider:'seedream'})
  await vi.waitFor(async()=>expect((await queue.list(scope))[0].attemptCount).toBe(13))
  expect((await queue.list(scope))[0].attempts?.map(a=>a.sequence)).toEqual([6,7,8,9,10,11,12,13])
 }finally{await queue.stop()}
})
it('recovery marks the interrupted running attempt failed without fabricating an old attempt',async()=>{
 const {repo,coordinator}=fixture(),time=new Date().toISOString()
 await repo.saveResources({generationTasks:[{id:'interrupted-attempt',key:'interrupted-attempt',scope,input,status:'running',runnerId:'gone',runnerPid:process.pid,createdAt:time,updatedAt:time,attemptCount:1,attempts:[{sequence:1,startedAt:time,requestStartedAt:time,sent:true,outcome:'running'}]}]})
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute:async()=>{throw Error('must not send')}})
 try{
  await queue.start();const job=(await queue.list(scope))[0]
  expect(job.status).toBe('failed');expect(job.attempts?.[0]).toMatchObject({outcome:'failed',endedAt:expect.any(String)})
 }finally{await queue.stop()}
})
it('a long Google cooldown does not delay an earlier retry on another provider',async()=>{
 const {repo,coordinator}=fixture();let peerCalls=0
 const queue=new GenerationTaskQueue({repository:repo,coordinator,retryDelayMs:()=>50,execute:async(job)=>{
  if(job.input.provider==='google')throw new TaskError('limited',429,false,true,{category:'rate_limit',message:'limited',retryable:true,uncertain:false,retryAfterMs:10000})
  if(++peerCalls===1)throw new TaskError('limited',429,false,true)
  return {filename:'peer.png',width:1,height:1,...input}
 }})
 try{
  await queue.submit(scope,'early-peer',{...input,provider:'seedream'})
  await vi.waitFor(async()=>expect((await queue.list(scope))[0].retryCount).toBe(1),{interval:5})
  await queue.submit(scope,'late-google',input)
  await vi.waitFor(()=>expect(peerCalls).toBe(2),{timeout:700,interval:10})
 }finally{await queue.stop()}
})
it('手动续查取回原结果，忽略之前执行超时后的迟到图片',async()=>{
 const {repo,coordinator}=fixture();let release!:()=>void
 const execute=vi.fn(async(job:import('../../src/types').GenerationTask,control:import('../../server/generation/task-queue').TaskControl)=>{
  if(job.upstreamTaskId) return {...job.input,filename:'resumed.png',width:1,height:1}
  await control.onRequestStarted()
  await control.onUpstreamTask('upstream-original')
  await new Promise<void>(resolve=>{release=resolve})
  return {...job.input,filename:'late.png',width:1,height:1}
 })
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute,resumable:()=>true,timeoutMs:100,maxRetries:0})
 try {
  const job=await queue.submit(scope,'timeout-original',{...input,provider:'kling',model:'kling/kling-v3-omni-image-generation'})
  await vi.waitFor(async()=>expect((await queue.list(scope))[0].status).toBe('failed'))
  await queue.resumeQuery(scope,job.id,'recover-request',0)
  await vi.waitFor(async()=>expect((await queue.list(scope))[0].status).toBe('completed'))
  release()
  await new Promise(resolve=>setImmediate(resolve))
  expect((await queue.list(scope))[0]).toMatchObject({upstreamTaskId:'upstream-original',result:{filename:'resumed.png'}})
  expect(execute).toHaveBeenCalledTimes(2)
 } finally {release?.();await queue.stop()}
})

it('旧的恢复回执重试不能覆盖后来的一轮恢复，累计尝试保留而原请求不重置',async()=>{
 const {repo,coordinator}=fixture()
 const original={id:'recover',key:'old',scope,input:{...input,provider:'kling' as const,model:'kling/kling-v3-omni-image-generation'},status:'uncertain' as const,upstreamTaskId:'remote',createdAt:'2026-11-04',updatedAt:'2026-11-04',requestStartedAt:'2026-11-04T00:00:00Z',attemptCount:1}
 await repo.saveResources!({generationTasks:[original]},scope)
 const execute=vi.fn(async()=>{throw new TaskError('上游结果未知',409,true,false,{category:'unknown',message:'上游结果未知',uncertain:true,retryable:false})})
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute,resumable:()=>true,maxRetries:0})
 try{
  await queue.resumeQuery(scope,'recover','A',0)
  await vi.waitFor(async()=>expect((await queue.list(scope))[0].status).toBe('failed'))
  await queue.resumeQuery(scope,'recover','A',0);expect(execute).toHaveBeenCalledTimes(1)
  await queue.resumeQuery(scope,'recover','B',1)
  await vi.waitFor(async()=>expect((await queue.list(scope))[0].status).toBe('failed'))
  await expect(queue.resumeQuery(scope,'recover','A',0)).rejects.toMatchObject({status:409})
  const job=(await queue.list(scope))[0];expect(job.attemptCount).toBe(3);expect(job.requestStartedAt).toBe(original.requestStartedAt);expect(execute).toHaveBeenCalledTimes(2)
 }finally{await queue.stop()}
})

it('shares one active-task count across entry limits and releases slots at terminal status', async () => {
 const {repo,coordinator}=fixture()
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute:()=>new Promise(()=>{})})
 try {
  for (let i=0;i<20;i++) await queue.submit(scope,`remote-${i}`,input)
  await expect(queue.submit(scope,'remote-full',input)).rejects.toMatchObject({status:429,code:'QUEUE_FULL'})
  for (let i=20;i<100;i++) await queue.submit(scope,`local-${i}`,input,{maxActive:100})
  await expect(queue.submit(scope,'local-full',input,{maxActive:100})).rejects.toMatchObject({status:429,code:'QUEUE_FULL'})
  const queued=(await queue.list(scope)).find(job=>job.key==='local-99')!
  await queue.cancel(scope,queued.id)
  await expect(queue.submit(scope,'local-replacement',input,{maxActive:100})).resolves.toMatchObject({key:'local-replacement'})
  await expect(queue.submit(scope,'remote-still-full',input)).rejects.toMatchObject({code:'QUEUE_FULL'})
 } finally {await queue.stop()}
})

it('polls an idle JSON queue without cloning resources or acquiring the write lock, but notices an external replacement', async () => {
 const {repo,coordinator}=fixture()
 const time=new Date().toISOString()
 const finished={id:'finished',key:'finished',scope,input,status:'failed' as const,createdAt:time,updatedAt:time}
 await repo.saveResources({generationTasks:[finished]})
 const writes=vi.spyOn(coordinator,'run'), reads=vi.spyOn(repo,'readResources')
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute:async()=>{throw Error('must not send')}})
 vi.useFakeTimers()
 try {
  await queue.start()
  await vi.advanceTimersByTimeAsync(0)
  writes.mockClear(); reads.mockClear()
  await vi.advanceTimersByTimeAsync(6_000)
  expect(writes).not.toHaveBeenCalled()
  expect(reads).not.toHaveBeenCalled()

  const file=path.join(roots.at(-1)!,'gallery.json')
  const replacement=file+'.external'
  fs.writeFileSync(replacement,JSON.stringify({images:[],resources:{generationTasks:[{
   ...finished,id:'external',scope:{...scope,workspaceId:'external'},status:'running',runnerId:'gone',runnerPid:process.pid,
  }]}}))
  fs.renameSync(replacement,file)
  await vi.advanceTimersByTimeAsync(2_000)
  expect((await repo.readResources()).generationTasks?.[0].status).toBe('failed')
 } finally { await queue.stop(); vi.useRealTimers() }
})

it('backs off repeated automatic library failures without writing the same error again', async () => {
 const {repo,coordinator}=fixture()
 const time=new Date().toISOString()
 await repo.saveResources({generationTasks:[{id:'pending',key:'pending',scope,input,status:'completed',workSavePending:true,createdAt:time,updatedAt:time}]})
 const save=vi.spyOn(repo,'saveResources')
 const saveWork=vi.fn(async()=>{throw new Error('library unavailable')})
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute:async()=>{throw Error('must not send')},saveWork})
 vi.useFakeTimers()
 try {
  await queue.start()
  await vi.advanceTimersByTimeAsync(0)
  expect((await queue.list(scope))[0].workSaveError).toBe('library unavailable')
  expect(saveWork).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(saveWork).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(8_000)
  expect(saveWork).toHaveBeenCalledTimes(2)
  expect(save).toHaveBeenCalledTimes(1)
 } finally { await queue.stop(); vi.useRealTimers() }
})

it('retries only the terminal write and releases the same-provider slot', async () => {
 const {repo,coordinator}=fixture()
 const save=repo.saveResources.bind(repo)
 let rejected=0
 vi.spyOn(repo,'saveResources').mockImplementation(async resources=>{
  if (!rejected && resources.generationTasks?.some(job=>job.key==='first' && job.status==='completed')) {
   rejected++
   throw new Error('temporary disk failure')
  }
  await save(resources)
 })
 let release!:()=>void
 const firstMayFinish=new Promise<void>(resolve=>{release=resolve})
 const execute=vi.fn(async (job:import('../../src/types').GenerationTask)=>{
  if(job.key==='first') await firstMayFinish
  return {...input,filename:job.key+'.png',width:1,height:1}
 })
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute,maxConcurrentByProvider:{google:1}})
 try {
  await queue.submit(scope,'first',input)
  await queue.submit(scope,'second',input)
  expect((await queue.list(scope)).find(job=>job.key==='second')?.status).toBe('queued')
  release()
  await vi.waitFor(async()=>expect((await queue.list(scope)).map(job=>job.status)).toEqual(['completed','completed']),{timeout:3000})
  expect(rejected).toBe(1)
  expect(execute.mock.calls.map(([job])=>job.key)).toEqual(['first','second'])
 } finally { release();await queue.stop() }
})

it('never resubmits an interrupted task, even when the send marker was absent',async()=>{
 const {repo,coordinator}=fixture(),time=new Date().toISOString()
 const base={scope,input,status:'running' as const,runnerId:'gone',runnerPid:process.pid,createdAt:time,updatedAt:time}
 await repo.saveResources({generationTasks:[
  {...base,id:'unsent',key:'unsent',attemptCount:1,attempts:[{sequence:1,startedAt:time,sent:false,outcome:'running'}]},
  {...base,id:'sent',key:'sent',requestStartedAt:time,attemptCount:1,attempts:[{sequence:1,startedAt:time,sent:true,outcome:'running'}]},
  {...base,id:'legacy',key:'legacy'},
  {...base,id:'original',key:'original',upstreamTaskId:'old-remote',attemptCount:1,attempts:[{sequence:1,startedAt:time,sent:false,outcome:'running'}]},
 ]})
 const execute=vi.fn(async (job:import('../../src/types').GenerationTask)=>({...input,filename:job.key+'.png',width:1,height:1}))
 const queue=new GenerationTaskQueue({repository:repo,coordinator,execute})
 try {
  await queue.start()
  await vi.waitFor(async()=>expect((await queue.list(scope)).map(job=>job.status)).toEqual(['failed','failed','failed','failed']))
  expect(execute).not.toHaveBeenCalled()
 } finally {await queue.stop()}
})

it('aborts an active run on stop and refuses new submissions', async () => {
 const {repo,coordinator}=fixture()
 let signal: AbortSignal | undefined
 const queue = new GenerationTaskQueue({repository:repo,coordinator,execute:async (_job, control) => {
  signal = control.signal
  return new Promise<never>(() => {})
 }})
 try {
  await queue.submit(scope,'running-at-shutdown',input)
  await vi.waitFor(()=>expect(signal).toBeDefined())
  await queue.stop()
  expect(signal?.aborted).toBe(true)
  await expect(queue.submit(scope,'new-at-shutdown',input)).rejects.toMatchObject({status:503})
 } finally {await queue.stop()}
})
