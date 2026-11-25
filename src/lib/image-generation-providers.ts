import type { PersonalPreferences } from '../types.ts'

export const SEEDREAM_5_5_IMAGE_MODEL = 'doubao-seedream-5-5-261028'
const LEGACY_SEEDREAM_LABELS = new Map([
  ['doubao-seedream-5-0-pro-260628', 'Seedream · 5.0 Pro'],
  ['doubao-seedream-5-0-flash-260915', 'Seedream · 5.0 Flash'],
  ['doubao-seedream-5-0-260128', 'Seedream · 5.0 Lite'],
  ['doubao-seedream-5-0-lite-260128', 'Seedream · 5.0 Lite'],
])

export function isRetiredSeedreamRequest(provider: string, model: string, imageSize?: string) {
  return provider === 'seedream' && (LEGACY_SEEDREAM_LABELS.has(model) || imageSize === '1.5K')
}

export function migrateSeedreamResolution(size?: string) {
  return size === '1.5K' ? '1K' : size === '1K' ? '1K' : '2K'
}

export const GOOGLE_NANO_BANANA_2_1_MODEL = 'gemini-nano-banana-2.1'
// Gemini 3.1 Flash Image（Nano Banana 2）已于 2026-10-06 被 2.1 取代，保留旧 ID 用于兼容存量偏好与历史记录。
const LEGACY_GOOGLE_IMAGE_MODELS = ['gemini-3.1-flash-image']

export type ImageGenerationProviderName =
  | 'google'
  | 'seedream'
  | 'qwen-local'
  | 'krea-local'
  | 'qwen'
  | 'kling'
  | 'openai-compatible'
  | 'demo'
// Stored records may refer to providers the current runtime no longer offers.
export type RecordedImageGenerationProvider = string
export type ImageGenerationQuality = 'low' | 'medium' | 'high'
export type ImageGenerationParameterMode = 'resolution' | 'quality'

export interface ImageGenerationProviderDefinition {
  id: ImageGenerationProviderName
  label: string
  maxReferenceImages: number
  supportedResolutions: readonly string[]
  supportedAspectRatios: readonly string[]
}

export interface ImageGenerationModelDefinition {
  provider: ImageGenerationProviderName
  model: string
  label: string
  defaultResolution?: string
  referenceAspectRatioMode?: 'source' | 'source-or-preset'
  parameterMode: ImageGenerationParameterMode
  fixedQuality?: ImageGenerationQuality
  defaultAspectRatio: string
  maxReferenceImages: number
  supportedResolutions: readonly string[]
  supportedQualities: readonly ImageGenerationQuality[]
  supportedAspectRatios: readonly string[]
}

const ALL_ASPECT_RATIOS = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
] as const

export const OPENAI_IMAGE_DEFAULT_MODEL = 'gpt-image-1'
export const DEMO_IMAGE_MODEL = 'banana-demo-v1'
export const OPENAI_IMAGE_SIZE_PRESETS: Readonly<Record<string, string>> = {
  auto: 'auto',
  '1:1': '1024x1024',
  '2:3': '1024x1536',
  '3:2': '1536x1024',
}

