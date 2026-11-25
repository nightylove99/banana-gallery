import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { render, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

import type { GalleryImage } from '../src/types.ts'

function setGlobalValue(name: PropertyKey, value: unknown) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  })
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://127.0.0.1:4173/',
  })

  setGlobalValue('window', dom.window)
  setGlobalValue('document', dom.window.document)
  setGlobalValue('navigator', dom.window.navigator)
  setGlobalValue('React', React)
  setGlobalValue('Node', dom.window.Node)
  setGlobalValue('NodeFilter', dom.window.NodeFilter)
  setGlobalValue('Element', dom.window.Element)
  setGlobalValue('HTMLElement', dom.window.HTMLElement)
  setGlobalValue('HTMLInputElement', dom.window.HTMLInputElement)
  setGlobalValue('HTMLButtonElement', dom.window.HTMLButtonElement)
  setGlobalValue('Event', dom.window.Event)
  setGlobalValue('MouseEvent', dom.window.MouseEvent)
  setGlobalValue('KeyboardEvent', dom.window.KeyboardEvent)
  setGlobalValue('CustomEvent', dom.window.CustomEvent)
  setGlobalValue('MutationObserver', dom.window.MutationObserver)
  setGlobalValue('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  setGlobalValue('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0))
  setGlobalValue('cancelAnimationFrame', (id: number) => clearTimeout(id))
  setGlobalValue('IS_REACT_ACT_ENVIRONMENT', true)

  if (!('PointerEvent' in dom.window)) {
    class PointerEventPolyfill extends dom.window.MouseEvent {}
    setGlobalValue('PointerEvent', PointerEventPolyfill)
  } else {
    setGlobalValue('PointerEvent', dom.window.PointerEvent)
  }

  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => undefined,
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'attachEvent', {
    configurable: true,
    value: () => undefined,
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'detachEvent', {
    configurable: true,
    value: () => undefined,
  })

  return dom
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
  })
}

const demoImage: GalleryImage = {
  id: 'img-1',
  filename: 'demo.jpg',
  prompt: '测试提示词',
  referenceImages: ['ref-1.jpg'],
  tags: ['测试'],
  favorited: false,
  createdAt: '2026-03-19T00:00:00.000Z',
  width: 1024,
  height: 1024,
  assetType: 'work',
}

async function renderDetailModal(
  image: GalleryImage = demoImage,
  options: {
    primaryActions?: React.ReactNode
    onDelete?: (id: string) => Promise<void>
    nextImage?: GalleryImage
    onUpdatePrompt?: (id: string, prompt: string) => Promise<void> | void
  } = {},
) {
  const dom = setupDom()
  let closeCount = 0
  const { DetailModal } = await import('../src/components/DetailModal.tsx')

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)

  function DetailModalHarness() {
    const [selectedImage, setSelectedImage] = React.useState<GalleryImage | null>(image)

    return (
      <DetailModal
        image={selectedImage}
        primaryActions={options.primaryActions}
        onDelete={options.onDelete}
        onNext={options.nextImage ? () => setSelectedImage(options.nextImage!) : undefined}
        onClose={() => {
          closeCount += 1
        }}
        onToggleFavorite={() => undefined}
        onUpdateTags={() => undefined}
        onUpdatePrompt={async (id, prompt) => {
          await options.onUpdatePrompt?.(id, prompt)
          setSelectedImage((prev) => (prev?.id === id ? { ...prev, prompt } : prev))
        }}
      />
    )
  }

  const view = render(
    (
      <MemoryRouter>
        <DetailModalHarness />
      </MemoryRouter>
    ),
    { container },
  )
  await flushEffects()

  const user = userEvent.setup({
    document: dom.window.document,
    pointerEventsCheck: 0,
  })

  return { dom, user, closeCountRef: () => closeCount, view }
}

async function openReferenceZoom(user: ReturnType<typeof userEvent.setup>, dom: JSDOM) {
  const referenceThumb = dom.window.document.querySelector('img[alt="Reference 1"]')
  assert.ok(referenceThumb instanceof dom.window.HTMLImageElement)
  await user.click(referenceThumb)
  await flushEffects()
}

function getZoomImage(dom: JSDOM) {
  return dom.window.document.querySelector('img[alt="参考图"]')
}

