import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { attachStaticApp } from '../../server/static-app'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function createStaticTestApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-gallery-static-'))
  tempRoots.push(root)
  fs.mkdirSync(path.join(root, 'assets'))
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Banana Gallery</title>')
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'window.banana = true')

  const app = express()
  app.get('/api/health', (_req, res) => res.json({ ok: true }))
  attachStaticApp(app, root)
  return app
}

describe('attachStaticApp', () => {
  it('提供构建资源并为前端路由回退 index.html', async () => {
    const app = createStaticTestApp()

    const asset = await request(app).get('/assets/app.js')

    expect(asset.status).toBe(200)
    expect(asset.text).toContain('window.banana')
    for (const path of ['/generate', '/trash']) {
      const route = await request(app).get(path)
      expect(route.status).toBe(200)
      expect(route.text).toContain('<title>Banana Gallery</title>')
      expect(route.headers['x-robots-tag']).toBe('noindex, nofollow')
    }
  })

  it('不会把未知 API 或受保护资源路径回退成前端 HTML', async () => {
    const app = createStaticTestApp()

    expect((await request(app).get('/api/missing')).status).toBe(404)
    expect((await request(app).get('/cdn-cgi/access/logout')).status).toBe(404)
    expect((await request(app).get('/images/missing.png')).status).toBe(404)
    expect((await request(app).get('/references/missing.png')).status).toBe(404)
  })
})
