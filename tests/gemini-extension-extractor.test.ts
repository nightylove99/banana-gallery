import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'

function loadExtractor() {
  const source = fs.readFileSync('extension/gemini-to-banana/extractor.js', 'utf-8')
  const sandbox: { BananaGeminiExtractor?: ExtractorApi } = {}
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  if (!sandbox.BananaGeminiExtractor) {
    throw new Error('Extractor did not register')
  }
  return sandbox.BananaGeminiExtractor
}

function loadCaptureUtils() {
  const source = fs.readFileSync('extension/gemini-to-banana/capture-utils.js', 'utf-8')
  const sandbox: { BananaGeminiCaptureUtils?: CaptureUtilsApi } = {}
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  if (!sandbox.BananaGeminiCaptureUtils) {
    throw new Error('Capture utils did not register')
  }
  return sandbox.BananaGeminiCaptureUtils
}

function loadExtractorWithDom(html: string) {
  const source = fs.readFileSync('extension/gemini-to-banana/extractor.js', 'utf-8')
  const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    url: 'https://gemini.google.com/app/test',
  })
  const sandbox = {
    document: dom.window.document,
    location: dom.window.location,
    innerHeight: 900,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  } as { BananaGeminiExtractor?: ExtractorApi } & Record<string, unknown>

  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  if (!sandbox.BananaGeminiExtractor) {
    throw new Error('Extractor did not register')
  }
  return { extractor: sandbox.BananaGeminiExtractor, document: dom.window.document }
}

test('Gemini extension extractor recognizes result-sized images', () => {
  const extractor = loadExtractor()

  assert.equal(extractor.isResultImage({
    src: 'blob:https://gemini.google.com/result',
    naturalWidth: 1024,
    naturalHeight: 1024,
  }), true)
  assert.equal(extractor.isResultImage({
    src: 'https://example.com/thumb.png',
    naturalWidth: 48,
    naturalHeight: 48,
  }), false)
})

test('Gemini extension only reuses reference data for the same tab, conversation, turn and attachments', () => {
  const captureUtils = loadCaptureUtils()
  const attachment = { src: 'blob:attachment' }
  const scope = {
    conversationUrl: 'https://gemini.google.com/app/a',
    turn: {},
    resultUrl: 'blob:result',
    prompt: 'same words',
    attachments: [{ element: attachment, url: attachment.src }],
  }
  const cached = { scope, references: [{ name: 'correct.png' }] }
  const pick = (owner: ReferenceScope) => Array.from(captureUtils.selectCachedReferences(cached, owner), item => item.name)
  assert.deepEqual(pick({ ...scope }), ['correct.png'])
  assert.deepEqual(pick({ ...scope, conversationUrl: 'https://gemini.google.com/app/b' }), [])
  assert.deepEqual(pick({ ...scope, turn: {} }), [])
  assert.deepEqual(pick({ ...scope, attachments: [{ element: {}, url: attachment.src }] }), [])
  assert.deepEqual(pick({ ...scope, attachments: [{ element: attachment, url: 'blob:changed' }] }), [])
  assert.deepEqual(pick({ ...scope, resultUrl: 'blob:other-result' }), [])
})

test('Gemini extension filenames follow the captured image MIME type', () => {
  const captureUtils = loadCaptureUtils()

  assert.equal(captureUtils.filenameForMimeType('gemini-result.png', 'image/jpeg'), 'gemini-result.jpg')
  assert.equal(captureUtils.filenameForMimeType('reference.jpeg', 'image/webp'), 'reference.webp')
  assert.equal(captureUtils.filenameForMimeType('reference', 'image/png'), 'reference.png')
})

test('Gemini extension extractor selects the largest visible current result image', () => {
  const extractor = loadExtractor()
  const thumbnail = imageCandidate({
    src: 'blob:https://gemini.google.com/thumb',
    naturalWidth: 320,
    naturalHeight: 320,
    rect: { top: 24, bottom: 124, width: 100, height: 100 },
  })
  const currentResult = imageCandidate({
    src: 'blob:https://gemini.google.com/result',
    naturalWidth: 1600,
    naturalHeight: 1200,
    rect: { top: 200, bottom: 820, width: 960, height: 620 },
  })
  const olderOffscreen = imageCandidate({
    src: 'blob:https://gemini.google.com/older',
    naturalWidth: 2048,
    naturalHeight: 2048,
    rect: { top: -1800, bottom: -1000, width: 960, height: 800 },
  })

  assert.equal(
    extractor.selectCurrentResultImage([thumbnail, olderOffscreen, currentResult], 900),
    currentResult,
  )
})

