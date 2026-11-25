import type { AppEnv } from '../config/env.ts'
import type {
  GeneratedImageBytes,
  ImageGenerationProvider,
} from './image-generation-provider.ts'
import {
  DEFAULT_SEEDREAM_IMAGE_MODEL,
  SeedreamImageGenerationProvider,
} from './seedream-image-provider.ts'

type SeedreamRuntimeEnv = Pick<AppEnv, 'seedreamApiKey' | 'seedreamImageModel'>

interface SeedreamRuntimeProviderDeps {
  readAgentSecret: (key: string) => string
  warn?: (message: string) => void
}

export class SeedreamImageGenerationUnavailableError extends Error {
  constructor() {
    super('VOLCENGINE_DOUBAO_API_KEY_NOT_CONFIGURED')
    this.name = 'SeedreamImageGenerationUnavailableError'
  }
}

class UnavailableSeedreamImageGenerationProvider
implements ImageGenerationProvider {
  async generateImage(): Promise<GeneratedImageBytes> {
    throw new SeedreamImageGenerationUnavailableError()
  }
}

export function createSeedreamRuntimeProvider(
  env: SeedreamRuntimeEnv,
  deps: SeedreamRuntimeProviderDeps,
): {
  available: boolean
  imageGenerationProvider: ImageGenerationProvider
  imageGenerationModels: Record<string, ImageGenerationProvider>
  strategy: { mode: 'seedream'; model: string }
} {
  const model = DEFAULT_SEEDREAM_IMAGE_MODEL
  const strategy = { mode: 'seedream' as const, model }
  const apiKey = resolveSeedreamApiKey(env, deps)

  if (!apiKey) {
    deps.warn?.(
      '图片生成暂不可用：未能读取 VOLCENGINE_DOUBAO_API_KEY。服务仍会启动，其他供应商与画廊功能不受影响。',
    )
    const unavailableProvider = new UnavailableSeedreamImageGenerationProvider()
    return {
      available: false,
      imageGenerationProvider: unavailableProvider,
      imageGenerationModels: {
        [DEFAULT_SEEDREAM_IMAGE_MODEL]: unavailableProvider,
      },
      strategy,
    }
  }

  const provider = new SeedreamImageGenerationProvider({ apiKey, model })

  return {
    available: true,
    imageGenerationProvider: provider,
    imageGenerationModels: { [model]: provider },
    strategy,
  }
}

function resolveSeedreamApiKey(
  env: SeedreamRuntimeEnv,
  deps: SeedreamRuntimeProviderDeps,
): string | null {
  if (env.seedreamApiKey) return env.seedreamApiKey

  try {
    const secret = deps.readAgentSecret('VOLCENGINE_DOUBAO_API_KEY').trim()
    return secret || null
  } catch {
    return null
  }
}
