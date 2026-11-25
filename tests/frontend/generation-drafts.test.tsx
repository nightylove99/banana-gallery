// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IDBObjectStore } from 'fake-indexeddb'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom'
import { SessionProvider } from '../../src/auth/useSession'
import GeneratePage from '../../src/pages/GeneratePage'
import { loadGenerationDraft, readDraftCatalog } from '../../src/lib/generation-drafts'
beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear() })
})
afterEach(() => { cleanup(); window.localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function mockSession() {
  let workspace = 'first'
  vi.stubGlobal('fetch', async (url: string) => {
    if (url === '/api/generation-tasks?limit=60') return Response.json({tasks:[],error:null})
    if (url === '/api/session') return Response.json({ user: { id: 'owner', email: 'owner@test' }, workspace: { id: workspace, name: workspace } })
    if (url.startsWith('/api/images')) return Response.json([])
    return Response.json({}, { status: 404 })
  })
  return (next: string) => { workspace = next }
}
function mount(state?: unknown) {
  return render(<MemoryRouter initialEntries={[{ pathname: '/generate', state }]}><SessionProvider><GeneratePage /></SessionProvider></MemoryRouter>)
}
it('restores a text draft after remount and isolates another workspace', async () => {
  const switchWorkspace = mockSession()
  const first = mount()
  const user = userEvent.setup()
  await waitFor(() => expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).readOnly).toBe(false))
  await user.type(screen.getByLabelText('提示词'), '下次继续的提示词')
  await waitFor(() => expect(screen.getByText('草稿已保存到此浏览器')).toBeTruthy())
  first.unmount()
  const second = mount()
  await waitFor(() => expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('下次继续的提示词'))
  second.unmount(); switchWorkspace('second')
  mount()
  await waitFor(() => expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe(''))
})
it('incoming recipe cannot silently replace a draft; opening another preserves the old one', async () => {
  mockSession()
  const first = mount()
  const user = userEvent.setup()
  await waitFor(() => expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).readOnly).toBe(false))
  await user.type(screen.getByLabelText('提示词'), '保留原草稿')
  await waitFor(() => expect(screen.getByText('草稿已保存到此浏览器')).toBeTruthy())
  first.unmount()
  mount({ prompt: '新配方', referenceImages: ['source.png'], aspectRatio: '1:1' })
  await screen.findByRole('button', { name: '另开草稿' })
  expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('保留原草稿')
  await user.click(screen.getByRole('button', { name: '另开草稿' }))
  await waitFor(() => expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('新配方'))
  await screen.findByText('草稿已保存到此浏览器')
  const scope = JSON.stringify(['owner', 'first'])
  const catalog = await readDraftCatalog(scope)
  const old = catalog.drafts.find(draft => draft.prompt === '保留原草稿')!
  expect(old).toBeTruthy()
  expect(old.id).not.toBe(catalog.activeId)
  expect((await loadGenerationDraft(scope, old.id))?.prompt).toBe('保留原草稿')
})

it('storage failure stays visible and keeps unsaved text across an in-app remount for retry', async () => {
  mockSession()('quota-test')
  const first = mount()
  const user = userEvent.setup()
  await waitFor(() => expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).readOnly).toBe(false))
  await user.type(screen.getByLabelText('提示词'), '原草稿')
  await screen.findByText('草稿已保存到此浏览器')
  const write = IDBObjectStore.prototype.put
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new Error('存储空间不足') })
  await user.type(screen.getByLabelText('提示词'), '但这些尚未保存')
  await waitFor(() => expect(screen.getByText('存储空间不足', {exact:false}).textContent).toContain('存储空间不足'))
  first.unmount()
  mount()
  await waitFor(() => expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('原草稿但这些尚未保存'))
  const retry = await screen.findByRole('button', { name: '重试保存' })
  spy.mockImplementation(write)
  await user.click(retry)
  await screen.findByText('草稿已保存到此浏览器')
  spy.mockRestore()
})