test('Gemini extension extractor blocks incomplete reference captures', () => {
  const extractor = loadExtractor()

  const result = extractor.classifyCapture({
    resultPresent: true,
    prompt: 'make an image',
    visibleReferenceCount: 2,
    cachedReferenceCount: 1,
    recoveredReferenceCount: 1,
  })
  assert.equal(result.complete, false)
  assert.equal(result.reason, '参考图不完整：页面显示 2 张，当前可保存 1 张')
})

test('Gemini extension extractor accepts complete cached or recovered references', () => {
  const extractor = loadExtractor()

  assert.equal(extractor.classifyCapture({
    resultPresent: true,
    prompt: 'make an image',
    visibleReferenceCount: 2,
    cachedReferenceCount: 2,
    recoveredReferenceCount: 0,
  }).complete, true)

  assert.equal(extractor.classifyCapture({
    resultPresent: true,
    prompt: 'make an image',
    visibleReferenceCount: 2,
    cachedReferenceCount: 0,
    recoveredReferenceCount: 2,
  }).complete, true)
})

test('Gemini extension extractor finds prompt in the nearest previous user query', () => {
  const { extractor, document } = loadExtractorWithDom(`
    <main>
      <user-query id="prompt">Use this uploaded image as a style reference</user-query>
      <model-response>
        <img id="result" src="blob:https://gemini.google.com/result">
      </model-response>
    </main>
  `)
  const result = document.querySelector('#result') as HTMLImageElement
  defineImageMetrics(result, {
    naturalWidth: 1600,
    naturalHeight: 1200,
    rect: { top: 300, bottom: 820, width: 760, height: 520 },
  })
  defineRect(document.querySelector('#prompt') as HTMLElement, {
    top: 120,
    bottom: 180,
    width: 700,
    height: 60,
  })

  assert.equal(extractor.findPromptForImage(result), 'Use this uploaded image as a style reference')
})

test('Gemini extension extractor strips user label and preserves prompt line breaks', () => {
  const { extractor, document } = loadExtractorWithDom(`
    <main>
      <user-query id="prompt"></user-query>
      <model-response>
        <img id="result" src="blob:https://gemini.google.com/result">
      </model-response>
    </main>
  `)
  const prompt = document.querySelector('#prompt') as HTMLElement
  const result = document.querySelector('#result') as HTMLImageElement
  Object.defineProperty(prompt, 'innerText', {
    configurable: true,
    value: [
      '你说',
      '利用提供的角色参考图片，创作一幅超写实的、具有电影质感的4K分辨率GTS（巨大娘）艺术摄影作品。',
      '',
      '核心指令与角色整合：',
      '',
      '请保持提供图片中角色的面部特征、发型、服装设计和所有细节的完整性与一致性。',
      'floating，lying',
      'focus face close up camera.',
      'full body',
      '4K resolution',
      '3:2',
    ].join('\n'),
  })
  defineRect(prompt, { top: 120, bottom: 260, width: 700, height: 140 })
  defineImageMetrics(result, {
    naturalWidth: 1600,
    naturalHeight: 1200,
    rect: { top: 320, bottom: 820, width: 760, height: 500 },
  })

  assert.equal(extractor.findPromptForImage(result), [
    '利用提供的角色参考图片，创作一幅超写实的、具有电影质感的4K分辨率GTS（巨大娘）艺术摄影作品。',
    '',
    '核心指令与角色整合：',
    '',
    '请保持提供图片中角色的面部特征、发型、服装设计和所有细节的完整性与一致性。',
    'floating，lying',
    'focus face close up camera.',
    'full body',
    '4K resolution',
    '3:2',
  ].join('\n'))
})

test('Gemini extension extractor removes layout-added blank lines without losing intentional blank lines', () => {
  const { extractor, document } = loadExtractorWithDom(`
    <main>
      <user-query id="prompt">
        <p>第一行</p>
        <p>第二行</p>
        <p></p>
        <p>第四行</p>
      </user-query>
      <model-response>
        <img id="result" src="blob:https://gemini.google.com/result">
      </model-response>
    </main>
  `)
  const prompt = document.querySelector('#prompt') as HTMLElement
  const result = document.querySelector('#result') as HTMLImageElement
  Object.defineProperty(prompt, 'innerText', {
    configurable: true,
    value: '第一行\n\n第二行\n\n\n\n第四行',
  })
  defineRect(prompt, { top: 120, bottom: 260, width: 700, height: 140 })
  defineImageMetrics(result, {
    naturalWidth: 1600,
    naturalHeight: 1200,
    rect: { top: 320, bottom: 820, width: 760, height: 500 },
  })

  assert.equal(extractor.findPromptForImage(result), '第一行\n第二行\n\n第四行')
})

