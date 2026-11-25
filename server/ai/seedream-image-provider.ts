import { abortableSleep, stepSignal } from './request-abort.ts'
import { ImageGenerationResponseError, responseRetryDelay, imageResponseDetail } from './generation-failure.ts'
import type {
  GeneratedImageBytes,
  GenerateImageProviderInput,
  ImageGenerationProvider,
} from './image-generation-provider.ts'
import { SEEDREAM_5_5_IMAGE_MODEL } from '../../src/lib/image-generation-providers.ts'

export const DEFAULT_SEEDREAM_IMAGE_MODEL = SEEDREAM_5_5_IMAGE_MODEL
export const DEFAULT_SEEDREAM_ENDPOINT =
  'https://ark.cn-beijing.volces.com/api/v3/images/generations'

type FetchLike = typeof fetch

interface SeedreamImageGenerationProviderOptions {
  apiKey: string
  model?: string
  endpoint?: string
  fetch?: FetchLike
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  maxAttempts?: number
  timeoutMs?: number
}

const SEEDREAM_SIZE_PRESETS: Record<string, Record<string, string>> = {
  '1K': {
    '1:1': '1024x1024',
    '2:3': '832x1248',
    '3:2': '1248x832',
    '3:4': '864x1152',
    '4:3': '1152x864',
    '4:5': '960x1200',
    '5:4': '1200x960',
    '9:16': '800x1424',
    '16:9': '1424x800',
    '21:9': '1568x672',
  },
  '2K': {
    '1:1': '2048x2048',
    '2:3': '1664x2496',
    '3:2': '2496x1664',
    '3:4': '1776x2368',
    '4:3': '2368x1776',
    '4:5': '1920x2400',
    '5:4': '2400x1920',
    '9:16': '1584x2816',
    '16:9': '2816x1584',
    '21:9': '3136x1344',
  },
}

interface SeedreamModelProfile {
  label: string
  maxReferenceImages: number
  sizePresets: Record<string, Record<string, string>>
}

export class SeedreamImageGenerationRequestError extends Error {
  readonly status: number
  readonly providerCode: string
  readonly providerMessage: string
  readonly retryAfterMs?: number
  readonly requestId: string | null

  constructor(options: {
    status: number
    providerCode: string
    providerMessage: string
    requestId: string | null
    retryAfterMs?: number
  }) {
    super(`SEEDREAM_REQUEST_FAILED:${options.status}:${options.providerCode}`)
    this.name = 'SeedreamImageGenerationRequestError'
    this.status = options.status
    this.providerCode = options.providerCode
    this.providerMessage = options.providerMessage
    this.requestId = options.requestId
    this.retryAfterMs = options.retryAfterMs
  }
}

export class SeedreamImageGenerationValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeedreamImageGenerationValidationError'
  }
}

export class SeedreamImageGenerationProvider implements ImageGenerationProvider {
  private readonly apiKey: string
  private readonly model: string
  private readonly endpoint: string
  private readonly fetchImpl: FetchLike
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  private readonly maxAttempts: number
  private readonly timeoutMs: number

  constructor(options: SeedreamImageGenerationProviderOptions) {
    this.apiKey = options.apiKey
    this.model = options.model ?? DEFAULT_SEEDREAM_IMAGE_MODEL
    this.endpoint = options.endpoint ?? DEFAULT_SEEDREAM_ENDPOINT
    this.fetchImpl = options.fetch ?? fetch
    this.sleep = options.sleep ?? abortableSleep
    this.maxAttempts = options.maxAttempts ?? 3
    this.timeoutMs = options.timeoutMs ?? 300_000
  }

