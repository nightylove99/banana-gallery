// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { Toaster } from 'sonner'
import { RequireAuth } from '../../src/auth/RequireAuth'
import { SessionProvider } from '../../src/auth/useSession'
import { GalleryProvider } from '../../src/hooks/GalleryProvider'
import GalleryPage from '../../src/pages/GalleryPage'
import GeneratePage from '../../src/pages/GeneratePage'
import type { GalleryImage, GenerationTask } from '../../src/types'

const createdAt = '2026-11-01T10:00:00Z'
const requestStartedAt = '2026-11-01T10:01:00Z'
const completedAt = '2026-11-01T10:01:12Z'
const input: GenerationTask['input'] = {
  prompt: '本次生成的提示词', provider: 'demo', model: 'banana-demo-v1', aspectRatio: '3:2',
  imageSize: '2K', quality: 'high', referenceFilenames: ['snapshot.png'], referenceNotes: ['本次参考图用途'],
}
const job: GenerationTask = {
  id: 'job', key: 'job-key', scope: { userId: 'detail-test', workspaceId: 'detail-test' }, status: 'completed',
  input, workAssetId: 'work', createdAt, requestStartedAt, completedAt, updatedAt: completedAt,
  result: { ...input, filename: 'result.png', width: 1200, height: 800 },
}
const work: GalleryImage = {
  id: 'work', workCode: '#WORK', assetType: 'work', filename: 'result.png', prompt: '图库修改后的提示词',
  referenceImages: ['edited.png'], referenceNotes: ['图库修改后的用途'], width: 42, height: 24,
  favorited: false, tags: [], createdAt: '2026-11-03T00:00:00Z',
  generation: { provider: 'seedream', model: 'different-model', aspectRatio: '1:1', imageSize: '1K' },
}
function LocationState() {
  const { state } = useLocation()
  return <span hidden data-testid="location-state">{JSON.stringify(state)}</span>
}
function mount({ jobs = [job], works = [work], direct, fetched }: {
  jobs?: GenerationTask[]; works?: GalleryImage[]; direct?: boolean; fetched?: GalleryImage
} = {}) {
  let tasks = jobs
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/session') return Response.json({ user: { id: 'detail-test', email: 'test@local' }, workspace: { id: 'detail-test', name: 'Test' } })
    if (url.startsWith('/api/generation-tasks?')) return Response.json({ tasks })
    if (url === '/api/generation-tasks/job/trash') {
      tasks = tasks.filter(item => item.id !== job.id)
      return Response.json({ ...job, deletedAt: completedAt })
    }
    if (url.startsWith('/api/images?')) return Response.json(works)
    if (url === '/api/images/work' && init?.method === 'PATCH') return Response.json({ ...work, favorited: true })
    if (url === '/api/images/work' && fetched) return Response.json(fetched)
    if (url === '/api/reference-library/assets' && init?.method === 'POST') {
      return Response.json({ asset: { currentVersionId: 'v1', versions: [{ id: 'v1', filename: 'result-ref.png' }] } })
    }
    if (url === '/api/generate/save') return Response.json({ ...work, id: 'recipe', assetType: 'recipe' })
    if (url === '/api/groups' || url === '/api/trash') return Response.json([])
    if (url === '/api/gallery/state') return Response.json({ revision: 'detail', count: works.length, trashCount: 0 })
    return Response.json({}, { status: 404 })
  })
  vi.stubGlobal('fetch', fetcher)
  render(<MemoryRouter initialEntries={[direct
    ? { pathname: '/', search: '?view=all&assetType=recipe', state: { openImageId: 'work', assetType: 'work' } }
    : '/generate']}>
    <SessionProvider><RequireAuth><GalleryProvider><Routes>
      <Route path="/generate" element={<GeneratePage />} />
      <Route path="/" element={<GalleryPage />} />
    </Routes><LocationState /><Toaster /></GalleryProvider></RequireAuth></SessionProvider>
  </MemoryRouter>)
  return { fetcher, user: userEvent.setup() }
}
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function openDetail(user: ReturnType<typeof userEvent.setup>, label = '打开作品 #WORK') {
  const card = await screen.findByRole('button', { name: label, exact: true })
  await user.click(within(card.parentElement!).getByRole('button', { name: '详情', exact: true }))
  return within(await screen.findByRole('dialog'))
}

