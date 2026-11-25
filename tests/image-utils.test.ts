import assert from 'node:assert/strict'
import test from 'node:test'

import { SUPPORTED_ASPECT_RATIOS, SUPPORTED_RESOLUTIONS } from '../src/lib/image-utils.ts'

test('image-utils：全局比例与分辨率候选集保持稳定', () => {
  assert.deepEqual(
    SUPPORTED_ASPECT_RATIOS.map((ratio) => ratio.label),
    ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
  )
  assert.deepEqual(SUPPORTED_RESOLUTIONS, ['1K', '1.5K', '2K', '3K', '4K'])
})