it('metadata persistence never stores object URLs and missing Blob data remains visible', async () => {
  mockSession()('missing-file')
  const { saveGenerationDraft } = await import('../../src/lib/generation-drafts')
  const scope = JSON.stringify(['owner', 'missing-file'])
  await saveGenerationDraft(scope, { id: 'missing', updatedAt: '2026-09-11', prompt: '文件丢失测试', selectedModelKey: 'seedream:doubao-seedream-5-0-pro-260628', aspectRatio: '1:1', imageSize: '2K', quality: 'high', refs: [{ id: 'ref', fileInfo: { key: `${scope}:missing:ref`, name: 'test.png', type: 'image/png', lastModified: 0 }, ...{ previewUrl: 'blob:must-not-persist' } }] })
  expect(window.localStorage.getItem(`banana-generation-drafts:v1:${scope}`)).toBeNull()
  expect(JSON.stringify(await readDraftCatalog(scope))).not.toContain('blob:must-not-persist')
  mount()
  expect(await screen.findByText('参考图文件未恢复，请重新添加')).toBeTruthy()
})

it('a removed draft model cannot silently turn into another model on generation', async () => {
  mockSession()('retired-model')
  const { saveGenerationDraft } = await import('../../src/lib/generation-drafts')
  await saveGenerationDraft(JSON.stringify(['owner', 'retired-model']), { id: 'retired', updatedAt: '2026-09-11', prompt: '不要自动换供应商', selectedModelKey: 'seedream:retired-model', aspectRatio: '1:1', imageSize: '2K', quality: 'high', refs: [] })
  mount()
  await waitFor(() => expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('不要自动换供应商'))
  expect((screen.getByRole('button', { name: '提交生成', exact: true }) as HTMLButtonElement).disabled).toBe(true)
})

it('restores an existing Flash 1.5K draft as 5.5 at 1K with its reference', async () => {
  mockSession()('flash-migration')
  const { saveGenerationDraft } = await import('../../src/lib/generation-drafts')
  await saveGenerationDraft(JSON.stringify(['owner', 'flash-migration']), { id: 'flash', updatedAt: '2026-10-06', prompt: '旧 Flash 草稿', selectedModelKey: 'seedream:doubao-seedream-5-0-flash-260915', aspectRatio: '16:9', imageSize: '1.5K', quality: 'high', refs: [{ id: 'ref', serverFilename: 'old.png' }] })
  const view = mount()
  await waitFor(() => expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('旧 Flash 草稿'))
  await waitFor(() => {
    const selects = view.container.querySelectorAll('select:not([aria-label="切换草稿"])')
    expect((selects[0] as HTMLSelectElement).value).toBe('seedream:doubao-seedream-5-5-261028')
    expect((selects[2] as HTMLSelectElement).value).toBe('1K')
    expect((selects[1] as HTMLSelectElement).value).toBe('16:9')
    expect(view.container.querySelector('img[src*="old.png"]')).not.toBeNull()
  })
})

it.each([
  [{ selectedModelKey: 'poe:nano-banana-2' }, '3:2', '3:2'],
  [{ selectedModelKey: 'poe:gpt-image-2.6-sunburst' }, 'auto', '1:1'],
  [{ provider: 'poe', model: 'gpt-image-2' }, 'auto', '1:1'],
])('restores a legacy Poe draft (%j) on Google with a supported ratio', async (modelFields, aspectRatio, expectedRatio) => {
  mockSession()('poe-migration')
  const scope = JSON.stringify(['owner', 'poe-migration'])
  window.localStorage.setItem(`banana-generation-drafts:v1:${scope}`, JSON.stringify({
    version: 1,
    activeId: 'old-draft',
    drafts: [{
      id: 'old-draft', updatedAt: '2026-10-06', prompt: '旧 Poe 草稿',
      ...modelFields, aspectRatio, imageSize: '4K', quality: 'medium',
      refs: [{ id: 'ref', serverFilename: 'old.png' }],
    }],
  }))
  const view = mount()
  await waitFor(() => {
    expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('旧 Poe 草稿')
    expect((screen.getByLabelText('模型') as HTMLSelectElement).value).toBe('google:gemini-nano-banana-2.1')
    expect((screen.getByLabelText('宽高比') as HTMLSelectElement).value).toBe(expectedRatio)
    expect((screen.getByLabelText('分辨率') as HTMLSelectElement).value).toBe('4K')
    expect(view.container.querySelector('img[src*="old.png"]')).not.toBeNull()
  })
  expect(window.localStorage.getItem(`banana-generation-drafts:v1:${scope}`)).toBeNull()
})

