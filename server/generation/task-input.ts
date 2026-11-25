import type { GenerationTaskInput } from '../../src/types'
import type { ImageGenerationModelDefinition } from '../../src/lib/image-generation-providers'
import {resolveImageGenerationModel,generationAspectRatios,isRetiredSeedreamRequest,isRetiredGenerationProvider,RETIRED_GENERATION_PROVIDER_MESSAGE} from '../../src/lib/image-generation-providers'
import { TaskError } from './task-queue'
export function parseTaskInput(body: Record<string, unknown>, models: ImageGenerationModelDefinition[]): GenerationTaskInput {
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 20_000) throw new TaskError('提示词应为 1–20,000 字')
  if (body.provider === 'seedream' && typeof body.model === 'string' && isRetiredSeedreamRequest(body.provider, body.model, typeof body.imageSize === 'string' ? body.imageSize : undefined)) throw new TaskError('Seedream 仅支持 5.5 的 1K 或 2K，请调整后提交')
  if (isRetiredGenerationProvider(body.provider)) throw new TaskError(RETIRED_GENERATION_PROVIDER_MESSAGE)
  const model = models.find(item => item.provider === body.provider && typeof body.model === 'string' && item.model === resolveImageGenerationModel(item.provider, body.model))
  if (!model) throw new TaskError('不支持的生成模型')
  const refs = body.referenceFilenames ?? []
  if (!Array.isArray(refs) || refs.length > model.maxReferenceImages || refs.some(name => typeof name !== 'string' || !name || /[/\\\0]/.test(name) || name.startsWith('.'))) throw new TaskError(`参考图无效，当前模型最多支持 ${model.maxReferenceImages} 张`)
  const followsReference = refs.length > 0 && model.referenceAspectRatioMode === 'source'
  const aspectRatio = followsReference ? 'source' : body.aspectRatio ?? (refs.length>0 && model.referenceAspectRatioMode==='source-or-preset'?'source':model.defaultAspectRatio)
  if (typeof aspectRatio !== 'string' || !generationAspectRatios(model,refs.length).includes(aspectRatio)) throw new TaskError('当前模型不支持该比例')
  const input: GenerationTaskInput = { prompt: body.prompt, referenceFilenames: [...refs], provider: model.provider, model: model.model, aspectRatio }
  if (model.parameterMode === 'resolution') {
    const size = body.imageSize ?? model.defaultResolution ?? '2K'
    if (typeof size !== 'string' || !model.supportedResolutions.includes(size)) throw new TaskError('当前模型不支持该分辨率')
    input.imageSize = size
    if (model.fixedQuality) {
      if (body.quality !== undefined && body.quality !== model.fixedQuality) throw new TaskError(`当前模型仅支持质量 ${model.fixedQuality}`)
      input.quality = model.fixedQuality
    }
  } else {
    const quality = body.quality ?? 'high'
    if ((quality !== 'low' && quality !== 'medium' && quality !== 'high') || !model.supportedQualities.includes(quality)) throw new TaskError('当前模型不支持该质量')
    input.quality = quality
  }
  if (body.sourceAssetId !== undefined) {
    if (typeof body.sourceAssetId !== 'string') throw new TaskError('来源条目无效')
    input.sourceAssetId = body.sourceAssetId
  }
  if (body.sourceTaskId !== undefined) {
    if (typeof body.sourceTaskId !== 'string') throw new TaskError('来源任务无效')
    input.sourceTaskId = body.sourceTaskId
  }
  if (body.referenceNotes !== undefined) {
    if (!Array.isArray(body.referenceNotes) || body.referenceNotes.length !== refs.length || body.referenceNotes.some(note => typeof note !== 'string' || note.length > 500)) throw new TaskError('参考图用途与顺序不匹配')
    input.referenceNotes = [...body.referenceNotes]
  }
  return input
}
