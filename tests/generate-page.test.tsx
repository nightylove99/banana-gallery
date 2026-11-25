import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import React, { act } from 'react'
import { render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { findImageGenerationModelDefinition } from '../src/lib/image-generation-providers.ts'

function setGlobalValue(name: PropertyKey, value: unknown) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  })
}

interface FetchRecord {
  url: string
  init?: RequestInit
}

interface SetupDomOptions {
  recentWorkCount?: number
  withSourceResultLink?: boolean
  defaultModel?: { provider: string; model: string }
  generateResponse?: (record: FetchRecord) => Promise<Response> | Response
  referenceUploadResponse?: (record: FetchRecord) => Promise<Response> | Response
}

let testSessionSequence = 0
function setupDom(options: SetupDomOptions = {}) {
  const testWorkspaceId = `test-workspace-${++testSessionSequence}`
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://127.0.0.1:4173/generate',
  })
  const requests: FetchRecord[] = []
  const works = Array.from({ length: options.recentWorkCount ?? 0 }, (_, index) => ({
    id: `work-${index + 1}`, filename: `work-${index + 1}.png`, assetType: 'work',
    workCode: `#WORK${index + 1}`, prompt: `作品提示词 ${index + 1}`,
    tags: [], referenceImages: [], favorited: false, width: 1024, height: 1024, createdAt: new Date(Date.UTC(2026, 0, 31 - index)).toISOString(),
  }))
  const tasks: unknown[] = works.map(work => ({
    id: work.id, key: work.id, status: 'completed', workAssetId: work.id, createdAt: work.createdAt,
    result: { filename: work.filename }, input: {
      prompt: work.prompt, provider: 'seedream', model: 'doubao-seedream-5-5-261028',
      referenceFilenames: [], aspectRatio: '1:1', imageSize: '2K',
    },
  }))
  const metrics = { scrollIntoViewCalls: 0 }

  Object.defineProperty(dom.window, 'indexedDB', { value: new IDBFactory() })
  setGlobalValue('IDBKeyRange', IDBKeyRange)
  setGlobalValue('window', dom.window)
  setGlobalValue('FormData', dom.window.FormData)
  setGlobalValue('document', dom.window.document)
  setGlobalValue('navigator', dom.window.navigator)
  setGlobalValue('Node', dom.window.Node)
  setGlobalValue('NodeFilter', dom.window.NodeFilter)
  setGlobalValue('MutationObserver', dom.window.MutationObserver)
  setGlobalValue('HTMLInputElement', dom.window.HTMLInputElement)
  setGlobalValue('FormData', dom.window.FormData)
  setGlobalValue('CustomEvent', dom.window.CustomEvent)
  setGlobalValue('HTMLElement', dom.window.HTMLElement)
  setGlobalValue('HTMLTextAreaElement', dom.window.HTMLTextAreaElement)
  setGlobalValue('Event', dom.window.Event)
  setGlobalValue('InputEvent', dom.window.InputEvent)
  setGlobalValue('ClipboardEvent', dom.window.ClipboardEvent)
  setGlobalValue('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  setGlobalValue('IS_REACT_ACT_ENVIRONMENT', true)
  const requestFrame = (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0)
  const cancelFrame = (id: number) => clearTimeout(id)
  setGlobalValue('requestAnimationFrame', requestFrame)
  setGlobalValue('cancelAnimationFrame', cancelFrame)
  Object.defineProperty(dom.window, 'requestAnimationFrame', {
    configurable: true,
    value: requestFrame,
  })
  Object.defineProperty(dom.window, 'cancelAnimationFrame', {
    configurable: true,
    value: cancelFrame,
  })
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  })
  Object.defineProperty(dom.window.URL, 'createObjectURL', {
    configurable: true,
    value: (file: File) => `blob:${file.name}`,
  })
  Object.defineProperty(dom.window.URL, 'revokeObjectURL', {
    configurable: true,
    value: () => undefined,
  })
  setGlobalValue('URL', dom.window.URL)
  dom.window.HTMLAnchorElement.prototype.click = () => {} // jsdom cannot perform browser downloads.
  setGlobalValue('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const record = { url, init }
    requests.push(record)
    if (url.startsWith('/api/images')) {
      return Response.json(works)
    }
    if (url === '/api/session') {
      return Response.json({
        user: { id: 'local-user', email: 'local-user@banana.gallery' },
        workspace: { id: testWorkspaceId, name: 'Local Workspace' },
      })
    }
    if (url === '/api/account/summary') {
      return Response.json({
        user: { id: 'local-user', email: 'owner@example.com' },
        workspace: { id: 'local-workspace', name: 'Local Workspace' },
        runtimeMode: 'personal-local',
        plan: { id: 'personal' },
      })
    }
    if (url === '/api/generation/providers') {
      return Response.json({
        defaultProvider: 'seedream',
        providers: [
          {
            id: 'seedream',
            label: 'Seedream 5.0 Pro',
            available: true,
            maxReferenceImages: 10,
            supportedResolutions: ['1K', '2K'],
            supportedAspectRatios: ['1:1', '16:9'],
          },
          {
            id: 'google',
            label: 'Google Gemini',
            available: true,
            maxReferenceImages: 14,
            supportedResolutions: ['1K', '2K', '4K'],
            supportedAspectRatios: ['1:1', '16:9'],
          },
        ],
      })
    }
    if (url === '/api/generation/models') {
      return Response.json({
        defaultModel: options.defaultModel ?? {
          provider: 'seedream',
          model: 'doubao-seedream-5-5-261028',
        },
        models: [
          { ...findImageGenerationModelDefinition('krea-local','krea-2-turbo'), available:true },
          { ...findImageGenerationModelDefinition('qwen-local','qwen-image-2.1-UC-Q8_0'), available:true },
          {
            ...findImageGenerationModelDefinition('openai-compatible', 'gpt-image-1'),
            available: true,
          },
          {
            ...findImageGenerationModelDefinition('demo', 'banana-demo-v1'),
            available: true,
          },
          {
            provider: 'seedream',
            model: 'doubao-seedream-5-5-261028',
            label: 'Seedream · 5.5',
            parameterMode: 'resolution',
            available: true,
            maxReferenceImages: 10,
            supportedResolutions: ['1K', '2K'],
            supportedQualities: [],
            supportedAspectRatios: ['1:1', '16:9'],
          },
          {
            ...findImageGenerationModelDefinition('google', 'gemini-nano-banana-2.1'),
            available: true,
          },
        ],
      })
    }
    if (url === '/api/references/upload') {
      if (options.referenceUploadResponse) {
        return options.referenceUploadResponse(record)
      }
      return Response.json({ filenames: ['uploaded-reference.png'] })
    }
    if (url.startsWith('/api/generation-tasks/by-key/')) return Response.json({ code: 'TASK_KEY_NOT_FOUND' }, { status: 404 })
    if (url === '/api/generation-tasks?limit=60') return Response.json({tasks,error:null})
    if (url === '/api/generation-tasks') {
      const input = JSON.parse(String(init?.body))
      const response = options.generateResponse ? await options.generateResponse(record) : Response.json({
        filename: 'generated-test.png',
        prompt: '测试提示词',
        width: 1024,
        height: 1024,
        aspectRatio: '1:1',
        imageSize: '2K',
        provider: 'seedream',
        model: 'doubao-seedream-5-5-261028',
      })
      if (!response.ok) return response
      const job = {id: String(tasks.length + 1),key:input.key,input,status:'completed',createdAt:new Date().toISOString(),result:await response.json()}
      tasks.push(job); if(options.withSourceResultLink) tasks.push({...job,id:`child-${job.id}`,status:'cancelled',result:undefined,input:{...input,prompt:'后续草稿',sourceTaskId:job.id}}); return Response.json(job, {status:202})
    }
    return Response.json({ error: 'not found' }, { status: 404 })
  })

  Object.defineProperty(dom.window.HTMLElement.prototype, 'attachEvent', {
    configurable: true,
    value: () => undefined,
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'detachEvent', {
    configurable: true,
    value: () => undefined,
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {
      metrics.scrollIntoViewCalls += 1
    },
  })

  Object.defineProperty(dom.window.HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      const value = (this as HTMLTextAreaElement).value || ''
      const lineCount = Math.max(value.split('\n').length, 1)
      return Math.max(200, lineCount * 32 + 24)
    },
  })

  return { dom, metrics, requests }
}

