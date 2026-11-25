// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { ImageCard } from '../../src/components/ImageCard'
import { DetailModal } from '../../src/components/DetailModal'
import { MemoryRouter } from 'react-router-dom'
import type { GalleryImage } from '../../src/types'

const image: GalleryImage = { id: 'copy', filename: 'copy.png', prompt: '第一段\n\n  保留缩进与换行\n最后一行', referenceImages: [], tags: [], favorited: true, assetType: 'recipe', createdAt: '2026-09-12', width: 100, height: 150 }
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('toggles favorite from a card without opening details', async () => {
  const user = userEvent.setup(), open = vi.fn(), favorite = vi.fn()
  const { rerender } = render(<ImageCard image={image} onOpen={open} onToggleFavorite={favorite} />)
  expect(screen.queryByRole('button', { name: '复制提示词', exact: true })).toBeNull()
  const unlikeButton = screen.getByRole('button', { name: '取消喜欢', exact: true })
  expect(unlikeButton.getAttribute('aria-pressed')).toBe('true')
  await user.click(unlikeButton)
  expect(favorite).toHaveBeenCalledWith(image.id)
  expect(open).not.toHaveBeenCalled()

  rerender(<ImageCard image={{ ...image, favorited: false }} onOpen={open} onToggleFavorite={favorite} />)
  const likeButton = screen.getByRole('button', { name: '喜欢', exact: true })
  expect(likeButton.getAttribute('aria-pressed')).toBe('false')
  await user.click(likeButton)
  expect(favorite).toHaveBeenCalledTimes(2)
  expect(open).not.toHaveBeenCalled()
})

it('hides the card favorite button while batch selecting', () => {
  render(<ImageCard image={image} onOpen={() => {}} onToggleFavorite={() => {}} onSelect={() => {}} selected={false} />)
  expect(screen.queryByRole('button', { name: '取消喜欢', exact: true })).toBeNull()
  expect(screen.queryByRole('button', { name: '喜欢', exact: true })).toBeNull()
})

it('exposes all recipe actions directly and requires confirmation before recycling', async () => {
  const user = userEvent.setup(), close = vi.fn(), favorite = vi.fn(), collection = vi.fn(), remove = vi.fn()
  render(<MemoryRouter><DetailModal image={image} onClose={close} onToggleFavorite={favorite} onAddToCollection={collection} onUpdateTags={() => {}} onUpdatePrompt={() => {}} onDelete={remove} /></MemoryRouter>)
  for(const name of ['复制提示词','用此配方生成','取消喜欢','移入回收站','加入收藏夹','下载图片','用这张图继续修改'])expect(screen.getByRole('button',{name,exact:true})).toBeTruthy()
  expect(screen.queryByRole('button',{name:'配方更多操作'})).toBeNull()
  await user.click(screen.getByRole('button',{name:'取消喜欢'}))
  expect(favorite).toHaveBeenCalledWith(image.id)
  await user.click(screen.getByRole('button',{name:'加入收藏夹'}))
  expect(collection).toHaveBeenCalledWith(image)
  await user.click(screen.getByRole('button', { name: '复制提示词', exact: true }))
  expect(await navigator.clipboard.readText()).toBe(image.prompt)
  expect(screen.getByRole('button',{name:'已复制提示词'})).toBeTruthy()
  await user.click(screen.getByRole('button',{name:'移入回收站',exact:true}))
  expect(screen.getByText('移入回收站？之后可以恢复。')).toBeTruthy()
  expect(remove).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button',{name:'取消',exact:true}))
  expect(remove).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
})

const work: GalleryImage = { ...image, assetType: 'work', workCode: '#F75G25XX80' }

it('copies the card code by keyboard without opening the card', async () => {
  const user = userEvent.setup()
  const open = vi.fn()
  render(<ImageCard image={work} onOpen={open} onToggleFavorite={() => {}} />)

  const copyCode = screen.getByRole('button', { name: '复制图片编号 #F75G25XX80' })
  copyCode.focus()
  expect(document.activeElement).toBe(copyCode)
  await user.keyboard('{Enter}')
  expect(await navigator.clipboard.readText()).toBe(work.workCode)
  expect(open).not.toHaveBeenCalled()
})

it('copies the work code by the detail heading separately from the saved prompt', async () => {
  const user = userEvent.setup()
  const close = vi.fn()
  render(<MemoryRouter><DetailModal image={work} onClose={close} onToggleFavorite={() => {}} onUpdateTags={() => {}} onUpdatePrompt={() => {}} /></MemoryRouter>)

  const copyCode = screen.getByRole('button', { name: '复制图片编号 #F75G25XX80' })
  expect(copyCode.previousElementSibling?.textContent).toBe('作品详情')
  await user.click(copyCode)
  expect(await navigator.clipboard.readText()).toBe(work.workCode)
  await user.click(screen.getByRole('button', { name: '复制提示词', exact: true }))
  expect(await navigator.clipboard.readText()).toBe(work.prompt)
  expect(close).not.toHaveBeenCalled()
})
