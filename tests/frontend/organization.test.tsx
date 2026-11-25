// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { OrganizationBar } from '../../src/components/OrganizationBar'
import type { GalleryImage } from '../../src/types'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const images: GalleryImage[] = Array.from({ length: 3 }, (_, i) => ({
  id: String(i), filename: 'a.png', prompt: 'same prompt', referenceImages: [], tags: [],
  favorited: false, createdAt: '2026-09-11', assetType: 'recipe', width: 1, height: 1,
}))

function Harness({ onChanged = () => {} }: { onChanged?: (image: GalleryImage) => void }) {
  const [selected, onSelected] = useState(new Map<string, number>())
  const [selecting, onSelecting] = useState(true)
  return <OrganizationBar images={images} allImages={images} loadingMore={false} selected={selected}
    onSelected={onSelected} selecting={selecting} onSelecting={onSelecting} onChanged={onChanged}
    groups={[]} groupId="" reloadGroups={async () => {}} />
}

it('adds tags from the dock and retries only the failed item with its refreshed version', async () => {
  const changed = vi.fn()
  const requests: Array<{ targets: Array<{ id: string; version: number }> }> = []
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (!init?.body) return Response.json({ ...images[1], version: 2 })
    const body = JSON.parse(String(init.body))
    requests.push(body)
    return Response.json({ results: body.targets.map((target: { id: string }) => (
      target.id === '1' && requests.length === 1
        ? { id: target.id, ok: false, error: '版本冲突' }
        : { id: target.id, ok: true, image: { ...images[Number(target.id)], tags: ['portrait'], version: 3 } }
    )) })
  })
  render(<Harness onChanged={changed} />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '全选当前' }))
  const dock = within(screen.getByRole('group', { name: '所选条目操作' }))
  await user.click(dock.getByRole('button', { name: '标签' }))
  await user.type(dock.getByLabelText('批量标签'), 'portrait')
  await user.click(dock.getByRole('button', { name: '添加' }))
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
  expect(screen.getByText('已选 1 项')).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain('失败 1 项')
  await user.click(screen.getByRole('button', { name: '重试失败项' }))
  await waitFor(() => expect(screen.getByText('已选 0 项')).toBeTruthy())
  expect(requests).toMatchObject([
    { targets: images.map(image => ({ id: image.id, version: 0 })), action: { type: 'addTags', tags: ['portrait'] } },
    { targets: [{ id: '1', version: 2 }], action: { type: 'addTags', tags: ['portrait'] } },
  ])
})

it('only enables comparison for a valid selection and exits from the compact selection bar', async () => {
  render(<Harness />)
  const user = userEvent.setup()
  const compare = screen.getByRole<HTMLButtonElement>('button', { name: '对比' })
  expect(compare.disabled).toBe(true)
  await user.click(screen.getByRole('button', { name: '全选当前' }))
  expect(compare.disabled).toBe(false)
  await user.click(compare)
  expect(await screen.findByRole('dialog', { name: /对比/ })).toBeTruthy()
  await user.keyboard('{Escape}')
  await user.click(screen.getByRole('button', { name: '取消全选' }))
  expect(compare.disabled).toBe(true)
  await user.click(screen.getByRole('button', { name: '退出多选' }))
  expect(screen.queryByRole('group', { name: '所选条目操作' })).toBeNull()
})
