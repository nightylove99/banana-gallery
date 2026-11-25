import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import { once } from 'node:events'
import express from 'express'

import { CloudflareAccessVerifier } from '../server/auth/cloudflare-access-verifier.js'
import { createSessionAttacher, resolveCloudflareAccessSession } from '../server/auth/session-middleware.js'
import { startRuntimeListeners } from '../server/runtime-listeners.js'

const TEAM_DOMAIN = 'banana.cloudflareaccess.com'
const AUDIENCE = 'banana-audience'
const OWNER_EMAIL = 'owner@example.com'
const NOW_SECONDS = 1_800_000_000

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
})
const publicJwk = publicKey.export({ format: 'jwk' })
const jwks = {
  keys: [{
    ...publicJwk,
    kid: 'test-key',
    alg: 'RS256',
    use: 'sig',
  }],
}

function encodeJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function createAssertion(overrides: Record<string, unknown> = {}) {
  const header = encodeJson({ alg: 'RS256', typ: 'JWT', kid: 'test-key' })
  const payload = encodeJson({
    iss: `https://${TEAM_DOMAIN}`,
    aud: [AUDIENCE],
    email: OWNER_EMAIL,
    iat: NOW_SECONDS - 30,
    exp: NOW_SECONDS + 300,
    ...overrides,
  })
  const signingInput = `${header}.${payload}`
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey)
    .toString('base64url')
  return `${signingInput}.${signature}`
}

function createVerifier() {
  return new CloudflareAccessVerifier({
    teamDomain: TEAM_DOMAIN,
    audience: AUDIENCE,
    allowedEmails: [OWNER_EMAIL],
    now: () => NOW_SECONDS * 1000,
    fetchJwks: async () => jwks,
  })
}

test('Cloudflare Access verifier 接受签名、签发者、Audience 和邮箱均有效的断言', async () => {
  const identity = await createVerifier().verify(createAssertion())

  assert.deepEqual(identity, { email: OWNER_EMAIL })
})

test('Cloudflare Access verifier 拒绝不在白名单中的邮箱', async () => {
  const identity = await createVerifier().verify(createAssertion({ email: 'other@example.com' }))

  assert.equal(identity, null)
})

test('Cloudflare Access verifier 拒绝错误的 Audience、签发者和过期断言', async () => {
  const verifier = createVerifier()

  assert.equal(await verifier.verify(createAssertion({ aud: ['wrong-audience'] })), null)
  assert.equal(await verifier.verify(createAssertion({ iss: 'https://evil.example' })), null)
  assert.equal(await verifier.verify(createAssertion({ exp: NOW_SECONDS - 31 })), null)
})

test('Cloudflare Access verifier 拒绝篡改和格式错误的断言', async () => {
  const verifier = createVerifier()
  const assertion = createAssertion()
  const [header, payload, signature] = assertion.split('.')
  const tamperedPayload = encodeJson({
    iss: `https://${TEAM_DOMAIN}`,
    aud: [AUDIENCE],
    email: 'attacker@example.com',
    exp: NOW_SECONDS + 300,
  })

  assert.equal(await verifier.verify(`${header}.${tamperedPayload}.${signature}`), null)
  assert.equal(await verifier.verify(`${header}.${payload}`), null)
  assert.equal(await verifier.verify(undefined), null)
})

test('Cloudflare Access 会让本机端口直进，并要求远程端口提供有效断言', async () => {
  const localSession = {
    user: { id: 'local-user', email: 'local-user@banana.gallery' },
    workspace: { id: 'local-workspace', name: 'Local Workspace' },
  }
  const verifier = createVerifier()

  const local = await resolveCloudflareAccessSession({
    listenerPort: 3333,
    localAccessPort: 3333,
    remoteAccessPort: 3334,
    assertion: undefined,
    verifier,
    localSession,
  })
  const remoteWithoutAssertion = await resolveCloudflareAccessSession({
    listenerPort: 3334,
    localAccessPort: 3333,
    remoteAccessPort: 3334,
    assertion: undefined,
    verifier,
    localSession,
  })
  const remoteWithAssertion = await resolveCloudflareAccessSession({
    listenerPort: 3334,
    localAccessPort: 3333,
    remoteAccessPort: 3334,
    assertion: createAssertion(),
    verifier,
    localSession,
  })
  const unexpectedPort = await resolveCloudflareAccessSession({
    listenerPort: 4444,
    localAccessPort: 3333,
    remoteAccessPort: 3334,
    assertion: createAssertion(),
    verifier,
    localSession,
  })

  assert.deepEqual(local, localSession)
  assert.equal(remoteWithoutAssertion, null)
  assert.deepEqual(remoteWithAssertion, {
    ...localSession,
    user: { ...localSession.user, email: OWNER_EMAIL },
  })
  assert.equal(unexpectedPort, null)
})

