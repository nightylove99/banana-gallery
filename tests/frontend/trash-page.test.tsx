// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import App from '../../src/App'
import type { TrashItem } from '../../src/types'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mount() {
  let items: TrashItem[] = [
    { id: 'one', filename: 'one.png', title: '旧作品', version: 3 },
    { id: 'two', filename: 'two.png', title: '旧配方', version: 5, originalMissing: true, assetType: 'recipe' as const },
    { id: 'pending', filename: 'pending.png', title: '清理中作品', version: 6, purgePending: true },
  ].map(item => ({ prompt: '提示词', deletedAt: '2026-09-11T08:00:00Z', referenceImages: [], tags: [], favorited: false, assetType: 'work', width: 1, height: 1, createdAt: '2026-09-11', ...item }))
  const calls: { id: string; method: string; version: number }[] = []
  let reads = 0
  let failNext = false
  let beforeNext: Promise<void> | undefined
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/session') return Response.json({ user: { id: 'trash', email: 'test@local' }, workspace: { id: 'trash', name: 'Test' } })
    if (url === '/api/gallery/state') return Response.json({ revision: String(items.length), count: 0, trashCount: items.length })
    if (url.startsWith('/api/images?') || url === '/api/groups') return Response.json([])
    if (url === '/api/trash') { reads++; return Response.json(items) }
    if (url.startsWith('/api/trash/')) {
      const id = url.split('/')[3]
      const item = items.find(item => item.id === id)!
      const version = JSON.parse(String(init?.body)).expectedVersion
      calls.push({ id, method: init!.method!, version })
      if (beforeNext) { const gate = beforeNext; beforeNext = undefined; await gate }
      if (failNext) {
        failNext = false
        items = items.map(row => row.id === id ? { ...row, version: row.version + 1 } : row)
        return Response.json({ error: '条目已变化', code: 'TRASH_VERSION_CONFLICT' }, { status: 409 })
      }
      items = items.filter(row => row.id !== id)
      return Response.json(init?.method === 'POST' ? { ...item, deletedAt: undefined, version: version + 1 } : { ok: true })
    }
    return Response.json({}, { status: 404 })
  })
  vi.stubGlobal('fetch', fetch)
  return { ...render(<MemoryRouter initialEntries={['/trash']}><App /></MemoryRouter>), calls, reads: () => reads, pauseNext: (gate: Promise<void>) => { beforeNext = gate }, failNext: () => { failNext = true } }
}

it('uses strict thumbnails, distinguishes missing and pending items, and restores only eligible selections', async () => {
  const { container, calls } = mount()
  const user = userEvent.setup()
  const main = await screen.findByRole('main')
  const nav = screen.getByRole('navigation')
  expect(within(main).queryByRole('searchbox')).toBeNull()
  expect(await within(nav).findByRole('button', { name: /^回收站\s*3$/ })).toBeTruthy()
  expect(container.querySelector('main img')?.getAttribute('src')).toContain('size=standard')
  expect(container.querySelector('main img[src*="pending.png"], main img[src*="two.png"]')).toBeNull()
  expect(within(main).getByText('元数据保留，仍可恢复')).toBeTruthy()
  expect(within(main).getByText('不可恢复，可重试清理')).toBeTruthy()
  await user.click(within(main).getByRole('button', { name: '选择' }))
  await user.click(screen.getByRole('button', { name: '全选全部' }))
  expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(3)
  await user.click(screen.getByRole('button', { name: '恢复所选' }))
  await waitFor(() => expect(calls).toEqual([{ id: 'one', method: 'POST', version: 3 }, { id: 'two', method: 'POST', version: 5 }]))
  expect(await within(nav).findByRole('button', { name: /^回收站\s*1$/ })).toBeTruthy()
  expect(screen.getByRole('checkbox', { name: '选择 清理中作品' })).toBeTruthy()
})

it('confirms a frozen version, reloads on conflict and never resends against the new version', async () => {
  const fixture = mount()
  const user = userEvent.setup()
  await screen.findByRole('button', { name: '打开 旧作品' })
  const clear = screen.getByRole('button', { name: '清空回收站' })
  await user.click(clear)
  let dialog = screen.getByRole('dialog', { name: '清空回收站' })
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '取消' }))
  await user.keyboard('{Escape}')
  expect(fixture.calls).toEqual([])
  expect(document.activeElement).toBe(clear)
  fixture.failNext()
  await user.click(clear)
  dialog = screen.getByRole('dialog', { name: '清空回收站' })
  expect(within(dialog).getByText(/3 项/)).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '确认清空' }))
  expect((await screen.findByRole('alert')).textContent).toContain('失败 1 项')
  await waitFor(() => expect(fixture.reads()).toBe(2))
  expect(fixture.calls).toEqual([
    { id: 'one', method: 'DELETE', version: 3 },
    { id: 'two', method: 'DELETE', version: 5 },
    { id: 'pending', method: 'DELETE', version: 6 },
  ])
  expect(await screen.findByRole('button', { name: '打开 旧作品' })).toBeTruthy()
})


it('restores all recoverable entries serially and only purges the confirmed selection', async () => {
  const fixture = mount()
  const user = userEvent.setup()
  const { promise, resolve } = Promise.withResolvers<void>()
  await screen.findByRole('button', { name: '打开 旧作品' })
  fixture.pauseNext(promise)
  await user.click(screen.getByRole('button', { name: '全部恢复' }))
  expect(fixture.calls).toEqual([{ id: 'one', method: 'POST', version: 3 }])
  expect(screen.getByRole('status').textContent).toContain('0 / 2')
  resolve()
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('已恢复 2 项'))
  await user.click(screen.getByRole('button', { name: '选择' }))
  await user.click(screen.getByRole('checkbox', { name: '选择 清理中作品' }))
  await user.click(screen.getByRole('button', { name: '永久删除所选' }))
  const dialog = screen.getByRole('dialog', { name: '永久删除' })
  expect(within(dialog).getByText(/1 项/)).toBeTruthy()
  await user.click(within(dialog).getByRole('button', { name: '确认永久删除' }))
  expect(await screen.findByText('回收站是空的')).toBeTruthy()
  expect(fixture.calls.slice(1)).toEqual([
    { id: 'two', method: 'POST', version: 5 },
    { id: 'pending', method: 'DELETE', version: 6 },
  ])
})