function getZoomOverlay(dom: JSDOM) {
  return dom.window.document.querySelector('div[class*="z-[60]"]')
}

test('DetailModal 点击主图时打开作品大图', async (t) => {
  const page = await renderDetailModal()

  t.after(async () => {
    await act(async () => {
      page.view.unmount()
    })
    page.dom.window.close()
  })

  const openImageButton = page.dom.window.document.querySelector('button[aria-label="查看大图"]')
  assert.ok(openImageButton instanceof page.dom.window.HTMLButtonElement)
  await page.user.click(openImageButton)
  await flushEffects()

  const zoomImage = page.dom.window.document.querySelector('img[alt="作品大图"]')
  assert.ok(zoomImage instanceof page.dom.window.HTMLImageElement)
  assert.equal(zoomImage.getAttribute('src'), '/api/assets/images/demo.jpg')
  assert.equal(page.closeCountRef(), 0)
})

test('DetailModal 大图元素不会铺满整个遮罩点击区域', async (t) => {
  const page = await renderDetailModal()

  t.after(async () => {
    await act(async () => {
      page.view.unmount()
    })
    page.dom.window.close()
  })

  const openImageButton = page.dom.window.document.querySelector('button[aria-label="查看大图"]')
  assert.ok(openImageButton instanceof page.dom.window.HTMLButtonElement)
  await page.user.click(openImageButton)
  await flushEffects()

  const zoomImage = page.dom.window.document.querySelector('img[alt="作品大图"]')
  assert.ok(zoomImage instanceof page.dom.window.HTMLImageElement)
  assert.equal(zoomImage.classList.contains('h-screen') && zoomImage.classList.contains('w-screen'), false)
})

test('DetailModal 点击主图大图空白区域时只关闭大图，不关闭详情弹窗', async (t) => {
  const page = await renderDetailModal()

  t.after(async () => {
    await act(async () => {
      page.view.unmount()
    })
    page.dom.window.close()
  })

  const openImageButton = page.dom.window.document.querySelector('button[aria-label="查看大图"]')
  assert.ok(openImageButton instanceof page.dom.window.HTMLButtonElement)
  await page.user.click(openImageButton)
  await flushEffects()

  const zoomOverlay = getZoomOverlay(page.dom)
  assert.ok(zoomOverlay instanceof page.dom.window.HTMLDivElement)
  await page.user.click(zoomOverlay)
  await flushEffects()

  assert.equal(page.closeCountRef(), 0)
  assert.equal(page.dom.window.document.querySelector('img[alt="作品大图"]'), null)
})

test('DetailModal 点击参考图空白区域时只关闭参考图，不关闭详情弹窗', async (t) => {
  const page = await renderDetailModal()

  t.after(async () => {
    await act(async () => {
      page.view.unmount()
    })
    page.dom.window.close()
  })

  await openReferenceZoom(page.user, page.dom)

  const zoomOverlay = getZoomOverlay(page.dom)
  assert.ok(zoomOverlay instanceof page.dom.window.HTMLDivElement)
  await page.user.click(zoomOverlay)
  await flushEffects()

  assert.equal(page.closeCountRef(), 0)
  assert.equal(getZoomImage(page.dom), null)
})

test('DetailModal 点击放大后的参考图本身时不会关闭参考图', async (t) => {
  const page = await renderDetailModal()

  t.after(async () => {
    await act(async () => {
      page.view.unmount()
    })
    page.dom.window.close()
  })

  await openReferenceZoom(page.user, page.dom)

  const zoomImage = getZoomImage(page.dom)
  assert.ok(zoomImage instanceof page.dom.window.HTMLImageElement)
  await page.user.click(zoomImage)
  await flushEffects()

  assert.equal(page.closeCountRef(), 0)
  assert.ok(getZoomImage(page.dom))
})

test('DetailModal 点击参考图右上角关闭按钮时只关闭参考图，不关闭详情弹窗', async (t) => {
  const page = await renderDetailModal()

  t.after(async () => {
    await act(async () => {
      page.view.unmount()
    })
    page.dom.window.close()
  })

  await openReferenceZoom(page.user, page.dom)

  const zoomCloseButton = page.dom.window.document.querySelector('button.absolute.right-4.top-4')
  assert.ok(zoomCloseButton instanceof page.dom.window.HTMLButtonElement)
  await page.user.click(zoomCloseButton)
  await flushEffects()

  assert.equal(page.closeCountRef(), 0)
  assert.equal(getZoomImage(page.dom), null)
})

