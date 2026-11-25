// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Toaster } from 'sonner'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { RequireAuth } from '../../src/auth/RequireAuth'
import { SessionProvider } from '../../src/auth/useSession'
import GalleryPage from '../../src/pages/GalleryPage'
import type { GalleryImage, ResultGroup } from '../../src/types'
let images: GalleryImage[], groups: ResultGroup[]
let recipeResponse: Promise<Response> | undefined
let movedToTrash: boolean
const group = (id: string, name: string, imageIds: string[]): ResultGroup => ({ id, name, imageIds, assetType: 'recipe', coverId: imageIds[0], version: 0, createdAt: '2026-09-12', updatedAt: '2026-09-12' })
beforeEach(() => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
  recipeResponse = undefined
  movedToTrash = true
  images = ['地球互动', '居家日常', '地球配方'].map((title, i) => ({ id: String(i), filename: `${i}.png`, prompt: title, title, referenceImages: [], tags: [], favorited: i === 0, createdAt: '2026-09-12', assetType: i === 2 ? 'work' : 'recipe', width: 1, height: 1 }))
  groups = [group('earth', '地球系列', ['0', '2'])]
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/session') return Response.json({ user: { id: 'collections', email: 'test@local' }, workspace: { id: 'collections', name: 'Test' } })
    if (url === '/api/groups' && init?.method === 'POST') { const body = JSON.parse(String(init.body)); const created = group('new', body.name, body.imageIds); created.assetType = body.assetType; groups.push(created); return Response.json(created, { status: 201 }) }
    if (url === '/api/groups') return Response.json(groups)
    if (url.startsWith('/api/groups/')) {
      const id = url.split('/').at(-1)
      const current = groups.find(g => g.id === id)!
      const body = JSON.parse(String(init?.body))
      if (current.version !== body.expectedVersion) return Response.json({ error: '收藏夹已变化，请刷新后重试' }, { status: 409 })
      if (init?.method === 'DELETE') { groups = groups.filter(g => g.id !== id); return Response.json({ ok: true }) }
      const next = { ...current, ...body, version: current.version + 1 }; groups = groups.map(g => g.id === id ? next : g); return Response.json(next)
    }
    if (url === '/api/images/2/recipe' && recipeResponse) return recipeResponse
    if (url === '/api/images/1' && init?.method === 'DELETE') {
      images = images.filter(image => image.id !== '1')
      return Response.json({ ok: true, version: 7, moved: movedToTrash })
    }
    if (url === '/api/trash/1/restore') {
      const restored = { ...images[0], id: '1', title: '居家日常', filename: '1.png' }
      images.push(restored)
      return Response.json(restored)
    }
    if (url.startsWith('/api/images')) return Response.json(images)
    return Response.json({}, { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function LocationProbe() { return <span data-testid="location">{useLocation().search}</span> }
function mount(url = '/') { return render(<MemoryRouter initialEntries={[url]}><SessionProvider><RequireAuth><GalleryPage /></RequireAuth><Toaster /><LocationProbe /></SessionProvider></MemoryRouter>) }
it('folds collected images in overview, but keeps all images, search and likes accessible', async () => {
  mount(); const user = userEvent.setup()
  const card = await screen.findByRole('button', { name: '打开收藏夹 地球系列' })
  expect(within(card).getByText('1 张配方')).toBeTruthy()
  expect(card.querySelector('img')?.getAttribute('src')).toBe('/api/assets/images/0.png?thumbnail=true')
  expect(screen.queryByRole('button', { name: '打开 地球互动' })).toBeNull()
  expect(screen.getByRole('button', { name: '打开 居家日常' })).toBeTruthy()
  await user.click(screen.getByRole('button', { name: /^全部配方/ }))
  expect(await screen.findByRole('button', { name: '打开 地球互动' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '打开收藏夹 地球系列' })).toBeNull()
  await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: /^喜欢/ }))
  expect(screen.getByRole('button', { name: '打开 地球互动' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '打开 居家日常' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '概览' }))
  await user.click(screen.getByRole('button', { name: /^搜索与显示/ }))
  await user.type(screen.getByRole('searchbox', { name: '搜索图库' }), '地球')
  expect(await screen.findByRole('button', { name: '打开 地球互动' })).toBeTruthy()
})
it('creates an empty collection, adds a single image and deletes only the collection', async () => {
  mount(); const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '新建收藏夹', exact: true }))
  let dialog = screen.getByRole('dialog', { name: '新建收藏夹' })
  await user.type(within(dialog).getByLabelText('收藏夹名称'), '居家系列')
  await user.click(within(dialog).getByRole('button', { name: '创建', exact: true }))
  await waitFor(() => expect(groups.find(g => g.id === 'new')?.imageIds).toEqual([]))
  await user.click(screen.getByRole('button', { name: '概览' }))
  const image = screen.getByRole('button', { name: '打开 居家日常' })
  await user.click(within(image.parentElement!).getByRole('button', { name: '加入收藏夹' }))
  dialog = screen.getByRole('dialog', { name: '加入收藏夹' })
  await user.click(within(dialog).getByRole('button', { name: /^居家系列/ }))
  await waitFor(() => expect(groups.find(g => g.id === 'new')?.imageIds).toEqual(['1']))
  expect(images[1].favorited).toBe(false)
  await user.click(await screen.findByRole('button', { name: '打开收藏夹 居家系列' }))
  expect(screen.getByRole('button', { name: '打开 居家日常' })).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '管理收藏夹' }))
  await user.click(screen.getByRole('button', { name: '删除收藏夹（保留图片）' }))
  await waitFor(() => expect(groups).toHaveLength(1))
  expect(await screen.findByRole('button', { name: '打开 居家日常' })).toBeTruthy()
  expect(images).toHaveLength(3)
})
it('adds selected images to another collection without losing existing membership, then removes them', async () => {
  groups.push(group('home', '居家系列', [])); mount('/?assetType=recipe&group=earth'); const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '多选整理' }))
  await user.click(screen.getByRole('checkbox', { name: '选择 地球互动' }))
  await user.click(screen.getByRole('button', { name: '收藏夹', exact: true }))
  await user.click(screen.getByRole('button', { name: '加入收藏夹', exact: true }))
  await user.click(within(screen.getByRole('dialog', { name: '加入收藏夹' })).getByRole('button', { name: /^居家系列/ }))
  await waitFor(() => expect(groups.find(g => g.id === 'home')?.imageIds).toEqual(['0']))
  expect(groups[0].imageIds).toEqual(['0', '2'])
  await user.click(screen.getByRole('button', { name: /^居家系列/ }))
  await user.click(screen.getByRole('button', { name: '多选整理' }))
  await user.click(screen.getByRole('checkbox', { name: '选择 地球互动' }))
  await user.click(screen.getByRole('button', { name: '收藏夹', exact: true }))
  await user.click(screen.getByRole('button', { name: '移出当前收藏夹' }))
  await waitFor(() => expect(groups.find(g => g.id === 'home')?.imageIds).toEqual([]))
  expect(groups[0].imageIds).toEqual(['0', '2'])
})
it('separates folders on type switch and keeps empty folders only on their own side', async () => {
  groups.push({...group('works','作品夹',[]),assetType:'work'})
  mount('/?assetType=recipe&group=earth'); const user=userEvent.setup()
  await screen.findByRole('heading',{name:/地球系列/})
  expect(screen.queryByRole('button',{name:/^作品夹/})).toBeNull()
  await user.click(within(screen.getByRole('navigation')).getByRole('button',{name:/^作品/}))
  expect(await screen.findByRole('button',{name:'打开收藏夹 作品夹'})).toBeTruthy()
  expect(screen.getByTestId('location').textContent).not.toContain('group=earth')
  expect(screen.queryByRole('button',{name:/^地球系列/})).toBeNull()
  await user.click(screen.getByRole('button',{name:'新建收藏夹',exact:true}))
  const dialog=screen.getByRole('dialog',{name:'新建收藏夹'})
  await user.type(within(dialog).getByLabelText('收藏夹名称'),'新作品夹')
  await user.click(within(dialog).getByRole('button',{name:'创建',exact:true}))
  await waitFor(()=>expect(groups.find(g=>g.id==='new')?.assetType).toBe('work'))
})
it('does not expose management or members of a different type folder via a direct URL',async()=>{
  mount('/?assetType=work&group=earth')
  await waitFor(()=>expect(screen.queryByText('正在读取收藏夹…')).toBeNull())
  expect(screen.queryByRole('button',{name:'管理收藏夹'})).toBeNull()
  expect(screen.queryByRole('button',{name:'打开 地球配方'})).toBeNull()
  expect(await screen.findByRole('button',{name:'返回概览'})).toBeTruthy()
})
it('renames a collection and changes its cover while preserving the old best result', async () => {
  groups[0].imageIds.push('1'); groups[0].bestId = '0'
  mount('/?assetType=recipe&group=earth'); const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '管理收藏夹' }))
  const dialog = screen.getByRole('dialog', { name: '管理收藏夹' })
  await user.clear(within(dialog).getByLabelText('收藏夹名称'))
  await user.type(within(dialog).getByLabelText('收藏夹名称'), '人物与地球')
  await user.selectOptions(within(dialog).getByLabelText('收藏夹封面'), '1')
  await user.click(within(dialog).getByRole('button', { name: '保存修改' }))
  await waitFor(() => expect(groups[0]).toMatchObject({ name: '人物与地球', coverId: '1', bestId: '0' }))
  await user.click(screen.getByRole('button', { name: '概览' }))
  const card = await screen.findByRole('button', { name: '打开收藏夹 人物与地球' })
  expect(card.querySelector('img')?.getAttribute('src')).toContain('/1.png?thumbnail=true')
})
it('adds from details without losing a title draft or navigating the underlying detail', async () => {
  mount('/?view=all'); const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '打开 居家日常' }))
  await user.click(screen.getByRole('button', { name: /更多信息/ }))
  await user.type(screen.getByLabelText('标题'), ' 草稿')
  await user.click(screen.getByRole('button', { name: '加入收藏夹', exact: true }))
  const dialog = screen.getByRole('dialog', { name: '加入收藏夹' })
  await user.click(within(dialog).getByRole('button', { name: /^地球系列/ }))
  await waitFor(() => expect(groups[0].imageIds).toContain('1'))
  expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('居家日常 草稿')
  await user.click(screen.getByRole('button', { name: '加入收藏夹', exact: true }))
  within(screen.getByRole('dialog', { name: '加入收藏夹' })).getByRole('button', { name: '取消' }).focus()
  await user.keyboard('{ArrowLeft}')
  await user.click(within(screen.getByRole('dialog', { name: '加入收藏夹' })).getByRole('button', { name: '取消' }))
  expect(screen.queryByText('修改尚未保存')).toBeNull()
  expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('居家日常 草稿')
})
it('shows external imports on focus while preserving the open detail draft', async () => {
  mount('/?view=all'); const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '打开 居家日常' }))
  await user.click(screen.getByRole('button', { name: /更多信息/ }))
  await user.type(screen.getByLabelText('标题'), ' 草稿')
  images = [{ ...images[1], id: 'imported', filename: 'imported.png', title: '扩展新配方' }, ...images]
  window.dispatchEvent(new Event('focus'))
  // The gallery behind the modal updates without replacing or closing the editor.
  expect(await screen.findByRole('button', { name: '打开 扩展新配方', hidden: true })).toBeTruthy()
  expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('居家日常 草稿')
  expect(screen.queryByText('加载更新')).toBeNull()
  expect(screen.getByTestId('location').textContent).toContain('view=all')
})
it('recovers a membership conflict without overwriting someone else’s additions', async () => {
  mount('/?view=all'); const user = userEvent.setup()
  const card = await screen.findByRole('button', { name: '打开 居家日常' })
  await user.click(within(card.parentElement!).getByRole('button', { name: '加入收藏夹' }))
  groups[0] = { ...groups[0], version: 1, imageIds: ['0', '2', 'concurrent'] }
  const dialog = screen.getByRole('dialog', { name: '加入收藏夹' })
  await user.click(within(dialog).getByRole('button', { name: /^地球系列/ }))
  expect(await within(dialog).findByRole('alert')).toBeTruthy()
  expect(groups[0].imageIds).not.toContain('1')
  await user.click(within(dialog).getByRole('button', { name: /^地球系列/ }))
  await waitFor(() => expect(groups[0].imageIds).toEqual(['0', '2', 'concurrent', '1']))
})

