import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mock } from 'node:test'
const modulePath='../server/ai/comfyui-runtime.ts'
async function load(){const mod=await import(modulePath).catch(()=>null);assert.ok(mod,'Gallery-owned ComfyUI runtime must exist');return mod}
test('disabled runtime never spawns SSH',async()=>{
 const mod=await load();let count=0
 const runtime=new mod.ComfyUIRuntime({spawn:()=>{count++;throw Error('unexpected')}})
 runtime.start();assert.equal((await runtime.status()).available,false);runtime.stop();assert.equal(count,0)
})
test('Krea availability requires all model files, not just a matching GPU',async()=>{
 const mod=await load();let ready=false
 const child=new EventEmitter();Object.assign(child,{kill:()=>true,stderr:new EventEmitter()})
 const runtime=new mod.ComfyUIRuntime({host:'comfyui-fixture',portAvailable:async()=>true,spawn:()=>child,fetch:async(url)=>{
  const node=new URL(url).pathname.split('/').at(-1)!
  if(node==='system_stats')return Response.json({devices:[{name:'cuda:0 RTX 4090'}]})
  const field=node==='UNETLoader'?'unet_name':node==='CLIPLoader'?'clip_name':'vae_name'
  const file=node==='UNETLoader'?'krea2_turbo_fp8_scaled.safetensors':node==='CLIPLoader'?'qwen3vl_4b_fp8_scaled.safetensors':'qwen_image_vae.safetensors'
  return Response.json({[node]:{input:{required:{[field]:[ready?[file]:[]]}}}})
 }})
 runtime.start();await new Promise(resolve=>setTimeout(resolve,20))
 try{assert.equal((await runtime.kreaStatus()).available,false);ready=true;assert.equal((await runtime.kreaStatus()).available,true)}finally{runtime.stop()}
})
test('configured ComfyUI output helper keeps legacy Qwen and Krea cleanup separate',async()=>{
 const mod=await load(),fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),crypto=await import('node:crypto')
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'banana-krea-cleanup-')),localPath=path.join(root,'image.png'),buffer=Buffer.from('Krea pixels'),sent:string[][]=[]
 await fs.writeFile(localPath,buffer)
 const runtime=new mod.ComfyUIRuntime({host:'comfyui-fixture',cleanupDir:root,outputHelperCommand:'python3 /srv/comfyui/output-helper.py',execFile:(...args:unknown[])=>{sent.push(args[1] as string[]);(args.at(-1) as (e:null,r:string)=>void)(null,JSON.stringify({deleted:true}))}})
 try {
  const sha=crypto.createHash('sha256').update(buffer).digest('hex'),host=crypto.createHash('sha256').update('comfyui-fixture').digest('hex').slice(0,16)
  const legacy=path.join(root,host);await fs.mkdir(legacy,{recursive:true})
  const id='00112233-4455-4677-8899-aabbccddeeff'
  await fs.writeFile(path.join(legacy,`${id}.json`),JSON.stringify({id,sha256:sha,localPath}))
  // Existing Qwen records must still be readable without adding a namespace field.
  await (runtime as unknown as {outputStore:{retry:()=>Promise<void>}}).outputStore.retry()
  assert.ok(sent.some(a=>a.at(-1) === `python3 /srv/comfyui/output-helper.py delete ${id} ${sha}`))
  const krea=(runtime as unknown as {kreaOutputStore:{saved:(id:string,b:Buffer,p:string)=>Promise<void>}}).kreaOutputStore
  assert.ok(krea,'Krea needs its own namespace-bound store')
  await krea.saved(id,buffer,localPath)
  assert.ok(sent.some(a=>a.at(-1)?.endsWith(`delete ${id} ${sha} Krea2`)))
 }finally{runtime.stop();await fs.rm(root,{recursive:true,force:true})}
})
test('owns one loopback tunnel, bypasses global fetch and stops only its process',async()=>{
 const mod=await load();let killed=0;let args:string[]=[]
 const child=new EventEmitter();Object.assign(child,{kill:()=>{killed++;return true},stderr:new EventEmitter()})
 const runtime=new mod.ComfyUIRuntime({host:'office-gpu',portAvailable:async()=>true,spawn:(_bin:string,a:string[])=>{args=a;return child},fetch:async()=>Response.json({devices:[{name:'cuda:0 NVIDIA GeForce RTX 3090'}]})})
 runtime.start();await new Promise(resolve=>setTimeout(resolve,20))
 assert.ok(args.includes('127.0.0.1:18488:127.0.0.1:8188'));assert.ok(args.includes('BatchMode=yes'));assert.ok(args.includes('StrictHostKeyChecking=yes'))
 assert.equal((await runtime.status()).available,true);runtime.stop();assert.equal(killed,1)
})
test('occupied port refuses ownership instead of stopping another tunnel',async()=>{
 const mod=await load();let count=0
 const runtime=new mod.ComfyUIRuntime({host:'office-gpu',portAvailable:async()=>false,spawn:()=>{count++;throw Error('unexpected')}})
 runtime.start();await new Promise(resolve=>setTimeout(resolve,20));assert.equal((await runtime.status()).available,false);assert.match((await runtime.status()).reason,/18488/);runtime.stop();assert.equal(count,0)
})
test('SSH exit marks the model offline and schedules a fresh owned connection',async()=>{
 const mod=await load();const children:EventEmitter[]=[]
 mock.timers.enable({apis:['setTimeout']})
 const runtime=new mod.ComfyUIRuntime({host:'office-gpu',portAvailable:async()=>true,spawn:()=>{const child=new EventEmitter();Object.assign(child,{kill:()=>true,stderr:new EventEmitter()});children.push(child);return child},fetch:async()=>Response.json({devices:[{name:'cuda:0 NVIDIA GeForce RTX 3090'}]})})
 try{
  runtime.start();await Promise.resolve();await Promise.resolve();assert.equal(children.length,1)
  children[0].emit('close',255);assert.equal((await runtime.status()).available,false)
  mock.timers.tick(2000);await Promise.resolve();await Promise.resolve();assert.equal(children.length,2)
 }finally{runtime.stop();mock.timers.reset()}
})
test('a failed remote start is attempted only once per connection until service recovery',async()=>{
 const mod=await load();let calls=0;const child=new EventEmitter();Object.assign(child,{kill:()=>true,stderr:new EventEmitter()})
 mock.timers.enable({apis:['setInterval','setTimeout','Date'],now:Date.now()})
 const runtime=new mod.ComfyUIRuntime({host:'comfyui-fixture',startCmd:'start-comfyui',portAvailable:async()=>true,spawn:()=>child,fetch:async()=>{throw Error('GPU is lost')},execFile:(...args:unknown[])=>{calls++;(args.at(-1) as (e:Error)=>void)(Error('GPU is lost'))}})
 try{
  runtime.start();await Promise.resolve();await Promise.resolve()
  for(let i=0;i<10;i++){mock.timers.tick(5000);for(let j=0;j<8;j++)await Promise.resolve()}
  assert.equal(calls,1)
 }finally{runtime.stop();mock.timers.reset()}
})
test('accepts any configured alias and remote port instead of a hardcoded host',async()=>{
 const mod=await load();let args:string[]=[]
 const child=new EventEmitter();Object.assign(child,{kill:()=>true,stderr:new EventEmitter()})
 const runtime=new mod.ComfyUIRuntime({host:'comfyui-fixture',remotePort:18188,portAvailable:async()=>true,spawn:(_bin:string,a:string[])=>{args=a;return child},fetch:async()=>Response.json({devices:[{name:'cuda:0 NVIDIA GeForce RTX 4090'}]})})
 runtime.start();await new Promise(resolve=>setTimeout(resolve,20))
 assert.ok(args.includes('127.0.0.1:18488:127.0.0.1:18188'))
 assert.ok(args.includes('comfyui-fixture'))
 assert.equal((await runtime.status()).available,true)
 runtime.stop()
})
test('gpu pattern rejects a device that does not match the configured host',async()=>{
 const mod=await load();const child=new EventEmitter();Object.assign(child,{kill:()=>true,stderr:new EventEmitter()})
 const runtime=new mod.ComfyUIRuntime({host:'comfyui-fixture',gpuPattern:'4090',portAvailable:async()=>true,spawn:()=>child,fetch:async()=>Response.json({devices:[{name:'cuda:0 NVIDIA GeForce RTX 3090'}]})})
 runtime.start();await new Promise(resolve=>setTimeout(resolve,20))
 assert.equal((await runtime.status()).available,false)
 runtime.stop()
})
test('start command runs through the owned SSH socket for the configured host',async()=>{
 const mod=await load();const sent:string[][]=[];const child=new EventEmitter();Object.assign(child,{kill:()=>true,stderr:new EventEmitter()})
 mock.timers.enable({apis:['setInterval','setTimeout','Date'],now:Date.now()})
 const runtime=new mod.ComfyUIRuntime({host:'comfyui-fixture',startCmd:'start-comfyui',portAvailable:async()=>true,spawn:()=>child,fetch:async()=>{throw Error('offline')},execFile:(...a:unknown[])=>{sent.push(a[1] as string[]);(a.at(-1) as (e:Error)=>void)(Error('offline'))}})
 try{
  runtime.start();await Promise.resolve();await Promise.resolve()
  for(let i=0;i<6;i++){mock.timers.tick(5000);for(let j=0;j<8;j++)await Promise.resolve()}
  assert.equal(sent.length,1)
  assert.ok(sent[0].includes('comfyui-fixture'))
  assert.ok(sent[0].some(part=>part.includes('start-comfyui')))
  assert.ok(sent[0].includes('-S'))
 }finally{runtime.stop();mock.timers.reset()}
})
test('without a start command the runtime never launches a remote service',async()=>{
 const mod=await load();let calls=0;const child=new EventEmitter();Object.assign(child,{kill:()=>true,stderr:new EventEmitter()})
 mock.timers.enable({apis:['setInterval','setTimeout','Date'],now:Date.now()})
 const runtime=new mod.ComfyUIRuntime({host:'comfyui-fixture',portAvailable:async()=>true,spawn:()=>child,fetch:async()=>{throw Error('offline')},execFile:(...a:unknown[])=>{calls++;(a.at(-1) as (e:Error)=>void)(Error('offline'))}})
 try{
  runtime.start();await Promise.resolve();await Promise.resolve()
  for(let i=0;i<6;i++){mock.timers.tick(5000);for(let j=0;j<8;j++)await Promise.resolve()}
  assert.equal(calls,0)
 }finally{runtime.stop();mock.timers.reset()}
})