  async generateImage(input: GenerateImageProviderInput): Promise<GeneratedImageBytes> {
    if (!input.imageSize) {
      throw new SeedreamImageGenerationValidationError('Seedream 需要指定分辨率')
    }
    const profile = seedreamModelProfile(this.model)
    const size = resolveSeedreamOutputSize(input.imageSize, input.aspectRatio, this.model)
    if (input.referenceImages.length > profile.maxReferenceImages) {
      throw new SeedreamImageGenerationValidationError(
        `${profile.label} 最多支持 ${profile.maxReferenceImages} 张参考图`,
      )
    }

    const images = input.referenceImages.map(
      (reference) =>
        `data:${normalizeReferenceMimeType(reference.mimeType)};base64,${reference.data.toString('base64')}`,
    )
    const payload: Record<string, unknown> = {
      model: this.model,
      prompt: input.prompt,
      size,
      output_format: 'png',
      response_format: 'b64_json',
      watermark: false,
    }
    if (images.length === 1) payload.image = images[0]
    if (images.length > 1) payload.image = images

    const maxAttempts = input.noAutomaticRetry ? 1 : this.maxAttempts
    const body = JSON.stringify(payload)
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await input.onRequestStarted?.()
      input.signal?.throwIfAborted()
      let response: Response
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: stepSignal(this.timeoutMs, input.signal),
        })
      } catch (error) {
        input.signal?.throwIfAborted()
        const detail = error instanceof Error ? error.message : 'unknown network error'
        throw new Error(`SEEDREAM_NETWORK_ERROR:${detail}`, { cause: error })
      }

      const responseBody = await readJsonResponse(response)
      if (response.ok) {
        const bodyRecord = asRecord(responseBody)
        const first = asRecord(Array.isArray(bodyRecord?.data) ? bodyRecord.data[0] : undefined)
        const errorBody = bodyRecord?.error ? bodyRecord : first?.error ? first : undefined
        if (errorBody) {
          const error = extractSeedreamError(errorBody)
          throw new SeedreamImageGenerationRequestError({ status: response.status, providerCode: error.code, providerMessage: error.message, requestId: response.headers.get('x-request-id'), retryAfterMs: responseRetryDelay(response) })
        }
        return decodeGeneratedImage(responseBody)
      }

      const retryable = response.status === 429
      if (retryable && attempt < maxAttempts) {
        const retryAfterHeader = response.headers.get('retry-after')
        const retryAfter =
          retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader)
        await this.sleep(
          Number.isFinite(retryAfter) && retryAfter >= 0
            ? retryAfter * 1000
            : 500 * 2 ** (attempt - 1),
          input.signal,
        )
        continue
      }

      const error = extractSeedreamError(responseBody)
      throw new SeedreamImageGenerationRequestError({
        status: response.status,
        retryAfterMs: responseRetryDelay(response),
        providerCode: error.code,
        providerMessage: error.message,
        requestId:
          response.headers.get('x-request-id') ??
          response.headers.get('x-tt-logid'),
      })
    }

    throw new Error('SEEDREAM_REQUEST_ATTEMPTS_EXHAUSTED')
  }
}

export function resolveSeedreamOutputSize(
  imageSize: string,
  aspectRatio: string,
  model = DEFAULT_SEEDREAM_IMAGE_MODEL,
): string {
  const profile = seedreamModelProfile(model)
  const sizes = profile.sizePresets[imageSize]
  if (!sizes) {
    const supportedResolutions = formatChineseList(Object.keys(profile.sizePresets))
    throw new SeedreamImageGenerationValidationError(
      `${profile.label} 仅支持 ${supportedResolutions} 分辨率`,
    )
  }
  const resolved = sizes[aspectRatio]
  if (!resolved) {
    throw new SeedreamImageGenerationValidationError(
      `${profile.label} 不支持宽高比 ${aspectRatio}`,
    )
  }
  return resolved
}

function formatChineseList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? ''
  return `${values.slice(0, -1).join('、')} 或 ${values.at(-1)}`
}

function seedreamModelProfile(model: string): SeedreamModelProfile {
  if (model !== DEFAULT_SEEDREAM_IMAGE_MODEL) {
    throw new SeedreamImageGenerationValidationError('Seedream 仅支持 5.5，请另开草稿后重新提交')
  }
  return {
    label: 'Seedream 5.5',
    maxReferenceImages: 10,
    sizePresets: SEEDREAM_SIZE_PRESETS,
  }
}

function normalizeReferenceMimeType(mimeType: string): string {
  if (mimeType === 'image/jpg') return 'image/jpeg'
  if (['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return mimeType
  throw new SeedreamImageGenerationValidationError(`Seedream 不支持参考图类型 ${mimeType}`)
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return {
      error: {
        code: 'NON_JSON_RESPONSE',
        message: '上游返回了无法解析的响应',
      },
    }
  }
}

function decodeGeneratedImage(body: unknown): GeneratedImageBytes {
  const record = asRecord(body)
  const data = Array.isArray(record?.data) ? record.data : []
  const image = asRecord(data[0])
  const encoded = typeof image?.b64_json === 'string' ? image.b64_json : ''
  if (!encoded) {
    throw new ImageGenerationResponseError('SEEDREAM_IMAGE_NOT_FOUND', imageResponseDetail(body))
  }
  const buffer = Buffer.from(encoded, 'base64')
  if (buffer.length === 0) {
    throw new ImageGenerationResponseError('SEEDREAM_EMPTY_IMAGE')
  }
  return {
    buffer,
    mimeType: 'image/png',
  }
}

function extractSeedreamError(body: unknown): { code: string; message: string } {
  const error = asRecord(asRecord(body)?.error)
  return {
    code: typeof error?.code === 'string' ? error.code : 'UNKNOWN_ERROR',
    message:
      typeof error?.message === 'string'
        ? error.message
        : 'Seedream 图片生成请求失败',
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}