it('lists concrete collections on the generation page and returns to the saved collection query', async () => {
  const { Sidebar } = await import('../../src/components/Sidebar')
  const { GalleryProvider } = await import('../../src/hooks/GalleryProvider')
  groups.push({...group('works','作品专用',[]),assetType:'work'})
  const saved = 'view=all&group=earth&q=%E5%9C%B0%E7%90%83&assetType=recipe'
  window.localStorage.setItem('banana-gallery-view:["collections","collections"]:query', JSON.stringify(saved))
  render(<MemoryRouter initialEntries={['/generate']}><SessionProvider><RequireAuth><GalleryProvider><Sidebar currentPage="generate" assetType="recipe" filter="all" onAssetTypeChange={()=>{}} onFilterChange={()=>{}} tags={[]} workCount={0} recipeCount={0} favoriteCount={0}/><LocationProbe/></GalleryProvider></RequireAuth></SessionProvider></MemoryRouter>)
  expect(await screen.findByRole('button', { name: /地球系列/ })).toBeTruthy()
  expect(screen.queryByRole('button',{name:/作品专用/})).toBeNull()
  await userEvent.setup().click(screen.getByRole('button', { name: /^配方\s*0$/ }))
  await waitFor(()=>expect(screen.getByTestId('location').textContent).toContain('group=earth'))
  expect(screen.getByTestId('location').textContent).toContain('q=')
  await userEvent.setup().click(screen.getByRole('button',{name:/^作品\s*0$/}))
  await waitFor(()=>expect(screen.getByTestId('location').textContent).toContain('assetType=work'))
  expect(screen.getByTestId('location').textContent).not.toContain('group=earth')
  expect(screen.getByTestId('location').textContent).toContain('view=overview')
})

