import fs from 'node:fs'
import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'
const { JSDOM } = createRequire(import.meta.url)('jsdom')

it('扩展重复提示允许跳过；明确继续和网络重试保留同一份采集快照', async () => {
  const dom = new JSDOM('<body><img id="result" src="data:image/png;base64,AAAA"></body>', { url: 'https://gemini.google.com/app/fixture', runScripts: 'outside-only' })
  const win = dom.window
  let clears = 0
  const calls: Array<{ metadata: Record<string, unknown> }> = []
  const duplicate = { ok: true, result: { entry: { requiresConfirmation: true, candidates: [{ title: '<b>原图</b>', evidence: ['图片内容相同'] }] } } }
  const responses = [duplicate, duplicate, { ok: false, error: '网络失败' }, { ok: true, result: { entry: { id: 'saved' }, galleryUrl: 'http://localhost:3333' } }]
  Object.assign(win, {
    structuredClone,
    BananaGeminiExtractor: { selectCurrentResultImage: () => win.document.querySelector('#result'), findPromptForImage: () => '猫咪插画', findVisibleReferenceImages: () => [], classifyCapture: () => ({ complete: true, reason: '可保存' }) },
    BananaGeminiCaptureUtils: { selectCachedReferences: () => [] },
    chrome: { runtime: { sendMessage: (message: { payload: typeof calls[number] }, callback: (response: unknown) => void) => { calls.push(structuredClone(message.payload)); callback(responses.shift()) } } },
    indexedDB: { open: () => {
      const request: { result: unknown; onsuccess?: () => void } = { result: { transaction: () => {
        const tx: { oncomplete?: () => void; objectStore: () => unknown } = { objectStore: () => ({
          getAll: () => { const read: { result: unknown[]; onsuccess?: () => void } = { result: [] }; queueMicrotask(() => read.onsuccess?.()); return read },
          clear: () => { clears++; queueMicrotask(() => tx.oncomplete?.()) },
        }) }; return tx
      } } }; queueMicrotask(() => request.onsuccess?.()); return request
    } },
  })
  win.performance.getEntriesByType = () => []
  try {
    win.eval(fs.readFileSync('extension/gemini-to-banana/content.js', 'utf8'))
    const button = (suffix: string) => win.document.querySelector(`.banana-save-panel__${suffix}`)
    win.document.querySelector('.banana-save-gemini-button').click()
    await vi.waitFor(() => expect(button('save')).toBeTruthy())
    button('save').click()
    await vi.waitFor(() => expect(button('skip').hidden).toBe(false))
    expect(button('status').textContent).toContain('<b>原图</b>')
    expect(button('status').querySelector('b')).toBeNull()
    button('skip').click()
    expect(win.document.querySelector('.banana-save-panel')).toBeNull()
    expect(clears).toBe(0)
    win.document.querySelector('.banana-save-gemini-button').click()
    await vi.waitFor(() => expect(button('save')).toBeTruthy())
    button('save').click()
    await vi.waitFor(() => expect(button('save').textContent).toBe('仍然保存为新条目'))
    expect(button('prompt').readOnly).toBe(true)
    button('save').click()
    await vi.waitFor(() => expect(button('status').textContent).toContain('相同标识重试'))
    button('save').click()
    await vi.waitFor(() => expect(clears).toBe(1))
    expect(calls).toHaveLength(4)
    expect(calls[0].metadata.requestId).not.toBe(calls[1].metadata.requestId)
    expect(calls[2]).toEqual(calls[3])
    expect(calls[2].metadata).toEqual({ ...calls[1].metadata, allowDuplicate: true })
    expect(button('status').querySelector('a').textContent).toBe('打开 Banana Gallery')
  } finally { win.close() }
})
