import type { AppEnv } from '../config/env.ts'
import {
  IMAGE_GENERATION_MODEL_DEFINITIONS,
  findImageGenerationModelDefinition,
} from '../../src/lib/image-generation-providers.ts'
import type {
  GeneratedImageBytes,
  ImageGenerationProvider,
} from './image-generation-provider.ts'
import { QwenImageGenerationProvider } from './qwen-image-provider.ts'
import { KlingImageGenerationProvider } from './kling-image-provider.ts'

type DashscopeRuntimeEnv = Pick<
  AppEnv,
  | 'dashscopeApiKey'
  | 'qwenImageModel'
  | 'qwenImageEndpoint'
  | 'klingImageModel'
  | 'klingImageEndpoint'
  | 'dashscopeTaskEndpoint'
  | 'dashscopeUploadEndpoint'
>

interface DashscopeRuntimeProviderDeps {
  readAgentSecret: (key: string) => string
  warn?: (message: string) => void
}

export class DashscopeImageGenerationUnavailableError extends Error {
  constructor() {
    super('DASHSCOPE_API_KEY_NOT_CONFIGURED')
    this.name = 'DashscopeImageGenerationUnavailableError'
  }
}

class UnavailableDashscopeImageGenerationProvider
implements ImageGenerationProvider {
  async generateImage(): Promise<GeneratedImageBytes> {
    throw new DashscopeImageGenerationUnavailableError()
  }
}

/** 注册表里 qwen 渠道的全部模型，外加环境变量显式指定的模型（去重，配置项在前） */
export function resolveQwenImageModels(configuredModel: string): string[] {
  const registryModels = IMAGE_GENERATION_MODEL_DEFINITIONS
    .filter((definition) => definition.provider === 'qwen')
    .map((definition) => definition.model)
  return [...new Set([configuredModel, ...registryModels].filter((model) => model.trim()))]
}

export function createDashscopeRuntimeProviders(
  env: DashscopeRuntimeEnv,
  deps: DashscopeRuntimeProviderDeps,
): {
  available: boolean
  qwenProvider: ImageGenerationProvider
  /** 按模型 ID 索引：qwen 渠道的每个模型各有一个独立 provider 实例 */
  qwenProviders: Record<string, ImageGenerationProvider>
  klingProvider: ImageGenerationProvider
  qwenStrategy: { mode: 'qwen'; model: string }
  klingStrategy: { mode: 'kling'; model: string }
} {
  const qwenStrategy = { mode: 'qwen' as const, model: env.qwenImageModel }
  const klingStrategy = { mode: 'kling' as const, model: env.klingImageModel }
  const qwenModels = resolveQwenImageModels(env.qwenImageModel)
  const apiKey = resolveDashscopeApiKey(env, deps)

  if (!apiKey) {
    deps.warn?.(
      '图片生成暂不可用：未能读取 DASHSCOPE_API_KEY。服务仍会启动，其他供应商与画廊功能不受影响。',
    )
    const unavailable = new UnavailableDashscopeImageGenerationProvider()
    return {
      available: false,
      qwenProvider: unavailable,
      qwenProviders: Object.fromEntries(
        qwenModels.map((model) => [model, unavailable]),
      ),
      klingProvider: unavailable,
      qwenStrategy,
      klingStrategy,
    }
  }

  const createQwenProvider = (model: string) => new QwenImageGenerationProvider({
    apiKey,
    model,
    endpoint: env.qwenImageEndpoint,
    maxReferenceImages:
      findImageGenerationModelDefinition('qwen', model)?.maxReferenceImages ?? 3,
  })
  const qwenProviders: Record<string, ImageGenerationProvider> =
    Object.fromEntries(qwenModels.map((model) => [model, createQwenProvider(model)]))

  return {
    available: true,
    qwenProvider:
      qwenProviders[env.qwenImageModel] ?? createQwenProvider(env.qwenImageModel),
    qwenProviders,
    klingProvider: new KlingImageGenerationProvider({
      apiKey,
      model: env.klingImageModel,
      endpoint: env.klingImageEndpoint,
      taskEndpoint: env.dashscopeTaskEndpoint,
      uploadEndpoint: env.dashscopeUploadEndpoint,
    }),
    qwenStrategy,
    klingStrategy,
  }
}

function resolveDashscopeApiKey(
  env: DashscopeRuntimeEnv,
  deps: DashscopeRuntimeProviderDeps,
): string | null {
  if (env.dashscopeApiKey) return env.dashscopeApiKey

  try {
    const secret = deps.readAgentSecret('DASHSCOPE_API_KEY').trim()
    return secret || null
  } catch {
    return null
  }
}
