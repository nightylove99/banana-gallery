import type { AppEnv } from '../config/env.ts'
import { OpenAICompatibleImageGenerationProvider } from './openai-compatible-image-provider.ts'

export function createOpenAICompatibleRuntimeProvider(
  env: Pick<AppEnv, 'openaiImageApiKey' | 'openaiImageBaseUrl' | 'openaiImageModel'>,
  fetchImpl?: typeof fetch,
) {
  if (!env.openaiImageApiKey) return undefined
  return new OpenAICompatibleImageGenerationProvider({
    apiKey: env.openaiImageApiKey,
    baseUrl: env.openaiImageBaseUrl,
    model: env.openaiImageModel,
    fetch: fetchImpl,
  })
}