test('DetailModal 支持编辑并保存提示词', async (t) => {
  const updates: Array<{ id: string; prompt: string }> = []
  const page = await renderDetailModal(demoImage, {
    onUpdatePrompt: (id, prompt) => {
      updates.push({ id, prompt })
    },
  })

  t.after(async () => {
    await act(async () => {
      page.view.unmount()
    })
    page.dom.window.close()
  })

  const editButton = page.dom.window.document.querySelector('button[aria-label="编辑提示词"]')
  assert.ok(editButton instanceof page.dom.window.HTMLButtonElement)
  await page.user.click(editButton)
  await flushEffects()

  const textarea = page.dom.window.document.querySelector('textarea[aria-label="编辑提示词"]')
  assert.ok(textarea instanceof page.dom.window.HTMLTextAreaElement)
  await page.user.clear(textarea)
  await page.user.type(textarea, '新的提示词{enter}第二行')

  const saveButton = page.dom.window.document.querySelector('button[aria-label="保存提示词"]')
  assert.ok(saveButton instanceof page.dom.window.HTMLButtonElement)
  await page.user.click(saveButton)
  await flushEffects()

  assert.deepEqual(updates, [{ id: 'img-1', prompt: '新的提示词\n第二行' }])
  assert.equal(page.dom.window.document.querySelector('textarea[aria-label="编辑提示词"]'), null)
  assert.ok(page.dom.window.document.body.textContent?.includes('新的提示词'))
  assert.ok(page.dom.window.document.body.textContent?.includes('第二行'))
})

test('DetailModal 不允许保存空提示词', async (t) => {
  let updateCount = 0
  const page = await renderDetailModal(demoImage, {
    onUpdatePrompt: () => {
      updateCount += 1
    },
  })

  t.after(async () => {
    await act(async () => {
      page.view.unmount()
    })
    page.dom.window.close()
  })

  const editButton = page.dom.window.document.querySelector('button[aria-label="编辑提示词"]')
  assert.ok(editButton instanceof page.dom.window.HTMLButtonElement)
  await page.user.click(editButton)
  await flushEffects()

  const textarea = page.dom.window.document.querySelector('textarea[aria-label="编辑提示词"]')
  assert.ok(textarea instanceof page.dom.window.HTMLTextAreaElement)
  await page.user.clear(textarea)
  await page.user.type(textarea, '   ')
  await flushEffects()

  const saveButton = page.dom.window.document.querySelector('button[aria-label="保存提示词"]')
  assert.ok(saveButton instanceof page.dom.window.HTMLButtonElement)
  assert.equal(saveButton.disabled, true)
  assert.equal(updateCount, 0)
})

test('DetailModal 对作品显示转入生成和提炼成配方动作', async (t) => {
  const page = await renderDetailModal({
    ...demoImage,
    assetType: 'work',
  })

  t.after(async () => {
    await act(async () => {
      page.view.unmount()
    })
    page.dom.window.close()
  })

  const transferButton = Array.from(page.dom.window.document.querySelectorAll('button')).find(button => button.textContent?.includes('转入生成'))
  assert.ok(transferButton?.textContent?.includes('转入生成'))
  assert.ok(within(page.dom.window.document.body).getByRole('button', { name: '提炼成配方' }))
  assert.equal(within(page.dom.window.document.body).queryByRole('button', { name: '作品更多操作' }), null)
})

test('DetailModal 对配方显示用此配方生成动作', async (t) => {
  const page = await renderDetailModal({
    ...demoImage,
    assetType: 'recipe',
    generation: {
      aspectRatio: '16:9',
      imageSize: '4K',
      outputFormat: 'png',
    },
  })

  t.after(async () => {
    await act(async () => {
      page.view.unmount()
    })
    page.dom.window.close()
  })

  assert.ok(page.dom.window.document.body.textContent?.includes('用此配方生成'))
  assert.equal(within(page.dom.window.document.body).queryByRole('button', { name: '提炼成配方' }), null)
})

