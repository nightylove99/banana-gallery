import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { createApp } from '../../server/app'
import { saveImageReferences } from '../../src/api'

it('the actual client sends a mixed ordered multipart list accepted by the server', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-reference-client-'))
  const app = createApp({
    ai: { models: { generateContent: async () => ({ candidates: [] }) } },
    strategy: { mode: 'apiKey', apiKey: 'test' },
    dataFile: path.join(root, 'gallery.json'), imagesDir: path.join(root, 'images'), referencesDir: path.join(root, 'references'),
    userAuthMode: 'local', localAuthSession: { user: { id: 'local', email: 'local@test.local' }, workspace: { id: 'local', name: 'Local' } },
  })
  const image = { id: 'one', filename: 'main.png', referenceImages: ['old.png'], prompt: 'original', assetType: 'recipe', tags: [], favorited: false, createdAt: '2026-09-06', width: 1, height: 1 }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==', 'base64')
  fs.writeFileSync(path.join(root, 'gallery.json'), JSON.stringify({ images: [image] }))
  fs.writeFileSync(path.join(root, 'references', 'old.png'), png)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing port')
  const originalFetch = globalThis.fetch
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => originalFetch(new URL(url, `http://127.0.0.1:${address.port}`), init))
  try {
    const file = new File([png], 'replacement.png', { type: 'image/png' })
    const updated = await saveImageReferences('one', [file, 'old.png'], ['old.png'])
    expect(updated.referenceImages).toEqual([expect.stringMatching(/^ref_.*\.png$/), 'old.png'])
    expect(JSON.parse(fs.readFileSync(path.join(root, 'gallery.json'), 'utf8')).images[0].referenceImages).toEqual(updated.referenceImages)
  } finally {
    vi.unstubAllGlobals()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
