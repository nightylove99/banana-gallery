import { abortableSleep, stepSignal } from './request-abort.ts'
import { ImageGenerationResponseError, retrieveGeneratedImage, imageResponseDetail } from './generation-failure.ts'
import { randomUUID } from 'node:crypto'

import type {
  GenerateImageProviderInput,
  GeneratedImageBytes,
  ImageGenerationProvider,
  ReferenceImageForGeneration,
} from './image-generation-provider.ts'
import {
  DashscopeImageGenerationValidationError,
  asRecord,
  dashscopeError,
  downloadGeneratedImage,
  firstDashscopeImageUrl,
  normalizeDashscopeMimeType,
  readDashscopeJson,
  type FetchLike,
} from './dashscope-image-common.ts'

export const DEFAULT_KLING_IMAGE_MODEL =
  'kling/kling-v3-omni-image-generation'
export const DEFAULT_KLING_IMAGE_ENDPOINT =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation'
export const DEFAULT_DASHSCOPE_TASK_ENDPOINT =
  'https://dashscope.aliyuncs.com/api/v1/tasks'
export const DEFAULT_DASHSCOPE_UPLOAD_ENDPOINT =
  'https://dashscope.aliyuncs.com/api/v1/uploads'

interface KlingImageGenerationProviderOptions {
  apiKey: string
  model?: string
  endpoint?: string
  taskEndpoint?: string
  uploadEndpoint?: string
  fetch?: FetchLike
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  pollIntervalMs?: number
  maxPolls?: number
  timeoutMs?: number
}

export class KlingImageGenerationProvider implements ImageGenerationProvider {
  private readonly apiKey: string
  private readonly model: string
  private readonly endpoint: string
  private readonly taskEndpoint: string
  private readonly uploadEndpoint: string
  private readonly fetchImpl: FetchLike
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  private readonly pollIntervalMs: number
  private readonly maxPolls: number
  private readonly timeoutMs: number

  constructor(options: KlingImageGenerationProviderOptions) {
    this.apiKey = options.apiKey
    this.model = options.model ?? DEFAULT_KLING_IMAGE_MODEL
    this.endpoint = options.endpoint ?? DEFAULT_KLING_IMAGE_ENDPOINT
    this.taskEndpoint =
      options.taskEndpoint ?? DEFAULT_DASHSCOPE_TASK_ENDPOINT
    this.uploadEndpoint =
      options.uploadEndpoint ?? DEFAULT_DASHSCOPE_UPLOAD_ENDPOINT
    this.fetchImpl = options.fetch ?? fetch
    this.sleep = options.sleep ?? abortableSleep
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000
    this.maxPolls = options.maxPolls ?? 60
    this.timeoutMs = options.timeoutMs ?? 120_000
  }

