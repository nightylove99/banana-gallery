import { isTrustedGenerationResultUrl } from '../../src/lib/generation-result-url.ts'
import { stepSignal } from './request-abort.ts'
import { ImageGenerationResponseError, retrieveGeneratedImage, imageResponseDetail } from './generation-failure.ts'
import type {
  GenerateImageProviderInput,
  GeneratedImageBytes,
  ImageGenerationProvider,
} from './image-generation-provider.ts'
import {
  DashscopeImageGenerationValidationError,
  dashscopeError,
  asRecord,
  downloadGeneratedImage,
  firstDashscopeImageUrl,
  readDashscopeJson,
  referenceToDataUri,
  type FetchLike,
} from './dashscope-image-common.ts'

export const DEFAULT_QWEN_IMAGE_MODEL = 'qwen-image-3.0-pro'
export const DEFAULT_QWEN_IMAGE_ENDPOINT =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'

const SIZE_PRESETS: Record<string, Record<string, string>> = {
  '1K': {
    '1:1': '1024*1024',
    '2:3': '832*1248',
    '3:2': '1248*832',
    '3:4': '864*1152',
    '4:3': '1152*864',
    '4:5': '896*1120',
    '5:4': '1120*896',
    '9:16': '768*1344',
    '16:9': '1344*768',
    '21:9': '1568*672',
  },
  '2K': {
    '1:1': '2048*2048',
    '2:3': '1664*2496',
    '3:2': '2496*1664',
    '3:4': '1728*2304',
    '4:3': '2304*1728',
    '4:5': '1792*2240',
    '5:4': '2240*1792',
    '9:16': '1536*2688',
    '16:9': '2688*1536',
    '21:9': '3024*1296',
  },
}

interface QwenImageGenerationProviderOptions {
  apiKey: string
  model?: string
  endpoint?: string
  fetch?: FetchLike
  timeoutMs?: number
  /** 每个 Qwen 图片模型的上限不同，由调用方按模型注册表传入；默认 3 */
  maxReferenceImages?: number
}

export class QwenImageGenerationProvider implements ImageGenerationProvider {
  private readonly apiKey: string
  private readonly model: string
  private readonly endpoint: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  private readonly maxReferenceImages: number

  constructor(options: QwenImageGenerationProviderOptions) {
    this.apiKey = options.apiKey
    this.model = options.model ?? DEFAULT_QWEN_IMAGE_MODEL
    this.endpoint = options.endpoint ?? DEFAULT_QWEN_IMAGE_ENDPOINT
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 300_000
    this.maxReferenceImages = options.maxReferenceImages ?? 3
  }

  async generateImage(input: GenerateImageProviderInput): Promise<GeneratedImageBytes> {
    if (input.resumeTaskId) return retrieveGeneratedImage(() => downloadGeneratedImage(input.resumeTaskId!, this.fetchImpl, input.signal))
    if (!input.imageSize) {
      throw new DashscopeImageGenerationValidationError(
        'qwen',
        'Qwen 需要指定分辨率',
      )
    }
    if (input.referenceImages.length > this.maxReferenceImages) {
      throw new DashscopeImageGenerationValidationError(
        'qwen',
        `Qwen（${this.model}）最多支持 ${this.maxReferenceImages} 张参考图`,
      )
    }

    const content: Array<{ image: string } | { text: string }> =
      input.referenceImages.map((reference) => ({
      image: referenceToDataUri('qwen', reference),
      }))
    content.push({ text: input.prompt })

    const size = resolveQwenOutputSize(input.imageSize, input.aspectRatio)
    await input.onRequestStarted?.()
    input.signal?.throwIfAborted()
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: {
          messages: [{ role: 'user', content }],
        },
        parameters: {
          n: 1,
          size,
          prompt_extend: true,
          watermark: false,
        },
      }),
      signal: stepSignal(this.timeoutMs, input.signal),
    })

    const body = await readDashscopeJson(response)
    if (!response.ok || asRecord(body)?.code) throw dashscopeError('qwen', response.status, body, response)
    const imageUrl = firstDashscopeImageUrl(body)
    if (!imageUrl) throw new ImageGenerationResponseError('QWEN_IMAGE_NOT_FOUND', imageResponseDetail(body), String(asRecord(body)?.request_id ?? response.headers.get('x-request-id') ?? '') || undefined)
    if (isTrustedGenerationResultUrl(imageUrl)) await input.onTaskSubmitted?.(imageUrl)
    return retrieveGeneratedImage(() => downloadGeneratedImage(imageUrl, this.fetchImpl, input.signal))
  }
}

export function resolveQwenOutputSize(imageSize: string, aspectRatio: string): string {
  const sizes = SIZE_PRESETS[imageSize]
  if (!sizes) {
    throw new DashscopeImageGenerationValidationError(
      'qwen',
      'Qwen 仅支持 1K 或 2K 分辨率',
    )
  }
  const resolved = sizes[aspectRatio]
  if (!resolved) {
    throw new DashscopeImageGenerationValidationError(
      'qwen',
      `Qwen 不支持宽高比 ${aspectRatio}`,
    )
  }
  return resolved
}
