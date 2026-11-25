import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { runPerfBaseline } from '../../scripts/perf-baseline'
import type { GalleryImage, GenerationTask } from '../../src/types'

it('samples the real app against a disposable copy without changing the source gallery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'banana-perf-test-'))
  try {
    const sourceDir = path.join(root, 'source')
    const tempDir = path.join(root, 'temp')
    const imagesDir = path.join(sourceDir, 'public', 'images')
    const referencesDir = path.join(sourceDir, 'public', 'references')
    await fs.mkdir(tempDir)
    await fs.mkdir(imagesDir, { recursive: true })
    await fs.mkdir(referencesDir, { recursive: true })
    vi.stubEnv('TMPDIR', tempDir)
    vi.stubEnv('TEMP', tempDir)
    const createdAt = '2026-01-01T00:00:00.000Z'
    const images: GalleryImage[] = [
      { id: 'one', filename: 'one.png', prompt: 'test', referenceImages: ['ref.png'], tags: [],
        favorited: false, assetType: 'work', createdAt, width: 1, height: 1 },
      { id: 'two', filename: 'two.png', prompt: 'recipe', referenceImages: [], tags: [],
        favorited: true, assetType: 'recipe', createdAt, width: 1, height: 1 },
    ]
    const job: GenerationTask = {
      id: 'task', key: 'key', scope: { workspaceId: 'fixture-workspace', userId: 'fixture-user' },
      input: { prompt: 'test', referenceFilenames: [], provider: 'google', model: 'test', aspectRatio: '1:1' },
      status: 'queued', createdAt, updatedAt: createdAt,
    }
    const sourceIndex = path.join(sourceDir, 'gallery-data.json')
    const original = JSON.stringify({ images, resources: { generationTasks: [job] } })
    await fs.writeFile(sourceIndex, original)
    await fs.writeFile(path.join(imagesDir, 'one.png'), 'original')
    await fs.writeFile(path.join(referencesDir, 'ref.png'), 'reference')

    const out = path.join(root, 'baseline.json')
    const result = await runPerfBaseline({ sourceDir, runs: 2, out })
    expect(JSON.parse(await fs.readFile(out, 'utf8'))).toEqual(result)
    expect(result.dataset).toMatchObject({ jsonBytes: Buffer.byteLength(original), imageCount: 2, workCount: 1, historyCount: 1 })
    const { gallery_full_pagination, gallery_state_poll, favorite_patch_and_queue_idle,
      generation_history_poll, storage_summary } = result.scenarios
    expect(gallery_full_pagination.pages).toBe(1)
    expect(gallery_full_pagination.firstPageMs.p95).toBeGreaterThan(0)
    expect(gallery_state_poll.responseBytes.median).toBeGreaterThan(0)
    expect(favorite_patch_and_queue_idle.readResourcesTripleMs.p95).toBeGreaterThan(0)
    expect(generation_history_poll.initial200.tasks).toBe(1)
    expect(generation_history_poll.conditional304.responseBytes.p95).toBe(0)
    expect(generation_history_poll.afterPatch304.responseBytes.p95).toBe(0)
    expect(storage_summary.scanned).toEqual({ originals: { files: 1, bytes: 8 }, references: { files: 1, bytes: 9 } })
    for (const scene of Object.values(result.scenarios)) {
      expect(scene.eventLoopDelayMs.p99).toBeGreaterThanOrEqual(scene.eventLoopDelayMs.p95)
      expect(scene.eventLoopDelayMs.max).toBeGreaterThan(0)
    }

    await expect(runPerfBaseline({ sourceDir, runs: 1, out: sourceIndex })).rejects.toThrow(/protected gallery/)
    await fs.symlink(imagesDir, path.join(root, 'media-alias'), 'dir')
    await expect(runPerfBaseline({ sourceDir, runs: 1, out: path.join(root, 'media-alias', 'new.json') }))
      .rejects.toThrow(/protected gallery/)
    expect(await fs.readFile(sourceIndex, 'utf8')).toBe(original)
    expect(await fs.readdir(sourceDir)).toEqual(['gallery-data.json', 'public'])
    expect(await fs.readdir(imagesDir)).toEqual(['one.png'])
    expect(await fs.readdir(referencesDir)).toEqual(['ref.png'])
    expect(await fs.readFile(path.join(imagesDir, 'one.png'), 'utf8')).toBe('original')
    expect(await fs.readFile(path.join(referencesDir, 'ref.png'), 'utf8')).toBe('reference')

    const emptySource = path.join(root, 'empty')
    await fs.mkdir(emptySource)
    await fs.writeFile(path.join(emptySource, 'gallery-data.json'), '{"images":[]}')
    await expect(runPerfBaseline({ sourceDir: emptySource, runs: 1 })).rejects.toThrow(/non-trashed entry/)
    expect(await fs.readdir(tempDir)).toEqual([])
  } finally {
    vi.unstubAllEnvs()
    await fs.rm(root, { recursive: true, force: true })
  }
})