function expectedHeight(value: string) {
  const lineCount = Math.max(value.split('\n').length, 1)
  return `${Math.max(200, lineCount * 32 + 24)}px`
}

function buildLongPrompt(lineCount = 20) {
  return Array.from(
    { length: lineCount },
    (_, index) => `第 ${index + 1} 行提示词，用来验证输入框会继续向下增长。`,
  ).join('\n')
}

function dispatchDragEvent(
  dom: JSDOM,
  target: EventTarget,
  type: string,
  files: File[] = [],
  types: string[] = ['Files'],
) {
  const event = new dom.window.Event(type, {
    bubbles: true,
    cancelable: true,
  })
  Object.defineProperty(event, 'dataTransfer', {
    configurable: true,
    value: {
      files,
      types,
      dropEffect: 'none',
      setData: () => undefined,
    },
  })
  target.dispatchEvent(event)
  return event
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function renderGeneratePage(
  initialEntry: string | { pathname: string; state?: unknown },
  options: SetupDomOptions = {},
) {
  const { dom, metrics, requests } = setupDom(options)
  const { default: GeneratePage } = await import('../src/pages/GeneratePage.tsx')
  const { SessionProvider } = await import('../src/auth/useSession.tsx')
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const view = render(
    (
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/generate"
            element={(
              <SessionProvider>
                <GeneratePage />
              </SessionProvider>
            )}
          />
        </Routes>
      </MemoryRouter>
    ),
    { container, baseElement: dom.window.document.body },
  )
  await flushEffects()

  const textarea = view.container.querySelector('textarea')
  assert.ok(textarea instanceof dom.window.HTMLTextAreaElement)
  await waitFor(() => assert.equal(textarea.readOnly, false))

  const user = userEvent.setup({
    document: dom.window.document,
  })

  return { dom, metrics, requests, textarea, user, ...view }
}

async function cleanupPage(dom: JSDOM, unmount: () => void) {
  await act(async () => {
    unmount()
  })
  dom.window.close()
}

test('presentationForHttpActionError 将 422 显示为内容无法处理', async () => {
  const { presentationForHttpActionError } = await import('../src/lib/http-error-presentation.ts')
  const result = presentationForHttpActionError(422, '生成失败：上游模型没有返回图片。')

  assert.deepEqual(result, {
    title: '内容无法处理',
    detail: '生成失败：上游模型没有返回图片。',
  })
})

test('resizePromptTextarea 调整高度时保留外层滚动和光标位置', async () => {
  const {
    resizePromptTextarea,
  } = await import('../src/lib/prompt-textarea.ts')
  const scrollContainer = { scrollTop: 720 }
  let height = '640px'
  let overflowY = 'hidden'
  const style = {} as CSSStyleDeclaration

  Object.defineProperties(style, {
    height: {
      configurable: true,
      get: () => height,
      set: (value: string) => {
        height = value
        if (value === 'auto') scrollContainer.scrollTop = 0
      },
    },
    overflowY: {
      configurable: true,
      get: () => overflowY,
      set: (value: string) => {
        overflowY = value
      },
    },
  })

  const textarea = {
    scrollHeight: 640,
    scrollTop: 36,
    selectionStart: 512,
    selectionEnd: 512,
    setSelectionRange(start: number, end: number) {
      this.selectionStart = start
      this.selectionEnd = end
    },
    style,
  }

  const contentHeight = resizePromptTextarea(textarea, { scrollContainer })

  assert.equal(contentHeight, 640)
  assert.equal(scrollContainer.scrollTop, 720)
  assert.equal(textarea.scrollTop, 36)
  assert.equal(textarea.selectionStart, 512)
  assert.equal(textarea.selectionEnd, 512)
  assert.equal(height, '640px')
  assert.equal(overflowY, 'hidden')

  assert.equal(resizePromptTextarea(textarea, {
    collapsed: true,
    scrollContainer,
  }), 640)
  assert.equal(height, '200px')
  assert.equal(overflowY, 'auto')
  assert.equal(scrollContainer.scrollTop, 720)
  assert.equal(textarea.scrollTop, 36)
  assert.equal(textarea.selectionStart, 512)

  textarea.scrollHeight = 180
  resizePromptTextarea(textarea, { collapsed: true })
  assert.equal(height, '200px')
  assert.equal(overflowY, 'hidden')
})

test('GeneratePage 输入长提示词时会继续增高且不启用内部滚动', async (t) => {
  const page = await renderGeneratePage('/generate')
  t.after(async () => {
    await cleanupPage(page.dom, page.unmount)
  })

  const longPrompt = buildLongPrompt(20)

  await page.user.type(page.textarea, longPrompt)
  await flushEffects()

  assert.equal(page.textarea.value, longPrompt)
  assert.equal(page.textarea.style.height, expectedHeight(longPrompt))
  assert.equal(page.textarea.style.overflowY, 'hidden')
  assert.ok(Number.parseInt(page.textarea.style.height, 10) > 400)
})

test('GeneratePage 在提示词框内粘贴长文本时不会被全局粘贴监听拦截', async (t) => {
  const page = await renderGeneratePage('/generate')
  t.after(async () => {
    await cleanupPage(page.dom, page.unmount)
  })

  const longPrompt = buildLongPrompt(18)
  await page.user.click(page.textarea)
  await page.user.paste(longPrompt)
  await flushEffects()

  assert.equal(page.textarea.value, longPrompt)
  assert.equal(page.textarea.style.height, expectedHeight(longPrompt))
  assert.equal(page.textarea.style.overflowY, 'hidden')
})

test('GeneratePage 在路由状态回填长提示词后会自动展开', async (t) => {
  const longPrompt = buildLongPrompt(22)
  const page = await renderGeneratePage({
    pathname: '/generate',
    state: { prompt: longPrompt },
  })
  t.after(async () => {
    await cleanupPage(page.dom, page.unmount)
  })

  await flushEffects()

  assert.equal(page.textarea.value, longPrompt)
  assert.equal(page.textarea.style.height, expectedHeight(longPrompt))
  assert.equal(page.textarea.style.overflowY, 'hidden')
  assert.ok(Number.parseInt(page.textarea.style.height, 10) > 400)
})

test('GeneratePage 接收窗口任意区域的文件拖放且只添加一次', async (t) => {
  const page = await renderGeneratePage('/generate')
  t.after(async () => {
    await cleanupPage(page.dom, page.unmount)
  })

  const file = new page.dom.window.File(['image'], 'finder.png', {
    type: 'image/png',
  })
  const sidebar = page.container.querySelector('aside')
  const header = page.container.querySelector('header')
  assert.ok(sidebar)
  assert.ok(header)

  await act(async () => {
    const dragEnter = dispatchDragEvent(page.dom, sidebar, 'dragenter', [file])
    assert.equal(dragEnter.defaultPrevented, true)
  })
  assert.ok(page.container.querySelector('[data-testid="reference-drop-overlay"]'))

  await act(async () => {
    const drop = dispatchDragEvent(page.dom, header, 'drop', [file])
    assert.equal(drop.defaultPrevented, true)
  })
  await flushEffects()

  assert.equal(
    page.container.querySelectorAll('img[alt^="参考图 "]').length,
    1,
  )
  assert.equal(
    page.container.querySelector('[data-testid="reference-drop-overlay"]'),
    null,
  )
})

test('GeneratePage 不接管文字等非文件拖拽', async (t) => {
  const page = await renderGeneratePage('/generate')
  t.after(async () => {
    await cleanupPage(page.dom, page.unmount)
  })

  const main = page.container.querySelector('main')
  assert.ok(main)

  let dragEnter: Event
  await act(async () => {
    dragEnter = dispatchDragEvent(page.dom, main, 'dragenter', [], ['text/plain'])
  })

  assert.equal(dragEnter!.defaultPrevented, false)
  assert.equal(
    page.container.querySelector('[data-testid="reference-drop-overlay"]'),
    null,
  )
})

test('GeneratePage 生成长提示词收起后与右栏齐底，窄屏使用默认高度', async (t) => {
  const longPrompt = buildLongPrompt(20)
  const page = await renderGeneratePage({
    pathname: '/generate',
    state: { prompt: longPrompt },
  })
  t.after(async () => {
    await cleanupPage(page.dom, page.unmount)
  })

  const settings = Array.from(page.container.querySelectorAll('h3')).find(
    (heading) => heading.textContent === '生成设置',
  )?.parentElement
  assert.ok(settings)
  page.textarea.getBoundingClientRect = () => new page.dom.window.DOMRect(0, 100, 700, 640)
  settings.getBoundingClientRect = () => new page.dom.window.DOMRect(724, 70, 280, 330)

  const generateButton = Array.from(page.container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === '提交生成',
  )
  assert.ok(generateButton)

  await page.user.click(generateButton)
  await flushEffects()

  assert.equal(page.textarea.style.height, '300px')
  assert.equal(page.textarea.style.overflowY, 'auto')
  const expandButton = Array.from(page.container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === '展开',
  )
  assert.ok(expandButton)
  // 提交立即返回；仅在主动打开历史结果时滚动，不跳离正在编辑的草稿。
  assert.equal(page.metrics.scrollIntoViewCalls, 0)

  await page.user.click(expandButton)
  await flushEffects()
  assert.equal(page.textarea.style.height, expectedHeight(longPrompt))
  assert.equal(page.textarea.style.overflowY, 'hidden')

  const collapseButton = Array.from(page.container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === '收起',
  )
  assert.ok(collapseButton)
  await page.user.click(collapseButton)
  await flushEffects()
  assert.equal(page.textarea.style.height, '300px')
  assert.equal(page.textarea.style.overflowY, 'auto')
  settings.getBoundingClientRect = () => new page.dom.window.DOMRect(0, 320, 700, 330)
  await act(async () => {
    page.dom.window.dispatchEvent(new page.dom.window.Event('resize'))
  })
  assert.equal(page.textarea.style.height, '200px')
  assert.equal(page.textarea.style.overflowY, 'auto')
})

test('GeneratePage 生成短提示词时保持默认输入框状态', async (t) => {
  const page = await renderGeneratePage({
    pathname: '/generate',
    state: { prompt: '简短提示词' },
  })
  t.after(async () => {
    await cleanupPage(page.dom, page.unmount)
  })

  const generateButton = Array.from(page.container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === '提交生成',
  )
  assert.ok(generateButton)
  await page.user.click(generateButton)
  await flushEffects()

  assert.equal(page.textarea.style.height, '200px')
  assert.equal(page.textarea.style.overflowY, 'hidden')
  assert.equal(
    Array.from(page.container.querySelectorAll('button')).some(
      (button) => button.textContent?.trim() === '展开',
    ),
    false,
  )
})

test('GeneratePage 上传期间展示真实阶段且请求使用点击时的提示词快照', async (t) => {
  const upload = createDeferred<Response>()
  const page = await renderGeneratePage('/generate', {
    referenceUploadResponse: () => upload.promise,
  })
  t.after(async () => {
    upload.resolve(Response.json({ filenames: ['uploaded-reference.png'] }))
    await cleanupPage(page.dom, page.unmount)
  })

  const file = new page.dom.window.File(['image'], 'reference.png', {
    type: 'image/png',
  })
  const main = page.container.querySelector('main')
  assert.ok(main)
  await act(async () => {
    dispatchDragEvent(page.dom, main, 'dragenter', [file])
    dispatchDragEvent(page.dom, main, 'drop', [file])
  })

  await page.user.type(page.textarea, '本次生成提示词')
  const generateButton = Array.from(page.container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === '提交生成',
  )
  assert.ok(generateButton)
  await page.user.click(generateButton)
  await waitFor(() => assert.match(page.container.textContent ?? '', /正在上传参考图/))

  await page.user.clear(page.textarea)
  await page.user.type(page.textarea, '下一次生成提示词')

  upload.resolve(Response.json({ filenames: ['uploaded-reference.png'] }))
  await waitFor(() => assert.ok(page.requests.some(record => record.url === '/api/generation-tasks' && record.init?.method === 'POST')))

  const generateRequest = page.requests.find(
    (request) => request.url === '/api/generation-tasks' && request.init?.method === 'POST',
  )
  assert.ok(generateRequest?.init?.body)
  const payload = JSON.parse(String(generateRequest.init.body)) as {
    prompt: string
    referenceFilenames: string[]
  }
  assert.equal(payload.prompt, '本次生成提示词')
  assert.deepEqual(payload.referenceFilenames, ['uploaded-reference.png'])
})

test('GeneratePage 会从路由状态回填配方保存的生成参数', async (t) => {
  const page = await renderGeneratePage({
    pathname: '/generate',
    state: {
      prompt: '配方提示词',
      referenceImages: [],
      aspectRatio: '16:9',
      imageSize: '4K',
      provider: 'google',
      model: 'gemini-3.1-flash-image',
      outputFormat: 'png',
    },
  })
  t.after(async () => {
    await cleanupPage(page.dom, page.unmount)
  })

  const selects = page.container.querySelectorAll('select:not([aria-label="切换草稿"])')
  assert.equal(selects.length, 3)
  assert.equal(page.textarea.value, '配方提示词')
  assert.equal((selects[0] as HTMLSelectElement).value, 'google:gemini-nano-banana-2.1')
  assert.equal((selects[1] as HTMLSelectElement).value, '16:9')
  assert.equal((selects[2] as HTMLSelectElement).value, '4K')
})

test('GeneratePage 默认选择 Seedream，隐藏 4K 并显示 10 张参考图上限', async (t) => {
  const page = await renderGeneratePage('/generate')
  t.after(async () => {
    await cleanupPage(page.dom, page.unmount)
  })

  const selects = page.container.querySelectorAll('select:not([aria-label="切换草稿"])')
  assert.equal(selects.length, 3)
  assert.equal(
    (selects[0] as HTMLSelectElement).value,
    'seedream:doubao-seedream-5-5-261028',
  )
  await flushEffects()

  const resolutionOptions = Array.from(
    (selects[2] as HTMLSelectElement).options,
  ).map((option) => option.value)
  assert.deepEqual(resolutionOptions, ['1K', '2K'])
  assert.match(page.container.textContent ?? '', /最多 10 张/)
})

test('GeneratePage 选择 Seedream 5.5 时显示 1K/2K 和 10 张上限', async (t) => {
  const page = await renderGeneratePage('/generate')
  t.after(async () => {
    await cleanupPage(page.dom, page.unmount)
  })

  const selects = page.container.querySelectorAll('select:not([aria-label="切换草稿"])')
  await page.user.selectOptions(
    selects[0] as HTMLSelectElement,
    'seedream:doubao-seedream-5-5-261028',
  )
  await flushEffects()

  assert.deepEqual(
    Array.from((selects[2] as HTMLSelectElement).options).map((option) => option.value),
    ['1K', '2K'],
  )
  assert.match(page.container.textContent ?? '', /最多 10 张/)
})

test('旧 Lite 配方转入生成时选择 5.5、降为 2K 并保留全部参考图', async (t) => {
  const page = await renderGeneratePage({ pathname: '/generate', state: { prompt: 'legacy recipe', provider: 'seedream', model: 'doubao-seedream-5-0-260128', imageSize: '4K', referenceImages: Array.from({ length: 14 }, (_, i) => `ref-${i}.png`) } })
  t.after(async () => { await cleanupPage(page.dom, page.unmount) })
  await flushEffects()
  const selects = page.container.querySelectorAll('select:not([aria-label="切换草稿"])')
  assert.equal((selects[0] as HTMLSelectElement).value, 'seedream:doubao-seedream-5-5-261028')
  assert.equal((selects[2] as HTMLSelectElement).value, '2K')
  assert.match(page.container.textContent ?? '', /当前有 14 张参考图/)
  assert.match(page.container.textContent ?? '', /移除多余图片/)
})

test('GeneratePage 选择OpenAI 兼容 时默认自动比例和 High，并只显示质量参数', async (t) => {
  const page = await renderGeneratePage('/generate')
  t.after(async () => {
    await cleanupPage(page.dom, page.unmount)
  })

  const selects = page.container.querySelectorAll('select:not([aria-label="切换草稿"])')
  await page.user.selectOptions(selects[0] as HTMLSelectElement, 'openai-compatible:gpt-image-1')
  await flushEffects()

  assert.equal(selects.length, 3)
  assert.equal((selects[1] as HTMLSelectElement).value, 'auto')
  assert.equal((selects[2] as HTMLSelectElement).value, 'high')
  assert.deepEqual(
    Array.from((selects[1] as HTMLSelectElement).options).map((option) => ({
      value: option.value,
      label: option.textContent,
    })),
    [
      { value: 'auto', label: '自动' },
      { value: '1:1', label: '1:1' },
      ...['2:3', '3:2'].map(value => ({ value, label: value })),
    ],
  )
  assert.deepEqual(
    Array.from((selects[2] as HTMLSelectElement).options).map((option) => option.value),
    ['low', 'medium', 'high'],
  )
  assert.match(page.container.textContent ?? '', /质量/)
  assert.doesNotMatch(page.container.textContent ?? '', /分辨率/)
})

test('旧渠道草稿保留内容并要求手动选择，切到免费演示后可提交', async (t) => {
  const page = await renderGeneratePage({ pathname: '/generate', state: { prompt: '竖版测试', provider: 'retired-relay', model: 'archived-model', aspectRatio: '9:16' } })
  t.after(async () => { await cleanupPage(page.dom, page.unmount) })
  const model = page.container.querySelector('select[aria-label="模型"]') as HTMLSelectElement
  await waitFor(() => assert.equal(model.value, 'retired-relay:archived-model'))
  const button = Array.from(page.container.querySelectorAll('button')).find(button => button.textContent?.includes('提交生成'))!
  assert.equal(button.disabled, true)
  await page.user.selectOptions(model, 'demo:banana-demo-v1')
  assert.equal((page.container.querySelector('select[aria-label="宽高比"]') as HTMLSelectElement).value, '9:16')
  await page.user.click(button)
  await flushEffects()
  const submitted = page.requests.find(record => record.url === '/api/generation-tasks' && record.init?.method === 'POST')
  assert.ok(submitted)
  assert.match(String(submitted.init?.body), /竖版测试/)
  assert.equal(JSON.parse(String(submitted.init?.body)).model, 'banana-demo-v1')
})

test('fresh local Qwen default starts at 1K without a saved resolution preference',async(t)=>{
 const page=await renderGeneratePage('/generate',{defaultModel:{provider:'qwen-local',model:'qwen-image-2.1-UC-Q8_0'}})
 t.after(async()=>{await cleanupPage(page.dom,page.unmount)})
 await waitFor(()=>assert.equal((page.container.querySelector('select[aria-label="模型"]') as HTMLSelectElement).value,'qwen-local:qwen-image-2.1-UC-Q8_0'))
 assert.equal((page.container.querySelector('select[aria-label="分辨率"]') as HTMLSelectElement).value,'1K')
})

test('local Qwen shows actual preset pixels and retains the selected ratio after adding references',async(t)=>{
 const page=await renderGeneratePage('/generate')
 t.after(async()=>{await cleanupPage(page.dom,page.unmount)})
 await page.user.selectOptions(page.container.querySelector('select[aria-label="模型"]') as HTMLSelectElement,'qwen-local:qwen-image-2.1-UC-Q8_0')
 await page.user.selectOptions(page.container.querySelector('select[aria-label="宽高比"]') as HTMLSelectElement,'16:9')
 await waitFor(()=>assert.match(page.container.textContent??'',/1376\s*×\s*768/))
 const file=new page.dom.window.File(['fixture'],'ref.png',{type:'image/png'})
 await page.user.upload(page.container.querySelector('input[type="file"]') as HTMLInputElement,file)
 await flushEffects()
 const ratio=page.container.querySelector('select[aria-label="宽高比"]') as HTMLSelectElement
 assert.equal(ratio.value,'16:9');assert.ok([...ratio.options].some(o=>o.value==='source'))
 await page.user.selectOptions(page.container.querySelector('select[aria-label="分辨率"]') as HTMLSelectElement,'2K')
 await waitFor(()=>assert.match(page.container.textContent??'',/2752\s*×\s*1536/))
 await page.user.selectOptions(ratio,'source')
 await waitFor(()=>assert.match(page.container.textContent??'',/跟随第一张参考图/))
 await page.user.click(page.getByRole('button',{name:'移除参考图 1'}))
 await flushEffects();assert.equal(ratio.value,'1:1');assert.ok(![...ratio.options].some(o=>o.value==='source'))
})

test('GeneratePage 切换模型时保留新模型支持的用户宽高比选择', async (t) => {
  const page = await renderGeneratePage('/generate')
  t.after(async () => {
    await cleanupPage(page.dom, page.unmount)
  })

  const selects = page.container.querySelectorAll('select:not([aria-label="切换草稿"])')
  await page.user.selectOptions(
    selects[0] as HTMLSelectElement,
    'google:gemini-nano-banana-2.1',
  )
  await page.user.selectOptions(selects[1] as HTMLSelectElement, '21:9')
  await flushEffects()

  assert.equal((selects[1] as HTMLSelectElement).value, '21:9')

  await page.user.selectOptions(selects[0] as HTMLSelectElement, 'qwen-local:qwen-image-2.1-UC-Q8_0')
  await flushEffects()
  assert.equal((selects[1] as HTMLSelectElement).value, '1:1')

  await page.user.selectOptions(
    selects[0] as HTMLSelectElement,
    'google:gemini-nano-banana-2.1',
  )
  await flushEffects()
  assert.equal((selects[1] as HTMLSelectElement).value, '21:9')
})

test('GeneratePage 复用主界面左侧导航，只切换右侧生成内容', async (t) => {
  const page = await renderGeneratePage('/generate')
  t.after(async () => {
    await cleanupPage(page.dom, page.unmount)
  })

  const sidebar = page.container.querySelector('aside')
  assert.ok(sidebar)
  assert.match(sidebar.textContent ?? '', /作品/)
  assert.match(sidebar.textContent ?? '', /配方/)
  assert.match(sidebar.textContent ?? '', /生成图片/)
  assert.doesNotMatch(sidebar.textContent ?? '', /上传图片/)
  assert.match(sidebar.textContent ?? '', /Banana Gallery/)
  assert.doesNotMatch(sidebar.textContent ?? '', /返回画廊/)
})

test('GeneratePage 打开生成结果大图后按 Escape 会关闭预览', async (t) => {
  const page = await renderGeneratePage('/generate', {withSourceResultLink:true})
  t.after(async () => {
    await cleanupPage(page.dom, page.unmount)
  })

  await page.user.type(page.textarea, '测试提示词')
  const generateButton = Array.from(page.container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === '提交生成',
  )
  assert.ok(generateButton)

  await page.user.click(generateButton)
  await flushEffects()

  await page.user.click(page.getByRole('button', {name:'任务记录'}))
  await page.user.click(page.getByRole('button', {name:'查看来源结果'}))
  const resultImage = page.container.querySelector('img[alt="生成结果"]')
  assert.ok(resultImage)
  await page.user.click(resultImage)
  assert.ok(page.queryByRole('dialog', {name:'大图预览'}))

  await page.user.keyboard('{Escape}')

  assert.equal(page.queryByRole('dialog', {name:'大图预览'}), null)
})

test('点生成历史缩略图就地打开大图，不滚动页面，点空白或按 Escape 关闭', async (t) => {
  const page = await renderGeneratePage('/generate')
  t.after(async () => {
    await cleanupPage(page.dom, page.unmount)
  })

  await page.user.type(page.textarea, '测试提示词')
  const generateButton = Array.from(page.container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === '提交生成',
  )
  assert.ok(generateButton)
  await page.user.click(generateButton)
  await flushEffects()

  await page.user.click(page.getByRole('button', {name:'任务记录'}))
  const thumbnail = await page.findByRole('button', { name: '查看大图' })
  await page.user.click(thumbnail)

  const dialog = page.queryByRole('dialog', {name:'大图预览'})
  assert.ok(dialog)
  assert.equal(dialog.querySelector('img')?.getAttribute('src'), '/api/assets/images/generated-test.png')
  // 只开浮层：不把历史结果塞进顶部「生成结果」，也不滚回页面顶部。
  assert.equal(page.container.querySelector('img[alt="生成结果"]'), null)
  assert.equal(page.metrics.scrollIntoViewCalls, 0)

  // 点空白遮罩关闭。
  await page.user.click(dialog)
  assert.equal(page.queryByRole('dialog', {name:'大图预览'}), null)

  // 再开一次，按 Escape 关闭。
  await page.user.click(thumbnail)
  assert.ok(page.queryByRole('dialog', {name:'大图预览'}))
  await page.user.keyboard('{Escape}')
  assert.equal(page.queryByRole('dialog', {name:'大图预览'}), null)
})

test('点参考图缩略图就近打开大图，删除按钮和拖完的点击不弹浮层', async (t) => {
  const page = await renderGeneratePage({
    pathname: '/generate',
    state: { prompt: 'original', referenceImages: ['a.png', 'b.png'] },
  })
  t.after(async () => {
    await cleanupPage(page.dom, page.unmount)
  })

  await page.user.click(page.getByAltText('参考图 1'))
  const dialog = page.queryByRole('dialog', {name:'大图预览'})
  assert.ok(dialog)
  assert.equal(dialog.querySelector('img')?.getAttribute('src'), '/api/assets/references/a.png')
  await page.user.click(dialog)
  assert.equal(page.queryByRole('dialog', {name:'大图预览'}), null)

  // 删除按钮不是大图入口。
  await page.user.click(page.getByRole('button', { name: '移除参考图 2' }))
  assert.equal(page.queryByRole('dialog', {name:'大图预览'}), null)
  assert.equal(page.container.querySelectorAll('img[alt^="参考图 "]').length, 1)

  // 拖动刚结束的那一下点击不弹浮层；隔开一段时间再点才当作看大图。
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => clock
  try {
    const thumbnail = page.getByAltText('参考图 1')
    await act(async () => {
      dispatchDragEvent(page.dom, thumbnail, 'dragstart', [], [])
      dispatchDragEvent(page.dom, thumbnail, 'drop', [], [])
    })
    await page.user.click(thumbnail)
    assert.equal(page.queryByRole('dialog', {name:'大图预览'}), null)

    clock += 1000
    await page.user.click(thumbnail)
    assert.ok(page.queryByRole('dialog', {name:'大图预览'}))
  } finally {
    Date.now = realNow
  }
})

test('生成结果保存使用当次有序参考图，编辑下一轮输入不会改变已生成结果', async (t) => {
  const page = await renderGeneratePage({ pathname: '/generate', state: { prompt: 'original', referenceImages: ['a.png', 'b.png'] } }, {withSourceResultLink:true})
  t.after(() => cleanupPage(page.dom, page.unmount))
  await page.user.click(page.getByRole('button', { name: '提交生成', exact: true }))
  await flushEffects()
  await page.user.click(page.getByRole('button', {name:'任务记录'}))
  await page.user.click(page.getByRole('button', {name:'查看来源结果'}))
  // 通过可见参考图区的删除按钮移除第一张，模拟准备下一次生成。
  const refImage = page.getByAltText('参考图 1')
  const removeRef = refImage.parentElement?.parentElement?.querySelector('button')
  assert.ok(removeRef)
  await page.user.click(removeRef)
  await page.user.click(page.getByRole('button', { name: '保存作品', exact: true }))
  await flushEffects()
  const saved = page.requests.find(r => r.url === '/api/generate/save')
  assert.ok(saved)
  assert.deepEqual(JSON.parse(String(saved.init?.body)).referenceFilenames, ['a.png', 'b.png'])
})

test('下一次生成失败仍保留上一张结果供保存', async (t) => {
  let calls = 0
  const page = await renderGeneratePage({ pathname: '/generate', state: { prompt: 'original' } }, {
    withSourceResultLink:true,
    generateResponse: () => ++calls === 1 ? Response.json({ filename: 'first.png', prompt: 'original', width: 1, height: 1, provider: 'seedream', model: 'doubao-seedream-5-5-261028', aspectRatio: '1:1', imageSize: '2K' }) : Response.json({ error: 'test failure' }, { status: 500 }),
  })
  t.after(() => cleanupPage(page.dom, page.unmount))
  await page.user.click(page.getByRole('button', { name: '提交生成', exact: true }))
  await flushEffects()
  await page.user.click(page.getByRole('button', {name:'任务记录'}))
  await page.user.click(page.getByRole('button', {name:'查看来源结果'}))
  await page.user.click(page.getByRole('button', { name: '提交生成', exact: true }))
  await flushEffects()
  assert.match(page.getByAltText('生成结果').getAttribute('src') ?? '', /first.png/)
})

test('GeneratePage 拖动参考图会改变上传与提交的顺序', async (t) => {
  const uploadedNames: string[] = []
  const page = await renderGeneratePage('/generate', {
    referenceUploadResponse: (record) => {
      const names = (record.init?.body as FormData)
        .getAll('references')
        .map((file) => (file as File).name)
      uploadedNames.push(...names)
      return Response.json({ filenames: names.map((name) => `server-${name}`) })
    },
  })
  t.after(() => cleanupPage(page.dom, page.unmount))

  const files = ['a', 'b', 'c'].map(
    (name) => new page.dom.window.File(['image'], `${name}.png`, { type: 'image/png' }),
  )
  const main = page.container.querySelector('main')
  assert.ok(main)
  await act(async () => {
    dispatchDragEvent(page.dom, main, 'dragenter', files)
    dispatchDragEvent(page.dom, main, 'drop', files)
  })
  await flushEffects()

  const refImages = () => Array.from(page.container.querySelectorAll('img[alt^="参考图 "]'))
  assert.deepEqual(refImages().map((img) => img.getAttribute('src')), [
    'blob:a.png',
    'blob:b.png',
    'blob:c.png',
  ])

  // 只有缩略图本身是拖拽把手；图片禁掉原生拖拽，外层容器的删除按钮和角标保持纯点击。
  const thumbnail = refImages()[2]!.parentElement
  assert.equal(thumbnail?.getAttribute('draggable'), 'true')
  assert.equal(refImages()[2]!.getAttribute('draggable'), 'false')
  assert.equal(thumbnail?.parentElement?.getAttribute('draggable'), null)

  let dropEvent: Event | undefined
  await act(async () => {
    dispatchDragEvent(page.dom, refImages()[2]!, 'dragstart', [], [])
    const overEvent = dispatchDragEvent(page.dom, refImages()[0]!, 'dragover', [], [])
    assert.equal(overEvent.defaultPrevented, true)
    dropEvent = dispatchDragEvent(page.dom, refImages()[0]!, 'drop', [], [])
  })
  await flushEffects()
  assert.equal(dropEvent?.defaultPrevented, true)
  assert.deepEqual(refImages().map((img) => img.getAttribute('src')), [
    'blob:c.png',
    'blob:a.png',
    'blob:b.png',
  ])

  await page.user.type(page.textarea, '拖动后生成')
  await page.user.click(page.getByRole('button', { name: '提交生成', exact: true }))
  await waitFor(() => assert.ok(page.requests.some(record => record.url === '/api/generation-tasks' && record.init?.method === 'POST')))

  assert.deepEqual(uploadedNames, ['c.png', 'a.png', 'b.png'])
  const generateRequest = page.requests.find(
    (request) => request.url === '/api/generation-tasks' && request.init?.method === 'POST',
  )
  assert.ok(generateRequest?.init?.body)
  assert.deepEqual(
    JSON.parse(String(generateRequest.init.body)).referenceFilenames,
    ['server-c.png', 'server-a.png', 'server-b.png'],
  )
})

test('GeneratePage 排序拖动中落下的图片文件仍追加而不是重排', async (t) => {
  const page = await renderGeneratePage('/generate')
  t.after(() => cleanupPage(page.dom, page.unmount))

  const main = page.container.querySelector('main')
  assert.ok(main)
  const initial = ['a', 'b', 'c'].map(
    (name) => new page.dom.window.File(['image'], `${name}.png`, { type: 'image/png' }),
  )
  await act(async () => {
    dispatchDragEvent(page.dom, main, 'dragenter', initial)
    dispatchDragEvent(page.dom, main, 'drop', initial)
  })
  await flushEffects()

  const refImages = () => Array.from(page.container.querySelectorAll('img[alt^="参考图 "]'))
  const extra = new page.dom.window.File(['image'], 'd.png', { type: 'image/png' })
  await act(async () => {
    // 上一次内部拖拽没有 dragend（比如拖出窗口后拖回文件），此时把文件拖到缩略图上必须仍走上传追加。
    dispatchDragEvent(page.dom, refImages()[2]!, 'dragstart', [], [])
    dispatchDragEvent(page.dom, refImages()[0]!, 'dragover', [extra])
    dispatchDragEvent(page.dom, refImages()[0]!, 'drop', [extra])
  })
  await flushEffects()
  assert.deepEqual(refImages().map((img) => img.getAttribute('src')), [
    'blob:a.png',
    'blob:b.png',
    'blob:c.png',
    'blob:d.png',
  ])
})

test('GeneratePage 内部拖拽落到加号上不发生重排', async (t) => {
  const page = await renderGeneratePage('/generate')
  t.after(() => cleanupPage(page.dom, page.unmount))

  const main = page.container.querySelector('main')
  assert.ok(main)
  const files = ['a', 'b', 'c'].map(
    (name) => new page.dom.window.File(['image'], `${name}.png`, { type: 'image/png' }),
  )
  await act(async () => {
    dispatchDragEvent(page.dom, main, 'dragenter', files)
    dispatchDragEvent(page.dom, main, 'drop', files)
  })
  await flushEffects()

  const addButton = page.container.querySelector('button.border-dashed')
  assert.ok(addButton)
  const refImages = () => Array.from(page.container.querySelectorAll('img[alt^="参考图 "]'))
  await act(async () => {
    dispatchDragEvent(page.dom, refImages()[2]!, 'dragstart', [], [])
    dispatchDragEvent(page.dom, addButton, 'drop', [], [])
  })
  await flushEffects()
  assert.deepEqual(refImages().map((img) => img.getAttribute('src')), [
    'blob:a.png',
    'blob:b.png',
    'blob:c.png',
  ])
})

test('GeneratePage 拖动落点提示画在落点一侧', async (t) => {
  const page = await renderGeneratePage('/generate')
  t.after(() => cleanupPage(page.dom, page.unmount))

  const main = page.container.querySelector('main')
  assert.ok(main)
  const files = ['a', 'b', 'c'].map(
    (name) => new page.dom.window.File(['image'], `${name}.png`, { type: 'image/png' }),
  )
  await act(async () => {
    dispatchDragEvent(page.dom, main, 'dragenter', files)
    dispatchDragEvent(page.dom, main, 'drop', files)
  })
  await flushEffects()

  const refImages = () => Array.from(page.container.querySelectorAll('img[alt^="参考图 "]'))
  const wrapper = (img: Element) => img.parentElement?.parentElement as HTMLElement

  // 向下拖（第 1 张到第 3 张）：落点在目标之后，提示线画在右侧。
  await act(async () => {
    dispatchDragEvent(page.dom, refImages()[0]!, 'dragstart', [], [])
  })
  await act(async () => {
    dispatchDragEvent(page.dom, refImages()[2]!, 'dragover', [], [])
  })
  assert.match(wrapper(refImages()[2]!).className, /before:left-full/)
  assert.doesNotMatch(wrapper(refImages()[2]!).className, /before:-left-1\.5/)

  await act(async () => {
    dispatchDragEvent(page.dom, refImages()[2]!, 'dragend', [], [])
  })
  // 向上拖（第 3 张到第 1 张）：落点在目标之前，提示线画在左侧。
  await act(async () => {
    dispatchDragEvent(page.dom, refImages()[2]!, 'dragstart', [], [])
  })
  await act(async () => {
    dispatchDragEvent(page.dom, refImages()[0]!, 'dragover', [], [])
  })
  assert.match(wrapper(refImages()[0]!).className, /before:-left-1\.5/)
  assert.doesNotMatch(wrapper(refImages()[0]!).className, /before:left-full/)
})

test('GeneratePage 提交开始后拖动不影响已提交的顺序', async (t) => {
  const upload = createDeferred<Response>()
  const page = await renderGeneratePage('/generate', {
    referenceUploadResponse: async record => {
      await upload.promise
      const file = (record.init?.body as FormData).get('references') as File
      return Response.json({ filenames: [`u-${file.name}`] })
    },
  })
  t.after(async () => {
    upload.resolve(Response.json({ filenames: ['u-a.png', 'u-b.png', 'u-c.png'] }))
    await cleanupPage(page.dom, page.unmount)
  })

  const main = page.container.querySelector('main')
  assert.ok(main)
  const files = ['a', 'b', 'c'].map(
    (name) => new page.dom.window.File(['image'], `${name}.png`, { type: 'image/png' }),
  )
  await act(async () => {
    dispatchDragEvent(page.dom, main, 'dragenter', files)
    dispatchDragEvent(page.dom, main, 'drop', files)
  })
  await flushEffects()

  await page.user.type(page.textarea, '提交中拖动')
  await page.user.click(page.getByRole('button', { name: '提交生成', exact: true }))
  await flushEffects()

  const refImages = () => Array.from(page.container.querySelectorAll('img[alt^="参考图 "]'))
  await act(async () => {
    dispatchDragEvent(page.dom, refImages()[2]!, 'dragstart', [], [])
  })
  await act(async () => {
    dispatchDragEvent(page.dom, refImages()[0]!, 'dragover', [], [])
    dispatchDragEvent(page.dom, refImages()[0]!, 'drop', [], [])
  })
  await flushEffects()
  assert.deepEqual(refImages().map((img) => img.getAttribute('src')), [
    'blob:c.png',
    'blob:a.png',
    'blob:b.png',
  ])

  upload.resolve(Response.json({ filenames: ['u-a.png', 'u-b.png', 'u-c.png'] }))
  await waitFor(() => assert.ok(page.requests.some(record => record.url === '/api/generation-tasks' && record.init?.method === 'POST')))

  const generateRequest = page.requests.find(
    (request) => request.url === '/api/generation-tasks' && request.init?.method === 'POST',
  )
  assert.ok(generateRequest?.init?.body)
  assert.deepEqual(
    JSON.parse(String(generateRequest.init.body)).referenceFilenames,
    ['u-a.png', 'u-b.png', 'u-c.png'],
  )
})


test('Krea selection preserves Qwen references, blocks submission and displays its canvas', async (t) => {
 const page=await renderGeneratePage('/generate',{defaultModel:{provider:'qwen-local',model:'qwen-image-2.1-UC-Q8_0'}})
 t.after(()=>cleanupPage(page.dom,page.unmount))
 const main=page.container.querySelector('main')!
 const file=new page.dom.window.File(['image'],'keep.png',{type:'image/png'})
 await act(async()=>{dispatchDragEvent(page.dom,main,'dragenter',[file]);dispatchDragEvent(page.dom,main,'drop',[file])})
 await flushEffects()
 await page.user.type(page.textarea,'portrait')
 const menu=page.container.querySelector('select[aria-label="模型"]') as HTMLSelectElement
 await page.user.selectOptions(menu,'krea-local:krea-2-turbo')
 await flushEffects()
 assert.equal(page.container.querySelectorAll('img[alt^="参考图 "]').length,1)
 assert.equal((page.getByRole('button',{name:'提交生成',exact:true}) as HTMLButtonElement).disabled,true)
 assert.match(page.container.textContent??'',/仅支持文生图/)
 assert.match(page.container.textContent??'',/预计 1024 × 1024/)
 await page.user.selectOptions(menu,'qwen-local:qwen-image-2.1-UC-Q8_0')
 assert.equal(page.container.querySelectorAll('img[alt^="参考图 "]').length,1)
})


test('生成记录首击直接看原图并按作品顺序翻页', async t => {
  const page = await renderGeneratePage('/generate', { recentWorkCount: 31 })
  t.after(() => cleanupPage(page.dom, page.unmount))
  const first = await page.findByRole('button', { name: '打开作品 #WORK1' })
  const scroll = page.container.querySelector('main')!
  const originalDownloads: string[] = []
  page.dom.window.HTMLAnchorElement.prototype.click = function () { originalDownloads.push(this.download) }

  await page.user.click(first)
  const viewer = () => page.getByRole('dialog', { name: '大图预览' })
  assert.equal(viewer().querySelector('img')?.getAttribute('src'), '/api/assets/images/work-1.png')
  assert.ok(viewer().textContent?.includes('1 / 31'))
  await page.user.keyboard('{ArrowLeft}')
  assert.ok(viewer().textContent?.includes('1 / 31'))
  await page.user.click(page.getByRole('button', { name: '下一张' }))
  assert.ok(viewer().textContent?.includes('2 / 31'))
  await page.user.click(page.getByRole('button', { name: '下载原图' }))
  assert.deepEqual(originalDownloads, ['work-2.png'])
  await page.user.click(page.getByRole('button', { name: '详情', exact: true }))
  assert.equal(page.queryByRole('dialog', { name: '大图预览' }), null)
  const detail = page.getByRole('dialog', { name: '作品提示词 2' })
  assert.equal(within(detail).getByRole('button', { name: '喜欢', exact: true }).getAttribute('aria-pressed'), 'false')
  await page.user.click(page.getByRole('button', { name: '关闭详情' }))

  const thirtieth = page.getByRole('button', { name: '打开作品 #WORK30' })
  scroll.scrollTop = 600
  await page.user.click(thirtieth)
  await page.user.keyboard('{ArrowRight}{ArrowRight}')
  assert.ok(viewer().textContent?.includes('31 / 31'))
  await page.user.keyboard('{Escape}')
  assert.equal(page.queryByRole('dialog', { name: '大图预览' }), null)
  assert.equal(scroll.scrollTop, 600)
  assert.equal(page.dom.window.document.activeElement, thirtieth)
  assert.equal(page.queryByRole('button', { name: '打开作品 #WORK31' }), null)
})

test('生成记录快捷按钮复制编号、打开详情和另开草稿', async t => {
  const page = await renderGeneratePage('/generate', { recentWorkCount: 2 })
  t.after(() => cleanupPage(page.dom, page.unmount))
  const thumbnail = await page.findByRole('button', { name: '打开作品 #WORK2' })
  const viewer = () => page.queryByRole('dialog', { name: '大图预览' })
  const copy = page.getByRole('button', { name: '复制图片编号 #WORK2' })
  assert.equal(thumbnail.contains(copy), false)
  await page.user.click(copy)
  assert.equal(await page.dom.window.navigator.clipboard.readText(), '#WORK2')
  assert.equal(viewer(), null)

  await page.user.click(thumbnail.parentElement!.querySelector<HTMLButtonElement>('button[aria-label="详情"]')!)
  assert.ok(page.getByRole('dialog', { name: '作品提示词 2' }))
  assert.equal(viewer(), null)
  await page.user.click(page.getByRole('button', { name: '关闭详情' }))

  await page.user.click(thumbnail.parentElement!.querySelector<HTMLButtonElement>('button[aria-label="另开"]')!)
  await waitFor(() => assert.equal(page.textarea.value, '作品提示词 2'))
  assert.equal(viewer(), null)
  await page.user.click(thumbnail.querySelector('img')!)
  assert.ok(viewer())
})

test('再次点击生成记录大图关闭预览并恢复缩略图焦点', async t => {
  const page = await renderGeneratePage('/generate', { recentWorkCount: 2 })
  t.after(() => cleanupPage(page.dom, page.unmount))
  const thumbnail = await page.findByRole('button', { name: '打开作品 #WORK1' })
  const scroll = page.container.querySelector('main')!
  scroll.scrollTop = 600
  await page.user.click(thumbnail)
  const viewer = page.getByRole('dialog', { name: '大图预览' })
  const toolbar = within(viewer).getByRole('group', { name: '大图操作' })
  await page.user.click(within(toolbar).getByRole('button', { name: '下一张' }))
  const image = within(viewer).getByRole('img', { name: '#WORK2' })
  Object.defineProperties(image, {
    naturalWidth: { value: 400 },
    naturalHeight: { value: 200 },
  })
  await page.user.click(image)
  assert.equal(Boolean(page.queryByRole('dialog', { name: '大图预览' })), false)
  await waitFor(() => assert.equal(page.dom.window.document.activeElement, thumbnail))
  assert.equal(scroll.scrollTop, 600)
})

test('生成页在免凭据安装默认选中演示模型并使用 1K', async (t) => {
  const page = await renderGeneratePage('/generate', { defaultModel: { provider: 'demo', model: 'banana-demo-v1' } })
  t.after(async () => { await cleanupPage(page.dom, page.unmount) })
  await waitFor(() => assert.equal((page.container.querySelector('select[aria-label="模型"]') as HTMLSelectElement).value, 'demo:banana-demo-v1'))
  assert.equal((page.container.querySelector('select[aria-label="分辨率"]') as HTMLSelectElement).value, '1K')
})