export const LOCAL_QWEN_MODEL = 'qwen-image-2.1-UC-Q8_0'
export const LOCAL_KREA_MODEL = 'krea-2-turbo'
export const isLocalImageProvider = (provider: unknown): boolean => provider === 'qwen-local' || provider === 'krea-local'
export const LOCAL_QWEN_SIZE_PRESETS: Record<string,Record<string,readonly [number,number]>> = {
  '1K': {'1:1':[1024,1024],'4:3':[1184,896],'3:4':[896,1184],'3:2':[1280,864],'2:3':[864,1280],'16:9':[1376,768],'9:16':[768,1376],'4:5':[896,1120],'5:4':[1120,896]},
  '2K': {'1:1':[2048,2048],'4:3':[2400,1792],'3:4':[1792,2400],'3:2':[2528,1696],'2:3':[1696,2528],'16:9':[2752,1536],'9:16':[1536,2752],'4:5':[1792,2240],'5:4':[2240,1792]},
}
export function localQwenReferenceDimensions(width: number,height: number,resolution: number): {width:number;height:number} {
  const ratio=width/height
  if(!Number.isFinite(ratio)||width<=0||height<=0)throw new Error('参考图尺寸无效')
  return {width:Math.max(32,Math.round(resolution*Math.sqrt(ratio)/32)*32),height:Math.max(32,Math.round(resolution/Math.sqrt(ratio)/32)*32)}
}
export function resolveLocalQwenOutputSize(imageSize: string,aspectRatio: string,source?: {width:number;height:number}): {width:number;height:number}|null {
  const presets=Object.hasOwn(LOCAL_QWEN_SIZE_PRESETS,imageSize)?LOCAL_QWEN_SIZE_PRESETS[imageSize]:undefined
  if(!presets)throw new Error('本地 Qwen 仅支持 1K/2K')
  if(aspectRatio==='source'){
    if(!source)return null
    const ratio=source.width/source.height
    if(!Number.isFinite(ratio)||ratio<1/3||ratio>3)throw new Error('第一张参考图比例应在 1:3 至 3:1 之间')
    return localQwenReferenceDimensions(source.width,source.height,imageSize==='2K'?2048:1024)
  }
  const size=Object.hasOwn(presets,aspectRatio)?presets[aspectRatio]:undefined
  if(!size)throw new Error('本地 Qwen 不支持该宽高比')
  return {width:size[0],height:size[1]}
}
export const IMAGE_GENERATION_MODEL_DEFINITIONS: readonly ImageGenerationModelDefinition[] = [
  { provider: 'krea-local', model: LOCAL_KREA_MODEL, label: '本地 Krea 2 Turbo', parameterMode: 'resolution', defaultResolution: '1K', defaultAspectRatio: '1:1', maxReferenceImages: 0, supportedResolutions: ['1K', '2K'], supportedQualities: [], supportedAspectRatios: Object.keys(LOCAL_QWEN_SIZE_PRESETS['1K']) },
  { provider: 'qwen-local', model: LOCAL_QWEN_MODEL, label: '本地 Qwen Image 2.1', parameterMode: 'resolution', defaultResolution: '1K', referenceAspectRatioMode: 'source-or-preset', defaultAspectRatio: '1:1', maxReferenceImages: 10, supportedResolutions: ['1K', '2K'], supportedQualities: [], supportedAspectRatios: Object.keys(LOCAL_QWEN_SIZE_PRESETS['1K']) },
  {
    provider: 'seedream',
    model: SEEDREAM_5_5_IMAGE_MODEL,
    defaultResolution: '2K',
    label: 'Seedream · 5.5',
    parameterMode: 'resolution',
    defaultAspectRatio: '1:1',
    maxReferenceImages: 10,
    supportedResolutions: ['1K', '2K'],
    supportedQualities: [],
    supportedAspectRatios: ALL_ASPECT_RATIOS,
  },
  {
    provider: 'google',
    model: GOOGLE_NANO_BANANA_2_1_MODEL,
    label: 'Google · Nano Banana 2.1',
    parameterMode: 'resolution',
    defaultAspectRatio: '1:1',
    maxReferenceImages: 14,
    supportedResolutions: ['1K', '2K', '4K'],
    supportedQualities: [],
    supportedAspectRatios: ALL_ASPECT_RATIOS,
  },
  {
    provider: 'qwen',
    model: 'qwen-image-3.0-pro',
    label: 'Qwen · Image 3.0 Pro',
    parameterMode: 'resolution',
    defaultAspectRatio: '1:1',
    maxReferenceImages: 3,
    supportedResolutions: ['1K', '2K'],
    supportedQualities: [],
    supportedAspectRatios: ALL_ASPECT_RATIOS,
  },
  {
    provider: 'kling',
    model: 'kling/kling-v3-omni-image-generation',
    label: 'Kling · V3 Omni Image',
    parameterMode: 'resolution',
    defaultAspectRatio: '1:1',
    maxReferenceImages: 10,
    supportedResolutions: ['1K', '2K', '4K'],
    supportedQualities: [],
    supportedAspectRatios: ['1:1', '16:9', '9:16'],
  },
  {
    provider: 'openai-compatible',
    model: OPENAI_IMAGE_DEFAULT_MODEL,
    label: `OpenAI 兼容 · ${OPENAI_IMAGE_DEFAULT_MODEL}`,
    parameterMode: 'quality',
    defaultAspectRatio: 'auto',
    maxReferenceImages: 16,
    supportedResolutions: [],
    supportedQualities: ['low', 'medium', 'high'],
    supportedAspectRatios: Object.keys(OPENAI_IMAGE_SIZE_PRESETS),
  },
  {
    provider: 'demo',
    model: DEMO_IMAGE_MODEL,
    label: '免费演示 · 本地占位图',
    parameterMode: 'resolution',
    defaultResolution: '1K',
    defaultAspectRatio: '1:1',
    maxReferenceImages: 0,
    supportedResolutions: ['1K'],
    supportedQualities: [],
    supportedAspectRatios: ALL_ASPECT_RATIOS,
  },
]