test('Cloudflare Access 模式使用同一应用启动本机和远程两个回环监听器', () => {
  const calls: Array<{ port: number; host: string }> = []
  const app = {
    listen(port: number, host: string, callback: () => void) {
      calls.push({ port, host })
      callback()
      return { close() {} }
    },
  }

  startRuntimeListeners({
    app,
    authMode: 'cloudflare_access',
    localPort: 3333,
    remoteAccessPort: 3334,
    bindHost: '127.0.0.1',
    log: () => {},
  })

  assert.deepEqual(calls, [
    { port: 3333, host: '127.0.0.1' },
    { port: 3334, host: '127.0.0.1' },
  ])
})

test('Cloudflare Access 模式拒绝本机端口与远程端口重复', () => {
  assert.throws(
    () => startRuntimeListeners({
      app: { listen: () => ({ close() {} }) },
      authMode: 'cloudflare_access',
      localPort: 3333,
      remoteAccessPort: 3333,
      bindHost: '127.0.0.1',
      log: () => {},
    }),
    /REMOTE_ACCESS_PORT 不能与 PORT 相同/,
  )
})

test('Cloudflare Access 模式拒绝监听非回环地址', () => {
  assert.throws(
    () => startRuntimeListeners({
      app: { listen: () => ({ close() {} }) },
      authMode: 'cloudflare_access',
      localPort: 3333,
      remoteAccessPort: 3334,
      bindHost: '0.0.0.0',
      log: () => {},
    }),
    /Cloudflare Access 模式只能监听回环地址/,
  )
})

test('JWKS refresh is shared, tolerates short outages, and rejects stale keys after 24 hours', async () => {
  let now = NOW_SECONDS * 1000
  let calls = 0
  let unavailable = false
  const verifier = new CloudflareAccessVerifier({
    teamDomain: TEAM_DOMAIN, audience: AUDIENCE, allowedEmails: [OWNER_EMAIL],
    now: () => now, jwksCacheTtlMs: 1,
    fetchJwks: async () => {
      calls++
      if (unavailable) throw Error('network unavailable')
      return jwks
    },
  })
  const assertion = () => createAssertion({ exp: Math.floor(now / 1000) + 300 })
  await Promise.all([verifier.verify(assertion()), verifier.verify(assertion())])
  assert.equal(calls, 1)
  unavailable = true
  now += 1_000
  assert.deepEqual(await verifier.verify(assertion()), { email: OWNER_EMAIL })
  now += 24 * 60 * 60 * 1000
  await assert.rejects(verifier.verify(assertion()), { name: 'CloudflareAccessJwksUnavailableError' })
})

test('remote session middleware returns 503 on JWKS outage, not 401', async () => {
  const verifier = new CloudflareAccessVerifier({
    teamDomain: TEAM_DOMAIN, audience: AUDIENCE, allowedEmails: [OWNER_EMAIL],
    now: () => NOW_SECONDS * 1000,
    fetchJwks: async () => { throw Error('network unavailable') },
  })
  const app = express()
  let port = 0
  app.use((req, res, next) => createSessionAttacher({
    cloudflareAccess: {
      verifier, remoteAccessPort: port, localAccessPort: 0,
      localSession: { user: { id: 'local', email: OWNER_EMAIL }, workspace: { id: 'local', name: 'Local' } },
    },
  })(req, res, next))
  app.get('/session', (req, res) => { res.sendStatus(req.authSession ? 200 : 401) })
  const server = app.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    port = address.port
    const url = `http://127.0.0.1:${port}/session`
    const valid = await fetch(url, { headers: { 'cf-access-jwt-assertion': createAssertion() }, signal: AbortSignal.timeout(2000) })
    assert.equal(valid.status, 503)
    assert.equal((await valid.json() as { code: string }).code, 'CLOUDFLARE_ACCESS_JWKS_UNAVAILABLE')
    const invalid = await fetch(url, { headers: { 'cf-access-jwt-assertion': createAssertion({ exp: 0 }) }, signal: AbortSignal.timeout(2000) })
    assert.equal(invalid.status, 401)
  } finally {
    server.close()
    server.closeAllConnections()
  }
})

test('local 模式会在调用 listen 前拒绝非回环地址', () => {
  for (const bindHost of ['0.0.0.0', '::', '192.0.2.10']) {
    assert.throws(
      () => startRuntimeListeners({
        app: { listen: () => { throw new Error('不应调用 listen') } },
        authMode: 'local',
        localPort: 3333,
        remoteAccessPort: 3334,
        bindHost,
      }),
      /AUTH_MODE=local.*BIND_HOST.*回环/,
    )
  }
})
