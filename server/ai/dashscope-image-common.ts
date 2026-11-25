import { downloadImageBytes } from './download-image.ts'
import { isTrustedGenerationResultUrl } from '../../src/lib/generation-result-url.ts'
import { responseRetryDelay } from './generation-failure.ts'
import type {
  GeneratedImageBytes,
  ReferenceImageForGeneration,
} from './image-generation-provider.ts'

export type FetchLike = typeof fetch

export class DashscopeImageGenerationRequestError extends Error {
  readonly provider: 'qwen' | 'kling'
  readonly status: number
  readonly providerCode: string
  readonly providerMessage: string
  readonly retryAfterMs?: number
  readonly requestId: string | null

  constructor(options: {
    provider: 'qwen' | 'kling'
    status: number
    providerCode: string
    providerMessage: string
    requestId: string | null
    retryAfterMs?: number
  }) {
    super(
      `DASHSCOPE_${options.provider.toUpperCase()}_REQUEST_FAILED:` +
      `${options.status}:${options.providerCode}`,
    )
    this.name = 'DashscopeImageGenerationRequestError'
    this.provider = options.provider
    this.status = options.status
    this.providerCode = options.providerCode
    this.providerMessage = options.providerMessage
    this.requestId = options.requestId
    this.retryAfterMs = options.retryAfterMs
  }
}

export class DashscopeImageGenerationValidationError extends Error {
  readonly provider: 'qwen' | 'kling'

  constructor(provider: 'qwen' | 'kling', message: string) {
    super(message)
    this.name = 'DashscopeImageGenerationValidationError'
    this.provider = provider
  }
}

export function referenceToDataUri(
  provider: 'qwen' | 'kling',
  reference: ReferenceImageForGeneration,
  maxBytes = 10 * 1024 * 1024,
): string {
  if (reference.data.byteLength > maxBytes) {
    throw new DashscopeImageGenerationValidationError(
      provider,
      `${providerLabel(provider)} 参考图不能超过 10MB`,
    )
  }
  const mimeType = normalizeDashscopeMimeType(provider, reference.mimeType)
  return `data:${mimeType};base64,${reference.data.toString('base64')}`
}

export function normalizeDashscopeMimeType(
  provider: 'qwen' | 'kling',
  mimeType: string,
): string {
  const normalized = mimeType === 'image/jpg' ? 'image/jpeg' : mimeType
  const allowed =
    provider === 'kling'
      ? ['image/jpeg', 'image/png']
      : [
          'image/jpeg',
          'image/png',
          'image/bmp',
          'image/tiff',
          'image/webp',
          'image/gif',
        ]
  if (!allowed.includes(normalized)) {
    throw new DashscopeImageGenerationValidationError(
      provider,
      `${providerLabel(provider)} 不支持参考图类型 ${mimeType}`,
    )
  }
  return normalized
}

export async function readDashscopeJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return {
      code: 'NON_JSON_RESPONSE',
      message: '上游返回了无法解析的响应',
    }
  }
}

export function dashscopeError(
  provider: 'qwen' | 'kling',
  status: number,
  body: unknown,
  response?: Response,
): DashscopeImageGenerationRequestError {
  const top = asRecord(body)
  const output = asRecord(top?.output)
  const record = output?.code ? { ...top, ...output } : top
  return new DashscopeImageGenerationRequestError({
    provider,
    status,
    retryAfterMs: response ? responseRetryDelay(response) : undefined,
    providerCode:
      typeof record?.code === 'string' ? record.code : 'UNKNOWN_ERROR',
    providerMessage:
      typeof record?.message === 'string'
        ? record.message
        : `${providerLabel(provider)} 图片生成请求失败`,
    requestId:
      (typeof record?.request_id === 'string' ? record.request_id : null) ??
      response?.headers.get('x-request-id') ??
      null,
  })
}

export async function downloadGeneratedImage(
  url: string,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<GeneratedImageBytes> {
  if (!isTrustedGenerationResultUrl(url)) {
    throw Object.assign(new Error('UNTRUSTED_IMAGE_URL'), { providerCode: 'UNTRUSTED_IMAGE_URL' })
  }
  const { buffer, mimeType } = await downloadImageBytes(url, fetchImpl, 120_000, signal)
  if (buffer.length === 0) throw new Error('DASHSCOPE_EMPTY_IMAGE')
  return { buffer, mimeType: mimeType || 'image/png' }
}

export function firstDashscopeImageUrl(body: unknown): string | null {
  const output = asRecord(asRecord(body)?.output)
  const choices = Array.isArray(output?.choices) ? output.choices : []
  for (const choice of choices) {
    const message = asRecord(asRecord(choice)?.message)
    const content = Array.isArray(message?.content) ? message.content : []
    for (const item of content) {
      const image = asRecord(item)?.image
      if (typeof image === 'string' && /^https?:\/\//i.test(image)) return image
    }
  }
  return null
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

function providerLabel(provider: 'qwen' | 'kling') {
  return provider === 'qwen' ? 'Qwen' : 'Kling'
}