export const IMAGE_GENERATION_PROVIDER_DEFINITIONS: Record<
  ImageGenerationProviderName,
  ImageGenerationProviderDefinition
> = {
  seedream: {
    id: 'seedream',
    label: 'Seedream 5.5',
    maxReferenceImages: 10,
    supportedResolutions: ['1K', '2K'],
    supportedAspectRatios: ALL_ASPECT_RATIOS,
  },
  google: {
    id: 'google',
    label: 'Google Gemini',
    maxReferenceImages: 14,
    supportedResolutions: ['1K', '2K', '4K'],
    supportedAspectRatios: ALL_ASPECT_RATIOS,
  },
  'krea-local': { id: 'krea-local', label: '本地 Krea', maxReferenceImages: 0, supportedResolutions: ['1K', '2K'], supportedAspectRatios: Object.keys(LOCAL_QWEN_SIZE_PRESETS['1K']) },
  'qwen-local': { id: 'qwen-local', label: '本地 Qwen', maxReferenceImages: 10, supportedResolutions: ['1K', '2K'], supportedAspectRatios: Object.keys(LOCAL_QWEN_SIZE_PRESETS['1K']) },
  qwen: {
    id: 'qwen',
    label: 'Qwen Image',
    maxReferenceImages: 3,
    supportedResolutions: ['1K', '2K'],
    supportedAspectRatios: ALL_ASPECT_RATIOS,
  },
  kling: {
    id: 'kling',
    label: 'Kling V3 Omni Image',
    maxReferenceImages: 10,
    supportedResolutions: ['1K', '2K', '4K'],
    supportedAspectRatios: ['1:1', '16:9', '9:16'],
  },
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI 兼容',
    maxReferenceImages: 16,
    supportedResolutions: [],
    supportedAspectRatios: Object.keys(OPENAI_IMAGE_SIZE_PRESETS),
  },
  demo: {
    id: 'demo',
    label: '免费演示',
    maxReferenceImages: 0,
    supportedResolutions: ['1K'],
    supportedAspectRatios: ALL_ASPECT_RATIOS,
  },
}

export function isImageGenerationProviderName(
  value: unknown,
): value is ImageGenerationProviderName {
  return typeof value === 'string' && Object.hasOwn(IMAGE_GENERATION_PROVIDER_DEFINITIONS, value)
}

export function isRetiredGenerationProvider(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !isImageGenerationProviderName(value)
}

export const RETIRED_GENERATION_PROVIDER_MESSAGE = '该生图渠道已下线或不受支持，请选择当前可用的渠道。'

export function defaultModelForProvider(provider: ImageGenerationProviderName): string {
  return IMAGE_GENERATION_MODEL_DEFINITIONS.find(definition => definition.provider === provider)!.model
}

export function imageGenerationModelKey(provider: string, model: string): string {
  return `${provider}:${resolveImageGenerationModel(provider, model)}`
}

export function resolveImageGenerationModel(provider: string, model: string): string {
  if (provider === 'seedream' && LEGACY_SEEDREAM_LABELS.has(model)) return SEEDREAM_5_5_IMAGE_MODEL
  if (provider === 'google' && LEGACY_GOOGLE_IMAGE_MODELS.includes(model)) return GOOGLE_NANO_BANANA_2_1_MODEL
  return model
}

export function normalizeImageGenerationModelKey(key: string): string {
  const separatorIndex = key.indexOf(':')
  const provider = key.slice(0, separatorIndex)
  if (separatorIndex <= 0 || !isImageGenerationProviderName(provider)) return key
  return imageGenerationModelKey(provider, key.slice(separatorIndex + 1))
}

type GenerationDefaults = NonNullable<PersonalPreferences['defaultGeneration']>
type StoredGenerationDefaults = Omit<GenerationDefaults, 'provider'> & { provider: RecordedImageGenerationProvider }

