// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CompareModal } from '../../src/components/CompareModal'
import type { GalleryImage } from '../../src/types'

afterEach(() => { cleanup() })

const sample = (id: string, title: string, prompt: string, favorited = false): GalleryImage => ({
  id,
  filename: `${id}.png`,
  title,
  prompt,
  referenceImages: [],
  tags: [],
  favorited,
  createdAt: '2026-11-24T00:00:00Z',
  assetType: 'work',
  width: 1600,
  height: 2400,
  generation: { provider: 'google', model: 'gemini-nano-banana-2.1', aspectRatio: '2:3', imageSize: '2K' },
})

describe('CompareModal', () => {
  it('renders side-by-side without zoom controls, expands on click, navigates with arrows, and toggles info panel', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onToggleFavorite = vi.fn()
    const onDelete = vi.fn()
    const images = [sample('a', '第一张', '提示词 A'), sample('b', '第二张', '提示词 B', true)]

    render(<CompareModal images={images} onClose={onClose} onToggleFavorite={onToggleFavorite} onDelete={onDelete} />)

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByRole('slider')).toBeNull()
    expect(within(dialog).queryByText('提示词 A')).toBeNull()

    // Toggle info panel and verify prompt diff is shown
    await user.click(within(dialog).getByRole('button', { name: /参数与提示词/ }))
    expect(within(dialog).getByText('提示词 A')).toBeTruthy()
    expect(within(dialog).getByText('提示词 B')).toBeTruthy()

    // Click image to open single fullscreen view, navigate with ArrowRight, Escape returns to side-by-side
    await user.click(within(dialog).getByRole('button', { name: '放大查看 第一张' }))
    expect(within(dialog).getByRole('button', { name: '返回并排对比' })).toBeTruthy()
    expect(within(dialog).getByText(/第一张 · 1 \/ 2/)).toBeTruthy()

    await user.keyboard('{ArrowRight}')
    expect(within(dialog).getByText(/第二张 · 2 \/ 2/)).toBeTruthy()

    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('button', { name: '放大查看 第一张' })).toBeTruthy()

    // Favorite & delete actions work directly from compare cards
    const cardActions = within(dialog).getByRole('group', { name: '第一张 操作' })
    await user.click(within(cardActions).getByRole('button', { name: '喜欢' }))
    expect(onToggleFavorite).toHaveBeenCalledWith('a')
    await user.click(within(cardActions).getByRole('button', { name: '移入回收站' }))
    expect(onDelete).toHaveBeenCalledWith('a')
  })
})
