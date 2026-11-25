import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { Agent, fetch } from 'undici'
import { createApp } from '../server/app'
import { generationTasksFileFor, generationTasksFilename } from '../server/gallery/generation-task-storage'
import { JsonGalleryRepository } from '../server/gallery/json-gallery-repository'
import type { AssetStorage } from '../server/storage/asset-storage'
import type { GenerationTask } from '../src/types'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const pageSize = 120
const monitorResolutionMs = 1
const protectedPaths = ['gallery-data.json', 'gallery-data.json.lock', generationTasksFilename, '.pending-reference-uploads.json', 'public/images', 'public/references', 'cache', 'backups']
const getRoutes = new Set(['/api/images', '/api/gallery/state', '/api/generation-tasks', '/api/personal/storage'])

interface Options {
  sourceDir?: string
  runs?: number
  out?: string
}

interface StorageSummary {
  originals: { files: number; bytes: number }
  references: { files: number; bytes: number }
}

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
}

async function realPathIfPresent(file: string) {
  try {
    return await fs.realpath(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}

async function galleryPaths(sourceDir: string) {
  // Also protect the daily library if the source is a fixture in a linked worktree.
  const worktrees = git('worktree', 'list', '--porcelain', '-z').split('\0')
    .filter(entry => entry.startsWith('worktree ')).map(entry => entry.slice('worktree '.length))
  const paths = [...new Set([sourceDir, repoRoot, ...worktrees])].flatMap(root =>
    protectedPaths.map(file => path.resolve(root, file)))
  return (await Promise.all(paths.map(async file => [
    file,
    await realPathIfPresent(file),
    // A protected path might not exist yet, but its parent could be a symlink.
    path.join(await realPathIfPresent(path.dirname(file)) ?? path.dirname(file), path.basename(file)),
  ]))).flat().filter(file => file !== undefined)
}

function assertOutsideGallery(target: string, gallery: string[]) {
  // Default macOS/Windows volumes can resolve differently cased names to the same entry.
  const comparable = (file: string) => process.platform === 'linux' ? file : file.toLowerCase()
  const inside = gallery.some(root => {
    const relative = path.relative(comparable(root), comparable(target))
    return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  })
  if (inside) throw new Error(`Refusing to write inside a protected gallery path: ${target}`)
}

async function resolveOutput(out: string, gallery: string[]) {
  const requested = path.resolve(out)
  assertOutsideGallery(requested, gallery)
  const target = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested))
  assertOutsideGallery(target, gallery)
  const current = await fs.lstat(target).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (current && (!current.isFile() || current.nlink !== 1)) {
    throw new Error('--out must not point to a symlink, hard link, directory, or special file')
  }
  return target
}

async function writeOutput(target: string, json: string) {
  const staging = await fs.mkdtemp(path.join(path.dirname(target), '.banana-perf-out-'))
  try {
    const stagedFile = path.join(staging, 'baseline.json')
    await fs.writeFile(stagedFile, json + '\n')
    await fs.rename(stagedFile, target)
  } finally {
    await fs.rm(staging, { force: true, recursive: true })
  }
}

function readOnlyMedia(imagesDir: string, referencesDir: string, uploads: string): AssetStorage {
  const rejectWrite = () => { throw new Error('Baseline media is read-only') }
  return {
    ensureDirectories: () => {},
    // Multer creates its destination during createApp; never give it a source directory.
    getImagesDir: () => uploads,
    getReferencesDir: () => uploads,
    getImagePath: filename => path.join(imagesDir, filename),
    getReferencePath: filename => path.join(referencesDir, filename),
    copyImageFrom: rejectWrite,
    finalizeImage: rejectWrite,
    finalizeReferences: rejectWrite,
    deleteImage: rejectWrite,
    deleteReferences: rejectWrite,
  }
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return {
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  }
}

async function sampleScene<T>(runs: number, sample: () => Promise<T>, signal?: AbortSignal) {
  const histogram = monitorEventLoopDelay({ resolution: monitorResolutionMs })
  histogram.enable()
  try {
    // Arm the monitor before synchronous repository work; let a delayed tick land afterward.
    await delay(5, undefined, { signal })
    histogram.reset()
    const samples: T[] = []
    for (let run = 0; run < runs; run++) {
      signal?.throwIfAborted()
      samples.push(await sample())
    }
    await delay(5, undefined, { signal })
    return {
      samples,
      eventLoopDelayMs: {
        p95: histogram.percentile(95) / 1e6,
        p99: histogram.percentile(99) / 1e6,
        max: histogram.max / 1e6,
      },
    }
  } finally {
    histogram.disable()
  }
}

