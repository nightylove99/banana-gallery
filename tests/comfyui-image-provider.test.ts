import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import http from 'node:http'
import type { GenerateImageProviderInput } from '../server/ai/image-generation-provider.ts'
import type { GenerationExecution } from '../src/types.ts'

const modulePath = '../server/ai/comfyui-image-provider.ts'
const id = '00112233-4455-4677-8899-aabbccddeeff'
const input: GenerateImageProviderInput = { requestId: id, prompt: 'hello 3090', referenceImages: [], aspectRatio: '1:1', imageSize: '1K' }
test('Krea persists its own 8-step canvas before POST and cleans only after saving', async () => {
 const mod=await load(),png=await image(1376,768),calls:string[]=[]
 let graph:Record<string,{inputs:Record<string,unknown>}>|undefined, persisted:GenerationExecution|undefined,saved=false
 const provider=new mod.ComfyUIImageProvider({kind:'krea',remoteOutput:{find:async()=>undefined,saved:async()=>{saved=true}},fetch:async(url,init)=>{
  const route=new URL(url).pathname;calls.push(route)
  if(route==='/system_stats')return Response.json({devices:[{name:'cuda:0 RTX 4090'}]})
  if(route==='/prompt'){graph=JSON.parse(String(init?.body)).prompt;return Response.json({prompt_id:id})}
  if(route.startsWith('/history/'))return Response.json({[id]:{status:{completed:true},outputs:{'900':{images:[{filename:'result_00001_.png',subfolder:`Krea2/Gallery/${id}`,type:'output'}]}}}})
  if(route==='/view')return new Response(new Uint8Array(png))
  throw Error(route)
 }})
 const result=await provider.generateImage({...input,aspectRatio:'16:9',onTaskSubmitted:async(_id,snapshot)=>{persisted=snapshot}})
 assert.equal(persisted?.workflowVersion,'krea2-turbo-v1');assert.equal(persisted?.width,1376)
 assert.equal(graph?.['458'].inputs.steps,8);assert.equal(graph?.['458'].inputs.cfg,1)
 assert.equal(graph?.['452'].inputs.text,input.prompt);assert.equal(graph?.['451'].inputs.unet_name,'krea2_turbo_fp8_scaled.safetensors')
 assert.equal(saved,false);await result.onSaved?.('/tmp/mac-result.png');assert.equal(saved,true)
 await assert.rejects(provider.generateImage({...input,referenceImages:[{data:png,mimeType:'image/png'}]}))
 await assert.rejects(provider.generateImage({...input,imageSize:'4K'}))
 assert.equal(calls.filter(c=>c==='/prompt').length,1)
})
test('Krea resumes its frozen original from disk after history loss without another POST', async () => {
 const mod=await load(),png=await image(),calls:string[]=[]
 const execution:GenerationExecution={engine:'comfyui',workflowVersion:'krea2-turbo-v1',seed:42,steps:8,cfg:1,sampler:'euler',scheduler:'simple',width:1024,height:1024,unetName:'krea2_turbo_fp8_scaled.safetensors'}
 let saved=0
 const provider=new mod.ComfyUIImageProvider({kind:'krea',remoteOutput:{find:async task=>{assert.equal(task,id);return {filename:'result_00001_.png',subfolder:`Krea2/Gallery/${id}`,type:'output'}},saved:async()=>{saved++}},fetch:async url=>{
  const route=new URL(url).pathname;calls.push(route)
  if(route.startsWith('/history/'))return Response.json({})
  if(route==='/queue')return Response.json({queue_running:[],queue_pending:[]})
  if(route==='/view')return new Response(new Uint8Array(png))
  throw Error(route)
 }})
 const output=await provider.generateImage({...input,resumeTaskId:id,execution})
 assert.deepEqual(output.execution,execution);assert.equal(calls.includes('/prompt'),false);assert.equal(saved,0)
 await output.onSaved?.('/tmp/saved.png');assert.equal(saved,1)
})
test('Krea persistence failure prevents submission and a lost receipt never repeats inference',async()=>{
 const mod=await load(),png=await image();let submits=0
 const provider=new mod.ComfyUIImageProvider({kind:'krea',fetch:async url=>{
  const route=new URL(url).pathname
  if(route==='/system_stats')return Response.json({devices:[{name:'cuda:0 RTX 4090'}]})
  if(route==='/prompt'){submits++;throw Error('receipt lost')}
  if(route.startsWith('/history/'))return Response.json({[id]:{status:{completed:true},outputs:{'900':{images:[{filename:'result.png',subfolder:`Krea2/Gallery/${id}`,type:'output'}]}}}})
  if(route==='/view')return new Response(new Uint8Array(png))
  throw Error(route)
 }})
 await assert.rejects(provider.generateImage({...input,onTaskSubmitted:async()=>{throw Error('disk full')}}))
 assert.equal(submits,0)
 const output=await provider.generateImage(input);assert.equal(output.execution?.steps,8);assert.equal(submits,1)
})
async function load() { const mod = await import(modulePath).catch(() => null); assert.ok(mod, 'ComfyUI provider must exist'); return mod }
async function image(width=1024,height=1024) { return sharp({create:{width,height,channels:3,background:'red'}}).png().toBuffer() }
test('direct transport serializes native FormData as actual multipart on this Node runtime',async()=>{
 const mod=await load();let contentType='';let body=''
 const server=http.createServer((req,res)=>{contentType=String(req.headers['content-type']);req.on('data',chunk=>{body+=chunk});req.on('end',()=>res.end('ok'))})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 try{
  const port=(server.address() as {port:number}).port
  const form=new FormData();form.append('image',new Blob(['pixels'],{type:'image/png'}),'ref.png')
  const response=await mod.comfyuiFetch(`http://127.0.0.1:${port}/upload`,{method:'POST',body:form});await response.text()
  assert.match(contentType,/multipart\/form-data/);assert.match(body,/filename="ref.png"/);assert.match(body,/pixels/)
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
test('persists UUID before submitting the fixed workflow and downloads only its output', async () => {
 const mod=await load(); const png=await image(); const calls:string[]=[]; let saved=false;let submittedAfterSave=false;let submitted:Record<string,unknown>|undefined
 const provider=new mod.ComfyUIImageProvider({fetch:async(url: string, init?:RequestInit)=>{
  const route=new URL(url).pathname;calls.push(route)
  if(route==='/system_stats')return Response.json({devices:[{name:'cuda:0 NVIDIA GeForce RTX 3090'}]})
  if(route==='/prompt') { submittedAfterSave=saved;submitted=JSON.parse(String(init?.body));return Response.json({prompt_id:id}) }
  if(route===`/history/${id}`)return Response.json({[id]:{status:{completed:true,status_str:'success'},outputs:{'900':{images:[{filename:'out.png',subfolder:`Qwen21\\Gallery\\${id}`,type:'output'}]}}}})
  if(route==='/view')return new Response(new Uint8Array(png),{headers:{'content-type':'image/png'}})
  throw Error(route)
 }})
 const result=await provider.generateImage({...input,onTaskSubmitted:async savedId=>{assert.equal(savedId,id);saved=true}})
 assert.equal(submittedAfterSave,true);assert.equal(submitted?.prompt_id,id)
 const graph=submitted?.prompt as Record<string,{inputs:Record<string,unknown>}>
 assert.equal(graph['452'].inputs.prompt,input.prompt);assert.equal(graph['456'].inputs.width,1024);assert.equal(graph['458'].inputs.cfg,1)
 assert.deepEqual(result.buffer,png);assert.equal(result.execution.steps,25)
 assert.equal(calls.filter(c=>c==='/prompt').length,1)
})
test('uploads one reference, preserves the edit latent and uses returned upload name',async()=>{
 const mod=await load();const png=await image(1536,1024);let submittedGraph:Record<string,{inputs:Record<string,unknown>}>|undefined
 const provider=new mod.ComfyUIImageProvider({fetch:async(url:string,init?:RequestInit)=>{
  const route=new URL(url).pathname
  if(route==='/system_stats')return Response.json({devices:[{name:'cuda:0 NVIDIA GeForce RTX 3090'}]})
  if(route==='/upload/image'){assert.ok(init?.body instanceof FormData);return Response.json({name:'accepted.png',subfolder:'banana-gallery',type:'input'})}
  if(route==='/prompt'){submittedGraph=JSON.parse(String(init?.body)).prompt;return Response.json({prompt_id:id})}
  if(route.startsWith('/history/'))return Response.json({[id]:{status:{completed:true,status_str:'success'},outputs:{'900':{images:[{filename:'out.png',subfolder:`Qwen21/Gallery/${id}`,type:'output'}]}}}})
  if(route==='/view')return new Response(new Uint8Array(await image(2496,1664)),{headers:{'content-type':'image/png'}})
  throw Error(route)
 }})
 await provider.generateImage({...input,execution:{engine:'comfyui',workflowVersion:'qwen21-v1',seed:42,steps:25,cfg:1,sampler:'euler',scheduler:'simple'},aspectRatio:'source',imageSize:'2K',referenceImages:[{mimeType:'image/png',data:png}]})
 assert.ok(submittedGraph);assert.equal(submittedGraph['901'].inputs.image,'banana-gallery/accepted.png');assert.deepEqual(submittedGraph['458'].inputs.latent_image,['474',2]);assert.equal(submittedGraph['474'].inputs.resolution,2048)
})
test('lost submit receipt recovers by UUID and never submits twice',async()=>{
 const mod=await load();const png=await image();let submits=0
 const provider=new mod.ComfyUIImageProvider({fetch:async(url:string)=>{
  const route=new URL(url).pathname
  if(route==='/system_stats')return Response.json({devices:[{name:'cuda:0 NVIDIA GeForce RTX 3090'}]})
  if(route==='/prompt'){submits++;throw Error('fetch failed')}
  if(route.startsWith('/history/'))return Response.json({[id]:{status:{completed:true,status_str:'success'},outputs:{'900':{images:[{filename:'out.png',subfolder:`Qwen21/Gallery/${id}`,type:'output'}]}}}})
  if(route==='/view')return new Response(new Uint8Array(png),{headers:{'content-type':'image/png'}})
  throw Error(route)
 }})
 await provider.generateImage(input);assert.equal(submits,1)
 await provider.generateImage({...input,resumeTaskId:id});assert.equal(submits,1)
})
test('missing resumed job stays uncertain; malformed workflow rejection does not retry',async()=>{
 const mod=await load();let posts=0
 const provider=new mod.ComfyUIImageProvider({fetch:async(url:string)=>{
  const route=new URL(url).pathname
  if(route==='/system_stats')return Response.json({devices:[{name:'cuda:0 NVIDIA GeForce RTX 3090'}]})
  if(route==='/prompt'){posts++;return Response.json({node_errors:{'451':{errors:[{message:'missing model'}]}}},{status:400})}
  if(route==='/queue')return Response.json({queue_running:[],queue_pending:[]})
  if(route.startsWith('/history/'))return Response.json({})
  throw Error(route)
 }})
 await assert.rejects(provider.generateImage({...input,resumeTaskId:id}), (e:unknown)=>!!e && typeof e==='object' && 'uncertain' in e && e.uncertain===true)
 assert.equal(posts,0)
 await assert.rejects(provider.generateImage(input), (e:unknown)=>!!e && typeof e==='object' && 'uncertain' in e && e.uncertain===false)
 assert.equal(posts,1)
})
test('validation rejects eleven references and a persisted-ID failure prevents POST',async()=>{
 const mod=await load();let posts=0;const png=await image()
 const provider=new mod.ComfyUIImageProvider({fetch:async(url:string)=>{if(new URL(url).pathname==='/prompt')posts++;return Response.json({devices:[{name:'cuda:0 NVIDIA GeForce RTX 3090'}]})}})
 await assert.rejects(provider.generateImage({...input,referenceImages:Array.from({length:11},()=>({mimeType:'image/png',data:png}))}))
 await assert.rejects(provider.generateImage({...input,onTaskSubmitted:async()=>{throw Error('disk full')}}))
 assert.equal(posts,0)
})

for (const count of [2, 10]) test(`uploads ${count} ordered references and persists v2 geometry before inference`, async () => {
 const mod=await load();const png=await image();const output=await image(2048,2048)
 let uploaded=0;let persisted:GenerationExecution|undefined;const filenames:string[]=[]
 let submittedGraph:Record<string,{class_type:string;inputs:Record<string,unknown>}>|undefined;let persistedBeforeSubmit:GenerationExecution|undefined;let uploadsAtSubmit=0
 const provider=new mod.ComfyUIImageProvider({unetName:'qwen-image-2.1-UC-Q4_K_M.gguf',fetch:async(url,init)=>{
  const route=new URL(url).pathname
  if(route==='/system_stats')return Response.json({devices:[{name:'cuda:0 RTX 4090'}]})
  if(route==='/upload/image'){
   const file=(init?.body as FormData).get('image') as File;filenames.push(file.name)
   assert.match(file.name,new RegExp(`${id}-${uploaded+1}\\.png$`));uploaded++
   return Response.json({name:`accepted-${uploaded}.png`,subfolder:'banana-gallery'})
  }
  if(route==='/prompt'){
   submittedGraph=JSON.parse(String(init?.body)).prompt;persistedBeforeSubmit=structuredClone(persisted);uploadsAtSubmit=uploaded
   return Response.json({prompt_id:id})
  }
  if(route.startsWith('/history/'))return Response.json({[id]:{status:{completed:true},outputs:{'900':{images:[{filename:'out.png',subfolder:`Qwen21/Gallery/${id}`,type:'output'}]}}}})
  if(route==='/view')return new Response(new Uint8Array(output))
  throw Error(route)
 }})
 const result=await provider.generateImage({...input,imageSize:'2K',aspectRatio:'source',referenceImages:Array.from({length:count},()=>({mimeType:'image/png',data:png})),onTaskSubmitted:async(_,execution)=>{persisted=execution}})
 assert.equal(uploadsAtSubmit,count);assert.equal(persistedBeforeSubmit?.workflowVersion,'qwen21-v2')
 assert.equal(persistedBeforeSubmit?.referenceResolution,2048);assert.equal(persistedBeforeSubmit?.width,2048);assert.equal(persistedBeforeSubmit?.height,2048)
 assert.deepEqual(persistedBeforeSubmit?.referenceDimensions,Array.from({length:count},(_,i)=>({width:i===0?2048:1024,height:i===0?2048:1024})))
 assert.equal(persistedBeforeSubmit?.unetName,'qwen-image-2.1-UC-Q4_K_M.gguf')
 assert.ok(submittedGraph);const graph=submittedGraph
 assert.equal(graph['474'].inputs.resolution,0)
 for(let i=1;i<=count;i++){
  const scaled=graph[(graph['474'].inputs[`images.image_${i}`] as [string,number])[0]]
  assert.equal(scaled.class_type,'ImageScale');assert.equal(scaled.inputs.width,i===1?2048:1024)
  assert.equal(scaled.inputs.crop,'disabled')
  assert.equal(graph[(scaled.inputs.image as [string,number])[0]].inputs.image,`banana-gallery/accepted-${i}.png`)
 }
 assert.deepEqual(graph['458'].inputs.latent_image,['474',2])
 assert.equal(new Set(filenames).size,count);assert.deepEqual(result.execution,persisted)
 // Resume relies on the persisted canvas, even if reference bytes/config have changed.
 const resumed=new mod.ComfyUIImageProvider({unetName:'different.gguf',fetch:async(url)=>{
  const route=new URL(url).pathname
  if(route.startsWith('/history/'))return Response.json({[id]:{status:{completed:true},outputs:{'900':{images:[{filename:'out.png',subfolder:`Qwen21/Gallery/${id}`,type:'output'}]}}}})
  if(route==='/view')return new Response(new Uint8Array(output))
  throw Error(`Resume must not call ${route}`)
 }})
 assert.deepEqual((await resumed.generateImage({...input,aspectRatio:'source',resumeTaskId:id,execution:persisted,referenceImages:[]})).execution,persisted)
})

test('a failed second reference upload never submits a partial inference',async()=>{
 const mod=await load();const png=await image();let uploads=0;let posts=0
 const provider=new mod.ComfyUIImageProvider({fetch:async(url)=>{
  const route=new URL(url).pathname
  if(route==='/system_stats')return Response.json({devices:[{name:'cuda:0 RTX 4090'}]})
  if(route==='/upload/image')return ++uploads===1?Response.json({name:'first.png',subfolder:'banana-gallery'}):new Response('unavailable',{status:503})
  if(route==='/prompt')posts++
  throw Error(route)
 }})
 await assert.rejects(provider.generateImage({...input,aspectRatio:'source',referenceImages:Array.from({length:2},()=>({mimeType:'image/png',data:png}))}),(e:unknown)=>!!e&&typeof e==='object'&&'uncertain' in e&&e.uncertain===false)
 assert.equal(uploads,2);assert.equal(posts,0)
})

test('v2 uses EXIF-oriented geometry and freezes every resized reference dimension',async()=>{
 const mod=await load();const reference=await sharp(await image(1500,1000)).jpeg().withMetadata({orientation:6}).toBuffer()
 let graph:Record<string,{inputs:Record<string,unknown>}>|undefined
 const provider=new mod.ComfyUIImageProvider({fetch:async(url,init)=>{
  const route=new URL(url).pathname
  if(route==='/system_stats')return Response.json({devices:[{name:'cuda:0 RTX 4090'}]})
  if(route==='/upload/image')return Response.json({name:'rotated.jpg',subfolder:'banana-gallery'})
  if(route==='/prompt'){graph=JSON.parse(String(init?.body)).prompt;return Response.json({prompt_id:id})}
  if(route.startsWith('/history/'))return Response.json({[id]:{status:{completed:true},outputs:{'900':{images:[{filename:'out.png',subfolder:`Qwen21/Gallery/${id}`,type:'output'}]}}}})
  if(route==='/view')return new Response(new Uint8Array(await image(832,1248)))
  throw Error(route)
 }})
 const result=await provider.generateImage({...input,aspectRatio:'source',referenceImages:[{mimeType:'image/jpeg',data:reference}]})
 assert.deepEqual(result.execution.referenceDimensions,[{width:832,height:1248}]);assert.equal(result.execution.width,832)
 assert.ok(graph);assert.equal(graph['951'].inputs.width,832);assert.equal(graph['951'].inputs.height,1248);assert.equal(graph['474'].inputs.resolution,0)
})

for(const [aspectRatio,count,width,height] of [['16:9',2,1376,768],['4:5',0,896,1120]] as const)test(`v2 honors ${aspectRatio} output with ${count} references`,async()=>{
 const mod=await load();const png=await image();let graph:Record<string,{inputs:Record<string,unknown>}>|undefined
 const provider=new mod.ComfyUIImageProvider({fetch:async(url,init)=>{
  const route=new URL(url).pathname
  if(route==='/system_stats')return Response.json({devices:[{name:'cuda:0 RTX 4090'}]})
  if(route==='/upload/image')return Response.json({name:'ref.png',subfolder:'banana-gallery'})
  if(route==='/prompt'){graph=JSON.parse(String(init?.body)).prompt;return Response.json({prompt_id:id})}
  if(route.startsWith('/history/'))return Response.json({[id]:{status:{completed:true},outputs:{'900':{images:[{filename:'out.png',subfolder:`Qwen21/Gallery/${id}`,type:'output'}]}}}})
  if(route==='/view')return new Response(new Uint8Array(await image(width,height)))
  throw Error(route)
 }})
 const result=await provider.generateImage({...input,aspectRatio,referenceImages:Array.from({length:count},()=>({data:png,mimeType:'image/png'}))})
 assert.equal(result.execution.width,width);assert.equal(result.execution.height,height);assert.ok(graph)
 assert.equal(graph['456'].inputs.width,width);assert.equal(graph['456'].inputs.height,height);assert.deepEqual(graph['458'].inputs.latent_image,['456',0])
})

test('remote output is acknowledged only after Mac storage confirms and resumes from disk after history loss',async()=>{
 const mod=await load();const png=await image();let acknowledged=0;let lookup=0
 const provider=new mod.ComfyUIImageProvider({remoteOutput:{
  find:async(taskId:string)=>{assert.equal(taskId,id);lookup++;return {filename:'result_00001_.png',subfolder:`Qwen21/Gallery/${id}`,type:'output'}},
  saved:async(taskId:string,buffer:Buffer,localPath:string)=>{assert.equal(taskId,id);assert.deepEqual(buffer,png);assert.equal(localPath,'/mac/saved.png');acknowledged++},
 },fetch:async(url:string)=>{
  const route=new URL(url).pathname
  if(route.startsWith('/history/'))return Response.json({})
  if(route==='/queue')return Response.json({queue_running:[],queue_pending:[]})
  if(route==='/view')return new Response(new Uint8Array(png))
  throw Error(`Must not regenerate: ${route}`)
 }})
 const result=await provider.generateImage({...input,resumeTaskId:id,execution:{engine:'comfyui',workflowVersion:'qwen21-v2',seed:42,steps:25,cfg:1,sampler:'euler',scheduler:'simple',width:1024,height:1024,unetName:'test.gguf',referenceResolution:1024}})
 assert.equal(lookup,1);assert.equal(acknowledged,0)
 assert.equal(typeof result.onSaved,'function');await result.onSaved('/mac/saved.png');assert.equal(acknowledged,1)
})

for (const kind of ['qwen', 'krea'] as const) {
 test(`${kind} records dispatch and its preallocated ID in one pre-POST callback`, async () => {
  const mod = await load()
  const events: string[] = []
  const provider = new mod.ComfyUIImageProvider({kind, fetch: async url => {
   const route = new URL(url).pathname
   if (route === '/system_stats') return Response.json({devices: [{name: kind === 'krea' ? 'cuda:0 RTX 4090' : 'cuda:0 RTX 3090'}]})
   if (route === '/prompt') { events.push('POST'); return new Response(null, {status: 400}) }
   throw Error(route)
  }})
  const dispatch = async (taskId: string, execution: GenerationExecution) => {
   assert.equal(taskId, id)
   assert.equal(execution.engine, 'comfyui')
   events.push('dispatch')
  }
  const callbacks = {
   onTaskSubmitted: async () => { events.push('separate ID write') },
   onRequestStarted: async () => { events.push('separate sent write') },
   onRequestStartedWithUpstream: dispatch,
  }
  await assert.rejects(provider.generateImage({...input, ...callbacks}), /拒绝工作流/)
  assert.deepEqual(events, ['dispatch', 'POST'])
 })
}