it('shows reclassified images in the other overview without discarding their old membership',async()=>{
  mount('/?assetType=work&view=overview')
  expect(await screen.findByRole('button',{name:'打开 地球配方'})).toBeTruthy()
  expect(groups[0].imageIds).toContain('2')
})
it('only offers matching folders when adding a work, including same-name independent folders',async()=>{
  groups.push({...group('works','作品夹',[]),assetType:'work'})
  mount('/?assetType=work&view=all');const user=userEvent.setup()
  const card=await screen.findByRole('button',{name:'打开 地球配方'})
  await user.click(within(card.parentElement!).getByRole('button',{name:'加入收藏夹'}))
  const dialog=screen.getByRole('dialog',{name:'加入收藏夹'})
  expect(within(dialog).queryByRole('button',{name:/地球系列/})).toBeNull()
  await user.click(within(dialog).getByRole('button',{name:/作品夹/}))
  await waitFor(()=>expect(groups.find(g=>g.id==='works')?.imageIds).toEqual(['2']))
  expect(groups[0].imageIds).toEqual(['0','2'])
})

it('recycles the card immediately without opening a detail or confirmation, and can undo', async () => {
  mount()
  const user = userEvent.setup()
  const card = await screen.findByRole('button', { name: '打开 居家日常' })
  const actions = within(card.parentElement!)
  expect(actions.queryByRole('button', { name: '提炼成配方' })).toBeNull()
  await user.click(actions.getByRole('button', { name: '移入回收站' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '打开 居家日常' })).toBeNull())
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(await screen.findByText('已移入回收站')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '撤销' }))
  expect(await screen.findByRole('button', { name: '打开 居家日常' })).toBeTruthy()
  const undo = vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/trash/1/restore')
  expect(JSON.parse(String(undo?.[1]?.body))).toEqual({ expectedVersion: 7 })
})

it('does not offer undo for a card already moved to trash elsewhere', async () => {
  movedToTrash = false
  mount()
  const card = await screen.findByRole('button', { name: '打开 居家日常' })
  await userEvent.setup().click(within(card.parentElement!).getByRole('button', { name: '移入回收站' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '打开 居家日常' })).toBeNull())
  expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
})

it('extracts a recipe only once while pending and opens the new stored recipe from the toast', async () => {
  const { promise, resolve } = Promise.withResolvers<Response>()
  recipeResponse = promise
  mount('/?assetType=work&view=all')
  const card = await screen.findByRole('button', { name: '打开 地球配方' })
  const extract = within(card.parentElement!).getByRole<HTMLButtonElement>('button', { name: '提炼成配方' })
  await userEvent.setup().dblClick(extract)
  expect(extract.disabled).toBe(true)
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/images/2/recipe')).toHaveLength(1)
  resolve(Response.json({ ...images[2], id: 'recipe-from-work', title: '新配方', assetType: 'recipe', sourceAssetId: '2' }))
  fireEvent.click(await screen.findByRole('button', { name: '查看配方' }))
  expect(await screen.findByRole('dialog', { name: '新配方' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '打开 新配方', hidden: true })).toBeTruthy()
})