it('lets users reopen the previous draft after creating a new one', async () => {
  mockSession()('draft-picker')
  mount()
  const user=userEvent.setup()
  await waitFor(()=>expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).readOnly).toBe(false))
  await user.type(screen.getByLabelText('提示词'),'需要找回的草稿')
  await screen.findByText('草稿已保存到此浏览器')
  await user.click(screen.getByRole('button',{name:'新建草稿'}))
  await waitFor(()=>expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe(''))
  const picker=await screen.findByRole('combobox',{name:'切换草稿'})
  const old=(await readDraftCatalog(JSON.stringify(['owner','draft-picker']))).drafts.find(d=>d.prompt==='需要找回的草稿')!
  await user.selectOptions(picker,old.id)
  await waitFor(()=>expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('需要找回的草稿'))
})


it('retains both edits when two saves start from the same legacy revision', async () => {
  const { saveGenerationDraft } = await import('../../src/lib/generation-drafts')
  const scope = 'concurrent-legacy'
  const original = { id: 'shared', updatedAt: '2026-09-11', prompt: 'original', selectedModelKey: 'google:test', aspectRatio: '1:1', imageSize: '2K', quality: 'high' as const, refs: [] }
  window.localStorage.setItem(`banana-generation-drafts:v1:${scope}`, JSON.stringify({ version: 1, activeId: original.id, drafts: [original] }))
  const tabA = (await loadGenerationDraft(scope, original.id))!
  const tabB = (await loadGenerationDraft(scope, original.id))!
  await Promise.all([
    saveGenerationDraft(scope, { ...tabA, prompt: 'tab A' }),
    saveGenerationDraft(scope, { ...tabB, prompt: 'tab B' }),
  ])
  const { drafts } = await readDraftCatalog(scope)
  expect(drafts.find(item => item.id === original.id)).toMatchObject({ prompt: 'tab A', revision: 1 })
  expect(drafts.find(item => item.id !== original.id)).toMatchObject({ prompt: 'tab B', revision: 1 })
})


it('continues editing the conflict copy instead of forking on every keystroke', async () => {
  mockSession()('two-editors')
  const scope = JSON.stringify(['owner', 'two-editors'])
  const { saveGenerationDraft } = await import('../../src/lib/generation-drafts')
  await saveGenerationDraft(scope, {
    id: 'shared', updatedAt: '2026-09-11', prompt: 'original', selectedModelKey: 'google:gemini-nano-banana-2.1',
    aspectRatio: '1:1', imageSize: '2K', quality: 'high', refs: [],
  })
  const tabA = within(mount().container)
  const tabB = within(mount().container)
  const promptA = tabA.getByPlaceholderText('描述你想生成的图片…') as HTMLTextAreaElement
  const promptB = tabB.getByPlaceholderText('描述你想生成的图片…') as HTMLTextAreaElement
  await waitFor(() => expect([promptA.value, promptB.value]).toEqual(['original', 'original']))
  const user = userEvent.setup()
  await user.type(promptA, ' A')
  await waitFor(async () => expect((await readDraftCatalog(scope)).drafts[0].prompt).toBe('original A'))
  await user.type(promptB, ' B continues')
  await tabB.findByText('原草稿已在其他标签页更新，本页修改已另存为新草稿。')
  await waitFor(async () => expect((await readDraftCatalog(scope)).drafts.map(item => item.prompt)).toEqual(['original B continues', 'original A']))
})

