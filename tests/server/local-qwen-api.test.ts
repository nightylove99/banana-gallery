import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import request from 'supertest'
import { afterEach, expect, it, vi } from 'vitest'
import { generationTasksFileFor } from '../../server/gallery/generation-task-storage'
import { createApp } from '../../server/app'
import type { GenerateImageProviderInput } from '../../server/ai/image-generation-provider'
// These API tests do not serve thumbnails; avoid background cache writes during fixture teardown.
const bypassThumbnail = async (source: string) => source
const thumbnailCache = { get: bypassThumbnail, warm: bypassThumbnail }
const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const fn of cleanup.splice(0))await fn()})
it('exposes live GPU status and persists seed, candidate ID and real source on save',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'banana-local-qwen-'));const dataFile=path.join(root,'gallery.json');fs.writeFileSync(dataFile,JSON.stringify({images:[]}))
 let available=false
 const provider={generateImage:vi.fn(async(input:GenerateImageProviderInput)=>{
  const execution={...input.execution!,workflowVersion:'qwen21-v2' as const,unetName:'Q4.gguf',referenceResolution:1024,width:1024,height:1024}
  await input.onRequestStartedWithUpstream!(input.requestId!,execution)
  const persisted=JSON.parse(fs.readFileSync(generationTasksFileFor(dataFile),'utf8')).generationTasks[0]
  expect(persisted.upstreamTaskId).toBe(input.requestId);expect(persisted.input.execution.seed).toBe(input.execution!.seed)
  expect(persisted.input.execution).toEqual(execution)
  expect(persisted.attempts[0]).toMatchObject({sent:true,requestStartedAt:expect.any(String)})
  return {buffer:await sharp({create:{width:1024,height:1024,channels:3,background:'red'}}).png().toBuffer(),mimeType:'image/png',execution}
 })}
 const app=createApp({thumbnailCache,ai:{models:{generateContent:async()=>({candidates:[]})}},strategy:{mode:'apiKey',apiKey:'test'},dataFile,imagesDir:path.join(root,'images'),referencesDir:path.join(root,'refs'),userAuthMode:'local',localAuthSession:{user:{id:'test',email:'test@local'},workspace:{id:'test',name:'Test'}},imageGenerationProviders:{'qwen-local':provider},localQwenStatus:async()=>({available,reason:available?undefined:'3090 离线'})})
 cleanup.push(async()=>{await app.locals.stopTaskQueue();fs.rmSync(root,{recursive:true,force:true})})
 let models=(await request(app).get('/api/generation/models')).body.models
 expect(models.find((m:{provider:string})=>m.provider==='qwen-local').available).toBe(false)
 available=true;models=(await request(app).get('/api/generation/models')).body.models
 expect(models.find((m:{provider:string})=>m.provider==='qwen-local').available).toBe(true)
 const body={key:'local-original',provider:'qwen-local',model:'qwen-image-2.1-UC-Q8_0',prompt:'local mug'}
 const submitted=await request(app).post('/api/generation-tasks').send(body);expect(submitted.status).toBe(202)
 await vi.waitFor(async()=>expect((await request(app).get('/api/generation-tasks')).body.tasks[0].status).toBe('completed'))
 const saved=await request(app).post('/api/generate/save').send({taskId:submitted.body.id,assetType:'work'})
 expect(saved.status).toBe(200);expect(saved.body.generation.provider).toBe('qwen-local');expect(saved.body.generation.execution.workflowVersion).toBe('qwen21-v2');expect(saved.body.generation.imageSize).toBe('1K')
 expect((await request(app).post('/api/generation-tasks').send(body)).body.id).toBe(submitted.body.id)
 expect(provider.generateImage).toHaveBeenCalledTimes(1)
})

