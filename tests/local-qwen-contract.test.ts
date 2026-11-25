import assert from 'node:assert/strict'
import test from 'node:test'
import { IMAGE_GENERATION_MODEL_DEFINITIONS, isImageGenerationProviderName } from '../src/lib/image-generation-providers.ts'
import { parseTaskInput } from '../server/generation/task-input.ts'
import { loadAppEnv } from '../server/config/env.ts'
import { buildGenerationSnapshot } from '../src/lib/generate-state.ts'
import * as modelRegistry from '../src/lib/image-generation-providers.ts'

test('form capabilities switch to reference ratio without losing the text-to-image choice', () => {
 assert.equal(typeof modelRegistry.generationAspectRatios,'function')
 const model=modelRegistry.IMAGE_GENERATION_MODEL_DEFINITIONS.find(m=>m.provider==='qwen-local')!
 const ratios=['1:1','4:3','3:4','3:2','2:3','16:9','9:16','4:5','5:4']
 assert.deepEqual(modelRegistry.generationAspectRatios(model,1),['source',...ratios])
 assert.deepEqual(modelRegistry.generationAspectRatios(model,0),ratios)
 assert.deepEqual(modelRegistry.generationAspectRatios({...model,referenceAspectRatioMode:'source'},2),['source'])
})

test('configuration accepts any SSH alias plus optional port, start command and device pattern', () => {
 assert.equal(loadAppEnv({QWEN_LOCAL_SSH_HOST:'office-gpu'}).qwenLocalSshHost,'office-gpu')
 const env=loadAppEnv({QWEN_LOCAL_SSH_HOST:'comfyui-fixture',QWEN_LOCAL_REMOTE_PORT:'18188',QWEN_LOCAL_START_CMD:'start-comfyui',QWEN_LOCAL_GPU_PATTERN:'4090',QWEN_LOCAL_START_TIMEOUT_MS:'90000'})
 assert.equal(env.qwenLocalSshHost,'comfyui-fixture')
 assert.equal(env.qwenLocalRemotePort,18188)
 assert.equal(env.qwenLocalStartCmd,'start-comfyui')
 assert.equal(env.qwenLocalGpuPattern,'4090')
 assert.equal(env.qwenLocalStartTimeoutMs,90000)
 const defaults=loadAppEnv({QWEN_LOCAL_SSH_HOST:'comfyui-fixture'})
 assert.equal(defaults.qwenLocalRemotePort,8188)
 assert.equal(defaults.qwenLocalStartCmd,undefined)
 assert.equal(defaults.qwenLocalGpuPattern,undefined)
 assert.equal(defaults.qwenLocalStartTimeoutMs,180000)
 const execution={engine:'comfyui' as const,workflowVersion:'qwen21-v1' as const,seed:42,steps:25,cfg:1,sampler:'euler',scheduler:'simple'}
 assert.deepEqual(buildGenerationSnapshot({aspectRatio:'source',provider:'qwen-local',execution}).execution,execution)
})

test('local Qwen defaults to 1K and accepts ten ordered references but not eleven or 4K', () => {
  assert.equal(isImageGenerationProviderName('qwen-local'), true)
  const models = [...IMAGE_GENERATION_MODEL_DEFINITIONS]
  const model = models.find(m => m.provider === 'qwen-local')!
  assert.ok(model)
  assert.equal(model.defaultResolution, '1K')
  assert.equal(model.maxReferenceImages, 10)
  const body = { provider: 'qwen-local', model: model.model, prompt: 'test' }
  assert.equal(parseTaskInput(body, models).imageSize, '1K')
  assert.equal(parseTaskInput({ ...body, referenceFilenames: ['ref.png'] }, models).aspectRatio, 'source')
  assert.throws(() => parseTaskInput({ ...body, aspectRatio: 'source' }, models))
  const references=Array.from({length:10},(_,i)=>`ref-${i}.png`)
  assert.deepEqual(parseTaskInput({ ...body, referenceFilenames: references }, models).referenceFilenames,references)
  assert.equal(parseTaskInput({...body,referenceFilenames:references,aspectRatio:'16:9'},models).aspectRatio,'16:9')
  assert.throws(() => parseTaskInput({ ...body, referenceFilenames: [...references,'extra.png'] }, models))
  assert.throws(() => parseTaskInput({ ...body, imageSize:'4K' }, models))
})

test('local Qwen output presets match the approved dimensions and retain source compatibility',()=>{
 const expected={
  '1:1':[[1024,1024],[2048,2048]],'4:3':[[1184,896],[2400,1792]],'3:4':[[896,1184],[1792,2400]],
  '3:2':[[1280,864],[2528,1696]],'2:3':[[864,1280],[1696,2528]],'16:9':[[1376,768],[2752,1536]],
  '9:16':[[768,1376],[1536,2752]],'4:5':[[896,1120],[1792,2240]],'5:4':[[1120,896],[2240,1792]],
 }
 assert.equal(typeof modelRegistry.resolveLocalQwenOutputSize,'function')
 for(const [ratio,sizes] of Object.entries(expected))for(const [i,size] of sizes.entries())assert.deepEqual(modelRegistry.resolveLocalQwenOutputSize(i?'2K':'1K',ratio),{width:size[0],height:size[1]})
 assert.equal(modelRegistry.resolveLocalQwenOutputSize('1K','source'),null)
 assert.deepEqual(modelRegistry.resolveLocalQwenOutputSize('1K','source',{width:1000,height:1500}),{width:832,height:1248})
 assert.throws(()=>modelRegistry.resolveLocalQwenOutputSize('4K','1:1'))
 assert.throws(()=>modelRegistry.resolveLocalQwenOutputSize('1K','21:9'))
 assert.throws(()=>modelRegistry.resolveLocalQwenOutputSize('1K','source',{width:4000,height:1000}))
 assert.throws(()=>modelRegistry.resolveLocalQwenOutputSize('1K','source',{width:-1,height:-1}))
 assert.throws(()=>modelRegistry.resolveLocalQwenOutputSize('1K','toString'))
 assert.throws(()=>modelRegistry.resolveLocalQwenOutputSize('constructor','1:1'))
})