it('opens a fresh asset draft without changing the shared active draft and restores it from tab history', async () => {
  const { saveGenerationDraft } = await import('../../src/lib/generation-drafts')
  const scope = JSON.stringify(['owner', 'first'])
  await saveGenerationDraft(scope, { id: 'other-tab', updatedAt: '2026-11-24', prompt: '另一页草稿',
    refs: [], selectedModelKey: 'google:gemini-nano-banana-2.1', aspectRatio: '1:1', imageSize: '2K', quality: 'high' })
  mockSession()
  const fetchSession = globalThis.fetch
  const fetchAsset = vi.fn(async () => Response.json({ id: 'work / one', filename: 'one.png', prompt: '作品的新提示词', width: 1696,
    height: 2528, referenceImages: ['b.png', 'a.png'], referenceNotes: ['先', '后'],
    generation: { aspectRatio: '2:3', imageSize: '2K', provider: 'google', model: 'gemini-nano-banana-2.1', quality: 'high' } }))
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    url === '/api/images/work%20%2F%20one' ? fetchAsset() : fetchSession(url, init))
  function renderTab(initial: { pathname: string; search?: string; state?: unknown }) {
    const router = createMemoryRouter([{ path: '/generate', element: <SessionProvider><GeneratePage /></SessionProvider> }], { initialEntries: [initial] })
    return { router, ...render(<RouterProvider router={router} />) }
  }
  const tab = renderTab({ pathname: '/generate', search: '?fromAsset=work%20%2F%20one' })
  await waitFor(() => expect(tab.router.state.location.search).toBe(''))
  expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('作品的新提示词')
  expect(screen.queryByRole('button', { name: '替换当前草稿' })).toBeNull()
  const catalog = await readDraftCatalog(scope)
  expect(catalog.activeId).toBe('other-tab')
  expect(catalog.drafts.find(draft => draft.sourceAssetId === 'work / one')).toMatchObject({
    prompt: '作品的新提示词', aspectRatio: '2:3', imageSize: '2K', quality: 'high', selectedModelKey: 'google:gemini-nano-banana-2.1',
    refs: [{ serverFilename: 'b.png', note: '先' }, { serverFilename: 'a.png', note: '后' }],
  })
  tab.unmount()
  renderTab(tab.router.state.location)
  await waitFor(() => expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('作品的新提示词'))
  expect(fetchAsset).toHaveBeenCalledOnce()
  expect((await readDraftCatalog(scope)).drafts).toHaveLength(2)
})

it.each([404, 410, 'deleted'])('does not persist an empty source draft when the asset is unavailable (%s)', async status => {
  mockSession()
  const baseFetch = globalThis.fetch
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    url === '/api/images/gone' ? Promise.resolve(status === 'deleted'
      ? Response.json({ id: 'gone', deletedAt: '2026-11-24' })
      : Response.json({}, { status })) : baseFetch(url, init))
  render(<MemoryRouter initialEntries={['/generate?fromAsset=gone']}><SessionProvider><GeneratePage /></SessionProvider></MemoryRouter>)
  expect(await screen.findByText(/来源条目不存在或已移入回收站/)).toBeTruthy()
  expect((await readDraftCatalog(JSON.stringify(['owner', 'first']))).drafts).toHaveLength(0)
  await userEvent.setup().type(screen.getByLabelText('提示词'), '手动起草')
  await waitFor(async () => expect((await readDraftCatalog(JSON.stringify(['owner', 'first']))).drafts).toMatchObject([{ prompt: '手动起草' }]))
})