function historyScope(tasks: GenerationTask[]) {
  const workspaces = new Map<string, { scope: GenerationTask['scope']; count: number }>()
  for (const { scope } of tasks) {
    const group = workspaces.get(scope.workspaceId)
    if (group) group.count++
    else workspaces.set(scope.workspaceId, { scope, count: 1 })
  }
  const configured = process.env.BANANA_GALLERY_DEFAULT_WORKSPACE_ID
  const largest = [...workspaces.values()].sort((a, b) => b.count - a.count)[0]
  return (configured ? workspaces.get(configured) : undefined)?.scope ?? largest?.scope
}

async function inspectDataset(dataFile: string) {
  const catalog = new JsonGalleryRepository(dataFile)
  const jsonBytes = (await fs.stat(dataFile)).size
  const images = await catalog.listImages()
  const history = (await catalog.readResources()).generationTasks ?? []
  const activeImages = images.filter(image => !image.deletedAt)
  const works = activeImages.filter(image => image.assetType === 'work')
  const target = works[0] ?? activeImages[0]
  if (!target) throw new Error('The source gallery needs a non-trashed entry for the PATCH benchmark')
  return {
    target,
    scope: historyScope(history),
    dataset: {
      jsonBytes,
      imageCount: images.length,
      activeImageCount: activeImages.length,
      workCount: works.length,
      historyCount: history.length,
    },
  }
}

