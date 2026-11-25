import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveSeedreamOutputSize,
  SeedreamImageGenerationProvider,
  SeedreamImageGenerationRequestError,
} from '../server/ai/seedream-image-provider.ts'

const tinyPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZC5QAAAAASUVORK5CYII='

test('Seedream provider 发送有序参考图、2K 尺寸与安全输出参数', async () => {
  let requestBody: Record<string, unknown> | null = null
  let authorization = ''
  const provider = new SeedreamImageGenerationProvider({
    apiKey: 'test-seedream-key',
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      authorization = new Headers(init?.headers).get('authorization') ?? ''
      return Response.json({
        data: [{ b64_json: tinyPngBase64, output_format: 'png' }],
      })
    },
  })

  const result = await provider.generateImage({
    prompt: '把图1和图2融合',
    aspectRatio: '4:5',
    imageSize: '2K',
    referenceImages: [
      { mimeType: 'image/png', data: Buffer.from('first') },
      { mimeType: 'image/jpeg', data: Buffer.from('second') },
    ],
  })

  assert.equal(authorization, 'Bearer test-seedream-key')
  assert.deepEqual(requestBody, {
    model: 'doubao-seedream-5-5-261028',
    prompt: '把图1和图2融合',
    size: '1920x2400',
    output_format: 'png',
    response_format: 'b64_json',
    watermark: false,
    image: [
      `data:image/png;base64,${Buffer.from('first').toString('base64')}`,
      `data:image/jpeg;base64,${Buffer.from('second').toString('base64')}`,
    ],
  })
  assert.equal(result.mimeType, 'image/png')
  assert.deepEqual(result.buffer, Buffer.from(tinyPngBase64, 'base64'))
})

test('Seedream provider 单张参考图使用字符串字段', async () => {
  let requestBody: Record<string, unknown> | null = null
  const provider = new SeedreamImageGenerationProvider({
    apiKey: 'test-seedream-key',
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({ data: [{ b64_json: tinyPngBase64 }] })
    },
  })

  await provider.generateImage({
    prompt: '编辑图片',
    aspectRatio: '1:1',
    imageSize: '1K',
    referenceImages: [
      { mimeType: 'image/png', data: Buffer.from('only') },
    ],
  })

  assert.equal(
    requestBody?.image,
    `data:image/png;base64,${Buffer.from('only').toString('base64')}`,
  )
})

test('Seedream provider 对 429 重试，对参数错误不重试', async () => {
  let calls = 0
  const delays: number[] = []
  const retryingProvider = new SeedreamImageGenerationProvider({
    apiKey: 'test-seedream-key',
    sleep: async (milliseconds) => {
      delays.push(milliseconds)
    },
    fetch: async () => {
      calls += 1
      if (calls === 1) {
        return Response.json(
          { error: { code: 'RateLimit', message: 'slow down' } },
          { status: 429 },
        )
      }
      return Response.json({ data: [{ b64_json: tinyPngBase64 }] })
    },
  })

  await retryingProvider.generateImage({
    prompt: 'banana',
    aspectRatio: '1:1',
    imageSize: '1K',
    referenceImages: [],
  })
  assert.equal(calls, 2)
  assert.deepEqual(delays, [500])

  calls = 0
  const failingProvider = new SeedreamImageGenerationProvider({
    apiKey: 'test-seedream-key',
    fetch: async () => {
      calls += 1
      return Response.json(
        { error: { code: 'InvalidParameter', message: 'bad size' } },
        { status: 400, headers: { 'x-request-id': 'seedream-req-1' } },
      )
    },
  })

  await assert.rejects(
    () =>
      failingProvider.generateImage({
        prompt: 'banana',
        aspectRatio: '1:1',
        imageSize: '1K',
        referenceImages: [],
      }),
    (error) => {
      assert.ok(error instanceof SeedreamImageGenerationRequestError)
      assert.equal(error.status, 400)
      assert.equal(error.providerCode, 'InvalidParameter')
      assert.equal(error.requestId, 'seedream-req-1')
      return true
    },
  )
  assert.equal(calls, 1)
})

test('Seedream 尺寸映射覆盖 4:5、5:4 并拒绝 4K', () => {
  assert.equal(resolveSeedreamOutputSize('1K', '5:4'), '1200x960')
  assert.equal(resolveSeedreamOutputSize('2K', '4:5'), '1920x2400')
  assert.throws(
    () => resolveSeedreamOutputSize('4K', '1:1'),
    /仅支持 1K 或 2K/,
  )
})

test('持久任务禁用 Seedream 网络与 5xx 自动重提',async()=>{
 for(const networkFailure of [true,false]){
  let calls=0
  const provider=new SeedreamImageGenerationProvider({apiKey:'test',sleep:async()=>{},fetch:async()=>{calls++;if(networkFailure)throw new Error('lost reply');return Response.json({error:{message:'unconfirmed'}},{status:500})}})
  await assert.rejects(provider.generateImage({prompt:'test',referenceImages:[],aspectRatio:'1:1',imageSize:'2K',noAutomaticRetry:true}))
  assert.equal(calls,1)
 }
})
