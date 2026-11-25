import { stepSignal } from './request-abort.ts'
import {
  OPENAI_IMAGE_DEFAULT_MODEL,
  OPENAI_IMAGE_SIZE_PRESETS,
} from '../../src/lib/image-generation-providers.ts'
import {
  ImageGenerationResponseError,
  imageResponseDetail,
  responseRetryDelay,
  retrieveGeneratedImage,
} from './generation-failure.ts'
import type {
  GenerateImageProviderInput,
  GeneratedImageBytes,
  ImageGenerationProvider,
} from './image-generation-provider.ts'

export const OPENAI_IMAGE_DEFAULT_BASE_URL = 'https://api.openai.com/v1'

interface OpenAICompatibleOptions {
  apiKey: string
  baseUrl?: string
  model?: string
  fetch?: typeof fetch
  downloadTimeoutMs?: number
  maxDownloadBytes?: number
}

interface ImageResponse {
  data?: Array<{ b64_json?: string; url?: string }>
  error?: { message?: string; code?: string; type?: string } | string
}

export class OpenAICompatibleRequestError extends Error {
  readonly status: number
  readonly providerMessage: string
  readonly requestId?: string
  readonly providerCode?: string
  readonly retryAfterMs?: number

  constructor(status: number, message: string, details: { requestId?: string; providerCode?: string; retryAfterMs?: number } = {}) {
    super(message)
    this.status = status
    this.providerMessage = message
    this.requestId = details.requestId
    this.providerCode = details.providerCode
    this.retryAfterMs = details.retryAfterMs
  }
}

export class OpenAICompatibleImageGenerationProvider implements ImageGenerationProvider {
  private readonly options: OpenAICompatibleOptions
  private readonly baseUrl: string
  private readonly model: string
  private readonly fetchImpl: typeof fetch

  constructor(options: OpenAICompatibleOptions) {
    this.options = options
    this.baseUrl = (options.baseUrl ?? OPENAI_IMAGE_DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.model = options.model ?? OPENAI_IMAGE_DEFAULT_MODEL
    this.fetchImpl = options.fetch ?? fetch
  }

  async generateImage(input: GenerateImageProviderInput): Promise<GeneratedImageBytes> {
    const size = Object.hasOwn(OPENAI_IMAGE_SIZE_PRESETS, input.aspectRatio)
      ? OPENAI_IMAGE_SIZE_PRESETS[input.aspectRatio]
      : undefined
    if (!size || input.referenceImages.length > 16) {
      throw new OpenAICompatibleRequestError(400, '不支持该宽高比或参考图超过 16 张')
    }

    const parameters = { model: this.model, prompt: input.prompt, n: 1, size, quality: input.quality ?? 'high' }
    const headers = new Headers({ Authorization: `Bearer ${this.options.apiKey}`, Accept: 'application/json' })
    const isEdit = input.referenceImages.length > 0
    let body: string | FormData
    if (isEdit) {
      const form = new FormData()
      for (const [name, value] of Object.entries(parameters)) form.set(name, String(value))
      const field = input.referenceImages.length > 1 ? 'image[]' : 'image'
      for (const [index, image] of input.referenceImages.entries()) {
        const extension = image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType === 'image/webp' ? 'webp' : 'png'
        form.append(field, new Blob([image.data], { type: image.mimeType }), `reference-${index + 1}.${extension}`)
      }
      body = form
    } else {
      headers.set('Content-Type', 'application/json')
      body = JSON.stringify(parameters)
    }

    await input.onRequestStarted?.()
    const response = await this.fetchImpl(`${this.baseUrl}/images/${isEdit ? 'edits' : 'generations'}`, {
      method: 'POST', headers, body, signal: stepSignal(600_000, input.signal),
    })
    const responseText = await response.text()
    let payload: ImageResponse | undefined
    try { payload = JSON.parse(responseText) } catch { /* Some gateways return plain text. */ }
    const requestId = response.headers.get('x-request-id') ?? undefined
    if (!response.ok || payload?.error) {
      const error = payload?.error
      throw new OpenAICompatibleRequestError(
        response.status,
        imageResponseDetail(typeof error === 'string' ? error : error?.message || responseText)
          .replaceAll(this.options.apiKey, '***'),
        {
          requestId,
          providerCode: typeof error === 'object' && error ? error.code ?? error.type : undefined,
          retryAfterMs: responseRetryDelay(response),
        },
      )
    }

    const image = payload?.data?.[0]
    if (typeof image?.b64_json === 'string' && image.b64_json.length > 0) {
      const buffer = Buffer.from(image.b64_json, 'base64')
      if (buffer.length) return { buffer, mimeType: imageMimeType(buffer) }
    }
    const imageUrl = image?.url
    if (typeof imageUrl === 'string') return retrieveGeneratedImage(() => this.downloadImage(imageUrl, input.signal))
    throw new ImageGenerationResponseError('NO_IMAGE', imageResponseDetail(payload), requestId)
  }

  private async downloadImage(value: string, signal?: AbortSignal): Promise<GeneratedImageBytes> {
    const url = URL.parse(value)
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('中转站返回了无效的图片地址')
    }
    const maxBytes = this.options.maxDownloadBytes ?? 32 * 1024 * 1024
    const response = await this.fetchImpl(url, {
      headers: { Accept: 'image/*' },
      signal: stepSignal(this.options.downloadTimeoutMs ?? 30_000, signal),
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`图片下载失败（HTTP ${response.status}）`)
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body.cancel().catch(() => {})
      throw new Error('图片大小超过下载限制')
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read()
        if (done) break
        size += chunk.byteLength
        if (size > maxBytes) {
          await reader.cancel().catch(() => {})
          throw new Error('图片大小超过下载限制')
        }
        chunks.push(chunk)
      }
    } finally {
      reader.releaseLock()
    }
    if (!size) throw new Error('下载的图片为空')
    const buffer = Buffer.concat(chunks, size)
    return { buffer, mimeType: imageMimeType(buffer) }
  }
}

function imageMimeType(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return 'image/png'
}
