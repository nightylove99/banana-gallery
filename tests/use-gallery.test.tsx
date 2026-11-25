import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import React, { useEffect } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'

import { useGallery } from '../src/hooks/useGallery.ts'
import type { GalleryImage } from '../src/types.ts'

function setGlobalValue(name: PropertyKey, value: unknown) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  })
}

function setupDom(images: GalleryImage[]) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://127.0.0.1:4173/',
  })

  setGlobalValue('window', dom.window)
  setGlobalValue('document', dom.window.document)
  setGlobalValue('navigator', dom.window.navigator)
  setGlobalValue('HTMLElement', dom.window.HTMLElement)
  setGlobalValue('IS_REACT_ACT_ENVIRONMENT', true)
  setGlobalValue('fetch', async (input: RequestInfo | URL) => {
    if (String(input).startsWith('/api/images')) {
      return Response.json(images)
    }

    return Response.json({ error: 'not found' }, { status: 404 })
  })

  return dom
}

function buildImage(id: string, assetType: GalleryImage['assetType']): GalleryImage {
  return {
    id,
    filename: `${id}.jpg`,
    prompt: id,
    referenceImages: [],
    tags: [],
    favorited: false,
    createdAt: '2026-06-20T00:00:00.000Z',
    width: 1024,
    height: 1024,
    assetType,
  }
}

test('useGallery：默认打开配方库', async () => {
  setupDom([
    buildImage('work-a', 'work'),
    buildImage('recipe-a', 'recipe'),
  ])

  const snapshots: Array<{
    assetType: GalleryImage['assetType']
    imageIds: string[]
    loading: boolean
  }> = []

  function Probe() {
    const gallery = useGallery()

    useEffect(() => {
      snapshots.push({
        assetType: gallery.assetType,
        imageIds: gallery.images.map((image) => image.id),
        loading: gallery.loading,
      })
    }, [gallery.assetType, gallery.images, gallery.loading])

    return null
  }

  render(<Probe />)

  await waitFor(() => {
    const latest = snapshots.at(-1)
    assert.equal(latest?.loading, false)
  })

  const latest = snapshots.at(-1)
  assert.equal(latest?.assetType, 'recipe')
  assert.deepEqual(latest?.imageIds, ['recipe-a'])

  cleanup()
})

test('收藏保存失败保留原状态，并把失败交给调用者重试', async () => {
  const dom = setupDom([buildImage('work-a', 'work')])
  const originalFetch = globalThis.fetch
  let patches = 0
  setGlobalValue('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      patches += 1
      return Response.json({ error: '暂时无法保存' }, { status: 500 })
    }
    return originalFetch(input, init)
  })
  let gallery: ReturnType<typeof useGallery> | undefined
  function Probe() { const value = useGallery(); useEffect(() => { gallery = value }, [value]); return null }
  render(<Probe />)
  await waitFor(() => assert.equal(gallery?.loading, false))
  await assert.rejects(gallery!.toggleFavorite('work-a'), /暂时无法保存/)
  assert.equal(gallery!.allImages[0].favorited, false)
  assert.equal(patches, 1)
  cleanup()
  dom.window.close()
})