test('saved output cleanup survives connection failure and process restart, and checks the Mac bytes',async()=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path')
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'qwen-cleanup-'))
 try{
  const moduleName='../server/ai/qwen-output-store.ts'
  const mod=await import(moduleName).catch(()=>null);assert.ok(mod,'durable Qwen output cleanup must exist')
  const local=path.join(root,'saved.png'),buffer=Buffer.from('verified image');await fs.writeFile(local,buffer)
  const pendingDir=path.join(root,'pending');let deletes=0
  const first=new mod.QwenOutputStore({pendingDir,remote:async()=>{throw Error('disconnected')}})
  await first.saved('00112233-4455-4677-8899-aabbccddeeff',buffer,local)
  assert.equal((await fs.readdir(pendingDir)).length,1)
  let indexed=false
  const next=new mod.QwenOutputStore({pendingDir,hasPersistedResult:async()=>indexed,remote:async(action:string)=>{assert.equal(action,'delete');deletes++;return {deleted:true}}})
  await next.retry();assert.equal(deletes,0);assert.equal((await fs.readdir(pendingDir)).length,1)
  indexed=true
  await fs.writeFile(local,'wrong bytes');await next.retry();assert.equal(deletes,0)
  await fs.writeFile(local,buffer);await next.retry();assert.equal(deletes,1);assert.deepEqual(await fs.readdir(pendingDir),[])
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