  async generateImage(input: GenerateImageProviderInput): Promise<GeneratedImageBytes> {
    if (input.resumeTaskId) return this.pollTask(input.resumeTaskId, input.signal)
    if (!input.imageSize) {
      throw new DashscopeImageGenerationValidationError(
        'kling',
        'Kling 需要指定分辨率',
      )
    }
    if (input.referenceImages.length > 10) {
      throw new DashscopeImageGenerationValidationError(
        'kling',
        'Kling V3 Omni Image 最多支持 10 张参考图',
      )
    }
    const resolution = resolveKlingResolution(input.imageSize)
    if (!['1:1', '16:9', '9:16'].includes(input.aspectRatio)) {
      throw new DashscopeImageGenerationValidationError(
        'kling',
        `Kling 不支持宽高比 ${input.aspectRatio}`,
      )
    }

    const uploadedImages = []
    for (const reference of input.referenceImages) {
      uploadedImages.push(await this.uploadReference(reference, input.signal))
    }
    const content: Array<{ text: string } | { image: string }> = [
      { text: input.prompt },
      ...uploadedImages.map((image) => ({ image })),
    ]

    await input.onRequestStarted?.()
    input.signal?.throwIfAborted()
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
        ...(uploadedImages.length > 0
          ? { 'X-DashScope-OssResourceResolve': 'enable' }
          : {}),
      },
      body: JSON.stringify({
        model: this.model,
        input: {
          messages: [{ role: 'user', content }],
        },
        parameters: {
          n: 1,
          result_type: 'single',
          aspect_ratio: input.aspectRatio,
          resolution,
          watermark: false,
        },
      }),
      signal: stepSignal(this.timeoutMs, input.signal),
    })

    const body = await readDashscopeJson(response)
    if (!response.ok || asRecord(body)?.code) throw dashscopeError('kling', response.status, body, response)
    const output = asRecord(asRecord(body)?.output)
    const taskId = typeof output?.task_id === 'string' ? output.task_id : ''
    if (!taskId) throw new Error('KLING_TASK_ID_NOT_FOUND')

    await input.onTaskSubmitted?.(taskId)
    return this.pollTask(taskId, input.signal)
  }

  private async uploadReference(
    reference: ReferenceImageForGeneration,
    signal?: AbortSignal,
  ): Promise<string> {
    if (reference.data.byteLength > 10 * 1024 * 1024) {
      throw new DashscopeImageGenerationValidationError(
        'kling',
        'Kling 参考图不能超过 10MB',
      )
    }
    const mimeType = normalizeDashscopeMimeType('kling', reference.mimeType)
    const policyUrl = new URL(this.uploadEndpoint)
    policyUrl.searchParams.set('action', 'getPolicy')
    policyUrl.searchParams.set('model', this.model)
    const policyResponse = await this.fetchImpl(policyUrl, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: stepSignal(this.timeoutMs, signal),
    })
    const policyBody = await readDashscopeJson(policyResponse)
    if (!policyResponse.ok) {
      throw dashscopeError('kling', policyResponse.status, policyBody, policyResponse)
    }
    const data = asRecord(asRecord(policyBody)?.data)
    const uploadHost = readString(data, 'upload_host')
    const uploadDir = readString(data, 'upload_dir')
    const accessKeyId = readString(data, 'oss_access_key_id')
    const policy = readString(data, 'policy')
    const signature = readString(data, 'signature')
    const objectAcl = readString(data, 'x_oss_object_acl')
    const forbidOverwrite = readString(data, 'x_oss_forbid_overwrite')
    if (
      !uploadHost ||
      !uploadDir ||
      !accessKeyId ||
      !policy ||
      !signature ||
      !objectAcl ||
      !forbidOverwrite
    ) {
      throw new Error('KLING_UPLOAD_POLICY_INVALID')
    }

    const extension = mimeType === 'image/png' ? 'png' : 'jpg'
    const key = `${uploadDir}/${randomUUID()}.${extension}`
    const form = new FormData()
    form.append('OSSAccessKeyId', accessKeyId)
    form.append('policy', policy)
    form.append('Signature', signature)
    form.append('key', key)
    form.append('x-oss-object-acl', objectAcl)
    form.append('x-oss-forbid-overwrite', forbidOverwrite)
    form.append('success_action_status', '200')
    form.append(
      'file',
      new Blob([new Uint8Array(reference.data)], { type: mimeType }),
      `reference.${extension}`,
    )
    const uploadResponse = await this.fetchImpl(uploadHost, {
      method: 'POST',
      body: form,
      signal: stepSignal(this.timeoutMs, signal),
    })
    if (!uploadResponse.ok) {
      throw new Error(`KLING_REFERENCE_UPLOAD_FAILED:${uploadResponse.status}`)
    }
    return `oss://${key}`
  }

  private async pollTask(taskId: string, signal?: AbortSignal): Promise<GeneratedImageBytes> {
    for (let poll = 0; poll < this.maxPolls; poll += 1) {
      if (poll > 0) await this.sleep(this.pollIntervalMs, signal)
      const response = await this.fetchImpl(
        `${this.taskEndpoint.replace(/\/$/, '')}/${encodeURIComponent(taskId)}`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          signal: stepSignal(this.timeoutMs, signal),
        },
      )
      const body = await readDashscopeJson(response)
      if (!response.ok || asRecord(body)?.code) throw dashscopeError('kling', response.status, body, response)
      const bodyRecord = asRecord(body)
      const output = asRecord(bodyRecord?.output)
      const status = typeof output?.task_status === 'string'
        ? output.task_status
        : ''

      if (!status && typeof bodyRecord?.code === 'string') {
        throw dashscopeError('kling', response.status, body, response)
      }
      if (status === 'SUCCEEDED') {
        const imageUrl = firstDashscopeImageUrl(body)
        if (!imageUrl) throw new ImageGenerationResponseError('KLING_IMAGE_NOT_FOUND', imageResponseDetail(body), String(bodyRecord?.request_id ?? response.headers.get('x-request-id') ?? '') || undefined)
        return retrieveGeneratedImage(() => downloadGeneratedImage(imageUrl, this.fetchImpl, signal))
      }
      if (['FAILED', 'CANCELED', 'UNKNOWN'].includes(status)) {
        throw dashscopeError('kling', response.status, body, response)
      }
    }
    throw new Error('KLING_TASK_TIMEOUT')
  }
}

export function resolveKlingResolution(imageSize: string): string {
  if (!['1K', '2K', '4K'].includes(imageSize)) {
    throw new DashscopeImageGenerationValidationError(
      'kling',
      'Kling 仅支持 1K、2K 或 4K 分辨率',
    )
  }
  return imageSize.toLowerCase()
}

function readString(
  record: Record<string, unknown> | null,
  key: string,
): string {
  return typeof record?.[key] === 'string' ? record[key] : ''
}
