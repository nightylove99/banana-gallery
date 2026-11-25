import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchSession, logoutSession } from '../src/api.ts'

test('fetchSession 保留服务端报告的登录模式', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(
    JSON.stringify({ error: 'UNAUTHORIZED', authMode: 'cloudflare_access' }),
    {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    },
  ))

  const result = await fetchSession()

  assert.deepEqual(result, {
    session: null,
    authMode: 'cloudflare_access',
  })
})

test('fetchSession 返回已登录 session', async (t) => {
  const session = {
    user: { id: 'user-1', email: 'user@example.com' },
    workspace: { id: 'workspace-1', name: 'Workspace' },
  }
  t.mock.method(globalThis, 'fetch', async () => new Response(
    JSON.stringify(session),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  ))

  const result = await fetchSession()

  assert.deepEqual(result, { session, authMode: null })
})

test('fetchSession retains the authenticated mode for isolated thumbnail caches', async (t) => {
  const session = { user: { id: 'one', email: 'one@example.test' }, workspace: { id: 'one', name: 'Test' } }
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(session), { headers: { 'Content-Type': 'application/json', 'X-Auth-Mode': 'cloudflare_access' } }))
  assert.deepEqual(await fetchSession(), { session, authMode: 'cloudflare_access' })
})

test('logoutSession 返回 Cloudflare Access 登出地址', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(
    JSON.stringify({ logoutUrl: '/cdn-cgi/access/logout' }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  ))

  const result = await logoutSession()

  assert.deepEqual(result, { logoutUrl: '/cdn-cgi/access/logout' })
})

test('logoutSession 兼容无响应体的本机免登录模式', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }))

  const result = await logoutSession()

  assert.deepEqual(result, {})
})
