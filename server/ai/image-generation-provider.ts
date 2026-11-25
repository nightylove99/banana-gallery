import type { GenerationExecution } from '../../src/types.ts'
export interface ReferenceImageForGeneration {
  mimeType: string
  data: Buffer
}

export interface GenerateImageProviderInput {
  signal?: AbortSignal
  requestId?: string
  execution?: GenerationExecution
  noAutomaticRetry?: boolean
  resumeTaskId?: string
  onRequestStarted?: () => Promise<void>
  onRequestStartedWithUpstream?: (id: string, execution: GenerationExecution) => Promise<void>
  onTaskSubmitted?: (id: string, execution?: GenerationExecution) => Promise<void>
  prompt: string
  referenceImages: ReferenceImageForGeneration[]
  aspectRatio: string
  imageSize?: string
  quality?: 'low' | 'medium' | 'high'
}

export interface GeneratedImageBytes {
  /** Called only after both the local image and its index entry are saved. */
  onSaved?: (localPath: string) => Promise<void>
  execution?: GenerationExecution
  buffer: Buffer
  mimeType: string
}

export interface ImageGenerationProvider {
  generateImage(input: GenerateImageProviderInput): Promise<GeneratedImageBytes>
}
