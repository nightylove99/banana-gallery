// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { readGenerationHistory, taskRequest } from '../../src/lib/generation-tasks'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('treats an HTML 502 as temporary unavailability without invalidating Access', async () => {
  const expired = vi.fn()
  window.addEventListener('banana-session-expired', expired, { once: true })
  vi.stubGlobal('fetch', async () => new Response('<html>Bad gateway</html>', {
    status: 502, headers: { 'Content-Type': 'text/html' },
  }))
  try {
    await expect(taskRequest('/id')).rejects.toMatchObject({ status: 502, message: expect.stringContaining('服务暂时不可用') })
    expect(expired).not.toHaveBeenCalled()
  } finally { window.removeEventListener('banana-session-expired', expired) }
})

it('polls the limited feed and aborts a hanging request at 15s', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn((_url, { signal }: RequestInit) => new Promise<Response>((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason))
  }))
  vi.stubGlobal('fetch', fetch)
  const result = expect(readGenerationHistory()).rejects.toThrow('请求超时')
  expect(fetch.mock.calls[0][0]).toBe('/api/generation-tasks?limit=60')
  await vi.advanceTimersByTimeAsync(15_000)
  await result
})

it('recognizes an Access redirect but keeps 503 a connection problem', async () => {
  const expired = vi.fn()
  window.addEventListener('banana-session-expired', expired)
  const redirected = new Response('<html>Access</html>', { headers: { 'Content-Type': 'text/html' } })
  Object.defineProperty(redirected, 'type', { value: 'opaqueredirect' })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(redirected).mockResolvedValueOnce(Response.json({}, { status: 503 })))
  try {
    await expect(taskRequest()).rejects.toMatchObject({ status: 401, message: '登录已过期，请重新登录' })
    await expect(taskRequest()).rejects.toMatchObject({ status: 503, message: expect.stringContaining('服务暂时不可用') })
    expect(expired).toHaveBeenCalledOnce()
  } finally { window.removeEventListener('banana-session-expired', expired) }
})

it('only recognizes a definitive by-key 404 as permission to retry', async () => {
  const { readSubmission } = await import('../../src/lib/generation-tasks')
  const fetch = vi.fn().mockResolvedValueOnce(new Response('<html>Not found</html>', { status: 404 }))
    .mockResolvedValueOnce(Response.json({ code: 'TASK_KEY_NOT_FOUND' }, { status: 404 }))
  vi.stubGlobal('fetch', fetch)
  await expect(readSubmission('abc')).rejects.toThrow('非预期页面')
  await expect(readSubmission('abc')).resolves.toBeNull()
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/generation-tasks/by-key/abc', '/api/generation-tasks/by-key/abc'])
})