export async function runPerfBaseline(
  { sourceDir = repoRoot, runs = 5, out }: Options = {},
  signal?: AbortSignal,
) {
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer')
  const source = await fs.realpath(sourceDir)
  const gallery = await galleryPaths(source)
  const output = out === undefined ? undefined : await resolveOutput(out, gallery)
  const tempDir = await fs.realpath(os.tmpdir())
  assertOutsideGallery(tempDir, gallery)
  signal?.throwIfAborted()
  const sandbox = await fs.mkdtemp(path.join(tempDir, 'banana-perf-baseline-'))
  try {
    const dataFile = path.join(sandbox, 'gallery-data.json')
    const sourceIndex = path.join(source, 'gallery-data.json')
    await fs.copyFile(sourceIndex, dataFile)
    await fs.copyFile(generationTasksFileFor(sourceIndex), generationTasksFileFor(dataFile)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    const { target, scope, dataset } = await inspectDataset(dataFile)
    const uploads = path.join(sandbox, 'uploads')
    const backupDir = path.join(sandbox, 'backups')
    const cacheDir = path.join(sandbox, 'cache', 'thumbnails')
    await Promise.all([uploads, backupDir, cacheDir].map(dir => fs.mkdir(dir, { recursive: true })))
    // Storage summary intentionally skips symlink roots. Pass canonical paths for actual stat work.
    const imagesDir = await realPathIfPresent(path.join(source, 'public', 'images')) ?? uploads
    const referencesDir = await realPathIfPresent(path.join(source, 'public', 'references')) ?? uploads
    const repository = new JsonGalleryRepository(dataFile)
    const app = createApp({
      ai: { models: { generateContent: async () => { throw new Error('Generation is disabled in the baseline') } } },
      strategy: { mode: 'googleUnavailable' },
      imageGenerationProviders: {},
      dataFile,
      backupDir,
      imagesDir,
      referencesDir,
      galleryRepository: repository,
      assetStorage: readOnlyMedia(imagesDir, referencesDir, uploads),
      userAuthMode: 'local',
      localAuthSession: {
        user: { id: scope?.userId ?? 'local-user', email: 'baseline@localhost' },
        workspace: { id: scope?.workspaceId ?? 'local-workspace', name: 'Performance baseline' },
      },
      allowServerSideImport: false,
    })
    // Do not start the queue, thumbnail warmup, or automatic backup workers.
    const token = randomUUID()
    const patchPath = `/api/images/${encodeURIComponent(target.id)}`
    const server = createServer((req, res) => {
      const route = req.url?.split('?', 1)[0] ?? ''
      const allowed = req.method === 'GET' ? getRoutes.has(route) : req.method === 'PATCH' && route === patchPath
      if (allowed && req.headers['x-banana-perf-token'] === token) app(req, res)
      else res.writeHead(404).end()
    })
    const agent = new Agent({ connections: 1 })
    let scenarios
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No loopback port assigned')
      const request = async (route: string, expected = 200, headers?: Record<string, string>, favorited?: boolean) => {
        const start = performance.now()
        signal?.throwIfAborted()
        const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
          dispatcher: agent,
          redirect: 'error',
          // Let an admitted request finish before removing its sandbox, even on SIGINT.
          method: favorited === undefined ? 'GET' : 'PATCH',
          headers: { 'x-banana-perf-token': token, ...headers },
          body: favorited === undefined ? undefined : JSON.stringify({ favorited }),
        })
        const body = Buffer.from(await response.arrayBuffer())
        const ms = performance.now() - start
        if (response.status !== expected) {
          throw new Error(`${favorited === undefined ? 'GET' : 'PATCH'} ${route}: expected HTTP ${expected}, got ${response.status}`)
        }
        return { ms, bytes: body.length, body, etag: response.headers.get('etag') }
      }
      const patch = (favorited: boolean) => request(patchPath, 200, { 'content-type': 'application/json' }, favorited)

      const pagination = await sampleScene(runs, async () => {
        const start = performance.now()
        const cursors = new Set<string>()
        let cursor: string | null = null
        let pages = 0, firstPageMs = 0, responseBytes = 0
        do {
          const params = new URLSearchParams({ limit: String(pageSize) })
          if (cursor) params.set('cursor', cursor)
          const response = await request(`/api/images?${params}`)
          const page: { items: unknown[]; nextCursor: string | null } = JSON.parse(response.body.toString())
          if (!Array.isArray(page.items) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) {
            throw new Error('Unexpected gallery pagination response')
          }
          if (++pages === 1) firstPageMs = performance.now() - start
          responseBytes += response.bytes
          cursor = page.nextCursor
          if (cursor) {
            if (cursors.has(cursor)) throw new Error('Repeated gallery cursor')
            cursors.add(cursor)
          }
        } while (cursor)
        return { pages, firstPageMs, fullMs: performance.now() - start, responseBytes }
      }, signal)

      // Back-to-back requests measure the unchanged poll, not its 10s scheduling interval.
      const state = await sampleScene(runs, () => request('/api/gallery/state').then(({ ms, bytes }) => ({ ms, bytes })), signal)
      const favorite = await sampleScene(runs, async () => {
        const toggle = await patch(!target.favorited)
        const restore = await patch(target.favorited)
        if (JSON.parse(toggle.body.toString()).favorited !== !target.favorited ||
            JSON.parse(restore.body.toString()).favorited !== target.favorited) {
          throw new Error('PATCH did not toggle and restore the favorite flag')
        }
        const singleStart = performance.now()
        await repository.readResources()
        const readResourcesSingleMs = performance.now() - singleStart
        const tripleStart = performance.now()
        for (let read = 0; read < 3; read++) await repository.readResources()
        return {
          patchToggleMs: toggle.ms,
          patchRestoreMs: restore.ms,
          readResourcesSingleMs,
          readResourcesTripleMs: performance.now() - tripleStart,
        }
      }, signal)
      const historyPoll = await sampleScene(runs, async () => {
        const initial = await request('/api/generation-tasks')
        if (!initial.etag) throw new Error('Missing history ETag')
        const conditionalHeaders = { 'if-none-match': initial.etag }
        const unchanged = await request('/api/generation-tasks', 304, conditionalHeaders)
        await patch(!target.favorited)
        const afterPatch = await request('/api/generation-tasks', 304, conditionalHeaders)
        if (initial.etag !== afterPatch.etag) throw new Error('Favorite PATCH unexpectedly changed the history ETag')
        await patch(target.favorited)
        const { tasks }: { tasks: unknown[] } = JSON.parse(initial.body.toString())
        return {
          tasks: tasks.length,
          initialMs: initial.ms, initialBytes: initial.bytes,
          unchangedMs: unchanged.ms, unchangedBytes: unchanged.bytes,
          afterPatchMs: afterPatch.ms, afterPatchBytes: afterPatch.bytes,
        }
      }, signal)
      const storage = await sampleScene(runs, async () => {
        const { ms, body } = await request('/api/personal/storage')
        const { originals, references }: StorageSummary = JSON.parse(body.toString())
        return { ms, scanned: { originals, references } }
      }, signal)

      scenarios = {
        gallery_full_pagination: {
          pageSize, pages: pagination.samples[0].pages,
          firstPageMs: summarize(pagination.samples.map(sample => sample.firstPageMs)),
          fullMs: summarize(pagination.samples.map(sample => sample.fullMs)),
          responseBytes: summarize(pagination.samples.map(sample => sample.responseBytes)),
          eventLoopDelayMs: pagination.eventLoopDelayMs,
        },
        gallery_state_poll: {
          latencyMs: summarize(state.samples.map(sample => sample.ms)),
          responseBytes: summarize(state.samples.map(sample => sample.bytes)),
          eventLoopDelayMs: state.eventLoopDelayMs,
        },
        favorite_patch_and_queue_idle: {
          patchToggleMs: summarize(favorite.samples.map(sample => sample.patchToggleMs)),
          patchRestoreMs: summarize(favorite.samples.map(sample => sample.patchRestoreMs)),
          readResourcesSingleMs: summarize(favorite.samples.map(sample => sample.readResourcesSingleMs)),
          readResourcesTripleMs: summarize(favorite.samples.map(sample => sample.readResourcesTripleMs)),
          eventLoopDelayMs: favorite.eventLoopDelayMs,
        },
        generation_history_poll: {
          initial200: {
            tasks: historyPoll.samples[0].tasks,
            latencyMs: summarize(historyPoll.samples.map(sample => sample.initialMs)),
            responseBytes: summarize(historyPoll.samples.map(sample => sample.initialBytes)),
          },
          conditional304: {
            latencyMs: summarize(historyPoll.samples.map(sample => sample.unchangedMs)),
            responseBytes: summarize(historyPoll.samples.map(sample => sample.unchangedBytes)),
          },
          afterPatch304: {
            latencyMs: summarize(historyPoll.samples.map(sample => sample.afterPatchMs)),
            responseBytes: summarize(historyPoll.samples.map(sample => sample.afterPatchBytes)),
          },
          eventLoopDelayMs: historyPoll.eventLoopDelayMs,
        },
        storage_summary: {
          latencyMs: summarize(storage.samples.map(sample => sample.ms)),
          scanned: storage.samples[0].scanned,
          eventLoopDelayMs: storage.eventLoopDelayMs,
        },
      }
    } finally {
      try {
        await agent.destroy()
      } finally {
        if (server.listening) await new Promise<void>((resolve, reject) =>
          server.close(error => error ? reject(error) : resolve()))
      }
    }
    const result = {
      gitCommit: git('rev-parse', 'HEAD').trim(),
      runs,
      eventLoopResolutionMs: monitorResolutionMs,
      dataset,
      scenarios,
    }
    signal?.throwIfAborted()
    if (output) await writeOutput(output, JSON.stringify(result, null, 2))
    return result
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true })
  }
}