test('Gemini extension extractor prefers complete ancestor text over nested prompt previews', () => {
  const { extractor, document } = loadExtractorWithDom(`
    <main>
      <user-query id="prompt">
        <div id="preview" class="query-text">Create a cinematic miniature earth scene...</div>
      </user-query>
      <model-response>
        <img id="result" src="blob:https://gemini.google.com/result">
      </model-response>
    </main>
  `)
  const prompt = document.querySelector('#prompt') as HTMLElement
  const preview = document.querySelector('#preview') as HTMLElement
  const result = document.querySelector('#result') as HTMLImageElement
  const completePrompt = [
    'Create a cinematic miniature earth scene with a giant coser walking across continents.',
    '',
    'Keep the full-body composition, realistic atmosphere, and all costume details.',
    'Use dramatic sunlight, shallow depth of field, and a 3:2 aspect ratio.',
  ].join('\n')

  Object.defineProperty(prompt, 'innerText', {
    configurable: true,
    value: completePrompt,
  })
  Object.defineProperty(preview, 'innerText', {
    configurable: true,
    value: 'Create a cinematic miniature earth scene...',
  })
  defineRect(prompt, { top: 120, bottom: 260, width: 700, height: 140 })
  defineRect(preview, { top: 210, bottom: 290, width: 640, height: 80 })
  defineImageMetrics(result, {
    naturalWidth: 1600,
    naturalHeight: 1200,
    rect: { top: 320, bottom: 820, width: 760, height: 500 },
  })

  assert.equal(extractor.findPromptForImage(result), completePrompt)
})

test('Gemini extension extractor recovers high-resolution reference thumbnails from old conversations', () => {
  const { extractor, document } = loadExtractorWithDom(`
    <main>
      <user-query id="prompt">
        <img id="ref" src="https://lh3.googleusercontent.com/reference-image">
        Repaint this in a ceramic poster style
      </user-query>
      <model-response>
        <img id="result" src="blob:https://gemini.google.com/result">
      </model-response>
    </main>
  `)
  const prompt = document.querySelector('#prompt') as HTMLElement
  const reference = document.querySelector('#ref') as HTMLImageElement
  const result = document.querySelector('#result') as HTMLImageElement
  defineRect(prompt, { top: 80, bottom: 180, width: 700, height: 100 })
  defineImageMetrics(reference, {
    naturalWidth: 3024,
    naturalHeight: 4032,
    rect: { top: 96, bottom: 176, width: 80, height: 80 },
  })
  defineImageMetrics(result, {
    naturalWidth: 1600,
    naturalHeight: 1200,
    rect: { top: 300, bottom: 820, width: 760, height: 520 },
  })

  const references = extractor.findVisibleReferenceImages(result) as HTMLImageElement[]
  assert.equal(references.length, 1)
  assert.equal(references[0]?.src, reference.src)
})

test('Gemini extension extractor finds old uploaded thumbnails before the prompt text', () => {
  const { extractor, document } = loadExtractorWithDom(`
    <main>
      <section id="turn">
        <button>
          <img id="ref" src="https://lh3.googleusercontent.com/uploaded-reference">
        </button>
        <div id="prompt" data-test-id="user-query">Use the uploaded character reference</div>
      </section>
      <model-response>
        <img id="result" src="blob:https://gemini.google.com/result">
      </model-response>
    </main>
  `)
  const turn = document.querySelector('#turn') as HTMLElement
  const prompt = document.querySelector('#prompt') as HTMLElement
  const reference = document.querySelector('#ref') as HTMLImageElement
  const result = document.querySelector('#result') as HTMLImageElement
  defineRect(turn, { top: 80, bottom: 220, width: 700, height: 140 })
  defineRect(prompt, { top: 140, bottom: 210, width: 620, height: 70 })
  defineImageMetrics(reference, {
    naturalWidth: 3024,
    naturalHeight: 4032,
    rect: { top: 92, bottom: 132, width: 40, height: 40 },
  })
  defineImageMetrics(result, {
    naturalWidth: 1600,
    naturalHeight: 1200,
    rect: { top: 320, bottom: 820, width: 760, height: 500 },
  })

  const references = extractor.findVisibleReferenceImages(result) as HTMLImageElement[]
  assert.equal(references.length, 1)
  assert.equal(references[0]?.src, reference.src)
})

