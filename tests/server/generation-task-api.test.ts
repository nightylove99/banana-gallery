import {SeedreamImageGenerationRequestError} from '../../server/ai/seedream-image-provider'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import {afterEach,expect,it,vi} from 'vitest'
import {createApp} from '../../server/app'
import {GenerationTaskQueue} from '../../server/generation/task-queue'
import { createOpenAICompatibleRuntimeProvider } from '../../server/ai/openai-compatible-runtime'
import { loadAppEnv } from '../../server/config/env'
import type {ImageGenerationProvider} from '../../server/ai/image-generation-provider'
import {GalleryWriteCoordinator} from '../../server/gallery/write-coordinator'
import {DiskAssetStorage} from '../../server/storage/disk-asset-storage'
import {generationTasksFileFor} from '../../server/gallery/generation-task-storage'
import {JsonGalleryRepository} from '../../server/gallery/json-gallery-repository'
import type {GenerationTask} from '../../src/types'
import {IMAGE_GENERATION_MODEL_DEFINITIONS,imageGenerationModelKey,type ImageGenerationProviderName} from '../../src/lib/image-generation-providers'
const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const fn of cleanup.splice(0))await fn()})
const input={prompt:'frozen prompt',referenceFilenames:['a.png','b.png'],provider:'google',model:'gemini-nano-banana-2.1',aspectRatio:'1:1',imageSize:'2K'} satisfies GenerationTask['input']
function fixture(provider:ImageGenerationProvider,extra:Partial<Parameters<typeof createApp>[0]>={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'banana-job-api-')),dataFile=path.join(root,'gallery-data.json')
 fs.mkdirSync(path.join(root,'references'));fs.writeFileSync(path.join(root,'references','a.png'),'A');fs.writeFileSync(path.join(root,'references','b.png'),'B')
 fs.writeFileSync(dataFile,JSON.stringify({images:[{id:'source',filename:'source.png',prompt:'source',referenceImages:['a.png','b.png'],tags:[],favorited:false,createdAt:'2026-09-11',width:1,height:1,assetType:'recipe'}]}))
 const options={ai:{models:{generateContent:async()=>({candidates:[]})}},strategy:{mode:'apiKey' as const,apiKey:'fixture'},dataFile,imagesDir:path.join(root,'images'),referencesDir:path.join(root,'references'),userAuthMode:'local' as const,imageGenerationProvider:provider,localAuthSession:{user:{id:'test',email:'test@local'},workspace:{id:'test',name:'Test'}},generationRetryBaseDelayMs:20,...extra}
 let app=createApp(options);fs.writeFileSync(path.join(root,'images','source.png'),'original')
 cleanup.push(async()=>{await app.locals.stopTaskQueue();fs.rmSync(root,{recursive:true,force:true})})
 return {get app(){return app},root,async restart(){await app.locals.stopTaskQueue();app=createApp(options);await app.locals.startTaskQueue();return app}}
}
function controlledGeneration(){
 const active=new Map<string,number>(),peak=new Map<string,number>(),finishes=new Map<string,()=>void>()
 const models:Record<string,ImageGenerationProvider>={}
 const providers=new Map<ImageGenerationProviderName,ImageGenerationProvider>()
 for(const definition of IMAGE_GENERATION_MODEL_DEFINITIONS){
  const name=definition.provider
  if(!providers.has(name))providers.set(name,{generateImage:async args=>{
   await args.onRequestStarted?.()
   const count=(active.get(name)??0)+1;active.set(name,count);peak.set(name,Math.max(peak.get(name)??0,count))
   await new Promise<void>(resolve=>finishes.set(args.prompt,resolve))
   active.set(name,active.get(name)!-1)
   return {buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC','base64'),mimeType:'image/png'}
  }})
  models[imageGenerationModelKey(name,definition.model)]=providers.get(name)!
 }
 const fx=fixture(providers.get('google')!,{imageGenerationModelProviders:models,localQwenStatus:async()=>({available:true})})
 const submit=async(name:ImageGenerationProviderName,index:number,model?:string)=>{
  const definition=IMAGE_GENERATION_MODEL_DEFINITIONS.find(d=>d.provider===name&&(!model||d.model===model))!
  const key=`${name}-${index}`
  const response=await request(fx.app).post('/api/generation-tasks').send({...input,referenceFilenames:[],provider:name,model:definition.model,quality:definition.fixedQuality??'high',key,prompt:key})
  expect(response.status,response.body.error).toBe(202)
  return response.body.id as string
 }
 const jobs=async()=>((await request(fx.app).get('/api/generation-tasks')).body.tasks as GenerationTask[])
 return {fx,active,peak,finishes,submit,jobs}
}
it.each([['google',1],['qwen-local',1],['seedream',3],['qwen',3],['kling',3],['openai-compatible',3]] as const)('应用默认限制 %s 渠道并发为 %i，超额项排队并在空位后接续',async(name,limit)=>{
 const c=controlledGeneration()
 for(let index=1;index<=limit+1;index++)await c.submit(name,index)
 await vi.waitFor(async()=>{
  expect(c.active.get(name)).toBe(limit)
  const jobs=await c.jobs()
  expect(jobs.filter(j=>j.status==='running')).toHaveLength(limit)
  expect(jobs.find(j=>j.key===`${name}-${limit+1}`)?.status).toBe('queued')
 })
 c.finishes.get(`${name}-1`)!()
 await vi.waitFor(async()=>expect((await c.jobs()).find(j=>j.key===`${name}-${limit+1}`)?.status).toBe('running'))
 expect(c.peak.get(name)).toBe(limit)
})
it('Qwen and Krea share GPU1 while a cloud channel runs independently',async()=>{
 const c=controlledGeneration()
 await c.submit('qwen-local',1)
 await vi.waitFor(()=>expect(c.active.get('qwen-local')).toBe(1))
 await c.submit('krea-local',1)
 await c.submit('seedream',1)
 await vi.waitFor(()=>expect(c.active.get('seedream')).toBe(1))
 expect(c.active.get('krea-local')??0).toBe(0)
 const krea=(await c.jobs()).find(j=>j.key==='krea-local-1')!
 expect(krea.status).toBe('queued')
 expect(krea.input.execution?.workflowVersion).toBe('krea2-turbo-v1')
 expect(krea.input.execution?.steps).toBe(8)
 c.finishes.get('qwen-local-1')!()
 await vi.waitFor(()=>expect(c.active.get('krea-local')).toBe(1))
 expect(c.active.get('qwen-local')).toBe(0)
})
it('同一个人工作区可同时运行 Google 1、OpenAI 兼容 3、Seedream 3，共七个任务并独立接续',async()=>{
 const c=controlledGeneration()
 for(const name of ['google','openai-compatible','seedream'] as const)for(let i=1;i<=(name==='google'?2:4);i++)await c.submit(name,i)
 await vi.waitFor(async()=>{
  expect((await c.jobs()).filter(j=>j.status==='running')).toHaveLength(7)
  expect([...c.active.entries()].sort()).toEqual([['google',1],['openai-compatible',3],['seedream',3]])
 })
 for(const name of ['google','openai-compatible','seedream'] as const){
  c.finishes.get(`${name}-1`)!()
  await vi.waitFor(async()=>expect((await c.jobs()).find(j=>j.key===`${name}-${name==='google'?2:4}`)?.status).toBe('running'))
 }
 expect([...c.peak.entries()].sort()).toEqual([['google',1],['openai-compatible',3],['seedream',3]])
})
it('Qwen 同渠道共享三个执行位',async()=>{
 const name = 'qwen'
 const c=controlledGeneration(),models=IMAGE_GENERATION_MODEL_DEFINITIONS.filter(d=>d.provider===name)
 for(let i=1;i<=4;i++)await c.submit(name,i,models[(i-1)%models.length].model)
 await vi.waitFor(async()=>{
  expect((await c.jobs()).filter(j=>j.status==='running')).toHaveLength(3)
  expect((await c.jobs()).find(j=>j.key===`${name}-4`)?.status).toBe('queued')
 })
 expect(c.peak.get(name)).toBe(3)
})
it('returns before generation finishes, retains ordered input and durable assets after restart, saves once and backs up history',async()=>{
 let finish!:()=>void
 const generateImage=vi.fn(async(args:Parameters<ImageGenerationProvider['generateImage']>[0])=>{expect(args.referenceImages.map(r=>r.data.toString())).toEqual(['A','B']);await new Promise<void>(resolve=>{finish=resolve});return {buffer:recoveredPng,mimeType:'image/png'}})
 const fx=fixture({generateImage})
 const submit=await request(fx.app).post('/api/generation-tasks').send({...input,key:'original',sourceAssetId:'source'});expect(submit.status).toBe(202)
 const id=submit.body.id
 expect((await request(fx.app).post('/api/generation-tasks').send({...input,key:'original',sourceAssetId:'source'})).body.id).toBe(id)
 await vi.waitFor(()=>expect(generateImage).toHaveBeenCalledTimes(1));finish()
 await vi.waitFor(async()=>expect((await request(fx.app).get('/api/generation-tasks')).body.tasks[0].status).toBe('completed'))
 await fx.restart()
 const job=(await request(fx.app).get('/api/generation-tasks')).body.tasks[0]
 expect((await request(fx.app).get(`/api/assets/images/${job.result.filename}`)).status).toBe(200)
 const automatic=(await request(fx.app).get('/api/images')).body.find((image:{filename:string;assetType:string})=>image.filename===job.result.filename&&image.assetType==='work')
 expect(automatic).toBeTruthy()
 expect(automatic.prompt).toBe(input.prompt)
 expect(automatic.referenceImages).toEqual(['a.png','b.png'])
 const a=await request(fx.app).post('/api/generate/save').send({taskId:id,assetType:'work',prompt:'tampered',referenceFilenames:[]})
 expect(a.status).toBe(200);expect(a.body.prompt).toBe(input.prompt);expect(a.body.referenceImages).toEqual(['a.png','b.png']);expect(a.body.generation.model).toBe(input.model)
 const b=await request(fx.app).post('/api/generate/save').send({taskId:id,assetType:'work'});expect(a.body.id).toBe(b.body.id)
 expect(a.body.id).toBe(automatic.id)
 await request(fx.app).delete(`/api/images/${a.body.id}`);await request(fx.app).delete(`/api/trash/${a.body.id}`).send({confirm:true})
 expect((await request(fx.app).get(`/api/assets/images/${job.result.filename}`)).status).toBe(200)
 await request(fx.app).delete('/api/images/source');await request(fx.app).delete('/api/trash/source').send({confirm:true})
 expect(fs.existsSync(path.join(fx.root,'references','a.png'))).toBe(true)
 const backup=await request(fx.app).post('/api/personal/backups');expect(backup.status).toBe(201)
 expect(fs.existsSync(path.join(fx.root,'backups',backup.body.id,'public','images',job.result.filename))).toBe(true)
 expect(generateImage).toHaveBeenCalledTimes(1)
})
it('rejects inaccessible references and retries temporary provider failures automatically',async()=>{
 const generateImage=vi.fn(async()=>{throw Object.assign(new Error('rate limited'),{status:429})})
 const fx=fixture({generateImage})
 expect((await request(fx.app).post('/api/generation-tasks').send({...input,key:'bad',referenceFilenames:['foreign.png']})).status).toBe(404)
 expect(generateImage).not.toHaveBeenCalled()
 expect((await request(fx.app).post('/api/generation-tasks').send({...input,key:'retry-temp'})).status).toBe(202)
 await vi.waitFor(async()=>{
  const job=(await request(fx.app).get('/api/generation-tasks')).body.tasks[0]
  expect(job).toMatchObject({ status: 'failed', retryCount: 3, failure: { category: 'rate_limit' } })
 })
 await fx.restart()
 expect(generateImage).toHaveBeenCalledTimes(4)
})
it('fails a disconnected Google request without pausing its next task or re-sending', async () => {
 const generateImage = vi.fn<ImageGenerationProvider['generateImage']>(async ({ onRequestStarted }) => {
  await onRequestStarted?.()
  if (generateImage.mock.calls.length === 1) throw new TypeError('terminated', { cause: { code: 'ECONNRESET' } })
  return { buffer: recoveredPng, mimeType: 'image/png' }
 })
 const fx = fixture({ generateImage })
 const api = request(fx.app)
 const submit = (key: string) => api.post('/api/generation-tasks').send({ ...input, key }).expect(202)
 const first = await submit('disconnected')
 const next = await submit('next')
 await vi.waitFor(async () => {
  const { body: { tasks } } = await api.get('/api/generation-tasks')
  expect(tasks.find((job: GenerationTask) => job.id === first.body.id)).toMatchObject({
   status: 'failed', failure: { category: 'network', message: expect.stringContaining('上游可能仍在处理'), detail: 'terminated (ECONNRESET)' },
  })
  expect(tasks.find((job: GenerationTask) => job.id === next.body.id)).toMatchObject({ status: 'completed' })
 })
 expect(generateImage).toHaveBeenCalledTimes(2)
})

it('allows a legacy uncertain record to be trashed and purged without acknowledgment', async () => {
 const fx = fixture({ generateImage: vi.fn() })
 seedHistory(fx, [storedJob('legacy', 'uncertain'), storedJob('ack', 'uncertain')])
 const api = request(fx.app)
 const trashed = await api.post('/api/generation-tasks/legacy/trash').send({}).expect(200)
 expect(trashed.body.acknowledgedAt).toBeUndefined()
 await api.delete('/api/generation-tasks/legacy').send({ confirm: true }).expect(200)
 const acknowledged = await api.post('/api/generation-tasks/ack/acknowledge').send({ confirm: true }).expect(200)
 expect(acknowledged.body.acknowledgedAt).toBeTruthy()
})

it('a result write failure is terminal without calling the provider again',async()=>{
 const generateImage=vi.fn(async()=>({buffer:recoveredPng,mimeType:'image/png'}));const fx=fixture({generateImage})
 const original=fs.promises.writeFile.bind(fs.promises)
 const spy=vi.spyOn(fs.promises,'writeFile').mockImplementation(async(file,...args)=>{if(path.basename(String(file)).startsWith('.gen_'))throw new Error('ENOSPC');return original(file,...args)})
 try{
  await request(fx.app).post('/api/generation-tasks').send({...input,key:'disk-failure'})
  await vi.waitFor(async()=>expect((await request(fx.app).get('/api/generation-tasks')).body.tasks[0].status).toBe('failed'))
  expect(generateImage).toHaveBeenCalledTimes(1)
  await new Promise(resolve=>setTimeout(resolve,50))
  expect(generateImage).toHaveBeenCalledTimes(1)
  await fx.restart();expect(generateImage).toHaveBeenCalledTimes(1)
 }finally{spy.mockRestore()}
})
it('permanently cleans only a confirmed trashed task and keeps files shared with gallery records',async()=>{
 const fx=fixture({generateImage:async()=>({buffer:recoveredPng,mimeType:'image/png'})})
 const task=await request(fx.app).post('/api/generation-tasks').send({...input,key:'purge'})
 await vi.waitFor(async()=>expect((await request(fx.app).get('/api/generation-tasks')).body.tasks[0].status).toBe('completed'))
 expect((await request(fx.app).delete(`/api/generation-tasks/${task.body.id}`).send({confirm:true})).status).toBe(409)
 const saved=await request(fx.app).post('/api/generate/save').send({taskId:task.body.id,assetType:'work'})
 await request(fx.app).post(`/api/generation-tasks/${task.body.id}/trash`).send({})
 expect((await request(fx.app).delete(`/api/generation-tasks/${task.body.id}`).send({})).status).toBe(400)
 expect((await request(fx.app).delete(`/api/generation-tasks/${task.body.id}`).send({confirm:true})).status).toBe(200)
 expect((await request(fx.app).get('/api/generation-tasks')).body.tasks).toEqual([])
 expect((await request(fx.app).get(`/api/assets/images/${saved.body.filename}`)).status).toBe(200)
 expect(fs.existsSync(path.join(fx.root,'references','a.png'))).toBe(true)
})

it('retries work-library persistence after restart without regenerating or reviving deleted works',async()=>{
 const generateImage=vi.fn(async()=>({buffer:recoveredPng,mimeType:'image/png'}))
 const fx=fixture({generateImage})
 const save=JsonGalleryRepository.prototype.saveImages
 const spy=vi.spyOn(JsonGalleryRepository.prototype,'saveImages').mockImplementation(async function(images,scope){
  if(images.some(image=>image.assetType==='work'))throw new Error('index unavailable')
  return save.call(this,images,scope)
 })
 try{
  await request(fx.app).post('/api/generation-tasks').send({...input,key:'persist-work'})
  await vi.waitFor(async()=>{
   const job=(await request(fx.app).get('/api/generation-tasks')).body.tasks[0]
   expect(job.status).toBe('completed');expect(job.workSavePending).toBe(true);expect(job.workSaveError).toBeTruthy()
  })
  spy.mockRestore();await fx.restart()
  await vi.waitFor(async()=>expect((await request(fx.app).get('/api/images')).body.filter((image:{assetType:string})=>image.assetType==='work')).toHaveLength(1))
  const job=(await request(fx.app).get('/api/generation-tasks')).body.tasks[0]
  expect(job.workSavePending).toBe(false)
  const work=(await request(fx.app).get('/api/images')).body.find((image:{assetType:string})=>image.assetType==='work')
  await request(fx.app).delete(`/api/images/${work.id}`)
  await fx.restart()
  expect((await request(fx.app).get('/api/images')).body.some((image:{id:string})=>image.id===work.id)).toBe(false)
  expect(generateImage).toHaveBeenCalledTimes(1)
 }finally{spy.mockRestore()}
})

function seedHistory(fx:ReturnType<typeof fixture>,jobs:GenerationTask[]){
 const file=path.join(fx.root,'gallery-data.json'),data=JSON.parse(fs.readFileSync(file,'utf8'))
 fs.writeFileSync(file,JSON.stringify({...data,resources:{...data.resources,generationTasks:jobs}}))
}
function storedJob(id:string,status:GenerationTask['status'],extra:Partial<GenerationTask>={}):GenerationTask{
 return {id,key:id,scope:{userId:'test',workspaceId:'test',ownerUserId:'test'},input:{...input},createdAt:'2026-10-12T12:00:00Z',updatedAt:'2026-10-12T12:00:00Z',status,...extra}
}
it('backs up and safely retries a history purge interrupted after deleting the result', async () => {
 const fx = fixture({ generateImage: async () => { throw new Error('must not run') } })
 const date = '2026-10-12T12:00:00Z'
 seedHistory(fx, [storedJob('interrupted', 'completed', {
  deletedAt: date, purgePending: true, result: { ...input, filename: 'already-deleted.png', width: 1, height: 1 },
 })])
 const snapshot = await request(fx.app).post('/api/personal/backups')
 expect(snapshot.status, snapshot.body.error).toBe(201)
 expect(snapshot.body.files.map((file: { path: string }) => file.path)).not.toContain('public/images/already-deleted.png')
 expect((await request(fx.app).post(`/api/personal/backups/${snapshot.body.id}/verify`)).status).toBe(200)
 expect((await request(fx.app).delete('/api/generation-tasks/interrupted').send({ confirm: true })).status).toBe(200)
 expect((await request(fx.app).delete('/api/generation-tasks/interrupted').send({ confirm: true })).status).toBe(200)
 const resources = await new JsonGalleryRepository(path.join(fx.root, 'gallery-data.json')).readResources()
 expect(resources.generationTasks).toEqual([])
 expect(fs.readFileSync(path.join(fx.root, 'references', 'a.png'), 'utf8')).toBe('A')
})

it('bulk trash only moves settled history, preserves works, and requires confirmation',async()=>{
 const fx=fixture({generateImage:async()=>{throw new Error('must not run')}})
 const completed=storedJob('completed','completed',{result:{...input,filename:'source.png',width:1,height:1}})
 seedHistory(fx,[completed,storedJob('failed','failed'),storedJob('queued','queued'),storedJob('running','running'),storedJob('uncertain','uncertain')])
 const before=(await request(fx.app).get('/api/images')).body
 expect((await request(fx.app).post('/api/generation-tasks/trash-all').send({})).status).toBe(400)
 const moved=await request(fx.app).post('/api/generation-tasks/trash-all').send({confirm:true})
 expect(moved.status).toBe(200);expect(moved.body.moved).toBe(3);expect(moved.body.skipped).toBe(2)
 const jobs=(await request(fx.app).get('/api/generation-tasks')).body.tasks
 expect(jobs.filter((job:GenerationTask)=>job.deletedAt).map((job:GenerationTask)=>job.id)).toEqual(['completed','failed','uncertain'])
 expect(jobs.find((job:GenerationTask)=>job.id==='uncertain').acknowledgedAt).toBeUndefined()
 expect((await request(fx.app).get('/api/gallery/state')).body.trashCount).toBe(0)
 expect((await request(fx.app).get('/api/images')).body).toEqual(before)
 expect((await request(fx.app).get('/api/assets/images/source.png')).status).toBe(200)
})
it('purges only confirmed failures in the history recycle bin and preserves shared references',async()=>{
 const fx=fixture({generateImage:async()=>{throw new Error('must not run')}})
 seedHistory(fx,[storedJob('trashed-failure','failed',{deletedAt:'2026-10-12'}),storedJob('active-failure','failed'),storedJob('cancelled','cancelled',{deletedAt:'2026-10-12'}),storedJob('uncertain','uncertain',{deletedAt:'2026-10-12'}),storedJob('completed','completed',{deletedAt:'2026-10-12',result:{...input,filename:'source.png',width:1,height:1}})])
 expect((await request(fx.app).delete('/api/generation-tasks/failed').send({})).status).toBe(400)
 const removed=await request(fx.app).delete('/api/generation-tasks/failed').send({confirm:true})
 expect(removed.status).toBe(200);expect(removed.body.deleted).toBe(1)
 expect((await request(fx.app).get('/api/generation-tasks')).body.tasks.map((job:GenerationTask)=>job.id)).toEqual(['active-failure','cancelled','uncertain','completed'])
 expect(fs.existsSync(path.join(fx.root,'references','a.png'))).toBe(true)
 expect((await request(fx.app).get('/api/assets/images/source.png')).status).toBe(200)
})

it.each([
 ['Seedream 限流',()=>new SeedreamImageGenerationRequestError({status:429,providerCode:'RateLimitExceeded',providerMessage:'rate limited',requestId:'seed-429'}),'rate_limit',true],
 ['503 即使带限流字样也不重发',()=>new SeedreamImageGenerationRequestError({status:503,providerCode:'Throttling',providerMessage:'busy',requestId:'seed-503'}),'unavailable',false],
 ['Seedream鉴权',()=>new SeedreamImageGenerationRequestError({status:401,providerCode:'AuthenticationError',providerMessage:'invalid key',requestId:'seed-401'}),'auth',false],
 ['每日额度',()=>Object.assign(new Error('daily quota exceeded'),{status:429,details:[{'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaId:'GenerateRequestsPerDayPerProject'}]}]}),'quota',false],
 ['连接结果不明',()=>new Error('fetch failed'),'network',false],
] as const)('classifies %s using original provider errors',async(_name,error,category,retryable)=>{
 const generateImage=vi.fn(async()=>{throw error()});const fx=fixture({generateImage})
 await request(fx.app).post('/api/generation-tasks').send({...input,key:'classified'})
 await vi.waitFor(async()=>{
  const job=(await request(fx.app).get('/api/generation-tasks')).body.tasks[0]
  expect(job.failure?.category).toBe(category)
  expect(job.failure?.retryable).toBe(retryable)
 })
 if(!retryable){await new Promise(resolve=>setTimeout(resolve,70));expect(generateImage).toHaveBeenCalledTimes(1)}
})
it('records each actual submission time and clears the previous error on success',async()=>{
 let attempts=0;const times:string[]=[]
 const generateImage=vi.fn(async(args:Parameters<ImageGenerationProvider['generateImage']>[0])=>{
  await args.onRequestStarted?.()
  attempts++
  const job=(await request(fx.app).get('/api/generation-tasks')).body.tasks[0]
  times.push(job.requestStartedAt)
  if(attempts===1)throw Object.assign(new Error('limited'),{status:429})
  return {buffer:recoveredPng,mimeType:'image/png'}
 });const fx=fixture({generateImage})
 await request(fx.app).post('/api/generation-tasks').send({...input,key:'timed'})
 await vi.waitFor(async()=>expect((await request(fx.app).get('/api/generation-tasks')).body.tasks[0].status).toBe('completed'))
 expect(times).toHaveLength(2);expect(times[0]).toBeTruthy();expect(Date.parse(times[1])).toBeGreaterThan(Date.parse(times[0]))
 const job=(await request(fx.app).get('/api/generation-tasks')).body.tasks[0]
 expect(job.failure).toBeUndefined();expect(job.error).toBeUndefined()
})
it('retires only the synchronous generation endpoint without calling the provider', async () => {
 const generateImage = vi.fn()
 const fx = fixture({ generateImage })
 const response = await request(fx.app).post('/api/generate').send(input)
 expect(response.status).toBe(410)
 expect(response.body).toEqual({
  error: '同步生图接口已停用，请改用异步任务队列 /api/generation-tasks',
  code: 'SYNC_GENERATE_RETIRED',
 })
 expect(generateImage).not.toHaveBeenCalled()
})

it('actual API exposes shared Google cooldown for new tasks and restores it after restart',async()=>{
 let googleCalls=0
 const google:ImageGenerationProvider={generateImage:async()=>{googleCalls++;throw Object.assign(new Error('limited'),{status:429,retryAfterMs:10000})}}
 const fx=fixture(google,{imageGenerationModelProviders:{'openai-compatible:gpt-image-1':{generateImage:async()=>({buffer:recoveredPng,mimeType:'image/png'})}}})
 const first=await request(fx.app).post('/api/generation-tasks').send({...input,key:'api-limited'})
 expect(first.status).toBe(202)
 await vi.waitFor(async()=>expect((await request(fx.app).get('/api/generation-tasks')).body.tasks[0].failure?.httpStatus).toBe(429))
 await request(fx.app).post('/api/generation-tasks').send({...input,key:'api-new'})
 const peer=await request(fx.app).post('/api/generation-tasks').send({...input,key:'api-peer',provider:'openai-compatible',model:'gpt-image-1'})
 expect(peer.status).toBe(202)
 await vi.waitFor(async()=>expect((await request(fx.app).get('/api/generation-tasks')).body.tasks.find((j:GenerationTask)=>j.key==='api-peer')?.status).toBe('completed'))
 await fx.restart()
 const tasks=(await request(fx.app).get('/api/generation-tasks')).body.tasks as GenerationTask[]
 expect(googleCalls).toBe(1)
 expect(tasks.find(j=>j.key==='api-new')).toMatchObject({status:'queued',providerCooldownUntil:expect.any(String)})
 expect(Date.parse(tasks.find(j=>j.key==='api-new')!.providerCooldownUntil!)).toBeGreaterThan(Date.now())
})

const recoveredPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC','base64')
it('retains an old queued Poe input without sending to another provider', async () => {
 const generateImage = vi.fn(async () => ({ buffer: recoveredPng, mimeType: 'image/png' }))
 const fx = fixture({ generateImage })
 const legacyInput = { prompt: 'legacy', provider: 'poe', model: 'nano-banana-2', referenceFilenames: [], aspectRatio: 'auto', imageSize: '2K' }
 seedHistory(fx, [{ ...storedJob('legacy-poe', 'queued'), input: legacyInput as unknown as GenerationTask['input'] }])
 await fx.restart()
 await vi.waitFor(async () => {
  const jobs = (await request(fx.app).get('/api/generation-tasks')).body.tasks as GenerationTask[]
  expect(jobs.find(task => task.id === 'legacy-poe')).toMatchObject({ status: 'failed', input: legacyInput })
 })
 expect(generateImage).not.toHaveBeenCalled()
})

const queryInput={...input,provider:'kling' as const,model:'kling/kling-v3-omni-image-generation'}
function queryJob(id='recover',extra:Partial<GenerationTask>={}){return storedJob(id,'failed',{input:queryInput,upstreamTaskId:'original-upstream',requestStartedAt:'2026-10-12T12:00:01Z',retryCount:3,attemptCount:4,failure:{category:'network',message:'原结果未取回',retryable:true,uncertain:false},...extra})}
it('手动获取沿用原任务ID与原请求时间，不需要已缺失的原参考图，不重新生成',async()=>{
 const generateImage=vi.fn(async(args:Parameters<ImageGenerationProvider['generateImage']>[0])=>{void args;return{buffer:recoveredPng,mimeType:'image/png' as const}})
 const fx=fixture({generateImage},{imageGenerationModelProviders:{[imageGenerationModelKey('kling',queryInput.model)]:{generateImage}}})
 seedHistory(fx,[queryJob()]);fs.rmSync(path.join(fx.root,'references','a.png'));fs.rmSync(path.join(fx.root,'references','b.png'))
 const response=await request(fx.app).post('/api/generation-tasks/recover/resume-query').send({key:'query-one',expectedVersion:0})
 expect(response.status,response.body.error).toBe(200)
 await vi.waitFor(async()=>expect((await request(fx.app).get('/api/generation-tasks')).body.tasks[0].status).toBe('completed'))
 const duplicate=await request(fx.app).post('/api/generation-tasks/recover/resume-query').send({key:'query-one',expectedVersion:0})
 expect(duplicate.status).toBe(200);expect(generateImage).toHaveBeenCalledOnce();expect(generateImage.mock.calls[0][0].resumeTaskId).toBe('original-upstream');expect(generateImage.mock.calls[0][0].referenceImages).toEqual([])
 const job=duplicate.body;expect(job.upstreamTaskId).toBe('original-upstream');expect(job.requestStartedAt).toBe('2026-10-12T12:00:01Z');expect(job.attemptCount).toBe(5);expect(job.manualResumeVersion).toBe(1);expect(job.attempts.at(-1).sent).toBe(false)
})
it('等待获取原结果时不能被取消接口误取消',async()=>{
 const fx=fixture({generateImage:async()=>{throw new Error('must not send')}})
 seedHistory(fx,[queryJob('recover',{status:'queued',nextRetryAt:new Date(Date.now()+60000).toISOString()})])
 const response=await request(fx.app).post('/api/generation-tasks/recover/cancel').send({})
 expect(response.status).toBe(409);expect(response.body.error).toMatch(/原结果/)
 expect((await request(fx.app).get('/api/generation-tasks')).body.tasks[0].status).toBe('queued')
})
it.each([
 ['wrong-workspace',queryJob('recover',{scope:{workspaceId:'other',userId:'other'}}),404],
 ['deleted',queryJob('recover',{deletedAt:'2026-11-04'}),409],
 ['purging',queryJob('recover',{purgePending:true}),409],
 ['no-id',queryJob('recover',{upstreamTaskId:undefined}),409],
 ['unsupported',queryJob('recover',{input:{...input}}),409],
 ['blocked',queryJob('recover',{failure:{category:'blocked',message:'blocked',retryable:false,uncertain:false}}),409],
] as const)('获取原结果拒绝%s，不产生新的供应商调用',async(_label,job,status)=>{
 const generateImage=vi.fn(async()=>({buffer:recoveredPng,mimeType:'image/png' as const}))
 const fx=fixture({generateImage},{imageGenerationModelProviders:{[imageGenerationModelKey('kling',queryInput.model)]:{generateImage}}});seedHistory(fx,[job])
 const response=await request(fx.app).post('/api/generation-tasks/recover/resume-query').send({key:'request',expectedVersion:0})
 expect(response.status).toBe(status);expect(generateImage).not.toHaveBeenCalled()
})
it('恢复版本冲突拒绝旧请求，两个同时操作只认领一次',async()=>{
 let release!:()=>void
 const generateImage=vi.fn(async()=>{await new Promise<void>(resolve=>{release=resolve});return{buffer:recoveredPng,mimeType:'image/png' as const}})
 const fx=fixture({generateImage},{imageGenerationModelProviders:{[imageGenerationModelKey('kling',queryInput.model)]:{generateImage}}});seedHistory(fx,[queryJob()])
 try{
  const stale=await request(fx.app).post('/api/generation-tasks/recover/resume-query').send({key:'stale',expectedVersion:8});expect(stale.status).toBe(409)
  const replies=await Promise.all([request(fx.app).post('/api/generation-tasks/recover/resume-query').send({key:'same',expectedVersion:0}),request(fx.app).post('/api/generation-tasks/recover/resume-query').send({key:'same',expectedVersion:0})])
  expect(replies.map(r=>r.status)).toEqual([200,200]);await vi.waitFor(()=>expect(generateImage).toHaveBeenCalledOnce())
 }finally{release?.()}
})
it('旧Qwen v1获取结果保留用于校验画布的参考图，不上传或重发工作流',async()=>{
 const {ComfyUIImageProvider}=await import('../../server/ai/comfyui-image-provider')
 const calls:string[]=[];const uuid='00112233-4455-4677-8899-aabbccddeeff'
 const png=await (await import('sharp')).default({create:{width:1024,height:1024,channels:3,background:'red'}}).png().toBuffer()
 const provider=new ComfyUIImageProvider({fetch:async(url:string)=>{const route=new URL(url).pathname;calls.push(route);if(route===`/history/${uuid}`)return Response.json({[uuid]:{status:{completed:true,status_str:'success'},outputs:{'900':{images:[{filename:'out.png',subfolder:`Qwen21/Gallery/${uuid}`,type:'output'}]}}}});if(route==='/view')return new Response(new Uint8Array(png));throw new Error('unexpected '+route)}})
 const execution={engine:'comfyui' as const,workflowVersion:'qwen21-v1' as const,seed:42,steps:25,cfg:1,sampler:'euler',scheduler:'simple'}
 const fx=fixture(provider,{imageGenerationProviders:{'qwen-local':provider}})
 fs.writeFileSync(path.join(fx.root,'references','a.png'),png)
 seedHistory(fx,[queryJob('v1',{upstreamTaskId:uuid,input:{...input,provider:'qwen-local',model:'qwen-image-2.1-UC-Q8_0',referenceFilenames:['a.png'],aspectRatio:'source',imageSize:'1K',execution}})])
 expect((await request(fx.app).post('/api/generation-tasks/v1/resume-query').send({key:'v1-query',expectedVersion:0})).status).toBe(200)
 await vi.waitFor(async()=>expect((await request(fx.app).get('/api/generation-tasks')).body.tasks[0].status).toBe('completed'))
 expect(calls).toEqual([`/history/${uuid}`,'/view'])
})
it('手动重试保存作品后立即确认入库回执，不让成功保存继续显示入库失败',async()=>{
 const generateImage=vi.fn(async()=>({buffer:recoveredPng,mimeType:'image/png' as const}));const fx=fixture({generateImage})
 fs.writeFileSync(path.join(fx.root,'images','source.png'),recoveredPng)
 seedHistory(fx,[storedJob('save-only','completed',{result:{...input,filename:'source.png',width:1,height:1},workSavePending:true,workSaveError:'保存暂时失败'})])
 const response=await request(fx.app).post('/api/generate/save').send({taskId:'save-only',assetType:'work'})
 expect(response.status,response.body.error).toBe(200)
 const job=(await request(fx.app).get('/api/generation-tasks')).body.tasks[0]
 expect(job.workSavePending).toBe(false);expect(job.workSaveError).toBeUndefined();expect(job.workAssetId).toBe(response.body.id)
 expect(generateImage).not.toHaveBeenCalled()
})

it.each([false,true])('仅在 Mac 保存成功后确认远端清理（模拟写盘失败=%s）',async(failWrite)=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC','base64')
 let acknowledgements=0
 const provider:ImageGenerationProvider={generateImage:async args=>{
  if(failWrite)fs.mkdirSync(path.join(fx.root,'images',`gen_${args.requestId}.png`))
  return {buffer:png,mimeType:'image/png',onSaved:async(localPath:string)=>{expect(fs.readFileSync(localPath)).toEqual(png);acknowledgements++}}
 }}
 const fx=fixture(provider)
 const response=await request(fx.app).post('/api/generation-tasks').send({...input,referenceFilenames:[],key:'remote-cleanup'})
 expect(response.status).toBe(202)
 await vi.waitFor(async()=>{const jobs=(await request(fx.app).get('/api/generation-tasks')).body.tasks;expect(jobs[0].status).toBe(failWrite?'failed':'completed')})
 expect(acknowledgements).toBe(failWrite?0:1)
})

it('远端删除失败仍报告 Mac 已保存成功，不触发重新生成',async()=>{
 let calls=0,acknowledgements=0
 const fx=fixture({generateImage:async()=>{calls++;return {buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC','base64'),mimeType:'image/png',onSaved:async()=>{acknowledgements++;throw Error('SSH disconnected')}}}})
 const response=await request(fx.app).post('/api/generation-tasks').send({...input,referenceFilenames:[],key:'remote-delete-failed'})
 expect(response.status).toBe(202)
 await vi.waitFor(async()=>expect((await request(fx.app).get('/api/generation-tasks')).body.tasks[0].status).toBe('completed'))
 expect(acknowledgements).toBe(1);expect(calls).toBe(1)
})

it('任务未变化时条件读取返回 304，新增任务后返回新清单', async () => {
 const fx = fixture({generateImage: async () => ({buffer:recoveredPng, mimeType:'image/png'})})
 const first = await request(fx.app).get('/api/generation-tasks')
 expect(first.status).toBe(200)
 expect(first.headers.etag).toMatch(/^"tasks-/)
 const unchanged = await request(fx.app).get('/api/generation-tasks').set('If-None-Match', first.headers.etag)
 expect(unchanged.status).toBe(304)
 expect(unchanged.text).toBe('')
 const submitted = await request(fx.app).post('/api/generation-tasks').send({...input,key:'revision-new'})
 expect(submitted.status).toBe(202)
 const changed = await request(fx.app).get('/api/generation-tasks').set('If-None-Match', first.headers.etag)
 expect(changed.status).toBe(200)
 expect(changed.body.tasks[0].id).toBe(submitted.body.id)
})

it('replays the normalized key even when references disappear and the local queue is full', async () => {
 const fx=fixture({generateImage:()=>new Promise(()=>{})})
 const api=request(fx.app)
 const submit=(key:string, body:Record<string,unknown>={})=>api.post('/api/generation-tasks').send({...input,key,...body})
 const original=await submit('original-replay',{sourceAssetId:'source'})
 expect(original.status).toBe(202)
 const seed=Array.from({length:99},(_,index)=>({...original.body,id:`seed-${index}`,key:`seed-${index}`,status:'queued',nextRetryAt:'2099-01-01T00:00:00Z'}))
 const repo=new JsonGalleryRepository(path.join(fx.root,'gallery-data.json'))
 await vi.waitFor(async()=>expect((await repo.readResources()).generationTasks?.[0].status).toBe('running'))
 const [persisted]=(await repo.readResources()).generationTasks!
 // Legacy indexes may serialize input properties in a different order.
 persisted.input=Object.assign({model:input.model},persisted.input)
 await repo.saveResources({generationTasks:[persisted,...seed]})
 fs.unlinkSync(path.join(fx.root,'references','a.png'))
 await repo.saveImages([])
 expect((await submit('original-replay',{sourceAssetId:'source'})).body.id).toBe(original.body.id)
 expect(await submit('original-replay',{prompt:'different',sourceAssetId:'source'})).toMatchObject({status:409,body:{code:'TASK_KEY_CONFLICT'}})
 expect(await submit('new-missing')).toMatchObject({status:404,body:{code:'REFERENCE_UNAVAILABLE'}})
 expect(await submit('new-unknown-reference',{referenceFilenames:['unknown.png']})).toMatchObject({
  status:404,body:{code:'REFERENCE_UNAVAILABLE',referenceFilenames:['unknown.png']},
 })
 expect(await submit('new-source',{referenceFilenames:[],sourceTaskId:'missing'})).toMatchObject({status:404,body:{code:'SOURCE_TASK_UNAVAILABLE'}})
 expect(await submit('new-full',{referenceFilenames:[]})).toMatchObject({status:429,body:{code:'QUEUE_FULL'}})
})

it('exposes only the public task fields by key and retains tombstones until purged', async () => {
 const fx=fixture({generateImage:()=>new Promise(()=>{})})
 const repo=new JsonGalleryRepository(path.join(fx.root,'gallery-data.json'))
 const scope={workspaceId:'test',userId:'test',ownerUserId:'test'}
 const date='2026-09-11T00:00:00Z'
 const failure={category:'auth',message:'授权失败',retryable:false,uncertain:false,httpStatus:401,providerCode:'invalid',requestId:'upstream-id'} as const
 const historic: GenerationTask = {id:'failed',key:'failed-key',status:'failed',scope,input,createdAt:date,updatedAt:date,failure:{...failure,detail:'private details',retryAfterMs:1500},attempts:[]}
 await repo.saveResources({generationTasks:[historic,{...historic,id:'deleted',key:'deleted-key',deletedAt:date},{...historic,id:'purging',key:'purging-key',purgePending:true},{...historic,id:'foreign',key:'foreign-key',scope:{...scope,workspaceId:'other'}}]})
 const api=request(fx.app)
 const detail=await api.get('/api/generation-tasks/failed')
 expect(detail.body.failure).toEqual(failure)
 expect(detail.body).not.toHaveProperty('attempts')
 const byKey=(key:string)=>api.get(`/api/generation-tasks/by-key/${key}`)
 expect((await byKey('failed-key')).body).toEqual({id:'failed',key:'failed-key',status:'failed',input,failure})
 for (const key of ['deleted-key','purging-key']) expect(await byKey(key)).toMatchObject({status:200,body:{deleted:true}})
 for (const key of ['absent','foreign-key']) expect(await byKey(key)).toMatchObject({status:404,body:{code:'TASK_KEY_NOT_FOUND'}})
})

it('keyset-paginates a filtered task summary without changing legacy list ETags', async () => {
 const fx=fixture({generateImage:()=>new Promise(()=>{})})
 const repo=new JsonGalleryRepository(path.join(fx.root,'gallery-data.json'))
 const scope={workspaceId:'test',userId:'test',ownerUserId:'test'}
 const row=(id:string,createdAt:string,extra:Partial<GenerationTask>={}):GenerationTask=>({id,key:`key-${id}`,status:'failed',scope,input,createdAt,updatedAt:createdAt,...extra})
 const at='2026-09-11T00:00:00Z', before='2026-09-10T23:59:59Z', after='2026-09-12T00:00:00Z'
 const result={filename:'source.png',width:1,height:1,prompt:input.prompt,provider:input.provider,model:input.model,aspectRatio:input.aspectRatio}
 const failure={category:'network',message:'网络失败',retryable:true,uncertain:false} as const
 const jobs=[row('b',at,{status:'completed',result,workAssetId:'source'}),row('a',at,{failure:{...failure,detail:'private'}}),row('from',before),row('exclusive',after),row('trash',at,{deletedAt:at}),row('purge',at,{purgePending:true}),row('cancelled',at,{status:'cancelled'}),row('other-provider',at,{input:{...input,provider:'seedream'}})]
 const [source]=await repo.listImages()
 await repo.saveImages([{...source,assetType:'work'}])
 await repo.saveResources({generationTasks:jobs})
 const api=request(fx.app)
 const route='/api/generation-tasks'
 const legacy=await api.get(route)
 expect(Object.keys(legacy.body).sort()).toEqual(['canPurge','error','tasks'])
 expect((await api.get(route).set('If-None-Match',legacy.headers.etag)).status).toBe(304)
 const filters={view:'summary',provider:'google',status:['failed','completed'],from:before,to:after}
 const first=await api.get(route).query({...filters,limit:1}).set('If-None-Match',legacy.headers.etag)
 expect(first.body).toEqual({items:[{id:'a',key:'key-a',status:'failed',createdAt:at,updatedAt:at,provider:input.provider,model:input.model,failure}],total:3,nextCursor:expect.any(String)})
 await repo.saveResources({generationTasks:[row('newer','2026-09-11T01:00:00Z'),...jobs]})
 const second=await api.get(route).query({...filters,status:['completed','failed'],limit:2,cursor:first.body.nextCursor})
 expect(second.body.items.map((job:GenerationTask)=>job.id)).toEqual(['b','from'])
 expect(second.body).toMatchObject({items:[{workCode:expect.stringMatching(/^#/)},{id:'from'}],total:4,nextCursor:null})
 const completed=await api.get('/api/generation-tasks/by-key/key-b')
 expect(completed.body.workCode).toBe(second.body.items[0].workCode)
 expect(second.body.items[0]).not.toHaveProperty('result')
 expect((await api.get(route).query({view:'summary',from:'2026-09-11T08:00:00.000001+08:00',to:'2026-09-11T01:00:00.000001Z'})).body.items.map((job:GenerationTask)=>job.id)).toEqual(['newer'])
 for(const query of [{...filters,status:['failed'],cursor:first.body.nextCursor},{...filters,cursor:'invalid'},{...filters,cursor:''},{...filters,from:'2026-02-30T00:00:00Z'},{...filters,limit:101}]) {
   expect((await api.get(route).query(query)).status).toBe(400)
 }
})

it('returns lightweight image summaries after full prompt search in true date order', async () => {
 const fx=fixture({generateImage:()=>new Promise(()=>{})})
 const repo=new JsonGalleryRepository(path.join(fx.root,'gallery-data.json'))
 const [source]=await repo.listImages()
 const prompt=`${'长'.repeat(170)} find-me-at-the-end`
 await repo.saveImages([
   {...source,id:'older-pinned',assetType:'work',pinned:true,prompt,createdAt:'2025-01-01'},
   {...source,id:'newer',assetType:'work',prompt,title:'Recent',sourceType:'generated',generation:{provider:'google',model:input.model,aspectRatio:'1:1'}},
 ])
 const api=request(fx.app)
 const response=await api.get('/api/images').query({limit:1,fields:'summary',pinFirst:0,q:'find-me-at-the-end'})
 expect(response.body).toMatchObject({items:[{id:'newer',title:'Recent',assetType:'work',model:input.model,sourceType:'generated',workCode:expect.stringMatching(/^#/),promptExcerpt:'长'.repeat(160)}],total:2,nextCursor:expect.any(String)})
 for (const key of ['prompt','generation','thumbnailVersion','referenceImages']) expect(response.body.items[0]).not.toHaveProperty(key)
 expect((await api.get('/api/images').query({fields:'summary',pinFirst:0})).body.map((image:{id:string})=>image.id)).toEqual(['newer','older-pinned'])
 expect((await api.get('/api/images').query({limit:1})).body.items[0]).toMatchObject({id:'older-pinned',prompt})
})

it('keeps the generation ETag after favoriting a linked work, but changes it when its work code disappears', async () => {
 const fx=fixture({generateImage:async()=>{throw Error('must not send')}})
 const repo=new JsonGalleryRepository(path.join(fx.root,'gallery-data.json'))
 const [source]=await repo.listImages()
 await repo.saveImages([{...source,assetType:'work'}])
 await repo.saveResources({generationTasks:[{
  id:'linked',key:'linked',scope:{workspaceId:'test',userId:'test'},input,status:'completed',
  createdAt:'2026-09-11',updatedAt:'2026-09-11',workAssetId:source.id,
  result:{filename:source.filename,width:1,height:1,...input},
 }]})
 const api=request(fx.app)
 const first=await api.get('/api/generation-tasks').expect(200)
 expect(first.body.tasks[0].workCode).toMatch(/^#/)
 await api.patch('/api/images/source').send({favorited:true}).expect(200)
 await api.get('/api/generation-tasks').set('Cache-Control','no-cache').set('If-None-Match',first.headers.etag).expect(304)
 await api.delete('/api/images/source').expect(200)
 const changed=await api.get('/api/generation-tasks').set('If-None-Match',first.headers.etag).expect(200)
 expect(changed.body.tasks[0].workCode).toBeUndefined()
})

it('checks unchanged gallery state without per-file stats and notices an external index replacement', async () => {
 const fx=fixture({generateImage:async()=>{throw Error('must not send')}})
 const api=request(fx.app)
 const first=await api.get('/api/gallery/state').expect(200).expect('Cache-Control','no-store')
 expect(first.body).toEqual({revision:expect.any(String),count:1,trashCount:0})
 const stat=vi.spyOn(fs.promises,'stat')
 try {
  expect((await api.get('/api/gallery/state').expect(200)).body).toEqual(first.body)
  expect(stat.mock.calls.some(([file])=>file===path.join(fx.root,'images','source.png'))).toBe(false)
  const repo=new JsonGalleryRepository(path.join(fx.root,'gallery-data.json'))
  const [source]=await repo.listImages()
  await repo.saveImages([{...source,prompt:'external edit'}])
  const edited=await api.get('/api/gallery/state').expect(200)
  expect(edited.body.revision).not.toBe(first.body.revision)
  const original=path.join(fx.root,'images','source.png'), replacement=original+'.new'
  fs.writeFileSync(replacement,'new original')
  fs.renameSync(replacement,original)
  const replaced=await api.get('/api/gallery/state').expect(200)
  expect(replaced.body.revision).not.toBe(edited.body.revision)
  const now=vi.spyOn(Date,'now').mockReturnValue(Date.now()+61_000)
  try {
   fs.writeFileSync(original,'in-place edit')
   expect((await api.get('/api/gallery/state').expect(200)).body.revision).not.toBe(replaced.body.revision)
  } finally { now.mockRestore() }
 } finally { stat.mockRestore() }
 await api.delete('/api/images/source').expect(200)
 expect((await api.get('/api/gallery/state').expect(200)).body).toMatchObject({count:0,trashCount:1})
 await api.post('/api/trash/source/restore').expect(200)
 expect((await api.get('/api/gallery/state').expect(200)).body).toMatchObject({count:1,trashCount:0})
})

it('does not acknowledge remote cleanup until a failed result receipt write has been retried', async () => {
 let releaseReceipt=false
 let rejected=0
 let persistedAtCleanup: GenerationTask | undefined
 const generateImage=vi.fn(async()=>({
  buffer:recoveredPng,mimeType:'image/png' as const,
  onSaved:async(file:string)=>{
   expect(fs.readFileSync(file)).toEqual(recoveredPng)
   const data=JSON.parse(fs.readFileSync(generationTasksFileFor(path.join(fx.root,'gallery-data.json')),'utf8'))
   persistedAtCleanup=data.generationTasks[0]
  },
 }))
 const original=JsonGalleryRepository.prototype.saveResources
 const save=vi.spyOn(JsonGalleryRepository.prototype,'saveResources').mockImplementation(async function(this:JsonGalleryRepository,resources,...args){
  if(!releaseReceipt&&resources.generationTasks?.some(job=>job.key==='receipt-first'&&job.status==='completed')){
   rejected++
   throw Error('receipt not writable')
  }
  await original.call(this,resources,...args)
 })
 const fx=fixture({generateImage})
 try{
  const response=await request(fx.app).post('/api/generation-tasks').send({...input,referenceFilenames:[],key:'receipt-first'})
  expect(response.status).toBe(202)
  await vi.waitFor(()=>expect(rejected).toBeGreaterThan(0))
  expect(persistedAtCleanup).toBeUndefined()
  const receipt = path.join(fx.root, '.generation-receipts', response.body.id + '.json')
  expect(JSON.parse(fs.readFileSync(receipt, 'utf8'))).toMatchObject({
   result: { filename: 'gen_' + response.body.id + '.png', width: 1, height: 1 },
   outputBytes: recoveredPng.length,
   completedAt: expect.any(String),
  })
  releaseReceipt=true
  await vi.waitFor(()=>expect(persistedAtCleanup).toMatchObject({id:response.body.id,status:'completed',result:{filename:expect.stringContaining(response.body.id)}}),{timeout:3500})
  expect(generateImage).toHaveBeenCalledOnce()
  expect(fs.existsSync(receipt)).toBe(false)
 }finally{save.mockRestore()}
})

it('keeps retired provider IDs in stored works and history but rejects new submissions', async () => {
 const fx = fixture({ generateImage: async () => { throw new Error('must not generate') } })
 const dataFile = path.join(fx.root, 'gallery-data.json')
 const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
 // Legacy compatibility fixtures represent the two IDs written by earlier versions.
 const retiredIds = ['pikachu-gpt', 'pikachu-grok']
 const scope = { userId: 'test', workspaceId: 'test' }
 data.images = retiredIds.map((provider, i) => ({
  ...data.images[0], id: `legacy-${i}`, generation: { provider, model: 'archived-model', aspectRatio: '1:1' },
 }))
 data.resources = { generationTasks: retiredIds.map((provider, i) => ({
  id: `legacy-${i}`, key: `legacy-${i}`, scope, input: { ...input, provider },
  status: 'completed', createdAt: '2026-09-11', updatedAt: '2026-09-11',
  result: { provider, filename: 'source.png', model: 'archived-model', width: 1, height: 1 },
 })) }
 fs.writeFileSync(dataFile, JSON.stringify(data))
 await fx.restart()
 expect((await request(fx.app).get('/api/images')).body).toEqual(expect.arrayContaining(
  retiredIds.map(provider => expect.objectContaining({ generation: expect.objectContaining({ provider }) })),
 ))
 const history = await request(fx.app).get('/api/generation-tasks')
 expect(history.body.tasks.map((task: GenerationTask) => task.input.provider)).toEqual(expect.arrayContaining(retiredIds))
 for (const [i, provider] of retiredIds.entries()) {
  const image = await request(fx.app).get(`/api/images/legacy-${i}`)
  expect(image.body.generation.provider).toBe(provider)
  const detail = await request(fx.app).get(`/api/generation-tasks/legacy-${i}`)
  expect(detail.body).toMatchObject({ status: 'completed', result: { width: 1, height: 1 } })
  const summary = await request(fx.app).get('/api/generation-tasks').query({ view: 'summary', provider })
  expect(summary.body.items).toHaveLength(1)
  for (const url of ['/api/generation-tasks']) {
   const response = await request(fx.app).post(url).send({ ...input, provider, key: 'retired' })
   expect(response.status).toBe(400)
   expect(response.body.error).toContain('已下线')
  }
 }
})

it('selects the available demo on a credential-free installation and saves its result', async () => {
 const fx = fixture({ generateImage: async () => { throw new Error('must not call Google') } }, {
  strategy: { mode: 'googleUnavailable' },
  imageGenerationProviderAvailability: { google: false },
 })
 const providers = await request(fx.app).get('/api/generation/providers')
 expect(providers.body.defaultProvider).toBe('demo')
 expect(providers.body.providers).toContainEqual(expect.objectContaining({ id: 'demo', available: true }))
 const models = await request(fx.app).get('/api/generation/models')
 expect(models.body.defaultModel).toEqual({ provider: 'demo', model: 'banana-demo-v1' })
 const response = await request(fx.app).post('/api/generation-tasks').send({
  key: 'demo', prompt: 'Test offline', provider: 'demo', model: 'banana-demo-v1', aspectRatio: '16:9',
 })
 expect(response.status, response.body.error).toBe(202)
 await vi.waitFor(async () => {
  const jobs = (await request(fx.app).get('/api/generation-tasks')).body.tasks as GenerationTask[]
  expect(jobs[0].result).toMatchObject({ provider: 'demo', width: 1024, height: 576 })
 })
})

it('does not advertise or accept demo tasks when disabled', async () => {
 const fx = fixture({ generateImage: async () => { throw new Error('must not generate') } }, {
  enableDemoProvider: false,
  defaultImageGenerationProvider: 'demo',
 })
 const providers = await request(fx.app).get('/api/generation/providers')
 expect(providers.body.defaultProvider).toBe('google')
 expect(providers.body.providers.some((provider: { id: string }) => provider.id === 'demo')).toBe(false)
 const models = await request(fx.app).get('/api/generation/models')
 expect(models.body.models.some((model: { provider: string }) => model.provider === 'demo')).toBe(false)
 for (const url of ['/api/generation-tasks']) {
  const response = await request(fx.app).post(url).send({ key: 'disabled', prompt: 'demo', provider: 'demo', model: 'banana-demo-v1' })
  expect(response.status).toBe(400)
 }
})

it('routes the configured OpenAI-compatible model from discovery to a completed task', async () => {
 const model = 'vendor/custom-image'
 const env = loadAppEnv({
  OPENAI_IMAGE_API_KEY: 'relay-secret',
  OPENAI_IMAGE_BASE_URL: 'https://relay.example/v1',
  OPENAI_IMAGE_MODEL: model,
 })
 const png = recoveredPng.toString('base64')
 const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ data: [{ b64_json: png }] }))
 const fx = fixture({ generateImage: async () => { throw new Error('must not fall back to Google') } }, {
  imageGenerationProviders: { 'openai-compatible': createOpenAICompatibleRuntimeProvider(env, fetch) },
  imageGenerationProviderModels: { 'openai-compatible': model },
 })
 const models = await request(fx.app).get('/api/generation/models')
 expect(models.body.models.filter((item: { provider: string }) => item.provider === 'openai-compatible'))
  .toEqual([expect.objectContaining({ model, available: true, parameterMode: 'quality' })])
 expect(JSON.stringify(models.body)).not.toContain('relay-secret')
 const response = await request(fx.app).post('/api/generation-tasks').send({
  key: 'relay', prompt: 'test relay', provider: 'openai-compatible', model, quality: 'medium',
 })
 expect(response.status, response.body.error).toBe(202)
 await vi.waitFor(async () => {
  const jobs = (await request(fx.app).get('/api/generation-tasks')).body.tasks as GenerationTask[]
  expect(jobs[0].result).toMatchObject({ provider: 'openai-compatible', model, width: 1, height: 1 })
 })
 expect(fetch).toHaveBeenCalledTimes(1)
 expect(fetch.mock.calls[0][0]).toBe('https://relay.example/v1/images/generations')
 expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, quality: 'medium' })
})

it('rejects unconfigured OpenAI-compatible submissions without queuing or calling another channel', async () => {
 const fx = fixture({ generateImage: async () => { throw new Error('must not generate') } })
 for (const url of ['/api/generation-tasks']) {
  const response = await request(fx.app).post(url).send({
   key: 'no-key', prompt: 'test relay', provider: 'openai-compatible', model: 'gpt-image-1',
  })
  expect(response.status).toBe(503)
  expect(response.body.error).toContain('OPENAI_IMAGE_API_KEY')
 }
 expect((await request(fx.app).get('/api/generation-tasks')).body.tasks).toEqual([])
})

const bulkPreviewPath = '/api/generation-tasks/bulk/preview'
const bulkCommitPath = '/api/generation-tasks/bulk/commit'

it.each([
 ['failed', ['failed-hit', 'checked-hit', 'uncertain-hit']],
 ['completed', ['completed-hit']],
 ['cancelled', ['cancelled-hit']],
 ['all', ['failed-hit', 'completed-hit', 'cancelled-hit', 'checked-hit', 'uncertain-hit']],
] as const)('bulk trash locks only eligible matches in the %s tab', async (tab, expected) => {
 const fx = fixture({ generateImage: vi.fn() })
 const jobs = [
  storedJob('failed-hit', 'failed'),
  storedJob('completed-hit', 'completed'),
  storedJob('cancelled-hit', 'cancelled'),
  storedJob('checked-hit', 'uncertain', { acknowledgedAt: '2026-10-12' }),
  storedJob('uncertain-hit', 'uncertain'),
  storedJob('save-failed-hit', 'failed', { workSavePending: true }),
  storedJob('save-hit', 'completed', { workSavePending: true }),
  storedJob('queued-hit', 'queued'),
  storedJob('running-hit', 'running'),
  storedJob('purge-hit', 'failed', { purgePending: true }),
  storedJob('already-trashed', 'failed', { deletedAt: '2026-10-12' }),
  storedJob('outside-workspace', 'failed', { scope: { workspaceId: 'other', userId: 'other' } }),
  storedJob('miss', 'failed', { input: { ...input, prompt: 'different' } }),
 ]
 seedHistory(fx, jobs)
 const api = request(fx.app)
 const preview = await api.post(bulkPreviewPath).send({ operation: 'trash', tab, search: '  FROZEN  ' })
 expect(preview.status).toBe(200)
 expect(preview.body).toMatchObject({
  operation: 'trash', tab, search: 'FROZEN', eligibleCount: expected.length, retryPurgeCount: 0,
  matchedCount: { failed: 5, completed: 2, cancelled: 1, all: 10 }[tab],
 })
 const commit = await api.post(bulkCommitPath).send({ token: preview.body.token, confirm: true })
 expect(commit.status).toBe(200)
 expect(commit.body).toEqual({ moved: expected.length, skipped: preview.body.skippedCount })
 const resources = await new JsonGalleryRepository(path.join(fx.root, 'gallery-data.json')).readResources()
 expect(resources.generationTasks?.filter(job => job.deletedAt).map(job => job.id)).toEqual([...expected, 'already-trashed'])
 expect((await api.post(bulkCommitPath).send({ token: preview.body.token, confirm: true })).status).toBe(409)
})

it.each(['GOOGLE', 'gemini-nano-banana-2.1', 'google ·'])('bulk preview also matches the provider/model display fields: %s', async search => {
 const fx = fixture({ generateImage: vi.fn() })
 seedHistory(fx, [storedJob('done', 'completed')])
 const preview = await request(fx.app).post(bulkPreviewPath).send({ operation: 'trash', tab: 'completed', search })
 expect(preview.body.eligibleCount).toBe(1)
})

it('bulk purge matches a search, includes retry-pending failures, and preserves shared files', async () => {
 const fx = fixture({ generateImage: vi.fn() })
 const deletedAt = '2026-10-12'
 const result = { ...input, filename: 'shared.png', width: 1, height: 1 }
 fs.writeFileSync(path.join(fx.root, 'images', result.filename), 'shared')
 fs.writeFileSync(path.join(fx.root, 'references', 'exclusive.png'), 'exclusive')
 seedHistory(fx, [
  storedJob('failed-hit', 'failed', { deletedAt, purgePending: true, result, input: { ...input, referenceFilenames: ['a.png', 'exclusive.png'] } }),
  storedJob('uncertain-hit', 'uncertain', { deletedAt }),
  storedJob('failed-miss', 'failed', { deletedAt, input: { ...input, prompt: 'different' }, result }),
  storedJob('cancelled', 'cancelled', { deletedAt }),
  storedJob('active', 'failed'),
  storedJob('pending', 'failed', { deletedAt, workSavePending: true }),
  storedJob('failed-hit', 'failed', { deletedAt, scope: { workspaceId: 'other', userId: 'other' } }),
 ])
 const api = request(fx.app)
 const preview = await api.post(bulkPreviewPath).send({ operation: 'purge-failed', tab: 'trash', search: 'FROZEN' })
 expect(preview.status).toBe(200)
 expect(preview.body).toMatchObject({ matchedCount: 4, eligibleCount: 2, skippedCount: 2, retryPurgeCount: 1 })
 const commit = await api.post(bulkCommitPath).send({ token: preview.body.token, confirm: true })
 expect(commit.status).toBe(200)
 expect(commit.body).toEqual({ deleted: 2, skipped: 2 })
 expect((await api.get('/api/generation-tasks')).body.tasks.map((job: GenerationTask) => job.id)).toEqual(['failed-miss', 'cancelled', 'active', 'pending'])
 const resources = await new JsonGalleryRepository(path.join(fx.root, 'gallery-data.json')).readResources()
 expect(resources.generationTasks).toContainEqual(expect.objectContaining({ id: 'failed-hit', scope: { workspaceId: 'other', userId: 'other' } }))
 expect(fs.existsSync(path.join(fx.root, 'images', result.filename))).toBe(true)
 expect(fs.existsSync(path.join(fx.root, 'references', 'a.png'))).toBe(true)
 expect(fs.existsSync(path.join(fx.root, 'references', 'exclusive.png'))).toBe(false)
})

it('does not add newly completed tasks or new records after preview', async () => {
 const fx = fixture({ generateImage: vi.fn() })
 const done = storedJob('previewed', 'completed')
 seedHistory(fx, [done, storedJob('in-flight', 'running')])
 const api = request(fx.app)
 const preview = await api.post(bulkPreviewPath).send({ operation: 'trash', tab: 'all' })
 expect(preview.status).toBe(200)
 seedHistory(fx, [done, storedJob('in-flight', 'completed'), storedJob('new', 'completed')])
 const commit = await api.post(bulkCommitPath).send({
  token: preview.body.token, confirm: true, targetIds: ['previewed', 'in-flight', 'new'],
 })
 expect(commit.body).toEqual({ moved: 1, skipped: 1 })
 const tasks: GenerationTask[] = (await api.get('/api/generation-tasks')).body.tasks
 expect(tasks.filter(job => job.deletedAt).map(job => job.id)).toEqual(['previewed'])
})

it('rejects the whole commit when a previewed target has changed, even if still eligible', async () => {
 const fx = fixture({ generateImage: vi.fn() })
 const jobs = [storedJob('first', 'completed'), storedJob('second', 'failed')]
 seedHistory(fx, jobs)
 const api = request(fx.app)
 const preview = await api.post(bulkPreviewPath).send({ operation: 'trash', tab: 'all' })
 expect(preview.status).toBe(200)
 seedHistory(fx, [jobs[0], { ...jobs[1], status: 'cancelled' }])
 const result = await api.post(bulkCommitPath).send({ token: preview.body.token, confirm: true })
 expect(result.status).toBe(409)
 expect(result.body.error).toBe('任务状态已变化，请刷新后重新确认')
 const tasks: GenerationTask[] = (await api.get('/api/generation-tasks')).body.tasks
 expect(tasks.some(job => job.deletedAt)).toBe(false)
})

it('rejects invalid bulk requests without broadening the scope', async () => {
 const fx = fixture({ generateImage: vi.fn() })
 seedHistory(fx, [storedJob('done', 'completed')])
 const api = request(fx.app)
 for (const body of [
  {}, { operation: 'trash' }, { operation: 'unknown', tab: 'all' },
  { operation: 'trash', tab: 'trash' }, { operation: 'purge-failed', tab: 'all' },
  { operation: 'trash', tab: 'ALL' }, { operation: 'trash', tab: 'all', search: null },
 ]) {
  expect((await api.post(bulkPreviewPath).send(body)).status).toBe(400)
 }
 const empty = await api.post(bulkPreviewPath).send({ operation: 'trash', tab: 'all', search: 'none' })
 expect(empty.body).toMatchObject({ eligibleCount: 0, token: null })
 const preview = await api.post(bulkPreviewPath).send({ operation: 'trash', tab: 'all' })
 expect(preview.status).toBe(200)
 for (const body of [{ token: preview.body.token }, { token: preview.body.token, confirm: 'true' }, { confirm: true }]) {
  expect((await api.post(bulkCommitPath).send(body)).status).toBe(400)
 }
 expect((await api.post(bulkCommitPath).send({ token: 'invalid', confirm: true })).status).toBe(409)
 expect((await api.get('/api/generation-tasks')).body.tasks[0].deletedAt).toBeUndefined()
})

it('reports partial purge progress and leaves interrupted and unattempted records for a fresh preview', async () => {
 const fx = fixture({ generateImage: vi.fn() })
 const deletedAt = '2026-10-12'
 const blockedResult = { ...input, filename: 'blocked.png', width: 1, height: 1 }
 fs.mkdirSync(path.join(fx.root, 'images', blockedResult.filename))
 seedHistory(fx, [
  storedJob('first', 'failed', { deletedAt }),
  storedJob('blocked', 'failed', { deletedAt, result: blockedResult }),
  storedJob('last', 'failed', { deletedAt }),
 ])
 const api = request(fx.app)
 const preview = await api.post(bulkPreviewPath).send({ operation: 'purge-failed', tab: 'trash' })
 expect(preview.status).toBe(200)
 const result = await api.post(bulkCommitPath).send({ token: preview.body.token, confirm: true })
 expect(result.status).toBe(500)
 expect(result.body).toMatchObject({ deleted: 1, skipped: 0, remaining: 2, error: expect.any(String) })
 const tasks: GenerationTask[] = (await api.get('/api/generation-tasks')).body.tasks
 expect(tasks.map(job => [job.id, job.purgePending])).toEqual([['blocked', true], ['last', undefined]])
 fs.rmdirSync(path.join(fx.root, 'images', blockedResult.filename))
 const retry = await api.post(bulkPreviewPath).send({ operation: 'purge-failed', tab: 'trash' })
 expect(retry.body).toMatchObject({ eligibleCount: 2, retryPurgeCount: 1 })
 expect((await api.post(bulkCommitPath).send({ token: retry.body.token, confirm: true })).body).toEqual({ deleted: 2, skipped: 0 })
})

it('matches the accessible work code and rejects commit when that search no longer matches', async () => {
 const fx = fixture({ generateImage: vi.fn() })
 const repo = new JsonGalleryRepository(path.join(fx.root, 'gallery-data.json'))
 const [source] = await repo.listImages()
 await repo.saveImages([{ ...source, assetType: 'work' }])
 await repo.saveResources({ generationTasks: [
  storedJob('linked', 'completed', { workAssetId: source.id, result: { ...input, filename: source.filename, width: 1, height: 1 } }),
  storedJob('other', 'completed'),
 ] })
 const api = request(fx.app)
 const { body: { tasks } } = await api.get('/api/generation-tasks')
 const preview = await api.post(bulkPreviewPath).send({ operation: 'trash', tab: 'completed', search: tasks[0].workCode.toLowerCase() })
 expect(preview.body).toMatchObject({ matchedCount: 1, eligibleCount: 1 })
 await api.delete('/api/images/source').expect(200)
 await api.post(bulkCommitPath).send({ token: preview.body.token, confirm: true }).expect(409)
})

it('rejects a bulk confirmation after its preview expires', async () => {
 const fx = fixture({ generateImage: vi.fn() })
 seedHistory(fx, [storedJob('done', 'completed')])
 const api = request(fx.app)
 const preview = await api.post(bulkPreviewPath).send({ operation: 'trash', tab: 'all' }).expect(200)
 const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000)
 try {
  await api.post(bulkCommitPath).send({ token: preview.body.token, confirm: true }).expect(409)
 } finally {
  clock.mockRestore()
 }
 expect((await api.get('/api/generation-tasks')).body.tasks[0].deletedAt).toBeUndefined()
})

it('invalidates the history ETag and bulk preview when a target starts finalizing without an index change', async () => {
 const fx = fixture({ generateImage: vi.fn() })
 seedHistory(fx, [storedJob('finalizing', 'failed')])
 const execution = vi.spyOn(GenerationTaskQueue.prototype, 'isExecuting').mockReturnValue(false)
 try {
  const api = request(fx.app)
  const initial = await api.get('/api/generation-tasks').expect(200)
  expect(initial.body.tasks[0].executing).toBeUndefined()
  const preview = await api.post(bulkPreviewPath).send({ operation: 'trash', tab: 'failed' }).expect(200)
  execution.mockImplementation(id => id === 'finalizing')
  const updated = await api.get('/api/generation-tasks').set('If-None-Match', initial.headers.etag).expect(200)
  expect(updated.body.tasks[0]).toMatchObject({ executing: true, status: 'failed' })
  await api.get('/api/generation-tasks').set('If-None-Match', updated.headers.etag).expect(304)
  await api.post(bulkCommitPath).send({ token: preview.body.token, confirm: true }).expect(409)
  const blocked = await api.post(bulkPreviewPath).send({ operation: 'trash', tab: 'failed' }).expect(200)
  expect(blocked.body).toMatchObject({ token: null, eligibleCount: 0, skippedCount: 1 })
 } finally {
  execution.mockRestore()
 }
})

it('recognizes a disk receipt on restart without regenerating the image', async () => {
 const generateImage = vi.fn()
 const fx = fixture({ generateImage })
 const id = 'interrupted-with-receipt'
 const completedAt = new Date().toISOString()
 const filename = `gen_${id}.png`
 const dir = path.join(fx.root, '.generation-receipts')
 fs.mkdirSync(dir)
 fs.writeFileSync(path.join(fx.root, 'images', filename), recoveredPng)
 fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
  result: { ...input, filename, width: 1, height: 1 }, outputBytes: recoveredPng.length, completedAt,
 }))
 const repo = new JsonGalleryRepository(path.join(fx.root, 'gallery-data.json'))
 await repo.saveResources({ generationTasks: [{
  id, key: id, scope: { workspaceId: 'test', userId: 'test', ownerUserId: 'test' }, input,
  status: 'running', createdAt: completedAt, updatedAt: completedAt,
 }] })
 await fx.restart()
 await vi.waitFor(async () => {
  const job = (await request(fx.app).get('/api/generation-tasks')).body.tasks[0]
  expect(job).toMatchObject({ status: 'completed', completedAt, result: { filename } })
 })
 expect(generateImage).not.toHaveBeenCalled()
 expect(fs.existsSync(path.join(dir, `${id}.json`))).toBe(false)
})

it('does not publish an image whose PNG header is readable but whose pixels are truncated', async () => {
 const corrupt = recoveredPng.subarray(0, recoveredPng.length - 22)
 const generateImage = vi.fn(async () => ({ buffer: corrupt, mimeType: 'image/png' }))
 const fx = fixture({ generateImage })
 const api = request(fx.app)
 const submitted = await api.post('/api/generation-tasks').send({ ...input, key: 'corrupt-image' }).expect(202)
 await vi.waitFor(async () => {
  const { body: { tasks } } = await api.get('/api/generation-tasks')
  expect(tasks[0]).toMatchObject({ id: submitted.body.id, status: 'failed', failure: { category: 'storage' } })
  expect(tasks[0].result).toBeUndefined()
 })
 expect(fs.readdirSync(path.join(fx.root, 'images'))).toEqual(['source.png'])
 expect(generateImage).toHaveBeenCalledOnce()
})

it.each([
 ['qwen', 'qwen-image-3.0-pro', 'https://result.oss-cn-beijing.aliyuncs.com/original.png'],
] as const)('can resume %s from a trusted URL without requiring the old references', async (provider, model, url) => {
 const generateImage = vi.fn<ImageGenerationProvider['generateImage']>(async () => ({ buffer: recoveredPng, mimeType: 'image/png' }))
 const fx = fixture({ generateImage }, { imageGenerationModelProviders: { [imageGenerationModelKey(provider, model)]: { generateImage } } })
 seedHistory(fx, [queryJob('recover', { input: { ...input, provider, model }, upstreamTaskId: url })])
 fs.rmSync(path.join(fx.root, 'references', 'a.png'))
 fs.rmSync(path.join(fx.root, 'references', 'b.png'))
 const api = request(fx.app)
 await api.post('/api/generation-tasks/recover/resume-query').send({ key: 'download-only', expectedVersion: 0 }).expect(200)
 await vi.waitFor(async () => {
  const { body } = await api.get('/api/generation-tasks/recover').expect(200)
  expect(body.status).toBe('completed')
 })
 expect(generateImage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
  resumeTaskId: url, referenceImages: [], signal: expect.any(AbortSignal),
 }))
})

it('limits only history and uses a validator for the selected view', async () => {
 const fx = fixture({ generateImage: async () => { throw new Error('not run') } })
 const repository = new JsonGalleryRepository(path.join(fx.root, 'gallery-data.json'))
 const base = { input, scope: { userId: 'test', workspaceId: 'test' } }
 const tasks = [
  { id: 'old', status: 'failed', createdAt: '2026-01-01' },
  { id: 'queued', status: 'queued', createdAt: '2026-01-02' },
  { id: 'running', status: 'running', createdAt: '2026-01-03' },
  { id: 'saving', status: 'completed', workSavePending: true, createdAt: '2026-01-04' },
  { id: 'new', status: 'completed', createdAt: '2026-01-05' },
 ].map(job => ({ ...base, ...job })) as GenerationTask[]
 await repository.saveResources({ generationTasks: tasks })
 const full = await request(fx.app).get('/api/generation-tasks')
 const limited = await request(fx.app).get('/api/generation-tasks?limit=1').set('If-None-Match', full.headers.etag)
 expect(limited.status).toBe(200)
 expect(limited.body).toMatchObject({ total: 5, hasMore: true })
 expect(limited.body.tasks.map((job: GenerationTask) => job.id).sort()).toEqual(['new', 'queued', 'running', 'saving'])
 const etag = limited.headers.etag
 expect((await request(fx.app).get('/api/generation-tasks?limit=1').set('If-None-Match', etag)).status).toBe(304)
 tasks[0].input = { ...input, prompt: 'changed outside view' }
 await repository.saveResources({ generationTasks: tasks })
 expect((await request(fx.app).get('/api/generation-tasks?limit=1').set('If-None-Match', etag)).status).toBe(304)
 expect((await request(fx.app).get('/api/generation-tasks?limit=2')).body).toMatchObject({ total: 5, hasMore: false })
 const activeOnly = await request(fx.app).get('/api/generation-tasks?limit=0').expect(200)
 expect(activeOnly.body.tasks.map((job: GenerationTask) => job.id).sort()).toEqual(['queued', 'running', 'saving'])
})

it('reuses upload receipts after restart and only reclaims expired references that are not in use', async () => {
 const now = vi.spyOn(Date, 'now')
 const fx = fixture({ generateImage: async () => new Promise(() => {}) })
 const upload = (key: string) => request(fx.app).post('/api/references/upload').set('Idempotency-Key', key)
   .attach('references', recoveredPng, 'upload.png')
 try {
  now.mockReturnValue(Date.parse('2026-11-01T00:00:00Z'))
  const same = await Promise.all([upload('job-reference'), upload('job-reference')])
  expect(same.map(response => response.status)).toEqual([200, 200])
  expect(same[0].body).toEqual(same[1].body)
  const taskRef = same[0].body.filenames[0]
  const workRef = (await upload('work-reference')).body.filenames[0]
  const libraryRef = (await upload('library-reference')).body.filenames[0]
  const orphan = (await upload('orphan')).body.filenames[0]
  await fx.restart()
  expect((await upload('job-reference')).body).toEqual(same[0].body)
  const job = await request(fx.app).post('/api/generation-tasks').send({ ...input, key: 'claim', referenceFilenames: [taskRef] })
  expect(job.status).toBe(202)
  const library = await request(fx.app).post('/api/reference-library/assets').send({ name: 'Library', kind: 'references', filename: libraryRef })
  expect(library.status).toBe(201)
  const repository = new JsonGalleryRepository(path.join(fx.root, 'gallery-data.json'))
  const images = await repository.listImages()
  images[0].referenceImages.push(workRef)
  await repository.saveImages(images)
  now.mockReturnValue(Date.parse('2026-11-01T02:01:00Z'))
  expect((await upload('trigger-cleanup')).status).toBe(200)
  const references = fs.readdirSync(path.join(fx.root, 'references'))
  expect(references).toEqual(expect.arrayContaining([taskRef, workRef, libraryRef]))
  expect(references).not.toContain(orphan)
 } finally { now.mockRestore() }
})

it('rejects unauthenticated reference uploads before disk intake', async () => {
 const fx = fixture({ generateImage: async () => { throw new Error('not run') } }, { userAuthMode: 'cloudflare_access', localAuthSession: undefined })
 const response = await request(fx.app).post('/api/references/upload').attach('references', recoveredPng, 'upload.png')
 expect(response.status).toBe(401)
 expect(fs.readdirSync(path.join(fx.root, 'references')).sort()).toEqual(['a.png', 'b.png'])
})


it('prepares reference files even while the gallery write lock is busy', async () => {
 const fx = fixture({ generateImage: async () => { throw new Error('not run') } })
 const dataFile = path.join(fx.root, 'gallery-data.json')
 const coordinator = new GalleryWriteCoordinator(dataFile, `${dataFile}.lock`)
 let unlock!: () => void
 let locked!: () => void
 const acquired = new Promise<void>(resolve => { locked = resolve })
 const release = new Promise<void>(resolve => { unlock = resolve })
 const held = coordinator.run(async () => { locked(); await release })
 const finalize = vi.spyOn(DiskAssetStorage.prototype, 'finalizeReferences')
 try {
  await acquired
  const uploading = request(fx.app).post('/api/references/upload')
   .field('uploadKey', 'while-locked').attach('references', recoveredPng, 'upload.png')
   .then(response => response)
  try {
   await vi.waitFor(() => expect(finalize).toHaveBeenCalledOnce())
  } finally {
   unlock()
   await held
   expect((await uploading).status).toBe(200)
  }
 } finally { finalize.mockRestore() }
})