test('DetailModal 只在详情中展示准确的生成来源与质量', async (t) => {
  const page = await renderDetailModal({
    ...demoImage,
    assetType: 'work',
    generation: {
      aspectRatio: '3:2',
      provider: 'poe',
      model: 'gpt-image-2',
      quality: 'high',
    },
  })

  t.after(async () => {
    await act(async () => {
      page.view.unmount()
    })
    page.dom.window.close()
  })

  const text = page.dom.window.document.body.textContent ?? ''
  assert.match(text, /生成来源/)
  assert.match(text, /Poe · GPT Image 2/)
  assert.match(text, /质量/)
  assert.match(text, /High/)
})

test('DetailModal 将 GPT Image 2 的 auto 比例显示为自动', async (t) => {
  const page = await renderDetailModal({
    ...demoImage,
    generation: {
      aspectRatio: 'auto',
      provider: 'poe',
      model: 'gpt-image-2',
      quality: 'low',
    },
  })

  t.after(async () => {
    await act(async () => {
      page.view.unmount()
    })
    page.dom.window.close()
  })

  assert.match(page.dom.window.document.body.textContent ?? '', /生成比例：自动/)
})

test('DetailModal 对 Gemini 网页导入显示兼容来源文案', async (t) => {
  const page = await renderDetailModal({
    ...demoImage,
    assetType: 'work',
    sourceFile: 'gemini-web',
  })

  t.after(async () => {
    await act(async () => {
      page.view.unmount()
    })
    page.dom.window.close()
  })

  assert.match(
    page.dom.window.document.body.textContent ?? '',
    /Google · 模型未记录（网页导入）/,
  )
})

test('DetailModal 显示 OpenAI 来源', async (t) => {
  const page = await renderDetailModal({
    ...demoImage,
    sourceType: 'openai',
  })

  t.after(async () => {
    await act(async () => {
      page.view.unmount()
    })
    page.dom.window.close()
  })

  assert.match(page.dom.window.document.body.textContent ?? '', /来源：OpenAI/)
})

test('作品详情可在顶部显示生成历史专用操作', async () => {
  const { view, dom } = await renderDetailModal(demoImage, {
    primaryActions: <button>另开草稿</button>,
  })
  try {
    const action = dom.window.document.querySelector('button[aria-label="关闭"]')?.closest('[role="dialog"]')
      ?? dom.window.document.querySelector('[role="dialog"]')
    assert.ok(action)
    assert.ok([...action.querySelectorAll('button')].some(button => button.textContent === '另开草稿'))
    assert.ok(![...action.querySelectorAll('button')].some(button => button.textContent === '转入生成'))
  } finally {
    view.unmount()
    dom.window.close()
  }
})

test('再次点击作品大图只关闭放大层', async () => {
  const { view, dom, user, closeCountRef } = await renderDetailModal()
  try {
    await user.click(dom.window.document.querySelector('button[aria-label="查看大图"]')!)
    await flushEffects()
    const image = dom.window.document.querySelector('img[alt="作品大图"]')
    assert.ok(image)
    await user.click(image)
    await flushEffects()
    assert.ok(!dom.window.document.querySelector('img[alt="作品大图"]'))
    assert.equal(closeCountRef(), 0)
  } finally {
    view.unmount()
    dom.window.close()
  }
})


test('delete confirmation blocks arrow navigation and is dropped when changing works', async () => {
  const deleted: string[] = []
  const { dom, view, user } = await renderDetailModal(demoImage, {
    nextImage: { ...demoImage, id: 'img-2', prompt: '下一件作品' },
    onDelete: async id => { deleted.push(id) },
  })
  const modal = within(dom.window.document.body)
  try {
    await user.click(modal.getByRole('button', { name: '移入回收站' }))
    await user.keyboard('{ArrowRight}{ArrowLeft}')
    assert.ok(modal.getByText('移入回收站？之后可以恢复。'))
    assert.equal(modal.queryByRole('dialog', { name: '下一件作品' }), null)
    await user.click(modal.getByRole('button', { name: '下一张' }))
    assert.ok(modal.getByRole('dialog', { name: '下一件作品' }))
    assert.equal(modal.queryByRole('button', { name: '删除', exact: true }), null)
    assert.deepEqual(deleted, [])
    await user.click(modal.getByRole('button', { name: '移入回收站' }))
    await user.click(modal.getByRole('button', { name: '删除', exact: true }))
    assert.deepEqual(deleted, ['img-2'])
  } finally { view.unmount() }
})
