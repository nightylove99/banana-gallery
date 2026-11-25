import assert from 'node:assert/strict'
import test from 'node:test'

import {
  QwenImageGenerationProvider,
  resolveQwenOutputSize,
} from '../server/ai/qwen-image-provider.ts'

test('Qwen Image 3.0 Pro 构造同步多模态请求并下载结果', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const provider = new QwenImageGenerationProvider({
    apiKey: 'test-dashscope-key',
    fetch: async (input, init) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.includes('/multimodal-generation/generation')) {
        return new Response(JSON.stringify({
          output: {
            choices: [{
              message: {
                content: [{ image: 'https://result.oss-cn-beijing.aliyuncs.com/qwen.png' }],
              },
            }],
          },
        }), { status: 200 })
      }
      return new Response(Buffer.from([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    },
  })

  const result = await provider.generateImage({
    prompt: '参考图生成海报',
    referenceImages: [{
      mimeType: 'image/png',
      data: Buffer.from([4, 5, 6]),
    }],
    aspectRatio: '16:9',
    imageSize: '2K',
  })

  const requestBody = JSON.parse(String(calls[0].init?.body))
  assert.equal(calls[0].init?.method, 'POST')
  assert.equal(requestBody.model, 'qwen-image-3.0-pro')
  assert.equal(requestBody.parameters.size, '2688*1536')
  assert.equal(requestBody.parameters.n, 1)
  assert.match(requestBody.input.messages[0].content[0].image, /^data:image\/png;base64,/)
  assert.equal(requestBody.input.messages[0].content[1].text, '参考图生成海报')
  assert.deepEqual(result.buffer, Buffer.from([1, 2, 3]))
})

test('Qwen 尺寸映射覆盖 1K/2K 并拒绝 4K', () => {
  assert.equal(resolveQwenOutputSize('1K', '1:1'), '1024*1024')
  assert.equal(resolveQwenOutputSize('2K', '21:9'), '3024*1296')
  assert.throws(() => resolveQwenOutputSize('4K', '1:1'), /仅支持 1K 或 2K/)
})

test('Qwen 拒绝超过三张参考图', async () => {
  const provider = new QwenImageGenerationProvider({
    apiKey: 'test-key',
    fetch: async () => {
      throw new Error('不应调用网络')
    },
  })
  await assert.rejects(
    provider.generateImage({
      prompt: 'test',
      referenceImages: Array.from({ length: 4 }, () => ({
        mimeType: 'image/png',
        data: Buffer.from([1]),
      })),
      aspectRatio: '1:1',
      imageSize: '1K',
    }),
    /最多支持 3 张参考图/,
  )
})

test('Qwen persists its trusted URL before retrying downloads and resumes by GET only', async () => {
  const imageUrl = 'https://dashscope-result.oss-cn-beijing.aliyuncs.com/qwen.png?signature=example'
  const requests: string[] = []
  let saved: string | undefined
  let downloads = 0
  const provider = new QwenImageGenerationProvider({
    apiKey: 'test',
    fetch: async (url, init) => {
      requests.push(init?.method ?? 'GET')
      if (init?.method === 'POST') return Response.json({ output: { choices: [{ message: { content: [{ image: imageUrl }] } }] } })
      assert.equal(String(url), saved)
      if (++downloads === 1) throw new TypeError('fetch failed')
      if (downloads === 2) return new Response(null, { status: 503 })
      return new Response('image bytes')
    },
  })
  const input = { prompt: 'test', aspectRatio: '1:1', imageSize: '1K', referenceImages: [] }
  await provider.generateImage({ ...input, onTaskSubmitted: async value => { saved = value } })
  await provider.generateImage({ ...input, resumeTaskId: saved })
  assert.deepEqual(requests, ['POST', 'GET', 'GET', 'GET', 'GET'])
  await assert.rejects(provider.generateImage({ ...input, resumeTaskId: 'https://oss-cn-beijing.aliyuncs.com.example.com/image.png' }))
  assert.equal(requests.length, 5)
})

test('Qwen abort cancels download backoff before another GET', async () => {
  const controller = new AbortController()
  let downloads = 0
  let responded!: () => void
  const received = new Promise<void>(resolve => { responded = resolve })
  const provider = new QwenImageGenerationProvider({
    apiKey: 'test',
    fetch: async (_url, init) => {
      downloads++
      assert.ok(init?.signal)
      responded()
      return new Response(null, { status: 503 })
    },
  })
  const result = provider.generateImage({
    prompt: 'test', referenceImages: [], aspectRatio: '1:1', signal: controller.signal,
    resumeTaskId: 'https://result.oss-cn-beijing.aliyuncs.com/original.png',
  })
  await received
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
  assert.equal(downloads, 1)
})