export function normalizeGenerationDefaults(defaults: StoredGenerationDefaults): GenerationDefaults {
  const { provider, model, aspectRatio, imageSize } = defaults
  if (!isImageGenerationProviderName(provider)) {
    return {
      provider: 'google',
      model: GOOGLE_NANO_BANANA_2_1_MODEL,
      aspectRatio: ALL_ASPECT_RATIOS.some(ratio => ratio === aspectRatio) ? aspectRatio : '1:1',
      imageSize: imageSize === '1K' || imageSize === '4K' ? imageSize : '2K',
    }
  }
  const migratedDefaults = { ...defaults, provider, model: resolveImageGenerationModel(provider, model) }
  if (provider === 'seedream') {
    migratedDefaults.imageSize = migrateSeedreamResolution(migratedDefaults.imageSize)
  }
  return migratedDefaults
}

export function normalizeFavoriteModelKeys(keys: string[]): string[] {
  return [...new Set(keys.filter(key => !key.startsWith('poe:')).map(normalizeImageGenerationModelKey))]
}

export function normalizeGenerationPreferences(
  preferences: Omit<PersonalPreferences, 'defaultGeneration'> & { defaultGeneration?: StoredGenerationDefaults },
): PersonalPreferences {
  const { defaultGeneration, favoriteModels, ...rest } = preferences
  return {
    ...rest,
    ...(defaultGeneration && (defaultGeneration.provider === 'poe' || isImageGenerationProviderName(defaultGeneration.provider))
      ? { defaultGeneration: normalizeGenerationDefaults(defaultGeneration) } : {}),
    favoriteModels: normalizeFavoriteModelKeys(favoriteModels).filter(key => isImageGenerationProviderName(key.split(':', 1)[0])),
  }
}

export function findImageGenerationModelDefinition(
  provider: ImageGenerationProviderName,
  model: string,
): ImageGenerationModelDefinition | undefined {
  return IMAGE_GENERATION_MODEL_DEFINITIONS.find(
    (definition) => definition.provider === provider && definition.model === model,
  )
}

const LEGACY_POE_MODEL_LABELS = new Map([
  ['nano-banana-2', 'Nano Banana 2'],
  ['nano-banana-2.1', 'Nano Banana 2.1'],
  ['gpt-image-2', 'GPT Image 2'],
  ['gpt-image-2.6-sunburst', 'GPT Image 2.6 Sunburst'],
  ['gpt-image-2.6-flare', 'GPT Image 2.6 Flare'],
])

export function formatImageGenerationSource(
  provider: RecordedImageGenerationProvider,
  model?: string,
): string {
  if (provider === 'poe') {
    return `Poe · ${model ? LEGACY_POE_MODEL_LABELS.get(model) ?? model : '模型未记录'}`
  }
  if (model) {
    const legacyLabel = provider === 'seedream' && LEGACY_SEEDREAM_LABELS.get(model)
    if (legacyLabel) return legacyLabel
    if (provider === 'google' && LEGACY_GOOGLE_IMAGE_MODELS.includes(model)) return 'Google · Nano Banana 2'
    const definition = isImageGenerationProviderName(provider) && findImageGenerationModelDefinition(provider, model)
    if (definition) return definition.label
    return `${formatImageGenerationProvider(provider)} · ${model}`
  }
  return `${formatImageGenerationProvider(provider)} · 模型未记录`
}

export function formatImageGenerationProvider(provider: RecordedImageGenerationProvider): string {
  if (provider === 'poe') return 'Poe'
  if (provider === 'seedream') return 'Seedream'
  if (provider === 'google') return 'Google'
  if (provider === 'qwen') return 'Qwen'
  if (provider === 'kling') return 'Kling'
  return isImageGenerationProviderName(provider) ? IMAGE_GENERATION_PROVIDER_DEFINITIONS[provider].label : '已下线渠道'
}

export function generationAspectRatios(model: Pick<ImageGenerationModelDefinition, 'referenceAspectRatioMode' | 'supportedAspectRatios'>, referenceCount: number): readonly string[] {
  if(referenceCount>0 && model.referenceAspectRatioMode==='source')return ['source']
  return referenceCount>0 && model.referenceAspectRatioMode==='source-or-preset' ? ['source',...model.supportedAspectRatios] : model.supportedAspectRatios
}