function printBaseline(result: Awaited<ReturnType<typeof runPerfBaseline>>) {
  const { dataset } = result
  console.log(`Commit: ${result.gitCommit} | Samples/scenario: ${result.runs} | JSON: ${dataset.jsonBytes} B | Gallery: ${dataset.imageCount} entries (${dataset.workCount} active works) | History: ${dataset.historyCount}`)
  console.log('\n| Scenario | Measurement | Median | p95 | p99 | Max |')
  console.log('| --- | --- | ---: | ---: | ---: | ---: |')
  const row = (scenario: string, label: string, values: { median?: number; p95: number; p99?: number; max?: number }) => {
    const format = (value?: number) => value === undefined ? '—' : value.toFixed(label.endsWith('(ms)') ? 3 : 0)
    console.log(`| ${scenario} | ${label} | ${format(values.median)} | ${format(values.p95)} | ${format(values.p99)} | ${format(values.max)} |`)
  }
  for (const [name, scene] of Object.entries(result.scenarios)) {
    for (const [key, metric] of Object.entries(scene)) {
      if (typeof metric !== 'object' || metric === null || key === 'eventLoopDelayMs') continue
      if ('p95' in metric) {
        row(name, key.endsWith('Ms') ? `${key.slice(0, -2)} (ms)` : `${key} (B)`, metric)
      } else if ('latencyMs' in metric && 'responseBytes' in metric) {
        row(name, `${key} latency (ms)`, metric.latencyMs)
        row(name, `${key} body (B)`, metric.responseBytes)
      }
    }
    row(name, 'Event loop delay (ms)', scene.eventLoopDelayMs)
  }
  console.log('\n' + JSON.stringify(result, null, 2))
}

async function main() {
  const { values } = parseArgs({
    options: {
      'source-dir': { type: 'string' },
      runs: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    console.log('Usage: npm run perf:baseline -- [--source-dir <dir>] [--runs <n>] [--out <file>]')
    console.log('Defaults: this repository, 5 samples per scenario. The output parent directory must exist.')
    return
  }
  const controller = new AbortController()
  const interrupt = () => { process.exitCode = 130; controller.abort(new Error('Baseline interrupted')) }
  const terminate = () => { process.exitCode = 143; controller.abort(new Error('Baseline terminated')) }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    printBaseline(await runPerfBaseline({
      sourceDir: values['source-dir'],
      runs: values.runs === undefined ? undefined : Number(values.runs),
      out: values.out,
    }, controller.signal))
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode ||= 1
  })
}
