import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import sharp from 'sharp'
import request from 'supertest'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../server/app'
import { DiskAssetStorage } from '../../server/storage/disk-asset-storage'
import { ThumbnailCache } from '../../server/storage/thumbnails'
import { sha256 } from '../../server/gallery/import-duplicates'
import { normalizeIncomingPng, normalizeIncomingPngFiles, validateIncomingImageSize } from '../../server/gallery/png-intake'

const roots: string[] = []
const thumbnailWarmups: Promise<string>[] = []
let largePng: Buffer
let transparentPng: Buffer
let tinyPng: Buffer
let oversizedPng: Buffer
let oversizedTransparentPng: Buffer
beforeAll(async () => {
  largePng = await sharp({ create: { width: 1300, height: 1300, channels: 4, background: '#b34a21' } }).png({ compressionLevel: 0 }).toBuffer()
  const pixels = await sharp(largePng).raw().toBuffer()
  pixels[pixels.length - 1] = 254
  transparentPng = await sharp(pixels, { raw: { width: 1300, height: 1300, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer()
  tinyPng = await sharp(largePng).resize(2, 2).png().toBuffer()
  expect(largePng.length).toBeGreaterThan(5_000_000)
  oversizedPng = await sharp({ create: { width: 2700, height: 2700, channels: 4, background: '#b34a21' } }).png({ compressionLevel: 0 }).toBuffer()
  const oversizedPixels = await sharp(oversizedPng).raw().toBuffer()
  oversizedPixels[oversizedPixels.length - 1] = 254
  oversizedTransparentPng = await sharp(oversizedPixels, { raw: { width: 2700, height: 2700, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer()
  expect(oversizedPng.length).toBeGreaterThan(25 * 1024 * 1024)
})
afterEach(async () => {
  await Promise.allSettled(thumbnailWarmups.splice(0))
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function setup(extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-png-intake-'))
  roots.push(root)
  const imagesDir = path.join(root, 'images')
  const referencesDir = path.join(root, 'references')
  const storage = new DiskAssetStorage({ imagesDir, referencesDir })
  const cache = new ThumbnailCache(path.join(root, 'cache', 'thumbnails'))
  const app = createApp({
    thumbnailCache: {
      get: cache.get.bind(cache),
      warm: (...args) => {
        const warmup = cache.warm(...args)
        thumbnailWarmups.push(warmup)
        return warmup
      },
    },
    ai: { models: { generateContent: async () => ({ candidates: [] }) } },
    strategy: { mode: 'apiKey', apiKey: 'test' },
    dataFile: path.join(root, 'gallery.json'), imagesDir, referencesDir, assetStorage: storage,
    userAuthMode: 'local', allowServerSideImport: true,
    localAuthSession: { user: { id: 'local', email: 'local@test.local' }, workspace: { id: 'local', name: 'Local' } },
    ...extra,
  })
  return { root, app, storage, imagesDir, referencesDir }
}

async function expectJpeg(file: string) {
  expect(file).toMatch(/\.jpg$/)
  const metadata = await sharp(file).metadata()
  expect(metadata).toMatchObject({ format: 'jpeg', width: 1300, height: 1300 })
  const expected = await sharp(largePng).keepMetadata().jpeg({ quality: 92 }).toBuffer()
  expect(fs.readFileSync(file)).toEqual(expected)
}

describe('new PNG intake', () => {
  it.each(['work', 'references', 'append', 'edit', 'extension', 'markdown'])('accepts a real PNG above 25MiB on %s and rejects an unconvertible batch without persisting files', async kind => {
    const { app, root, imagesDir, referencesDir } = setup()
    const main = await request(app).post('/api/images').attach('image', tinyPng, 'main.png')
    let attempt = 0
    let baseReferences: string[] = []
    const send = (bytes: Buffer) => {
      if (kind === 'work') return request(app).post('/api/images').attach('image', bytes, 'input.png')
      if (kind === 'references') return request(app).post('/api/references/upload').attach('references', largePng, 'first.png').attach('references', bytes, 'input.png')
      if (kind === 'append') return request(app).post(`/api/images/${main.body.id}/references`).attach('references', largePng, 'first.png').attach('references', bytes, 'input.png')
      if (kind === 'edit') return request(app).put(`/api/images/${main.body.id}/references`).field('baseReferences', JSON.stringify(baseReferences)).field('order', '[{"upload":0},{"upload":1}]').attach('references', largePng, 'first.png').attach('references', bytes, 'input.png')
      if (kind === 'extension') return request(app).post('/api/external/gemini-web/import').field('metadata', '{"prompt":"large input","allowDuplicate":true}').attach('image', largePng, 'first.png').attach('references', bytes, 'input.png')
      fs.writeFileSync(path.join(root, 'source.png'), bytes)
      fs.writeFileSync(path.join(root, 'source.md'), '```text\nlarge ' + attempt++ + '\n```\n![[source.png]]')
      return request(app).post('/api/import').send({ markdownPath: path.join(root, 'source.md'), vaultImagesPath: root })
    }
    const response = await send(oversizedPng)
    expect(response.status).toBe(200)
    const directory = ['references', 'append', 'edit', 'extension'].includes(kind) ? referencesDir : imagesDir
    const filename = kind === 'references' ? response.body.filenames.at(-1) : kind === 'append' || kind === 'edit' || kind === 'extension' ? response.body.referenceImages.at(-1) : kind === 'work' ? response.body.filename : fs.readdirSync(imagesDir).find(name => name !== main.body.filename)
    const finalPath = path.join(directory, filename)
    expect(filename).toMatch(/\.jpg$/)
    expect(fs.statSync(finalPath).size).toBeLessThanOrEqual(25 * 1024 * 1024)
    expect(await sharp(finalPath).metadata()).toMatchObject({ format: 'jpeg', width: 2700, height: 2700 })
    await sharp(finalPath, { failOn: 'warning' }).raw().toBuffer()
    if (kind === 'markdown') expect(fs.readFileSync(path.join(root, 'source.png')).equals(oversizedPng)).toBe(true)
    baseReferences = response.body.referenceImages ?? []
    // A rejected batch must remove its earlier converted file and preserve existing references.
    const before = [fs.readdirSync(imagesDir).sort(), fs.readdirSync(referencesDir).sort()]
    const previousImages = (await request(app).get('/api/images')).body
    const denied = await send(oversizedTransparentPng)
    expect(denied.status).toBe(400)
    expect(denied.body.error).toMatch(/透明.*25\s*MiB/)
    expect([fs.readdirSync(imagesDir).sort(), fs.readdirSync(referencesDir).sort()]).toEqual(before)
    expect((await request(app).get('/api/images')).body).toEqual(previousImages)

  })

  it('normalizes Markdown imports without modifying the source file', async () => {
    const { app, root, imagesDir } = setup()
    const source = path.join(root, 'source.png')
    fs.writeFileSync(source, largePng)
    const markdownPath = path.join(root, 'recipes.md')
    fs.writeFileSync(markdownPath, '```text\nproduct photo\n```\n![[source.png]]')
    const response = await request(app).post('/api/import').send({ markdownPath, vaultImagesPath: root })
    expect(response.status).toBe(200)
    expect(response.body.imported).toBe(1)
    await expectJpeg(path.join(imagesDir, fs.readdirSync(imagesDir)[0]))
    expect(sha256(fs.readFileSync(source))).toBe(sha256(largePng))
    expect((await request(app).post('/api/import').send({ markdownPath, vaultImagesPath: root })).body.skipped).toBe(1)
  })
  it('converts a large opaque clipboard PNG on work upload, serves JPEG and persists the final name', async () => {
    const { app, imagesDir, storage } = setup()
    const finalize = vi.spyOn(storage, 'finalizeImage')
    const response = await request(app).post('/api/images').field('prompt', 'test').attach('image', largePng, 'clipboard.png')
    expect(response.status).toBe(200)
    await expectJpeg(path.join(imagesDir, response.body.filename))
    expect(finalize).toHaveBeenCalledWith(response.body.filename)
    expect(fs.readdirSync(imagesDir)).toEqual([response.body.filename])
    const image = await request(app).get(`/api/assets/images/${response.body.filename}`)
    expect(image.headers['content-type']).toMatch(/image\/jpeg/)
    expect((await request(app).get('/api/images')).body[0].filename).toBe(response.body.filename)
  })

  it('converts generation references in order but preserves a single semi-transparent pixel and small PNGs', async () => {
    const { app, referencesDir } = setup()
    const response = await request(app).post('/api/references/upload')
      .attach('references', largePng, 'opaque.png').attach('references', transparentPng, 'alpha.png').attach('references', tinyPng, 'tiny.png')
    expect(response.status).toBe(200)
    const [opaque, alpha, tiny] = response.body.filenames
    await expectJpeg(path.join(referencesDir, opaque))
    expect(fs.readFileSync(path.join(referencesDir, alpha)).equals(transparentPng)).toBe(true)
    expect(fs.readFileSync(path.join(referencesDir, tiny))).toEqual(tinyPng)
  })

  it.each(['post', 'put'] as const)('normalizes detail reference %s before constructing ordered references', async method => {
    const { app, imagesDir, referencesDir } = setup()
    const image = await request(app).post('/api/images').attach('image', tinyPng, 'main.png')
    let edit = request(app)[method](`/api/images/${image.body.id}/references`)
    if (method === 'put') edit = edit.field('baseReferences', '[]').field('order', '[{"upload":0}]')
    const response = await edit.attach('references', largePng, 'ref.png')
    expect(response.status).toBe(200)
    await expectJpeg(path.join(referencesDir, response.body.referenceImages[0]))
    expect(fs.readFileSync(path.join(imagesDir, image.body.filename))).toEqual(tinyPng)
    expect(fs.readdirSync(referencesDir)).toEqual(response.body.referenceImages)
  })

  it('converts extension assets with stable original-input idempotency and truthful stored hashes', async () => {
    const { app, imagesDir, referencesDir } = setup()
    const metadata = { prompt: 'extension', assetType: 'work', requestId: 'png-intake', checkDuplicates: true }
    const submit = (data = metadata) => request(app).post('/api/external/gemini-web/import').field('metadata', JSON.stringify(data))
      .attach('image', largePng, 'image.png').attach('references', largePng, 'ref.png')
    const first = await submit()
    expect(first.status).toBe(200)
    await expectJpeg(path.join(imagesDir, first.body.filename))
    await expectJpeg(path.join(referencesDir, first.body.referenceImages[0]))
    expect(first.body.contentHash).toBe(sha256(fs.readFileSync(path.join(imagesDir, first.body.filename))))
    expect(first.body.referenceHashes).toEqual([sha256(fs.readFileSync(path.join(referencesDir, first.body.referenceImages[0])))])
    const second = await submit()
    expect(second.body.id).toBe(first.body.id)
    const duplicate = await submit({ ...metadata, requestId: 'another-import' })
    expect(duplicate.body.requiresConfirmation).toBe(true)
    expect(duplicate.body.candidates[0].evidence).toContain('图片内容相同')
    expect(fs.readdirSync(imagesDir)).toEqual([first.body.filename])
    expect(fs.readdirSync(referencesDir)).toEqual(first.body.referenceImages)
  })
})

// Valid ancillary chunk before IEND allows exact size boundary and animation-marker fixtures.
function pngChunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const value of body) {
    crc ^= value
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  body.copy(chunk, 4)
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return chunk
}

function paddedPng(bytes: Buffer, size: number) {
  return Buffer.concat([bytes.subarray(0, -12), pngChunk('tEXt', Buffer.alloc(size - bytes.length - 12, 65)), bytes.subarray(-12)])
}

async function normalizeFixture(bytes: Buffer, filename = 'input.png') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-png-unit-'))
  roots.push(root)
  const file = { path: path.join(root, filename), filename, mimetype: 'image/png', size: bytes.length }
  fs.writeFileSync(file.path, bytes)
  await normalizeIncomingPng(file)
  return { root, file }
}

describe('PNG conversion boundaries and failure safety', () => {
  it.each([25 * 1024 * 1024, 100 * 1024 * 1024, 100 * 1024 * 1024 + 1])('checks PNG input size from the actual file (%i)', async size => {
    const { root } = setup()
    const file = path.join(root, 'boundary.png')
    fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'))
    fs.truncateSync(file, size)
    if (size > 100 * 1024 * 1024) await expect(validateIncomingImageSize(file)).rejects.toThrow('100 MiB')
    else await expect(validateIncomingImageSize(file)).resolves.toBe(size)
  })

  it.each([25 * 1024 * 1024, 25 * 1024 * 1024 + 1])('does not grant the PNG limit to a renamed JPEG (%i)', async size => {
    const { root } = setup()
    const file = path.join(root, 'pretend.png')
    fs.writeFileSync(file, await sharp(tinyPng).jpeg().toBuffer())
    fs.truncateSync(file, size)
    if (size > 25 * 1024 * 1024) await expect(validateIncomingImageSize(file)).rejects.toThrow('非 PNG 图片不能超过 25 MiB')
    else await expect(validateIncomingImageSize(file)).resolves.toBe(size)
  })

  it('allows exactly 100MiB for a single original and rejects one byte more', async () => {
    const { app, root, referencesDir } = setup()
    const file = path.join(root, 'boundary.png')
    fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'))
    fs.truncateSync(file, 100 * 1024 * 1024)
    const exact = await request(app).post('/api/references/upload').attach('references', file)
    expect(exact.status).toBe(400)
    // The invalid payload reaches normalization, rather than the raw size rejection.
    expect(exact.body.error).toMatch(/动态或无效 PNG/)
    fs.truncateSync(file, 100 * 1024 * 1024 + 1)
    const above = await request(app).post('/api/references/upload').attach('references', file)
    expect(above.status).toBe(400)
    expect(above.body.error).toContain('100 MiB')
    expect(fs.readdirSync(referencesDir)).toEqual([])
  })

  it('rejects a chunked multipart batch over the total limit without leaving uploads', async () => {
    const { app, referencesDir } = setup()
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing HTTP port')
    try {
      const boundary = 'banana-batch-boundary'
      const upload = http.request({
        host: '127.0.0.1',
        port: address.port,
        method: 'POST',
        path: '/api/references/upload',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      })
      const response = once(upload, 'response')
      const chunk = Buffer.alloc(1024 * 1024)
      for (const name of ['one.png', 'two.png']) {
        upload.write(`--${boundary}\r\nContent-Disposition: form-data; name="references"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`)
        for (let index = 0; index < 51; index++) {
          if (!upload.write(chunk)) await once(upload, 'drain')
        }
        upload.write('\r\n')
      }
      upload.end(`--${boundary}--\r\n`)
      const [result] = await response as [http.IncomingMessage]
      const chunks: Buffer[] = []
      for await (const data of result) chunks.push(data)
      expect(result.statusCode).toBe(413)
      expect(Buffer.concat(chunks).toString()).toContain('101 MiB')
      expect(fs.readdirSync(referencesDir)).toEqual([])
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('rejects a JPEG disguised as PNG above 25MiB over HTTP without retaining it', async () => {
    const { app, referencesDir } = setup()
    const jpeg = await sharp(tinyPng).jpeg().toBuffer()
    const disguised = Buffer.concat([jpeg, Buffer.alloc(25 * 1024 * 1024 + 1 - jpeg.length)])
    const response = await request(app).post('/api/references/upload').attach('references', disguised, { filename: 'fake.png', contentType: 'image/png' })
    expect(response.status).toBe(400)
    expect(response.body.error).toContain('非 PNG')
    expect(fs.readdirSync(referencesDir)).toEqual([])
  })

  it.each(['failed', 'not-smaller', 'still-large', 'animated'] as const)('rejects an oversized PNG after %s conversion and removes uncommitted copies', async kind => {
    const { root } = setup()
    let bytes = oversizedPng
    if (kind === 'animated') {
      const acTL = Buffer.alloc(8)
      acTL.writeUInt32BE(2)
      bytes = Buffer.concat([bytes.subarray(0, 33), pngChunk('acTL', acTL), bytes.subarray(33)])
    }
    const file = { path: path.join(root, 'input.png'), filename: 'input.png', mimetype: 'image/png', size: 1 }
    fs.writeFileSync(file.path, bytes)
    if (kind === 'failed') vi.spyOn(sharp.prototype, 'toBuffer').mockRejectedValueOnce(new Error('encoder failed'))
    if (kind === 'not-smaller') vi.spyOn(sharp.prototype, 'toBuffer').mockResolvedValueOnce(Buffer.alloc(bytes.length + 1) as never)
    if (kind === 'still-large') vi.spyOn(sharp.prototype, 'toBuffer').mockResolvedValueOnce(Buffer.alloc(25 * 1024 * 1024 + 1) as never)
    const message = kind === 'failed' ? '转换失败' : kind === 'not-smaller' ? '未能减小' : kind === 'animated' ? '动态' : '转换后仍超过'
    await expect(normalizeIncomingPngFiles([file])).rejects.toThrow(message)
    expect(fs.existsSync(file.path)).toBe(false)
    expect(fs.readdirSync(root).filter(name => /input|\.jpg|\.tmp/.test(name))).toEqual([])
  })
  it.each([4_999_999, 5_000_000, 5_000_001])('uses a strict 5,000,000 byte boundary (%i)', async size => {
    const bytes = paddedPng(tinyPng, size)
    const { file } = await normalizeFixture(bytes)
    expect(file.filename.endsWith('.jpg')).toBe(size > 5_000_000)
    expect((await sharp(file.path).metadata()).width).toBe(2)
    if (size <= 5_000_000) expect(sha256(fs.readFileSync(file.path))).toBe(sha256(bytes))
  })

  it('also converts PNGs without an alpha channel and preserves EXIF orientation', async () => {
    const bytes = await sharp(largePng).removeAlpha().withMetadata({ orientation: 6 }).png({ compressionLevel: 0 }).toBuffer()
    const { file } = await normalizeFixture(bytes)
    expect(file).toMatchObject({ mimetype: 'image/jpeg' })
    expect(fs.statSync(file.path).size).toBe(file.size)
    expect(await sharp(file.path).metadata()).toMatchObject({ format: 'jpeg', width: 1300, height: 1300, orientation: 6 })
  })

  it('preserves dynamic PNG even when its first frame is opaque', async () => {
    const acTL = Buffer.alloc(8)
    acTL.writeUInt32BE(2)
    const animation = Buffer.concat([largePng.subarray(0, 33), pngChunk('acTL', acTL), largePng.subarray(33)])
    const { file } = await normalizeFixture(animation)
    expect(sha256(fs.readFileSync(file.path))).toBe(sha256(animation))
    expect(file.filename).toBe('input.png')
  })

  it('does not trust a PNG extension and keeps malformed inputs', async () => {
    const bytes = Buffer.alloc(5_000_001)
    const { root, file } = await normalizeFixture(bytes)
    expect(file.filename).toBe('input.png')
    expect(fs.readdirSync(root)).toEqual(['input.png'])
    const corrupt = Buffer.from(largePng)
    corrupt.fill(0, 64, 200)
    const second = await normalizeFixture(corrupt)
    expect(second.file.filename).toBe('input.png')
    expect(sha256(fs.readFileSync(second.file.path))).toBe(sha256(corrupt))
  })

  it('keeps the PNG when JPEG would be larger', async () => {
    vi.spyOn(sharp.prototype, 'toBuffer').mockResolvedValueOnce(Buffer.alloc(largePng.length + 1) as never)
    const { root, file } = await normalizeFixture(largePng)
    expect(file.filename).toBe('input.png')
    expect(fs.readdirSync(root)).toEqual(['input.png'])
  })

  it.each(['writeFile', 'rename', 'unlink'] as const)('preserves the original and cleans temporary JPEGs when %s fails', async operation => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-png-failure-'))
    roots.push(root)
    const file = { path: path.join(root, 'input.png'), filename: 'input.png', mimetype: 'image/png', size: largePng.length }
    fs.writeFileSync(file.path, largePng)
    vi.spyOn(fs.promises, operation).mockRejectedValueOnce(new Error('disk failure'))
    await normalizeIncomingPng(file)
    expect(file.filename).toBe('input.png')
    expect(sha256(fs.readFileSync(file.path))).toBe(sha256(largePng))
    expect(fs.readdirSync(root)).toEqual(['input.png'])
  })
})
