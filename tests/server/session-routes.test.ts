import fs from 'node:fs'
import type { Server } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../../server/app'

const tempRoots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
  })))
})

async function getFreePort() {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('无法分配测试端口')
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return address.port
}

async function createLocalAuthTestApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-gallery-local-auth-'))
  tempRoots.push(root)

  const app = createApp({
    ai: {
      models: {
        generateContent: async () => ({ candidates: [] }),
      },
    },
    strategy: { mode: 'apiKey', apiKey: 'test-api-key' },
    dataFile: path.join(root, 'gallery-data.json'),
    imagesDir: path.join(root, 'images'),
    referencesDir: path.join(root, 'references'),
    userAuthMode: 'local',
    localAuthSession: {
      user: { id: 'local-user', email: 'local-user@banana.gallery' },
      workspace: { id: 'local-workspace', name: 'Local Workspace' },
    },
  })

  return { app }
}

describe('session routes', () => {
  it('local 模式下 /api/session 会直接返回本地 session', async () => {
    const { app } = await createLocalAuthTestApp()

    const response = await request(app).get('/api/session')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      user: { id: 'local-user', email: 'local-user@banana.gallery' },
      workspace: { id: 'local-workspace', name: 'Local Workspace' },
    })
  })

  it('local 模式的账户摘要保留 CLI ensure 所需标记，不包含额度', async () => {
    const { app } = await createLocalAuthTestApp()
    const session = await request(app).get('/api/session')
    const response = await request(app).get('/api/account/summary')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ...session.body,
      runtimeMode: 'personal-local',
      plan: { id: 'personal' },
    })
    expect((await request(app).post('/api/logout')).status).toBe(204)
  })

  it.each([
    ['post', '/api/auth/magic-link'],
    ['get', '/api/auth/magic-link/verify'],
    ['post', '/api/invite-code/redeem'],
    ['get', '/api/settings/user-gemini'],
    ['put', '/api/settings/user-gemini'],
    ['delete', '/api/settings/user-gemini'],
  ] as const)('不再提供退役路由 %s %s', async (method, url) => {
    const { app } = await createLocalAuthTestApp()
    expect((await request(app)[method](url)).status).toBe(404)
  })

  it('Cloudflare Access 远程端口只接受有效断言并映射到本地 workspace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-gallery-access-auth-'))
    tempRoots.push(root)
    const remoteAccessPort = await getFreePort()

    const app = createApp({
      ai: {
        models: {
          generateContent: async () => ({ candidates: [] }),
        },
      },
      strategy: { mode: 'apiKey', apiKey: 'test-api-key' },
      dataFile: path.join(root, 'gallery-data.json'),
      imagesDir: path.join(root, 'images'),
      referencesDir: path.join(root, 'references'),
      userAuthMode: 'cloudflare_access',
      cloudflareAccessVerifier: {
        verify: async (assertion) => (
          assertion === 'valid-assertion' ? { email: 'owner@example.com' } : null
        ),
      },
      cloudflareAccessSession: {
        user: { id: 'local-user', email: 'local-user@banana.gallery' },
        workspace: { id: 'local-workspace', name: 'Local Workspace' },
      },
      localAccessPort: remoteAccessPort + 1,
      remoteAccessPort,
    })
    const server = app.listen(remoteAccessPort, '127.0.0.1')
    servers.push(server)

    const unauthorized = await request(`http://127.0.0.1:${remoteAccessPort}`)
      .get('/api/session')
    const authorized = await request(`http://127.0.0.1:${remoteAccessPort}`)
      .get('/api/session')
      .set('Cf-Access-Jwt-Assertion', 'valid-assertion')

    expect(unauthorized.status).toBe(401)
    expect(unauthorized.body).toEqual({
      error: 'UNAUTHORIZED',
      authMode: 'cloudflare_access',
    })
    expect((await request(server).get('/api/account/summary')).status).toBe(401)
    const account = await request(server).get('/api/account/summary')
      .set('Cf-Access-Jwt-Assertion', 'valid-assertion')
    expect(account.status).toBe(200)
    expect(account.body).toEqual({
      ...authorized.body,
      runtimeMode: 'personal-remote',
      plan: { id: 'personal' },
    })
    expect(authorized.status).toBe(200)
    expect(authorized.body).toEqual({
      user: { id: 'local-user', email: 'owner@example.com' },
      workspace: { id: 'local-workspace', name: 'Local Workspace' },
    })
  })

  it('Cloudflare Access 模式退出时返回 Access 登出地址', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-gallery-access-logout-'))
    tempRoots.push(root)

    const app = createApp({
      ai: {
        models: {
          generateContent: async () => ({ candidates: [] }),
        },
      },
      strategy: { mode: 'apiKey', apiKey: 'test-api-key' },
      dataFile: path.join(root, 'gallery-data.json'),
      imagesDir: path.join(root, 'images'),
      referencesDir: path.join(root, 'references'),
      userAuthMode: 'cloudflare_access',
    })

    const response = await request(app).post('/api/logout')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ logoutUrl: '/cdn-cgi/access/logout' })
  })
})
