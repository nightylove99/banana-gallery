// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { RequireAuth } from '../../src/auth/RequireAuth'
import { SessionProvider } from '../../src/auth/useSession'
import GalleryPage from '../../src/pages/GalleryPage'
import type { GalleryImage, PersonalPreferences } from '../../src/types'
let images: GalleryImage[]
let serverAppearance: PersonalPreferences['gallery']
let storedValues: Map<string, string>
beforeEach(() => {
  storedValues = new Map()
  serverAppearance = undefined
  vi.stubGlobal('localStorage', { getItem: (key: string) => storedValues.get(key) ?? null, setItem: (key: string, value: string) => storedValues.set(key, value) })
  images = ['海边', '山间'].map((title, i) => ({ id: String(i), filename: `${i}.png`, prompt: `ENGLISH 提示词 ${title}`, title, notes: i ? '' : '柔和', referenceImages: [], tags: ['风景'], favorited: false, createdAt: '2026-09-11', assetType: 'recipe', width: 1, height: 1 }))
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/session') return Response.json({ user: { id: 'search-user', email: 'test@local' }, workspace: { id: 'search', name: 'Search' } })
    if (url === '/api/preferences') {
      if (init?.method === 'PATCH') {
        serverAppearance = { density: 'standard', fit: 'cover', ...serverAppearance, ...JSON.parse(String(init.body)).gallery }
      }
      return Response.json({ version: 1, favoriteModels: [], gallery: serverAppearance })
    }
    if (init?.method === 'PATCH') { const id = url.split('/').at(-1); const body = JSON.parse(String(init.body)); images = images.map(image => image.id === id ? { ...image, ...body, version: (image.version || 0) + 1 } : image); return Response.json(images.find(image => image.id === id)) }
    if (url.startsWith('/api/images')) return Response.json(images)
    return Response.json({}, { status: 404 })
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function LocationProbe() { const location = useLocation(); return <span data-testid="location">{location.search}</span> }
function mount() { return render(<MemoryRouter><SessionProvider><RequireAuth><GalleryPage /></RequireAuth><LocationProbe /></SessionProvider></MemoryRouter>) }
it('searches notes and complete prompts, and lets recipes be favorited', async () => {
  mount(); const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /^搜索与显示/ }))
  await user.type(screen.getByRole('searchbox', { name: '搜索图库' }), 'english 柔和')
  expect(await screen.findByRole('button', { name: '打开 海边' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '打开 山间' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '打开 海边' }))
  await user.click(screen.getByRole('button', { name: '喜欢', exact: true }))
  await waitFor(() => expect(images[0].favorited).toBe(true))
})

it('shows OpenAI as a named source filter', async () => {
  images[0] = { ...images[0], sourceType: 'openai' }
  mount(); const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /^搜索与显示/ }))
  await user.click(screen.getByRole('button', { name: '来源' }))
  await user.click(screen.getByRole('radio', { name: 'OpenAI' }))
  expect(screen.getByRole('button', { name: '取消筛选：OpenAI' })).toBeTruthy()
})
it('saves common title and notes, and protects those edits when closing details', async () => {
  mount(); const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '打开 海边' }))
  await user.click(screen.getByRole('button', { name: /更多信息/ }))
  await user.clear(screen.getByLabelText('标题')); await user.type(screen.getByLabelText('标题'), '夕阳配方')
  await user.type(screen.getByLabelText('备注'), ' 肤色很好')
  await user.click(screen.getByRole('button', { name: '关闭详情' }))
  expect(await screen.findByText('修改尚未保存')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '继续编辑' }))
  await user.click(screen.getByRole('button', { name: '保存标题与备注' }))
  await waitFor(() => expect(images[0]).toMatchObject({ title: '夕阳配方', notes: '柔和 肤色很好' }))
})

it('browses the filtered order and protects edits before moving to the next item', async () => {
  mount(); const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '打开 海边' }))
  await user.click(screen.getByRole('button', { name: /更多信息/ }))
  await user.type(screen.getByLabelText('备注'), ' 尚未保存')
  await user.click(screen.getByRole('button', { name: '下一张' }))
  expect(await screen.findByText('修改尚未保存')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '放弃修改' }))
  const more = screen.getByRole('button', { name: /更多信息/ })
  expect(more.getAttribute('aria-expanded')).toBe('false')
  await user.click(more)
  await waitFor(() => expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('山间'))
  await user.click(screen.getByLabelText('标题')); await user.keyboard('{ArrowLeft}')
  expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('山间')
})

it('keeps search and sort in the URL and restores the last gallery view on return', async () => {
  const first = mount(); const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /^搜索与显示/ }))
  await user.type(screen.getByRole('searchbox', { name: '搜索图库' }), 'english 柔和')
  await chooseOldest(user)
  await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('sort=oldest'))
  expect(screen.getByTestId('location').textContent).toContain('q=english')
  first.unmount(); mount()
  await user.click(await screen.findByRole('button', { name: /^搜索与显示/ }))
  await waitFor(() => expect((screen.getByRole('searchbox', { name: '搜索图库' }) as HTMLInputElement).value).toBe('english 柔和'))
  expect(screen.getByRole('button', { name: '取消筛选：最早优先' })).toBeTruthy()
})

