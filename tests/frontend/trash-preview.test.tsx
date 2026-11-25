// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import App from '../../src/App'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('previews only the current item and keeps navigation locked while confirming or restoring', async () => {
  const user = userEvent.setup()
  const { promise, resolve } = Promise.withResolvers<Response>()
  const items = ['one', 'two', 'three'].map(id => ({
    id, filename: id + '.png', title: id, prompt: '完整提示词 ' + id, referenceImages: [id + '-ref.png'],
    createdAt: '2026-09-11', deletedAt: '2026-09-11T08:00:00Z', version: 1, width: 300, height: 200,
    tags: [], favorited: false, assetType: 'work',
  }))
  vi.stubGlobal('fetch', async (url: string) => {
    if (url === '/api/session') return Response.json({ user: { id: 'preview', email: 'test@local' }, workspace: { id: 'preview', name: 'Test' } })
    if (url === '/api/gallery/state') return Response.json({ revision: 'a', count: 0, trashCount: 3 })
    if (url.startsWith('/api/images?') || url === '/api/groups') return Response.json([])
    if (url === '/api/trash') return Response.json(items)
    if (url === '/api/trash/two/restore') return promise
    return Response.json({}, { status: 404 })
  })
  render(<MemoryRouter initialEntries={['/trash']}><App /></MemoryRouter>)
  await user.click(await screen.findByRole('button', { name: '打开 one' }))
  let preview = screen.getByRole('dialog', { name: 'one' })
  expect(within(preview).getAllByRole('img').map(img => img.getAttribute('src'))).toEqual(['/api/assets/images/one.png', '/api/assets/references/one-ref.png'])
  expect(within(preview).getByText('完整提示词 one')).toBeTruthy()
  expect(within(preview).getByText('300 × 200')).toBeTruthy()
  expect(within(preview).queryByRole('button', { name: /编辑|喜欢|生成|收藏夹|提炼/ })).toBeNull()
  await user.click(within(preview).getByRole('button', { name: '复制提示词' }))
  expect(await navigator.clipboard.readText()).toBe('完整提示词 one')
  await user.click(within(preview).getByRole('button', { name: '永久删除' }))
  await user.keyboard('{ArrowRight}{Escape}')
  preview = screen.getByRole('dialog', { name: 'one' })
  expect(within(preview).getByText('1 / 3')).toBeTruthy()
  await user.keyboard('{ArrowRight}')
  preview = screen.getByRole('dialog', { name: 'two' })
  await user.click(within(preview).getByRole('button', { name: '恢复到图库' }))
  await user.keyboard('{ArrowLeft}{Escape}')
  expect(screen.getByRole('dialog', { name: 'two' })).toBeTruthy()
  expect(within(preview).getByRole('status').textContent).toContain('正在恢复')
  resolve(Response.json({ ...items[1], deletedAt: undefined, version: 2 }))
  preview = await screen.findByRole('dialog', { name: 'three' })
  expect(within(preview).getByText('2 / 2')).toBeTruthy()
  await user.click(within(preview).getByRole('button', { name: '上一项' }))
  expect(screen.getByRole('dialog', { name: 'one' })).toBeTruthy()
})
