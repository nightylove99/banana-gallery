import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import request from 'supertest'
import { afterEach, expect, it } from 'vitest'
import { createApp } from '../../server/app'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'banana-intake-regression-'))
  roots.push(root)
  const imagesDir = path.join(root, 'images')
  const referencesDir = path.join(root, 'references')
  const dataFile = path.join(root, 'gallery.json')
  await fs.writeFile(dataFile, JSON.stringify({ images: [] }))
  const appOptions: Parameters<typeof createApp>[0] = {
    ai: { models: { generateContent: async () => ({ candidates: [] }) } },
    strategy: { mode: 'googleUnavailable' }, dataFile, imagesDir, referencesDir,
    userAuthMode: 'local', allowServerSideImport: true,
    localAuthSession: { user: { id: 'test', email: 'test@local' }, workspace: { id: 'test', name: 'Test' } },
    thumbnailCache: { get: async source => source, warm: async source => source },
  }
  return { root, app: createApp(appOptions), appOptions, imagesDir, referencesDir, dataFile }
}

const makeImage = (background: string) => sharp({ create: { width: 64, height: 64, channels: 3, background } })
const entry = (prompt: string, attachment: string) => '\x60\x60\x60text\n' + prompt + '\n\x60\x60\x60\n![[' + attachment + ']]\n'

it('releases an uploaded WebP original so it can be purged without restarting', async () => {
  const { app, imagesDir } = await fixture()
  const webp = await makeImage('red').webp().toBuffer()
  const { body: work } = await request(app).post('/api/images').attach('image', webp, 'original.webp').expect(200)
  expect(await fs.readFile(path.join(imagesDir, work.filename))).toEqual(webp)
  await request(app).delete('/api/images/' + work.id).expect(200)
  await request(app).delete('/api/trash/' + work.id).send({ confirm: true }).expect(200)
  expect(await fs.readdir(imagesDir)).toEqual([])
})

it('commits concurrent reference retries once and remembers the key after an app restart', async () => {
  const { app, appOptions, referencesDir } = await fixture()
  const png = await makeImage('red').png().toBuffer()
  const { body: work } = await request(app).post('/api/images').attach('image', png, 'main.png').expect(200)
  const append = (target: typeof app) => request(target).post('/api/images/' + work.id + '/references')
  const send = () => append(app).set('X-Idempotency-Key', 'append-1').attach('references', png, 'ref.png').expect(200)
  const [first, retry] = await Promise.all([send(), send()])
  const afterRestart = await append(createApp(appOptions)).field('idempotencyKey', 'append-1')
    .attach('references', png, 'ref.png').expect(200)
  expect(first.body.referenceImages).toHaveLength(1)
  expect(retry.body).toEqual(first.body)
  expect(afterRestart.body).toEqual(first.body)
  expect(await fs.readdir(referencesDir)).toEqual(first.body.referenceImages)
  const unkeyed = await append(app).attach('references', png, 'ref.png').expect(200)
  expect(unkeyed.body.referenceImages).toHaveLength(2)
})

it('skips Markdown attachments outside the chosen real directory, non-files and invalid image data', async () => {
  const { app, root, imagesDir } = await fixture()
  const vaultImagesPath = path.join(root, 'vault')
  await fs.mkdir(path.join(vaultImagesPath, 'sub'), { recursive: true })
  const png = await makeImage('red').png().toBuffer()
  await fs.writeFile(path.join(root, 'outside.png'), png)
  await fs.symlink(path.join(root, 'outside.png'), path.join(vaultImagesPath, 'linked.png'))
  await fs.writeFile(path.join(vaultImagesPath, 'broken.png'), png.subarray(0, 45))
  await makeImage('green').tiff().toFile(path.join(vaultImagesPath, 'unsupported.png'))
  await fs.writeFile(path.join(vaultImagesPath, 'sub', 'valid.png'), png)
  await fs.symlink(path.join(vaultImagesPath, 'sub', 'valid.png'), path.join(vaultImagesPath, 'internal.png'))
  const markdownPath = path.join(root, 'recipes.md')
  await fs.writeFile(markdownPath, [
    entry('outside', '../outside.png'), entry('linked', 'linked.png'),
    entry('broken', 'broken.png'), entry('directory', 'sub'), entry('unsupported', 'unsupported.png'),
    entry('allowed', 'internal.png'),
  ].join('\n'))
  const result = await request(app).post('/api/import').send({ markdownPath, vaultImagesPath }).expect(200)
  expect(result.body).toEqual({ imported: 1, skipped: 5, total: 6 })
  expect((await request(app).get('/api/images')).body.map((image: { prompt: string }) => image.prompt)).toEqual(['allowed'])
  expect(await fs.readdir(imagesDir)).toHaveLength(1)
})

it('deduplicates Markdown by canonical note, full prompt and image bytes across and within batches', async () => {
  const { app, root, imagesDir } = await fixture()
  const a = await makeImage('red').png().toBuffer()
  const b = await makeImage('blue').png().toBuffer()
  await fs.writeFile(path.join(root, 'a.png'), a)
  await fs.writeFile(path.join(root, 'a-copy.png'), a)
  await fs.writeFile(path.join(root, 'b.png'), b)
  const markdownPath = path.join(root, 'recipes.md')
  const prefix = 'Common prompt prefix '.repeat(3)
  await fs.writeFile(markdownPath, [
    entry(prefix + 'first', 'a.png'), entry(prefix + 'second', 'a.png'),
    entry(prefix + 'first', 'b.png'), entry(prefix + 'first', 'a-copy.png'),
  ].join('\n'))
  const send = (note: string) => request(app).post('/api/import').send({ markdownPath: note, vaultImagesPath: root }).expect(200)
  expect((await send(markdownPath)).body).toEqual({ imported: 3, skipped: 1, total: 4 })
  const alias = path.join(root, 'note-alias.md')
  await fs.symlink(markdownPath, alias)
  expect((await send(alias)).body).toEqual({ imported: 0, skipped: 4, total: 4 })
  const otherDir = path.join(root, 'other')
  await fs.mkdir(otherDir)
  const sameBasename = path.join(otherDir, 'recipes.md')
  await fs.writeFile(sameBasename, entry(prefix + 'first', 'a.png'))
  expect((await send(sameBasename)).body).toEqual({ imported: 1, skipped: 0, total: 1 })
  expect(await fs.readdir(imagesDir)).toHaveLength(4)
})

it.each(['/api/images', '/api/external/gemini-web/import'])('rejects a header-readable but truncated main image on %s', async route => {
  const { app, imagesDir, referencesDir, dataFile } = await fixture()
  const before = await fs.readFile(dataFile, 'utf8')
  const jpeg = await makeImage('green').jpeg().toBuffer()
  const truncated = jpeg.subarray(0, jpeg.length - 12)
  expect((await sharp(truncated).metadata()).width).toBe(64)
  let upload = request(app).post(route)
  if (route !== '/api/images') {
    const reference = await makeImage('red').png().toBuffer()
    upload = upload.field('metadata', '{"prompt":"test"}').attach('references', reference, 'ref.png')
  }
  const result = await upload.attach('image', truncated, 'broken.jpg').expect(400)
  expect(result.body.error).toMatch(/有效|解码/)
  expect(await fs.readdir(imagesDir)).toEqual([])
  expect(await fs.readdir(referencesDir)).toEqual([])
  expect(await fs.readFile(dataFile, 'utf8')).toBe(before)
})