test('Gemini never borrows an earlier turn’s visible attachment for a text-only turn', () => {
  const { extractor, document } = loadExtractorWithDom(`
    <main>
      <section>
        <user-query id="earlier"><img id="earlier-ref" src="https://lh3.googleusercontent.com/earlier">Earlier request</user-query>
        <model-response>Earlier answer</model-response>
      </section>
      <section>
        <user-query id="current">New text-only request</user-query>
        <model-response><img id="result" src="blob:https://gemini.google.com/current"></model-response>
      </section>
    </main>
  `)
  const earlier = document.querySelector('#earlier') as HTMLElement
  const current = document.querySelector('#current') as HTMLElement
  const reference = document.querySelector('#earlier-ref') as HTMLImageElement
  const result = document.querySelector('#result') as HTMLImageElement
  defineRect(earlier, { top: 50, bottom: 160, width: 620, height: 110 })
  defineRect(current, { top: 220, bottom: 280, width: 620, height: 60 })
  defineImageMetrics(reference, {
    naturalWidth: 1024,
    naturalHeight: 1024,
    rect: { top: 55, bottom: 125, width: 70, height: 70 },
  })
  defineImageMetrics(result, {
    naturalWidth: 1600,
    naturalHeight: 1200,
    rect: { top: 320, bottom: 820, width: 760, height: 500 },
  })
  assert.equal(extractor.findVisibleReferenceImages(result).length, 0)
})

function imageCandidate(input: {
  src: string
  naturalWidth: number
  naturalHeight: number
  rect: { top: number; bottom: number; width: number; height: number }
}) {
  return {
    src: input.src,
    naturalWidth: input.naturalWidth,
    naturalHeight: input.naturalHeight,
    getBoundingClientRect: () => input.rect,
  }
}

interface ExtractorApi {
  isResultImage: (img: Record<string, unknown>) => boolean
  selectCurrentResultImage: (
    images: Array<Record<string, unknown>> | NodeListOf<HTMLImageElement>,
    viewportHeight?: number
  ) => Record<string, unknown> | HTMLImageElement | null
  findPromptForImage: (img: HTMLImageElement) => string
  findVisibleReferenceImages: (img: HTMLImageElement) => unknown[]
  classifyCapture: (input: {
    resultPresent: boolean
    prompt: string
    visibleReferenceCount: number
    cachedReferenceCount: number
    recoveredReferenceCount: number
  }) => { complete: boolean; reason: string }
}

interface ReferenceScope {
  conversationUrl: string
  turn: object
  resultUrl: string
  prompt: string
  attachments: Array<{ element: object; url: string }>
}

interface CaptureUtilsApi {
  selectCachedReferences: (
    cache: { scope: ReferenceScope; references: Array<{ name: string }> },
    scope: ReferenceScope
  ) => Array<{ name: string }>
  filenameForMimeType: (name: string, mimeType: string) => string
}

function defineImageMetrics(
  img: HTMLImageElement,
  input: {
    naturalWidth: number
    naturalHeight: number
    rect: { top: number; bottom: number; width: number; height: number }
  },
) {
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: input.naturalWidth })
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: input.naturalHeight })
  defineRect(img, input.rect)
}

function defineRect(
  element: Element,
  rect: { top: number; bottom: number; width: number; height: number },
) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      ...rect,
      left: 0,
      right: rect.width,
      x: 0,
      y: rect.top,
      height: rect.height,
      toJSON: () => rect,
    }),
  })
}

