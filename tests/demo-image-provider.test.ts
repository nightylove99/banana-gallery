import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { DemoImageGenerationProvider } from '../server/ai/demo-image-provider.ts'
import { loadAppEnv } from '../server/config/env.ts'

test('demo defaults on and can be explicitly disabled', () => {
  assert.equal(loadAppEnv({}).enableDemoProvider, true)
  assert.equal(loadAppEnv({ ENABLE_DEMO_PROVIDER: 'false' }).enableDemoProvider, false)
})

test('demo produces readable PNGs at square, landscape and portrait sizes without fetch', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request') })
  const provider = new DemoImageGenerationProvider()
  for (const [aspectRatio, width, height] of [['1:1', 1024, 1024], ['16:9', 1024, 576], ['9:16', 576, 1024]] as const) {
    const output = await provider.generateImage({ prompt: '<not markup>', referenceImages: [], aspectRatio })
    const metadata = await sharp(output.buffer).metadata()
    assert.equal(output.mimeType, 'image/png')
    assert.deepEqual([metadata.format, metadata.width, metadata.height], ['png', width, height])
  }
})