it('recovers a persisted v2 task from its canvas without requiring local reference files',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'banana-qwen-resume-'));const dataFile=path.join(root,'gallery.json')
 const execution={engine:'comfyui',workflowVersion:'qwen21-v2',seed:42,steps:25,cfg:1,sampler:'euler',scheduler:'simple',unetName:'Q4.gguf',referenceResolution:1024,width:1024,height:1024}
 fs.writeFileSync(dataFile,JSON.stringify({images:[],resources:{generationTasks:[{id:'old-v2',key:'old-v2',scope:{userId:'test',workspaceId:'test'},input:{provider:'qwen-local',model:'qwen-image-2.1-UC-Q8_0',prompt:'recover',referenceFilenames:['missing.png'],aspectRatio:'source',imageSize:'1K',execution},status:'running',runnerId:'old',runnerPid:99999999,upstreamTaskId:'00112233-4455-4677-8899-aabbccddeeff',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}]}}))
 const provider={generateImage:vi.fn(async(input:GenerateImageProviderInput)=>{
  expect(input.resumeTaskId).toBe('00112233-4455-4677-8899-aabbccddeeff');expect(input.referenceImages).toEqual([]);expect(input.execution).toEqual(execution)
  return {buffer:await sharp({create:{width:1024,height:1024,channels:3,background:'red'}}).png().toBuffer(),mimeType:'image/png',execution:input.execution}
 })}
 const app=createApp({thumbnailCache,ai:{models:{generateContent:async()=>({candidates:[]})}},strategy:{mode:'apiKey',apiKey:'test'},dataFile,imagesDir:path.join(root,'images'),referencesDir:path.join(root,'refs'),userAuthMode:'local',localAuthSession:{user:{id:'test',email:'test@local'},workspace:{id:'test',name:'Test'}},imageGenerationProviders:{'qwen-local':provider}})
 cleanup.push(async()=>{await app.locals.stopTaskQueue();fs.rmSync(root,{recursive:true,force:true})})
 await app.locals.startTaskQueue()
 await vi.waitFor(async()=>expect((await request(app).get('/api/generation-tasks')).body.tasks[0].status).toBe('completed'))
 expect(provider.generateImage).toHaveBeenCalledTimes(1)
})

it('keeps explicit local Qwen ratios in the task API and rejects 4K before inference',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'banana-qwen-ratios-'));const dataFile=path.join(root,'gallery.json');fs.writeFileSync(dataFile,JSON.stringify({images:[]}))
 const seen:GenerateImageProviderInput[]=[]
 let indexedAtCleanup=false
 const cleanupRemote=vi.fn(async(localPath:string)=>{
  const data=JSON.parse(fs.readFileSync(generationTasksFileFor(dataFile),'utf8'))
  indexedAtCleanup=data.generationTasks.some((job:{result?:{filename:string}})=>job.result?.filename===path.basename(localPath))
 })
 const provider={generateImage:vi.fn(async(input:GenerateImageProviderInput)=>{seen.push(input);return {buffer:await sharp({create:{width:1376,height:768,channels:3,background:'red'}}).png().toBuffer(),mimeType:'image/png',execution:input.execution,onSaved:cleanupRemote}})}
 const app=createApp({thumbnailCache,ai:{models:{generateContent:async()=>({candidates:[]})}},strategy:{mode:'apiKey',apiKey:'test'},dataFile,imagesDir:path.join(root,'images'),referencesDir:path.join(root,'refs'),userAuthMode:'local',localAuthSession:{user:{id:'test',email:'test@local'},workspace:{id:'test',name:'Test'}},imageGenerationProviders:{'qwen-local':provider}})
 cleanup.push(async()=>{await app.locals.stopTaskQueue();fs.rmSync(root,{recursive:true,force:true})})
 const png=await sharp({create:{width:64,height:64,channels:3,background:'red'}}).png().toBuffer()
 const refs=await request(app).post('/api/references/upload').attach('references',png,'first.png').attach('references',png,'second.png')
 expect(refs.status).toBe(200)
 const body={provider:'qwen-local',model:'qwen-image-2.1-UC-Q8_0',prompt:'compose',referenceFilenames:refs.body.filenames,aspectRatio:'16:9',imageSize:'1K'}
 const task=await request(app).post('/api/generation-tasks').send({...body,key:'explicit-ratio'});expect(task.status).toBe(202)
 await vi.waitFor(async()=>expect((await request(app).get('/api/generation-tasks')).body.tasks[0].status).toBe('completed'))
 expect((await request(app).post('/api/generate/save').send({taskId:task.body.id,assetType:'work'})).status).toBe(200)
 await vi.waitFor(()=>expect(cleanupRemote).toHaveBeenCalledOnce())
 expect(indexedAtCleanup).toBe(true)
 expect(seen.map(input=>input.aspectRatio)).toEqual(['16:9'])
 expect((await request(app).post('/api/generation-tasks').send({...body,key:'bad-4k',imageSize:'4K'})).status).toBe(400)
 expect(provider.generateImage).toHaveBeenCalledOnce()
})
