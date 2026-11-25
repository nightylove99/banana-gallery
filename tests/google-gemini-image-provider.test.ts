import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { GoogleGenAI } from '@google/genai'
import { describeImageGenerationFailure } from '../server/ai/generation-failure.ts'

import {
  DEFAULT_GEMINI_IMAGE_MODEL,
  GoogleGeminiImageGenerationProvider,
  type AppAI,
} from '../server/ai/google-gemini-image-provider.ts'

test('GoogleGeminiImageGenerationProvider 默认使用 GA Gemini image 模型', async () => {
  let requestedModel: string | undefined
  const ai: AppAI = {
    models: {
      generateContent: async (request) => {
        requestedModel = String(request.model)
        return {
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      data: Buffer.from('image-bytes').toString('base64'),
                      mimeType: 'image/png',
                    },
                  },
                ],
              },
            },
          ],
        }
      },
    },
  }

  const provider = new GoogleGeminiImageGenerationProvider(ai)
  await provider.generateImage({
    prompt: 'banana',
    referenceImages: [],
    aspectRatio: '1:1',
    imageSize: '1K',
  })

  assert.equal(requestedModel, DEFAULT_GEMINI_IMAGE_MODEL)
  assert.equal(requestedModel, 'gemini-nano-banana-2.1')
})

for (const [reason,category] of [['IMAGE_SAFETY','blocked'],['NO_IMAGE','no_image'],['IMAGE_OTHER','no_image']] as const) {
 test(`Google keeps ${reason} distinct from a missing upstream receipt`,async()=>{
  const provider=new GoogleGeminiImageGenerationProvider({models:{generateContent:async()=>({candidates:[{finishReason:reason as never,finishMessage:'upstream explanation'}]})}})
  await assert.rejects(provider.generateImage({prompt:'test',referenceImages:[],aspectRatio:'1:1'}),error=>{
   const e=error as Error & {providerCode?:string};assert.equal(e.providerCode,reason);assert.ok(e.message.includes(category==='blocked'?'IMAGE_SAFETY':reason));return true
  })
 })
}
test('Google captures prompt blocking without candidates',async()=>{
 const provider=new GoogleGeminiImageGenerationProvider({models:{generateContent:async()=>({promptFeedback:{blockReason:'SAFETY' as never}})}})
 await assert.rejects(provider.generateImage({prompt:'test',referenceImages:[],aspectRatio:'1:1'}),error=>{assert.equal((error as {providerCode?:string}).providerCode,'SAFETY');return true})
})
test('Google awaits the submission marker and does not call the model when it fails',async()=>{
 let sent=false;const provider=new GoogleGeminiImageGenerationProvider({models:{generateContent:async()=>{sent=true;return {}}}})
 const input={prompt:'test',referenceImages:[],aspectRatio:'1:1',onRequestStarted:async()=>{throw new Error('cannot persist marker')}}
 await assert.rejects(provider.generateImage(input),/cannot persist marker/);assert.equal(sent,false)
})
test('Google reads an image from a later candidate',async()=>{
 const provider=new GoogleGeminiImageGenerationProvider({models:{generateContent:async()=>({candidates:[{content:{parts:[{text:'no image here'}]}},{content:{parts:[{inlineData:{mimeType:'image/png',data:Buffer.from('second').toString('base64')}}]}}]})}})
 const result=await provider.generateImage({prompt:'test',referenceImages:[],aspectRatio:'1:1'})
 assert.equal(result.buffer.toString(),'second')
})
test('Google empty image preserves bounded structured evidence without image payloads',async()=>{
 const provider=new GoogleGeminiImageGenerationProvider({models:{generateContent:async()=>({responseId:'response-safe',candidates:[{finishReason:'STOP' as never,finishMessage:'x'.repeat(10000),content:{parts:[{text:'hello'}]}}],usageMetadata:{promptTokenCount:12}})}})
 await assert.rejects(provider.generateImage({prompt:'test',referenceImages:[],aspectRatio:'1:1'}),error=>{
  const evidence=(error as Error & {responseEvidence?:{candidateCount:number}}).responseEvidence
  assert.equal(evidence?.candidateCount,1);assert.ok(JSON.stringify(evidence).length<4096);return true
 })
})
test('Google empty candidates with oversized block metadata stays below 4 KiB',async()=>{
 const provider=new GoogleGeminiImageGenerationProvider({models:{generateContent:async()=>({candidates:[],promptFeedback:{blockReason:('x'.repeat(6000)) as never,blockReasonMessage:'界'.repeat(6000)}})}})
 await assert.rejects(provider.generateImage({prompt:'test',referenceImages:[],aspectRatio:'1:1'}),error=>{
  assert.ok(Buffer.byteLength(JSON.stringify((error as {responseEvidence?:unknown}).responseEvidence))<=4096);return true
 })
})

test('Google per-request timeout aborts the installed SDK HTTP response body', async () => {
  let requestCount = 0
  let reportClosed!: (aborted: boolean) => void
  const closed = new Promise<boolean>(resolve => { reportClosed = resolve })
  const server = createServer((_req, res) => {
    requestCount++
    res.once('close', () => reportClosed(!res.writableEnded))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write('{"candidates":')
    // End normally if no timeout is wired, so the test fails without leaving a socket open.
    const finish = setTimeout(() => res.end('[]}'), 900)
    res.once('close', () => clearTimeout(finish))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as AddressInfo
    const sdk = new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl: `http://127.0.0.1:${port}` } })
    const provider = new GoogleGeminiImageGenerationProvider(sdk, DEFAULT_GEMINI_IMAGE_MODEL, 300)
    await assert.rejects(provider.generateImage({
      prompt: 'timeout', referenceImages: [], aspectRatio: '1:1', noAutomaticRetry: true,
    }), error => {
      assert.match((error as Error).message, /timeout/i)
      const { category, uncertain, retryable } = describeImageGenerationFailure(error)
      assert.deepEqual({ category, uncertain, retryable }, { category: 'network', uncertain: true, retryable: false })
      return true
    })
    assert.equal(requestCount, 1)
    assert.equal(await closed, true)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
