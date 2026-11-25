import { classifyResolution, matchAspectRatio } from '@/lib/image-utils'
import type { GalleryImage, GalleryImageGeneration, GeneratePageState } from '@/types'
import type { RecordedImageGenerationProvider } from '@/lib/image-generation-providers'
import type { ImageGenerationQuality } from '@/lib/image-generation-providers'

export function buildGenerationSnapshot(input: {
  aspectRatio: string
  imageSize?: string
  provider?: RecordedImageGenerationProvider
  model?: string
  quality?: ImageGenerationQuality
  execution?: GalleryImageGeneration['execution']
  title?: string
  notes?: string
}): GalleryImageGeneration {
  const snapshot: GalleryImageGeneration = {
    aspectRatio: input.aspectRatio,
  }

  if (input.imageSize) snapshot.imageSize = input.imageSize
  if (input.provider) snapshot.provider = input.provider
  if (input.model) snapshot.model = input.model
  if (input.quality) snapshot.quality = input.quality
  if (input.execution) snapshot.execution = input.execution
  if (input.title) snapshot.title = input.title
  if (input.notes) snapshot.notes = input.notes

  return snapshot
}

export function buildGeneratePageState(image: GalleryImage): GeneratePageState {
  return {
    sourceAssetId: image.id,
    ...(image.referenceNotes ? { referenceNotes: image.referenceNotes } : {}),
    prompt: image.prompt,
    referenceImages: image.referenceImages,
    aspectRatio: image.generation?.aspectRatio ?? matchAspectRatio(image.width, image.height),
    imageSize: image.generation?.imageSize ?? classifyResolution(image.width, image.height),
    ...(image.generation?.provider ? { provider: image.generation.provider } : {}),
    ...(image.generation?.model ? { model: image.generation.model } : {}),
    ...(image.generation?.quality ? { quality: image.generation.quality } : {}),
    ...(image.generation?.outputFormat ? { outputFormat: image.generation.outputFormat } : {}),
  }
}

export function generateFromAssetHref(id: string): string {
  return `/generate?fromAsset=${encodeURIComponent(id)}`
}

export function parseGenerateFromAsset(search: string): string | null {
  return new URLSearchParams(search).get('fromAsset')
}
