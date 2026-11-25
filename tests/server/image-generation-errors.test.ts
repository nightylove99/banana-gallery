import {expect,it,vi} from 'vitest'
import {describeImageGenerationFailure as describe} from '../../server/ai/generation-failure'
import {SeedreamImageGenerationProvider} from '../../server/ai/seedream-image-provider'
import {QwenImageGenerationProvider} from '../../server/ai/qwen-image-provider'
import {KlingImageGenerationProvider} from '../../server/ai/kling-image-provider'
import {OpenAICompatibleImageGenerationProvider} from '../../server/ai/openai-compatible-image-provider'
import {ComfyUIImageProvider} from '../../server/ai/comfyui-image-provider'
import type {ImageGenerationProvider} from '../../server/ai/image-generation-provider'
const input={requestId:'00112233-4455-4677-8899-aabbccddeeff',prompt:'fixture',aspectRatio:'1:1',imageSize:'2K',referenceImages:[],noAutomaticRetry:true}
const factories: Array<[string,(fetch:typeof globalThis.fetch)=>ImageGenerationProvider]> = [
 ['Seedream',fetch=>new SeedreamImageGenerationProvider({apiKey:'fixture',fetch})],
 ['Qwen',fetch=>new QwenImageGenerationProvider({apiKey:'fixture',fetch})],
 ['Kling',fetch=>new KlingImageGenerationProvider({apiKey:'fixture',fetch})],
 ['OpenAI-compatible',fetch=>new OpenAICompatibleImageGenerationProvider({apiKey:'fixture',baseUrl:'https://fixture.invalid',fetch})],
]
for(const [name,create] of factories){
 it.each([
  [429,'Throttling','rate_limit',true],
  [401,'AuthenticationError','auth',false],
  [429,'insufficient_quota','quota',false],
  [503,'content_policy_violation','blocked',false],
  [200,'InvalidParameter','invalid_input',false],
 ] as const)(`${name} preserves original status %s and business code %s`,async(status,code,category,retryable)=>{
  const fetch=vi.fn(async()=>Response.json({error:{code,message:'provider detail'},code,message:'provider detail',request_id:'fixture-id'},{status,headers:{'x-request-id':'fixture-id','retry-after':'180'}}))
  try{await create(fetch).generateImage(input);throw Error('expected rejection')}catch(error){
   expect(describe(error)).toMatchObject({httpStatus:status,providerCode:code,category,retryable,requestId:'fixture-id',detail:'provider detail',retryAfterMs:180000})
  }
  expect(fetch).toHaveBeenCalledTimes(1)
 })
 it(`${name} does not send if the request marker cannot be saved`,async()=>{
  const fetch=vi.fn(async()=>Response.json({}))
  await expect(create(fetch).generateImage({...input,onRequestStarted:async()=>{throw Error('marker failed')}})).rejects.toThrow('marker failed')
  expect(fetch).not.toHaveBeenCalled()
 })
 if(name!=='Kling')it(`${name} stops on a complete response without an image`,async()=>{
  const fetch=vi.fn(async()=>Response.json({message:'provider returned text only'}))
  await expect(create(fetch).generateImage(input).catch(error=>{throw describe(error)})).rejects.toMatchObject({category:'no_image',retryable:false,uncertain:false,detail:expect.stringContaining('provider returned text only')})
  expect(fetch).toHaveBeenCalledTimes(1)
 })
}
it('ComfyUI saves the send marker after preparation and never POSTs when it fails',async()=>{
 const calls:string[]=[]
 const provider=new ComfyUIImageProvider({fetch:async(url)=>{calls.push(new URL(url).pathname);return Response.json({devices:[{name:'cuda fixture'}]})}})
 await expect(provider.generateImage({...input,onRequestStarted:async()=>{expect(calls).toEqual(['/system_stats']);throw Error('marker failed')}})).rejects.toThrow('marker failed')
 expect(calls).toEqual(['/system_stats'])
})
it('Qwen validates size before the send marker',async()=>{
 const marker=vi.fn();const fetch=vi.fn()
 await expect(new QwenImageGenerationProvider({apiKey:'fixture',fetch}).generateImage({...input,imageSize:'8K',onRequestStarted:marker})).rejects.toThrow()
 expect(marker).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled()
})
it('Kling resumes the original task without resetting the clock or re-submitting',async()=>{
 const marker=vi.fn();const fetch=vi.fn(async()=>Response.json({output:{task_status:'SUCCEEDED',choices:[]}}))
 await expect(new KlingImageGenerationProvider({apiKey:'fixture',fetch}).generateImage({...input,resumeTaskId:'original',onRequestStarted:marker}).catch(error=>{throw describe(error)})).rejects.toMatchObject({category:'no_image',retryable:false})
 expect(marker).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledTimes(1)
 expect(String(fetch.mock.calls[0][0])).toContain('/tasks/original')
})