function createPromptVariantsFixture(variants: Array<{ text: string; hidden?: boolean }>) {
  const { extractor, document } = loadExtractorWithDom(`
    <main>
      <user-query id="prompt"><div class="query-content"></div></user-query>
      <model-response><img id="result" src="blob:https://gemini.google.com/result"></model-response>
    </main>
  `)
  const query = document.querySelector('#prompt') as HTMLElement
  const content = query.querySelector('.query-content') as HTMLElement
  for (const variant of variants) {
    const node = document.createElement('div')
    node.className = 'query-text'
    node.textContent = variant.text
    if (variant.hidden) node.hidden = true
    content.append(node)
    defineRect(node, { top: 120, bottom: variant.hidden ? 0 : 240, width: variant.hidden ? 0 : 700, height: variant.hidden ? 0 : 120 })
  }
  Object.defineProperty(query, 'innerText', { configurable: true, value: variants.filter(item => !item.hidden).map(item => item.text).join('\n') })
  defineRect(query, { top: 100, bottom: 260, width: 700, height: 160 })
  const result = document.querySelector('#result') as HTMLImageElement
  defineImageMetrics(result, { naturalWidth: 1600, naturalHeight: 1200, rect: { top: 300, bottom: 800, width: 700, height: 500 } })
  return { extractor, document, result, query }
}

const sampleCompletePrompt = [
  'Photograph a yellow teapot on a wooden table beside a window. Preserve the details of the provided reference image and use soft daylight.',
  '',
  'Keep the background simple. Show the whole teapot.',
  'Aspect ratio: 3:4. Resolution: 4K.',
].join('\n')

test('Gemini extension selects full text instead of concatenating a 100-character preview', () => {
  const fixture = createPromptVariantsFixture([{ text: sampleCompletePrompt.slice(0, 100) + '…' }, { text: sampleCompletePrompt }])
  assert.equal(fixture.extractor.findPromptForImage(fixture.result), sampleCompletePrompt)
})

test('Gemini extension reads a hidden full-text variant while the prompt is collapsed', () => {
  const fixture = createPromptVariantsFixture([{ text: sampleCompletePrompt.slice(0, 100) + '…' }, { text: sampleCompletePrompt, hidden: true }])
  assert.equal(fixture.extractor.findPromptForImage(fixture.result), sampleCompletePrompt)
})

test('Gemini extension selects one of two identical complete DOM variants', () => {
  const fixture = createPromptVariantsFixture([{ text: sampleCompletePrompt }, { text: sampleCompletePrompt }])
  assert.equal(fixture.extractor.findPromptForImage(fixture.result), sampleCompletePrompt)
})

test('Gemini extension excludes multiple stacked preview nodes from the full body', () => {
  const fixture = createPromptVariantsFixture([{ text: sampleCompletePrompt.slice(0, 100) + '…' }, { text: sampleCompletePrompt.slice(0, 100) + '…' }, { text: sampleCompletePrompt }])
  assert.equal(fixture.extractor.findPromptForImage(fixture.result), sampleCompletePrompt)
})

test('Gemini extension preserves intentional repetition inside a single prompt body', () => {
  const repeated = 'Keep both objects in the frame.\nKeep both objects in the frame.\n\n' + sampleCompletePrompt
  const fixture = createPromptVariantsFixture([{ text: repeated }])
  assert.equal(fixture.extractor.findPromptForImage(fixture.result), repeated)
})

test('Gemini extension does not deduplicate ordinary repeated paragraphs', () => {
  const fixture = createPromptVariantsFixture([])
  fixture.query.innerHTML = '<p>Preserve the yellow color.</p><p>Preserve the yellow color.</p><p></p><p>Aspect ratio 3:4.</p>'
  Object.defineProperty(fixture.query, 'innerText', { configurable: true, value: 'Preserve the yellow color.\nPreserve the yellow color.\n\nAspect ratio 3:4.' })
  assert.equal(fixture.extractor.findPromptForImage(fixture.result), 'Preserve the yellow color.\nPreserve the yellow color.\n\nAspect ratio 3:4.')
})

test('Gemini extension keeps full long prompts even when duplicate variants exceed the extraction limit', () => {
  const long = sampleCompletePrompt + '\n' + 'Keep fine surface detail and natural shadows. '.repeat(100)
  const fixture = createPromptVariantsFixture([{ text: long }, { text: long }])
  assert.equal(fixture.extractor.findPromptForImage(fixture.result), long.trim())
})

test('Gemini extension does not choose a longer earlier turn over the current short prompt', () => {
  const fixture = createPromptVariantsFixture([{ text: 'Make the teapot blue.' }])
  const previous = fixture.document.createElement('user-query')
  previous.textContent = sampleCompletePrompt
  fixture.query.before(previous)
  defineRect(previous, { top: 10, bottom: 90, width: 700, height: 80 })
  assert.equal(fixture.extractor.findPromptForImage(fixture.result), 'Make the teapot blue.')
})