it('displays and copies the original task snapshot instead of editable gallery fields', async () => {
  const { user } = mount()
  const detail = await openDetail(user)
  expect(detail.getByText(input.prompt, { selector: 'p' })).toBeTruthy()
  expect(detail.queryByText(work.prompt)).toBeNull()
  expect(detail.getByText('本次参考图用途')).toBeTruthy()
  expect(detail.queryByText('图库修改后的用途')).toBeNull()
  const parameters = within(detail.getByRole('region', { name: '生成参数与来源' }))
  for (const value of [/演示/, '3:2', '2K', 'High', '1200 × 800', '用时 12 秒']) {
    expect(parameters.getByText(value).className).toContain('bg-indigo')
  }
  expect(parameters.queryByText(/different-model|1:1|1K/)).toBeNull()
  expect(detail.queryByText(/42 × 24/)).toBeNull()
  expect(detail.getByText('创建时间：' + new Date(createdAt).toLocaleString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }))).toBeTruthy()
  expect(detail.queryByRole('button', { name: /编辑提示词|更多信息/ })).toBeNull()
  const references = within(detail.getByRole('region', { name: '参考图片' }))
  expect(references.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['放大参考图 1'])
  await user.click(references.getByRole('button', { name: '放大参考图 1' }))
  expect(detail.getByRole('img', { name: '参考图' }).getAttribute('src')).toContain('snapshot.png')
  await user.keyboard('{Escape}')
  await user.click(detail.getByRole('button', { name: '复制提示词', exact: true }))
  expect(await navigator.clipboard.readText()).toBe(input.prompt)
})

it.each([
  ['未入库', { ...job, workAssetId: undefined }, []],
  ['已回收（有同名作品）', job, [{ ...work, id: 'different' }]],
  ['旧任务（同名作品不唯一）', { ...job, workAssetId: undefined }, [work, { ...work, id: 'different' }]],
] as const)('%s时不显示图库操作', async (_name, task, works) => {
  const { user } = mount({ jobs: [task], works: [...works] })
  const detail = await openDetail(user, '打开作品大图')
  expect(detail.queryByRole('button', { name: /复制图片编号|喜欢|去图库查看/ })).toBeNull()
})

