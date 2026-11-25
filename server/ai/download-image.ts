import { abortableSleep, stepSignal } from './request-abort.ts'

class ImageDownloadHttpError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`IMAGE_DOWNLOAD_FAILED:${status}`)
    this.status = status
  }
}

export async function downloadImageBytes(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
  headers?: RequestInit['headers'],
) {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted()
    try {
      const response = await fetchImpl(url, {
        signal: stepSignal(timeoutMs, signal),
        redirect: 'manual',
        headers,
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new ImageDownloadHttpError(response.status)
      }
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mimeType: response.headers.get('content-type')?.split(';')[0],
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (attempt === 3 || error instanceof ImageDownloadHttpError && error.status !== 429 && error.status < 500) throw error
      await abortableSleep(250 * 2 ** (attempt - 1), signal)
    }
  }
}