test('Gemini extension keeps the available preview when there is no complete variant', () => {
  const preview = sampleCompletePrompt.slice(0, 100) + '…'
  const fixture = createPromptVariantsFixture([{ text: preview }, { text: preview }])
  assert.equal(fixture.extractor.findPromptForImage(fixture.result), preview)
})

test('Gemini extension preserves preview-like text deliberately written as ordinary paragraphs', () => {
  const fixture = createPromptVariantsFixture([])
  const preview = sampleCompletePrompt.slice(0, 100) + '…'
  const first = fixture.document.createElement('p')
  first.textContent = preview
  const second = fixture.document.createElement('p')
  second.textContent = sampleCompletePrompt
  fixture.query.replaceChildren(first, second)
  Object.defineProperty(fixture.query, 'innerText', { configurable: true, value: preview + '\n' + sampleCompletePrompt })
  assert.equal(fixture.extractor.findPromptForImage(fixture.result), preview + '\n' + sampleCompletePrompt)
})

// Structure observed in Gemini's live luminous prompt bubble on 2026-09-06:
// one query-text contains an accessibility h5 followed by the actual p lines.
function createScreenReaderLabelFixture(body: string, labelText: string, hidden = false) {
  const fixture = createPromptVariantsFixture([{ text: body }])
  const content = fixture.query.querySelector('.query-text') as HTMLElement
  content.className = 'query-text gds-body-l collapsed'
  content.replaceChildren()
  const label = fixture.document.createElement('h5')
  label.className = 'cdk-visually-hidden screen-reader-user-query-label'
  if (hidden) label.setAttribute('aria-hidden', 'true')
  const speaker = fixture.document.createElement('span')
  speaker.textContent = 'You said'
  label.append(speaker, ' ' + labelText)
  content.append(label)
  for (const line of body.split('\n')) {
    const paragraph = fixture.document.createElement('p')
    paragraph.className = 'query-text-line ng-star-inserted'
    if (line) paragraph.append(' ' + line + ' ')
    else paragraph.append(fixture.document.createElement('br'))
    content.append(paragraph)
  }
  // Chromium innerText also includes the visually hidden heading.
  Object.defineProperty(fixture.query, 'innerText', { configurable: true, value: 'You said ' + labelText + '\n' + body })
  return fixture
}

test('Gemini extension excludes the live collapsed bubble screen-reader summary', () => {
  const fixture = createScreenReaderLabelFixture(sampleCompletePrompt, sampleCompletePrompt.slice(0, 100) + '…')
  assert.equal(fixture.extractor.findPromptForImage(fixture.result), sampleCompletePrompt)
})

test('Gemini extension excludes a full screen-reader copy of a short prompt', () => {
  const prompt = 'Photograph a yellow teapot.\nPreserve the yellow color.'
  const fixture = createScreenReaderLabelFixture(prompt, prompt)
  assert.equal(fixture.extractor.findPromptForImage(fixture.result), prompt)
})

test('Gemini extension does not use a screen-reader label to discard an identical body paragraph', () => {
  const prompt = 'Photograph a yellow teapot.'
  const fixture = createScreenReaderLabelFixture(prompt, prompt, true)
  assert.equal(fixture.extractor.findPromptForImage(fixture.result), prompt)
})

test('Gemini extension preserves existing body text without adding another screen-reader preview', () => {
  const preview = sampleCompletePrompt.slice(0, 100) + '…'
  const body = preview + '\n' + sampleCompletePrompt
  const fixture = createScreenReaderLabelFixture(body, preview)
  assert.equal(fixture.extractor.findPromptForImage(fixture.result), body)
})

test('Gemini extension does not fall back to a screen-reader label when the body is unavailable', () => {
  const fixture = createScreenReaderLabelFixture('', 'Photograph a yellow teapot…')
  assert.equal(fixture.extractor.findPromptForImage(fixture.result), '')
})

test('Gemini extension preserves headings and hidden text without the Gemini label marker', () => {
  const fixture = createPromptVariantsFixture([{ text: sampleCompletePrompt }])
  const heading = fixture.document.createElement('h5')
  heading.className = 'cdk-visually-hidden'
  heading.textContent = 'Composition details'
  fixture.query.querySelector('.query-text')?.prepend(heading)
  assert.equal(fixture.extractor.findPromptForImage(fixture.result), 'Composition details\n' + sampleCompletePrompt)
})
