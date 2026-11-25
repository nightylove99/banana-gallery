import assert from 'node:assert/strict'
import test from 'node:test'
import { IMAGE_GENERATION_MODEL_DEFINITIONS, isImageGenerationProviderName } from '../src/lib/image-generation-providers.ts'
import { parseTaskInput } from '../server/generation/task-input.ts'

test('local Krea is distinct text-to-image with nine ratios and native 1K/2K', () => {
  assert.equal(isImageGenerationProviderName('krea-local'), true)
  const model = IMAGE_GENERATION_MODEL_DEFINITIONS.find(m => String(m.provider) === 'krea-local')
  assert.ok(model)
  assert.equal(model.model, 'krea-2-turbo')
  assert.equal(model.maxReferenceImages, 0)
  assert.equal(model.supportedAspectRatios.length, 9)
  const base = { provider: 'krea-local', model: model.model, prompt: 'watercolor fox' }
  assert.equal(parseTaskInput(base, [model]).imageSize, '1K')
  for (const imageSize of ['1K', '2K']) for (const aspectRatio of model.supportedAspectRatios) {
    assert.equal(parseTaskInput({ ...base, imageSize, aspectRatio }, [model]).aspectRatio, aspectRatio)
  }
  for (const invalid of [{ imageSize: '4K' }, { aspectRatio: 'source' }, { referenceFilenames: ['ref.png'] }]) {
    assert.throws(() => parseTaskInput({ ...base, ...invalid }, [model]))
  }
})
