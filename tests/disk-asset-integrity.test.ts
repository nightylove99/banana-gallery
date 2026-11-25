import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import type { GalleryImage } from '../src/types'
import { inspectGalleryDiskAssets } from '../server/gallery/disk-asset-integrity'

describe('inspectGalleryDiskAssets', () => {
  it('主图缺失时返回记录', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-int-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const imagesDir = path.join(dir, 'images')
    const refsDir = path.join(dir, 'references')
    fs.mkdirSync(imagesDir, { recursive: true })
    fs.mkdirSync(refsDir, { recursive: true })

    const images: GalleryImage[] = [
      {
        id: 'a',
        filename: 'missing.jpg',
        prompt: 'p',
        referenceImages: [],
        tags: [],
        favorited: false,
        createdAt: new Date().toISOString(),
        width: 1,
        height: 1,
        assetType: 'work',
      },
    ]

    const { missing } = inspectGalleryDiskAssets({ images }, imagesDir, refsDir)
    assert.equal(missing.length, 1)
    assert.equal(missing[0]?.kind, 'images')
    assert.equal(missing[0]?.filename, 'missing.jpg')
  })

  it('主图与参考图均存在时为空', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-int-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const imagesDir = path.join(dir, 'images')
    const refsDir = path.join(dir, 'references')
    fs.mkdirSync(imagesDir, { recursive: true })
    fs.mkdirSync(refsDir, { recursive: true })
    fs.writeFileSync(path.join(imagesDir, 'ok.jpg'), Buffer.from([0xff, 0xd8, 0xff]))
    fs.writeFileSync(path.join(refsDir, 'ref_ok.jpg'), Buffer.from([0xff, 0xd8, 0xff]))

    const images: GalleryImage[] = [
      {
        id: 'b',
        filename: 'ok.jpg',
        prompt: 'p',
        referenceImages: ['ref_ok.jpg'],
        tags: [],
        favorited: false,
        createdAt: new Date().toISOString(),
        width: 1,
        height: 1,
        assetType: 'work',
      },
    ]

    const { missing } = inspectGalleryDiskAssets({ images }, imagesDir, refsDir)
    assert.equal(missing.length, 0)
  })
})

describe('verify-gallery-assets CLI', () => {
  for (const [label, data, expected, required] of [
    ['unfiled task result', { images: [], resources: { generationTasks: [{ id: 'job', input: { referenceFilenames: [] }, result: { filename: 'task.png' } }] } }, 1, /task\.png/],
    ['reference library version', { images: [], resources: { referenceAssets: [{ id: 'asset', versions: [{ filename: 'version.png' }] }] } }, 1, /version\.png/],
    ['unsafe normalized index', { images: [{ id: 'broken' }] }, 1, /索引/],
    ['interrupted purge', { images: [{ id: 'purging', filename: 'gone.png', prompt: 'p', purgePending: true }] }, 0, /OK/],
    ['live reference shared with a pending purge', { images: [{ id: 'purging', filename: 'shared.png', prompt: 'p', purgePending: true }, { id: 'live', filename: 'shared.png', prompt: 'p' }] }, 1, /shared\.png/],
  ] as const) {
    it(`checks ${label}`, async t => {
      const { spawnSync } = await import('node:child_process')
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-int-cli-'))
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
      fs.writeFileSync(path.join(dir, 'gallery-data.json'), JSON.stringify(data))
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/verify-gallery-assets.ts'], {
        env: { ...process.env, BANANA_GALLERY_DATA_DIR: dir, BANANA_GALLERY_BACKUP_DIR: path.join(dir, 'backups') },
        encoding: 'utf8',
      })
      assert.equal(result.status, expected, result.stdout + result.stderr)
      assert.match(result.stdout + result.stderr, required)
    })
  }
})