it('keeps fromAsset available for retry after a network failure', async () => {
  mockSession()
  const baseFetch = globalThis.fetch
  const fetchAsset = vi.fn()
    .mockRejectedValueOnce(new TypeError('Network failure'))
    .mockResolvedValueOnce(Response.json({ id: 'retry', prompt: '重试后读取', referenceImages: [], width: 10, height: 10 }))
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    url === '/api/images/retry' ? fetchAsset() : baseFetch(url, init))
  render(<MemoryRouter initialEntries={['/generate?fromAsset=retry']}><SessionProvider><GeneratePage /></SessionProvider></MemoryRouter>)
  const retry = await screen.findByRole('button', { name: '重试读取来源' })
  expect((await readDraftCatalog(JSON.stringify(['owner', 'first']))).drafts).toHaveLength(0)
  await userEvent.setup().click(retry)
  await waitFor(() => expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('重试后读取'))
  expect(fetchAsset).toHaveBeenCalledTimes(2)
})

it('keeps the selected draft on refresh and clears the last deleted draft', async () => {
  mockSession()('selected-draft')
  const scope = JSON.stringify(['owner', 'selected-draft'])
  const { saveGenerationDraft } = await import('../../src/lib/generation-drafts')
  const base = { updatedAt: '2026-11-24', refs: [], selectedModelKey: 'google:gemini-nano-banana-2.1', aspectRatio: '1:1', imageSize: '2K', quality: 'high' as const }
  await saveGenerationDraft(scope, { ...base, id: 'a', prompt: '草稿甲' })
  await saveGenerationDraft(scope, { ...base, id: 'b', prompt: '草稿乙' })
  const first = mount()
  const user = userEvent.setup()
  await screen.findByRole('option', { name: /草稿甲/ })
  await user.selectOptions(screen.getByLabelText('切换草稿'), 'a')
  await waitFor(() => expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('草稿甲'))
  first.unmount()
  mount()
  await waitFor(() => expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('草稿甲'))
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  await user.click(screen.getByRole('button', { name: '删除当前草稿' }))
  await waitFor(() => expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe('草稿乙'))
  await user.click(screen.getByRole('button', { name: '删除当前草稿' }))
  await waitFor(() => expect((screen.getByLabelText('提示词') as HTMLTextAreaElement).value).toBe(''))
  expect((await readDraftCatalog(scope)).drafts).toEqual([])
})

it('migrates legacy metadata, keeps referenced Blobs, then reclaims them on deletion', async () => {
  const { Blob: NativeBlob } = await import('node:buffer')
  const { deleteGenerationDraft } = await import('../../src/lib/generation-drafts')
  const scope = 'blob-migration'
  const kept = `${scope}:draft:ref`
  const orphan = `${scope}:old:ref`
  await new Promise<void>((resolve, reject) => {
    const request = window.indexedDB.open('banana-generation-draft-files', 1)
    request.onupgradeneeded = () => {
      const files = request.result.createObjectStore('files')
      files.put(new NativeBlob(['keep']), kept)
      files.put(new NativeBlob(['old']), orphan)
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => { request.result.close(); resolve() }
  })
  const legacyKey = `banana-generation-drafts:v1:${scope}`
  window.localStorage.setItem(legacyKey, JSON.stringify({ version: 1, activeId: 'draft', drafts: [{
    id: 'draft', updatedAt: '2026-11-24', prompt: '旧草稿',
    refs: [{ id: 'ref', serverFilename: 'uploaded.png', fileInfo: { key: kept, name: 'ref.png', type: 'image/png', lastModified: 0 } }],
  }] }))
  const keys = () => new Promise<IDBValidKey[]>((resolve, reject) => {
    const request = window.indexedDB.open('banana-generation-draft-files', 2)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction('files')
      const read = transaction.objectStore('files').getAllKeys()
      transaction.oncomplete = () => { db.close(); resolve(read.result) }
      transaction.onabort = () => { db.close(); reject(transaction.error) }
    }
  })

  expect((await loadGenerationDraft(scope, 'draft'))?.refs[0]).toMatchObject({ serverFilename: 'uploaded.png', fileMissing: false })
  expect(window.localStorage.getItem(legacyKey)).toBeNull()
  expect(await keys()).toEqual([kept])
  await deleteGenerationDraft(scope, 'draft', 0)
  expect(await keys()).toEqual([])
})
