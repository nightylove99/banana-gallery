// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { GalleryImage } from '../../src/types'
const save = vi.hoisted(() => vi.fn())
vi.mock('@/api', async importOriginal => ({ ...await importOriginal<typeof import('../../src/api')>(), saveImageReferences: save }))
import { DetailModal } from '../../src/components/DetailModal'
const image: GalleryImage = { id: 'one', filename: 'main.png', referenceImages: ['a.png', 'b.png'], prompt: 'original', assetType: 'recipe', tags: [], favorited: false, createdAt: '2026-09-06', width: 1, height: 1 }
beforeEach(() => {
  save.mockReset().mockResolvedValue({ ...image, referenceImages: ['new.png', 'a.png'] })
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:new'); static revokeObjectURL = vi.fn() })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function GeneratedReferences() {
  const location = useLocation()
  return <p data-testid="generated-references">{JSON.stringify(location.state?.referenceImages)}</p>
}
function setup(refs = image.referenceImages) {
  const onClose = vi.fn()
  const onReferencesUpdated = vi.fn()
  render(<MemoryRouter><Routes><Route path="/" element={<DetailModal image={{ ...image, referenceImages: refs }} onClose={onClose} onToggleFavorite={() => {}} onUpdateTags={() => {}} onUpdatePrompt={() => {}} onDelete={() => {}} onReferencesUpdated={onReferencesUpdated} />} /><Route path="/generate" element={<GeneratedReferences />} /></Routes></MemoryRouter>)
  return { user: userEvent.setup(), onClose, onReferencesUpdated }
}
describe('reference editor in details', () => {
  it('allows PNG above 25MiB into the upload draft instead of rejecting before conversion', async () => {
    const { user } = setup([])
    await user.click(screen.getByRole('button', { name: '添加参考图' }))
    const file = new File(['png'], 'large.png', { type: 'image/png' })
    Object.defineProperty(file, 'size', { value: 30 * 1024 * 1024 })
    fireEvent.drop(screen.getByTestId('reference-editor-dropzone'), { dataTransfer: { files: [file], types: ['Files'] } })
    await user.click(screen.getByRole('button', { name: '保存参考图片' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith('one', [file], [], [''], 0))
  })
  it.each([['image/png', 100 * 1024 * 1024 + 1], ['image/jpeg', 25 * 1024 * 1024 + 1], ['image/webp', 25 * 1024 * 1024 + 1]])('rejects oversized %s before saving (%i)', async (type, size) => {
    const { user } = setup([])
    await user.click(screen.getByRole('button', { name: '添加参考图' }))
    const file = new File(['image'], 'large.png', { type: String(type) })
    Object.defineProperty(file, 'size', { value: size })
    fireEvent.drop(screen.getByTestId('reference-editor-dropzone'), { dataTransfer: { files: [file], types: ['Files'] } })
    expect(screen.getByRole('alert').textContent).toContain('PNG 原图最多 100 MiB')
    await user.click(screen.getByRole('button', { name: '保存参考图片' }))
    expect(save).not.toHaveBeenCalled()
  })
  it('replaces in position and changes order before a single save', async () => {
    const { user, onReferencesUpdated } = setup()
    await user.click(screen.getByRole('button', { name: '编辑参考图片' }))
    await user.click(screen.getByRole('button', { name: '替换参考图 2' }))
    const file = new File(['new'], 'new.png', { type: 'image/png' })
    await user.upload(screen.getByLabelText('选择替换参考图'), file)
    await user.click(screen.getByRole('button', { name: '前移参考图 2' }))
    expect(save).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '保存参考图片' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith('one', [file, 'a.png'], ['a.png', 'b.png'], ['', ''], 0))
    expect(onReferencesUpdated).toHaveBeenCalledWith(expect.objectContaining({ referenceImages: ['new.png', 'a.png'] }))
  })
  it('cancels without uploading and restores originals', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: '编辑参考图片' }))
    await user.click(screen.getByRole('button', { name: '删除参考图 1' }))
    await user.click(screen.getByRole('button', { name: '取消编辑参考图片' }))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByAltText('Reference 1').getAttribute('src')).toContain('a.png')
  })
  it('preserves drafts after failure and guards closing until discarded', async () => {
    save.mockRejectedValue(new Error('保存失败'))
    const { user, onClose } = setup()
    await user.click(screen.getByRole('button', { name: '编辑参考图片' }))
    await user.click(screen.getByRole('button', { name: '删除参考图 1' }))
    await user.click(screen.getByRole('button', { name: '保存参考图片' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('保存失败'))
    await user.click(screen.getByRole('button', { name: '关闭详情' }))
    expect(onClose).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '放弃修改' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
  it('allows adding to an empty entry by file drop', async () => {
    const { user } = setup([])
    await user.click(screen.getByRole('button', { name: '添加参考图' }))
    const file = new File(['new'], 'new.webp', { type: 'image/webp' })
    fireEvent.drop(screen.getByTestId('reference-editor-dropzone'), { dataTransfer: { files: [file], types: ['Files'] } })
    await user.click(screen.getByRole('button', { name: '保存参考图片' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith('one', [file], [], [''], 0))
  })
  it('saves once before navigating and passes the updated references into generation', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: '编辑参考图片' }))
    await user.click(screen.getByRole('button', { name: '删除参考图 1' }))
    await user.click(screen.getByRole('button', { name: '用此配方生成' }))
    await user.click(screen.getByRole('button', { name: '保存并继续' }))
    await waitFor(() => expect(screen.getByTestId('generated-references').textContent).toBe('["new.png","a.png"]'))
    expect(save).toHaveBeenCalledOnce()
  })
  it('pastes and drags to reorder references, and retries the same draft after a failed save', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: '编辑参考图片' }))
    const file = new File(['new'], 'pasted.png', { type: 'image/png' })
    fireEvent.paste(screen.getByTestId('reference-editor-dropzone'), { clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } })
    const from = screen.getByRole('button', { name: '放大参考图 3' }).parentElement!
    const to = screen.getByRole('button', { name: '放大参考图 1' }).parentElement!
    const dataTransfer = { files: [], setData: vi.fn(), types: ['text/plain'] }
    fireEvent.dragStart(from, { dataTransfer })
    fireEvent.drop(to, { dataTransfer })
    save.mockRejectedValueOnce(new Error('请重试'))
    await user.click(screen.getByRole('button', { name: '保存参考图片' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('请重试'))
    await user.click(screen.getByRole('button', { name: '保存参考图片' }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save).toHaveBeenLastCalledWith('one', [file, 'a.png', 'b.png'], ['a.png', 'b.png'], ['', '', ''], 0)
  })

  it('discarding changes before deletion also exits reference editing', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: '编辑参考图片' }))
    await user.click(screen.getByRole('button', { name: '删除参考图 1' }))
    await user.click(screen.getByRole('button', { name: '移入回收站', exact: true }))
    await user.click(screen.getByRole('button', { name: '放弃修改' }))
    expect(screen.queryByRole('button', { name: '保存参考图片' })).toBeNull()
    expect(screen.getByAltText('Reference 1').getAttribute('src')).toContain('a.png')
  })

})
