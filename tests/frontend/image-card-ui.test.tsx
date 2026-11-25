// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'

import type { GalleryImage } from '../../src/types'

vi.mock('@/api', () => ({
  imageAssetUrl: (filename: string) => `/api/assets/images/${filename}`,
}))

import { ImageCard } from '../../src/components/ImageCard'

const baseImage: GalleryImage = {
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

describe('ImageCard UI', () => {
  it('使用固定 2:3 缩略图比例', () => {
    const { container } = render(
      <ImageCard image={baseImage} onOpen={() => {}} onToggleFavorite={() => {}} />,
    )

    const card = container.firstElementChild
    const img = screen.getByRole('img')

    expect(card?.classList.contains('aspect-[2/3]')).toBe(true)
    expect(img.classList.contains('h-full')).toBe(true)
    expect(img.classList.contains('w-full')).toBe(true)
    expect(img.classList.contains('object-cover')).toBe(true)
  })

  it('不再显示左上角的作品或配方角标', () => {
    render(
      <div>
        <ImageCard image={baseImage} onOpen={() => {}} onToggleFavorite={() => {}} />
        <ImageCard
          image={{ ...baseImage, id: 'recipe-1', filename: 'recipe-1.png', assetType: 'recipe' }}
          onOpen={() => {}}
          onToggleFavorite={() => {}}
        />
      </div>,
    )

    expect(screen.queryByText('作品')).toBeNull()
    expect(screen.queryByText('配方')).toBeNull()
  })
})

it('keeps the picture clean and groups six actions beside, not inside, the open button', () => {
  const { container } = render(<ImageCard image={{ ...baseImage, workCode: '#AA42', favorited: true }}
    onOpen={() => {}} onToggleFavorite={() => {}} onAddToCollection={() => {}}
    {...{ onExtractRecipe: () => {}, onDelete: () => {} }} />)
  expect(screen.queryByText(baseImage.prompt)).toBeNull()
  expect(container.querySelector('#asset-image-1')?.querySelector('button, a')).toBeNull()
  const dock = within(screen.getByRole('group', { name: '卡片操作', hidden: true }))
  expect(dock.getAllByRole('button', { hidden: true }).map(button => button.getAttribute('aria-label')))
    .toEqual(['取消喜欢', '加入收藏夹', '提炼成配方', '复制图片编号 #AA42', '移入回收站'])
  expect(dock.getByTitle('复制图片编号 #AA42').textContent).toBe('#')
  expect(dock.getByTitle('另开进生成页').getAttribute('href')).toBe('/generate?fromAsset=image-1')
})
