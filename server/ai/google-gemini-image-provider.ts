import type { GenerationResponseEvidence } from '../../src/types.ts'
import { ImageGenerationResponseError, safeGenerationDetail } from './generation-failure.ts'
import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai'

import type {
  GenerateImageProviderInput,
  GeneratedImageBytes,
  ImageGenerationProvider,
} from './image-generation-provider.ts'

export interface AppAI {
  models: {
    generateContent: (request: GenerateContentParameters) => Promise<GenerateContentResponse>
  }
}

export const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-nano-banana-2.1'
const DEFAULT_GOOGLE_REQUEST_TIMEOUT_MS = 300_000

export class GoogleImageGenerationUnavailableError extends Error {
  constructor() {
    super('GOOGLE_IMAGE_PROVIDER_NOT_CONFIGURED')
    this.name = 'GoogleImageGenerationUnavailableError'
  }
}

export class UnavailableGoogleImageGenerationProvider implements ImageGenerationProvider {
  async generateImage(): Promise<GeneratedImageBytes> {
    throw new GoogleImageGenerationUnavailableError()
  }
}

export class GoogleGeminiImageGenerationProvider implements ImageGenerationProvider {
  private readonly ai: AppAI
  private readonly model: string
  private readonly requestTimeoutMs: number

  constructor(ai: AppAI, model = DEFAULT_GEMINI_IMAGE_MODEL, requestTimeoutMs = DEFAULT_GOOGLE_REQUEST_TIMEOUT_MS) {
    this.ai = ai
    this.model = model
    this.requestTimeoutMs = requestTimeoutMs
  }

  async generateImage(input: GenerateImageProviderInput): Promise<GeneratedImageBytes> {
    const contents: Array<
      | { text: string }
      | { inlineData: { mimeType: string; data: string } }
    > = [{ text: input.prompt }]

    for (const reference of input.referenceImages) {
      contents.push({
        inlineData: {
          mimeType: reference.mimeType,
          data: reference.data.toString('base64'),
        },
      })
    }

    await input.onRequestStarted?.()
    input.signal?.throwIfAborted()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    timeout.unref()
    let response: GenerateContentResponse
    try {
      // The Node SDK forwards this signal to fetch, including consumption of the response body.
      response = await this.ai.models.generateContent({
        model: this.model,
        contents,
        config: {
          abortSignal: input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal,
          ...(input.noAutomaticRetry ? { httpOptions: { retryOptions: { attempts: 1 } } } : {}),
          responseModalities: ['IMAGE'],
          imageConfig: {
            aspectRatio: input.aspectRatio,
            imageSize: input.imageSize,
          },
        },
      })
    } catch (cause) {
      input.signal?.throwIfAborted()
      if (!controller.signal.aborted) throw cause
      throw new Error(`Google image request timeout (${this.requestTimeoutMs} ms)`, { cause })
    } finally {
      clearTimeout(timeout)
    }

    let imageData: string | null = null
    let imageMimeType = 'image/jpeg'

    for (const candidate of response.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        if (part.inlineData?.data) {
          imageData = part.inlineData.data
          imageMimeType = part.inlineData.mimeType || 'image/jpeg'
          break
        }
      }
      if (imageData) break
    }

    if (!imageData) {
      const short = (value: unknown, max = 100) => typeof value === 'string' ? safeGenerationDetail(value).slice(0,max) : undefined
      const evidence: GenerationResponseEvidence = { candidateCount: response.candidates?.length || 0, candidates: [], responseId: response.responseId ? safeGenerationDetail(response.responseId).slice(0,100) : undefined, blockReason: short(response.promptFeedback?.blockReason), blockMessage: safeGenerationDetail(response.promptFeedback?.blockReasonMessage || '') }
      for (const c of (response.candidates || []).slice(0,8)) {
        evidence.candidates.push({ finishReason: short(c.finishReason), finishMessage: safeGenerationDetail(c.finishMessage || ''), hasText: !!c.content?.parts?.some(p => !!p.text), hasImage: !!c.content?.parts?.some(p => !!p.inlineData?.data), safetyRatings: c.safetyRatings?.slice(0,8).map(r => ({ category: short(r.category), probability: short(r.probability), blocked: typeof r.blocked === 'boolean' ? r.blocked : undefined })) })
      }
      evidence.usage = {}
      for (const key of ['promptTokenCount','candidatesTokenCount','totalTokenCount','thoughtsTokenCount'] as const) {
        const value = response.usageMetadata?.[key]; if (typeof value === 'number' && Number.isFinite(value)) evidence.usage[key] = value
      }
      if ((response.candidates?.length || 0) > evidence.candidates.length) evidence.truncated = true
      while (Buffer.byteLength(JSON.stringify(evidence)) > 4096 && evidence.candidates.length) { evidence.candidates.pop(); evidence.truncated = true }
      if (Buffer.byteLength(JSON.stringify(evidence)) > 4096) { evidence.blockMessage = evidence.blockMessage?.slice(0,100); evidence.truncated = true }
      const candidate = response.candidates?.find(c => /SAFETY|PROHIBITED|BLOCKLIST|SPII/.test(String(c.finishReason))) || response.candidates?.[0]
      const reason = response.promptFeedback?.blockReason || candidate?.finishReason || 'NO_IMAGE'
      const text = candidate?.content?.parts?.map(part => part.text || '').filter(Boolean).join(' ')
      throw new ImageGenerationResponseError(String(reason), response.promptFeedback?.blockReasonMessage || candidate?.finishMessage || text || '', response.responseId, evidence)
    }

    return {
      buffer: Buffer.from(imageData, 'base64'),
      mimeType: imageMimeType,
    }
  }
}