it('可喜欢已入库作品，并跳转打开同一作品的可编辑图库详情', async () => {
  const { user, fetcher } = mount()
  const detail = await openDetail(user)
  expect(detail.getByRole('button', { name: '复制图片编号 #WORK' })).toBeTruthy()
  await user.click(detail.getByRole('button', { name: '喜欢', exact: true }))
  expect(await detail.findByRole('button', { name: '取消喜欢' })).toHaveProperty('ariaPressed', 'true')
  await user.click(detail.getByRole('button', { name: '去图库查看' }))
  const gallery = within(await screen.findByRole('dialog', { name: work.prompt }))
  for (const name of ['编辑提示词', '编辑参考图片', '更多信息', '加入收藏夹', '提炼成配方', '移入回收站']) {
    expect(gallery.getByRole('button', { name: new RegExp(name) })).toBeTruthy()
  }
  expect(screen.getByTestId('location-state').textContent).toBe('null')
  expect(fetcher.mock.calls.some(([url, init]) => url === '/api/images/work' && !init?.method)).toBe(false)
  await user.click(gallery.getByRole('button', { name: '关闭详情' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('按跳转 ID 读取还未加载的作品，并清理路由 state', async () => {
  const { fetcher } = mount({ works: [], direct: true, fetched: work })
  expect(await screen.findByRole('dialog', { name: work.prompt })).toBeTruthy()
  expect(fetcher.mock.calls.some(([url]) => url === '/api/images/work')).toBe(true)
  await waitFor(() => expect(screen.getByTestId('location-state').textContent).toBe('null'))
})

it.each([undefined, { ...work, deletedAt: completedAt }])('不打开无法读取或已回收的跳转作品', async fetched => {
  mount({ works: [], direct: true, fetched })
  expect(await screen.findByText(/无法打开作品/)).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  await waitFor(() => expect(screen.getByTestId('location-state').textContent).toBe('null'))
})

it('历史回收站需要确认，取消不发送请求', async () => {
  const { fetcher, user } = mount()
  const detail = await openDetail(user)
  const requests = () => fetcher.mock.calls.filter(([url]) => url.endsWith('/trash') && url.includes('generation-tasks'))
  await user.click(detail.getByRole('button', { name: '移入历史回收站' }))
  expect(detail.getByText('仅从生成记录隐藏，不影响图库里的作品，可在历史回收站恢复。')).toBeTruthy()
  expect(requests()).toHaveLength(0)
  await user.click(detail.getByRole('button', { name: '取消', exact: true }))
  expect(requests()).toHaveLength(0)
  await user.click(detail.getByRole('button', { name: '移入历史回收站' }))
  await user.click(detail.getByRole('button', { name: '移入回收站', exact: true }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(requests()).toHaveLength(1)
  expect(JSON.parse(requests()[0][1]!.body as string)).toEqual({ confirm: true })
  expect(screen.queryByRole('button', { name: '打开作品 #WORK' })).toBeNull()
})

it('下载原始结果，按任务快照存配方，且不重复保存', async () => {
  const { fetcher, user } = mount()
  const downloads: string[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download) })
  const detail = await openDetail(user)
  await user.click(detail.getByRole('button', { name: '下载原图' }))
  expect(downloads).toEqual(['result.png'])
  await user.click(detail.getByRole('button', { name: '存为配方' }))
  expect(await detail.findByRole('button', { name: '已存为配方' })).toHaveProperty('disabled', true)
  const saves = fetcher.mock.calls.filter(([url]) => url === '/api/generate/save')
  expect(saves).toHaveLength(1)
  expect(JSON.parse(saves[0][1]!.body as string)).toMatchObject({ taskId: job.id, assetType: 'recipe', prompt: input.prompt, referenceFilenames: input.referenceFilenames })
})

it('在详情内切换到来源任务，不打开生成页的结果区', async () => {
  const source: GenerationTask = {
    ...job, id: 'source', workAssetId: undefined,
    input: { ...input, prompt: '来源快照' }, result: { ...job.result!, prompt: '来源快照', filename: 'source.png' },
  }
  const { user } = mount({ jobs: [{ ...job, input: { ...input, sourceTaskId: source.id } }, source] })
  const detail = await openDetail(user)
  await user.click(detail.getByRole('button', { name: '来源结果' }))
  expect(await within(screen.getByRole('dialog')).findByText('来源快照', { selector: 'p' })).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '关闭详情' }))
  expect(screen.queryByText('来源快照')).toBeNull()
})

it('旧任务可按唯一同名作品显示图库操作', async () => {
  const { user } = mount({ jobs: [{ ...job, workAssetId: undefined }] })
  const detail = await openDetail(user)
  expect(detail.getByRole('button', { name: '复制图片编号 #WORK' })).toBeTruthy()
})

it.each([
  ['另开草稿', 'snapshot.png'],
  ['继续修改', 'result-ref.png'],
])('%s使用原提示词并在成功后关闭详情', async (action, reference) => {
  const { user, fetcher } = mount()
  const detail = await openDetail(user)
  await user.click(detail.getByRole('button', { name: action }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByLabelText('提示词')).toHaveProperty('value', input.prompt)
  expect(Array.from(document.images).some(image => image.src.includes(reference))).toBe(true)
  if (action === '继续修改') {
    const request = fetcher.mock.calls.find(([url, init]) => url === '/api/reference-library/assets' && init?.method === 'POST')
    expect(JSON.parse(request![1]!.body as string)).toMatchObject({ kind: 'images', filename: 'result.png' })
  }
})
