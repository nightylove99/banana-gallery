import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Agent } from 'undici'
import { fetchWithDispatcher } from '../server/dispatcher-fetch.ts'
import sharp from 'sharp'
import { loadAppEnv } from '../server/config/env.ts'
import { createOpenAICompatibleRuntimeProvider } from '../server/ai/openai-compatible-runtime.ts'
import { OpenAICompatibleImageGenerationProvider } from '../server/ai/openai-compatible-image-provider.ts'

const input = { prompt: 'fixture', referenceImages: [], aspectRatio: '3:2', quality: 'medium' as const }
const png = () => sharp({ create: { width: 2, height: 2, channels: 3, background: '#a84' } }).png().toBuffer()

test('OpenAI-compatible needs only an API key and defaults to the public API', async () => {
  assert.equal(createOpenAICompatibleRuntimeProvider(loadAppEnv({})), undefined)
  const image = await png()
  const provider = createOpenAICompatibleRuntimeProvider(loadAppEnv({ OPENAI_IMAGE_API_KEY: 'fixture' }), async (url, init) => {
    assert.equal(String(url), 'https://api.openai.com/v1/images/generations')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture')
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: 'gpt-image-1', prompt: 'fixture', n: 1, size: '1536x1024', quality: 'medium',
    })
    return Response.json({ data: [{ b64_json: image.toString('base64') }] })
  })
  assert.deepEqual(await provider!.generateImage(input), { buffer: image, mimeType: 'image/png' })
})

test('OpenAI-compatible sends multiple ordered multipart images and downloads results without the API key', async () => {
  const image = await png()
  const calls: string[] = []
  const provider = createOpenAICompatibleRuntimeProvider(loadAppEnv({
    OPENAI_IMAGE_API_KEY: 'fixture', OPENAI_IMAGE_BASE_URL: 'https://relay.example/custom/v1/', OPENAI_IMAGE_MODEL: 'vendor/custom-model',
  }), async (url, init) => {
    calls.push(String(url))
    if (init?.method === 'POST') {
      const form = init.body as FormData
      assert.equal(form.get('model'), 'vendor/custom-model')
      assert.equal(form.get('size'), '1536x1024')
      assert.deepEqual(await Promise.all(form.getAll('image[]').map(part => (part as File).text())), ['first', 'second'])
      return Response.json({ data: [{ url: 'https://cdn.example/result.png' }] })
    }
    assert.equal(new Headers(init?.headers).has('authorization'), false)
    return new Response(new Uint8Array(image), { headers: { 'content-type': 'image/png' } })
  })
  const result = await provider!.generateImage({ ...input, referenceImages: ['first', 'second'].map(data => ({ mimeType: 'image/png', data: Buffer.from(data) })) })
  assert.deepEqual(result.buffer, image)
  assert.deepEqual(calls, ['https://relay.example/custom/v1/images/edits', 'https://cdn.example/result.png'])
})

test('OpenAI-compatible bounds streamed downloads independently of Content-Length', async () => {
  const provider = new OpenAICompatibleImageGenerationProvider({
    apiKey: 'fixture', maxDownloadBytes: 3,
    fetch: async (_url, init) => init?.method === 'POST'
      ? Response.json({ data: [{ url: 'https://cdn.example/result.png' }] })
      : new Response(new Uint8Array([1, 2, 3, 4])),
  })
  await assert.rejects(provider.generateImage(input), { phase: 'download', message: /大小/ })
})

test('OpenAI-compatible aborts slow image downloads', async () => {
  const provider = new OpenAICompatibleImageGenerationProvider({
    apiKey: 'fixture', downloadTimeoutMs: 10,
    fetch: async (_url, init) => {
      if (init?.method === 'POST') return Response.json({ data: [{ url: 'https://cdn.example/result.png' }] })
      const keepAlive = setInterval(() => {}, 100)
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => {
        clearInterval(keepAlive)
        reject(init.signal!.reason)
      }, { once: true }))
    },
  })
  await assert.rejects(provider.generateImage(input), { phase: 'download', name: 'TimeoutError' })
})


test('the dispatcher transport sends a real multipart edit with named reference parts', async (t) => {
  const image = await png()
  const received: { contentType?: string; body?: string } = {}
  const server = createServer(async (req, res) => {
    received.contentType = req.headers['content-type']
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    received.body = Buffer.concat(chunks).toString()
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const dispatcher = new Agent()
  t.after(async () => {
    await dispatcher.close()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })

  const provider = new OpenAICompatibleImageGenerationProvider({
    apiKey: 'fixture', baseUrl: `http://127.0.0.1:${address.port}/v1`,
    fetch: (url, init) => fetchWithDispatcher(url, init, dispatcher),
  })
  const reference = { mimeType: 'image/png', data: image }
  await provider.generateImage({ ...input, referenceImages: [reference, reference] })
  assert.match(received.contentType ?? '', /^multipart\/form-data; boundary=/)
  assert.match(received.body ?? '', /name="image\[\]"; filename="reference-1.png"/)
  assert.match(received.body ?? '', /name="image\[\]"; filename="reference-2.png"/)
})
