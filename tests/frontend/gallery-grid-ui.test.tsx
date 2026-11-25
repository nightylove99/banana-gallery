// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'

import type { GalleryImage } from '../../src/types'

vi.mock('@/api', () => ({
  imageAssetUrl: (filename: string) => `/api/assets/images/${filename}`,
}))

import { GalleryGrid } from '../../src/components/GalleryGrid'

const image: GalleryImage = {
  id: 'image-1',
  filename: 'image-1.png',
  prompt: 'banana prompt',
  referenceImages: [],
  tags: [],
  favorited: false,
  createdAt: '2026-03-20T00:00:00.000Z',
  width: 1024,
  height: 1024,
  assetType: 'work',
}

afterEach(() => {
  cleanup()
})

describe('GalleryGrid UI', () => {
  function SelectableGallery({ onOpen }: { onOpen: (image: GalleryImage) => void }) {
    const [selected, setSelected] = useState(new Map<string, number>())
    const [selecting, setSelecting] = useState(true)
    return <>
      <button onClick={() => setSelecting(false)}>退出多选</button>
      <GalleryGrid images={[image]} fit="contain" loading={false} emptyTitle="" emptyDescription=""
        selected={selected} onOpen={onOpen} onToggleFavorite={() => undefined}
        onSelect={selecting ? item => setSelected(previous => {
          const next = new Map(previous)
          if (next.has(item.id)) next.delete(item.id)
          else next.set(item.id, 0)
          return next
        }) : undefined} />
    </>
  }

  it('多选时点击图片和卡片空白均切换选择，退出后恢复打开详情', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<SelectableGallery onOpen={onOpen} />)
    const checkbox = screen.getByRole<HTMLInputElement>('checkbox')
    await user.click(screen.getByRole('img'))
    expect(checkbox.checked).toBe(true)
    const card = screen.getByRole('button', { name: '取消选择 banana prompt' })
    expect(card.getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByText('banana prompt')).toBeNull()
    await user.click(card)
    expect(checkbox.checked).toBe(false)
    expect(onOpen).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '退出多选' }))
    await user.click(screen.getByRole('img'))
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(image)
    expect(screen.getByRole('button', { name: '打开 banana prompt' }).hasAttribute('aria-pressed')).toBe(false)
  })

  it('复选框及其外层热区每次点击只切换一次', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<SelectableGallery onOpen={onOpen} />)
    const checkbox = screen.getByRole<HTMLInputElement>('checkbox')
    await user.click(checkbox)
    expect(checkbox.checked).toBe(true)
    await user.click(checkbox.parentElement!)
    expect(checkbox.checked).toBe(false)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('多选时 Enter 和空格切换卡片，复选框的空格不会重复触发', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    const { container } = render(<SelectableGallery onOpen={onOpen} />)
    const checkbox = screen.getByRole<HTMLInputElement>('checkbox')
    container.querySelector<HTMLElement>('[data-asset-id]')!.focus()
    await user.keyboard('{Enter}')
    expect(checkbox.checked).toBe(true)
    await user.keyboard(' ')
    expect(checkbox.checked).toBe(false)
    checkbox.focus()
    await user.keyboard(' ')
    expect(checkbox.checked).toBe(true)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('图片加载失败后仍能选择，重试按钮保持独立', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<SelectableGallery onOpen={onOpen} />)
    fireEvent.error(screen.getByRole('img'))
    const checkbox = screen.getByRole<HTMLInputElement>('checkbox')
    await user.click(screen.getByText('图片文件缺失或无法加载'))
    expect(checkbox.checked).toBe(true)
    await user.click(screen.getByRole('button', { name: '重试加载' }))
    expect(checkbox.checked).toBe(true)
    expect(screen.getByRole('img').getAttribute('src')).toContain('retry=1')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('使用行优先网格、保留完整构图并通过受保护缩略图加载', () => {
    const { container } = render(
      <GalleryGrid
        images={[image]}
        fit="contain"
        loading={false}
        emptyTitle="暂无图片"
        emptyDescription="上传或生成图片后会出现在这里"
        onOpen={() => undefined}
        onToggleFavorite={() => undefined}
      />,
    )

    const picture = container.querySelector('img')
    expect(picture?.classList.contains('object-contain')).toBe(true)
    expect(picture?.getAttribute('src')).toBe('/api/assets/images/image-1.png?thumbnail=true')
    expect(container.querySelector('[data-asset-id]')?.getAttribute('data-asset-id')).toBe('image-1')
  })
})
