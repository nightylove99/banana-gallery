import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { configureHttpProxy } from '../../server/config/http-proxy'

it('preserves native multipart bytes across a real HTTP proxy and bypasses loopback', async () => {
  const fileBytes = Buffer.from([0, 88, 200, 255, 1])
  const origin = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    res.end(JSON.stringify({
      contentType: req.headers['content-type'],
      hasFile: Buffer.concat(chunks).includes(fileBytes),
      hasObjectString: Buffer.concat(chunks).includes('[object FormData]'),
    }))
  })
  await once(origin.listen(0, '127.0.0.1'), 'listening')
  const originPort = (origin.address() as net.AddressInfo).port
  const proxy = http.createServer()
  const sockets = new Set<net.Socket>()
  const destinations: string[] = []
  proxy.on('connect', (req, socket, head) => {
    destinations.push(req.url!)
    const upstream = net.connect(originPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket); upstream.destroy() })
    upstream.on('error', () => socket.destroy())
  })
  await once(proxy.listen(0, '127.0.0.1'), 'listening')
  const proxyPort = (proxy.address() as net.AddressInfo).port
  const previous = getGlobalDispatcher()
  const originalFetch = globalThis.fetch
  const logs: string[] = []
  const dispatcher = configureHttpProxy({
    HTTP_PROXY: `http://private-user:private-password@127.0.0.1:${proxyPort}`,
    NO_PROXY: '127.0.0.2',
  }, line => logs.push(line))
  try {
    expect(globalThis.fetch).toBe(originalFetch)
    const form = new FormData()
    form.append('file', new Blob([fileBytes]), 'reference.png')
    const result = await fetch(`http://multipart.example:${originPort}`, { method: 'POST', body: form })
    expect(await result.json()).toEqual({
      contentType: expect.stringContaining('multipart/form-data; boundary='), hasFile: true, hasObjectString: false,
    })
    await (await fetch(`http://127.0.0.1:${originPort}`)).text()
    expect(destinations).toEqual([`multipart.example:${originPort}`])
    expect(logs.join()).not.toMatch(/private-user|private-password/)
  } finally {
    globalThis.fetch = originalFetch
    setGlobalDispatcher(previous)
    for (const socket of sockets) socket.destroy()
    await dispatcher?.destroy()
    proxy.close()
    origin.close()
  }
})

it('does not disable TLS certificate verification', () => {
  const inherited = { NODE_TLS_REJECT_UNAUTHORIZED: '0' }
  configureHttpProxy(inherited)
  expect(inherited.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
})