it('collapses display and search without clearing the active query, and restores keyboard focus', async () => {
  mount(); const user = userEvent.setup()
  const toggle = await screen.findByRole('button', { name: /^搜索与显示/ })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('searchbox', { name: '搜索图库' })).toBeNull()
  expect(screen.getByRole('combobox', { name: '网格密度' })).toBeTruthy()
  expect(screen.getByRole('combobox', { name: '图片构图' })).toBeTruthy()
  await user.click(toggle)
  const search = screen.getByRole('searchbox', { name: '搜索图库' })
  expect(document.activeElement).toBe(search)
  await user.type(search, '柔和')
  await user.selectOptions(screen.getByRole('combobox', { name: '网格密度' }), 'compact')
  await chooseOldest(user)
  await user.click(search); await user.keyboard('{Escape}')
  expect(screen.queryByRole('searchbox', { name: '搜索图库' })).toBeNull()
  expect(document.activeElement).toBe(toggle)
  expect(toggle.getAttribute('aria-label')).toBe('搜索与显示，2 项条件已启用')
  expect(screen.queryByRole('button', { name: '打开 山间' })).toBeNull()
  await user.click(toggle)
  expect((screen.getByRole('searchbox', { name: '搜索图库' }) as HTMLInputElement).value).toBe('柔和')
  expect((screen.getByRole('combobox', { name: '网格密度' }) as HTMLSelectElement).value).toBe('compact')
  await user.click(screen.getByRole('button', { name: '重置全部', exact: true }))
  expect(toggle.getAttribute('aria-label')).toBe('搜索与显示')
  expect(await screen.findByRole('button', { name: '打开 山间' })).toBeTruthy()
})

it.each(['标题','备注','提示词'])('protects unsaved %s against browser refresh and clears the guard after discarding',async(field)=>{
  mount();const user=userEvent.setup()
  await user.click(await screen.findByRole('button',{name:'打开 海边'}))
  const clean=new Event('beforeunload',{cancelable:true});window.dispatchEvent(clean)
  expect(clean.defaultPrevented).toBe(false)
  if(field==='提示词'){
    await user.click(screen.getByRole('button',{name:'编辑提示词'}))
    await user.type(screen.getByRole('textbox',{name:'编辑提示词'}),'未保存')
  } else {
    await user.click(screen.getByRole('button', { name: /更多信息/ }))
    await user.type(screen.getByLabelText(field),'未保存')
  }
  const dirty=new Event('beforeunload',{cancelable:true});window.dispatchEvent(dirty)
  expect(dirty.defaultPrevented).toBe(true)
  await user.click(screen.getByRole('button',{name:'关闭详情'}))
  await user.click(await screen.findByRole('button',{name:'放弃修改'}))
  const discarded=new Event('beforeunload',{cancelable:true});window.dispatchEvent(discarded)
  expect(discarded.defaultPrevented).toBe(false)
})

async function chooseOldest(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^排序/ }))
  await user.click(screen.getByRole('radio', { name: '最早优先' }))
}

it('checks multiple tags with the keyboard, round-trips them through the URL, and removes individual chips', async () => {
  images[0].tags.push('海岸')
  mount(); const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /^搜索与显示/ }))
  const tags = screen.getByRole('button', { name: '标签' })
  tags.focus()
  await user.keyboard('{Enter}')
  const coast = screen.getByRole('checkbox', { name: '海岸' })
  const scenery = screen.getByRole('checkbox', { name: '风景' })
  expect(document.activeElement).toBe(screen.getAllByRole('checkbox', { name: /^(海岸|风景)$/ })[0])
  await user.keyboard(' {Tab} ')
  expect([coast, scenery].every(input => (input as HTMLInputElement).checked)).toBe(true)
  await user.keyboard('{Escape}')
  expect(document.activeElement).toBe(tags)
  expect(screen.queryByRole('checkbox', { name: '海岸' })).toBeNull()
  await waitFor(() => expect(new URLSearchParams(screen.getByTestId('location').textContent || '').getAll('tag').sort()).toEqual(['海岸', '风景']))
  await user.click(screen.getByRole('button', { name: '取消筛选：海岸' }))
  expect(await screen.findByRole('button', { name: '打开 山间' })).toBeTruthy()
})

it('finds a work by its #作品编号 and clears only the search term', async () => {
  images = images.map((image, i) => ({ ...image, assetType: 'work', workCode: i ? '#NB-200' : '#NB-100' }))
  render(<MemoryRouter initialEntries={['/?assetType=work']}><SessionProvider><RequireAuth><GalleryPage /></RequireAuth></SessionProvider></MemoryRouter>)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /^搜索与显示/ }))
  await chooseOldest(user)
  await user.type(screen.getByRole('searchbox', { name: '搜索图库' }), '#nb-100')
  expect(await screen.findByRole('button', { name: '打开 海边' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '打开 山间' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '清空搜索' }))
  expect(await screen.findByRole('button', { name: '打开 山间' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '取消筛选：最早优先' })).toBeTruthy()
})

it('opens external image import from the gallery action menu', async () => {
  mount(); const user = userEvent.setup()
  const menu = await screen.findByRole('button', { name: '图库更多操作' })
  menu.focus()
  await user.keyboard('{Enter}')
  await user.click(screen.getByRole('button', { name: '导入外部图片' }))
  expect(await screen.findByRole('dialog', { name: '导入外部图片' })).toBeTruthy()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(document.activeElement).toBe(menu))
})

it('saves toolbar appearance on the server and restores it without browser storage', async () => {
  const first = mount()
  const user = userEvent.setup()
  await user.selectOptions(await screen.findByLabelText('网格密度'), 'roomy')
  await user.selectOptions(screen.getByLabelText('图片构图'), 'contain')
  await waitFor(() => expect(serverAppearance).toEqual({ density: 'roomy', fit: 'contain' }))
  first.unmount()
  storedValues.clear()

  mount()
  await waitFor(() => {
    expect(screen.getByLabelText<HTMLSelectElement>('网格密度').value).toBe('roomy')
    expect(screen.getByLabelText<HTMLSelectElement>('图片构图').value).toBe('contain')
  })
})
