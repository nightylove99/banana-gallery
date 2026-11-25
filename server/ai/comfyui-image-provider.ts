import { abortableSleep, stepSignal } from './request-abort.ts'
import type { QwenRemoteOutput } from './qwen-output-store.ts'
import { retrieveGeneratedImage } from './generation-failure.ts'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import sharp, { type Metadata } from 'sharp'
import { Agent } from 'undici'
import { fetchWithDispatcher } from '../dispatcher-fetch.ts'
import type { GenerationExecution } from '../../src/types.ts'
import { createQwenExecution, createKreaExecution } from './qwen-execution.ts'
import { localQwenReferenceDimensions, resolveLocalQwenOutputSize } from '../../src/lib/image-generation-providers.ts'
import { TaskError } from '../generation/task-queue.ts'
import type { GenerateImageProviderInput, GeneratedImageBytes, ImageGenerationProvider } from './image-generation-provider.ts'

export const COMFYUI_BASE_URL = 'http://127.0.0.1:18488'
const directAgent = new Agent()
export const comfyuiFetch = (url: string, init?: RequestInit): Promise<Response> =>
  fetchWithDispatcher(url, init, directAgent)
interface Stats { devices?: Array<{ name?: string }> }
interface Upload { name: string; subfolder: string }
interface HistoryEntry { status?: { status_str?: string; completed?: boolean }; outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }> }
type History = Record<string, HistoryEntry>
interface Queue { queue_running?: unknown[][]; queue_pending?: unknown[][] }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>
async function referenceSize(data: Buffer, resolution: number, first: boolean): Promise<{ width: number; height: number }> {
  let dimensions: Metadata
  try { dimensions = await sharp(data).metadata() } catch { throw new TaskError('参考图无法解码') }
  const rotated = (dimensions.orientation ?? 1) >= 5
  const ratio = rotated ? (dimensions.height ?? 0) / (dimensions.width ?? 0) : (dimensions.width ?? 0) / (dimensions.height ?? 0)
  if (!Number.isFinite(ratio) || ratio <= 0) throw new TaskError('参考图尺寸无效')
  if (first && (ratio < 1 / 3 || ratio > 3)) throw new TaskError('第一张参考图比例应在 1:3 至 3:1 之间')
  return localQwenReferenceDimensions(rotated?dimensions.height!:dimensions.width!,rotated?dimensions.width!:dimensions.height!,resolution)
}
const templates = {
  t2i: JSON.parse(fs.readFileSync(new URL('./workflows/qwen21-t2i-api.json', import.meta.url), 'utf8')) as Graph,
  edit: JSON.parse(fs.readFileSync(new URL('./workflows/qwen21-edit-api.json', import.meta.url), 'utf8')) as Graph,
}
const templatesV2 = {
  t2i: JSON.parse(fs.readFileSync(new URL('./workflows/qwen21-v2-t2i-api.json', import.meta.url), 'utf8')) as Graph,
  edit: JSON.parse(fs.readFileSync(new URL('./workflows/qwen21-v2-edit-api.json', import.meta.url), 'utf8')) as Graph,
}
const kreaTemplate = JSON.parse(fs.readFileSync(new URL('./workflows/krea2-turbo-v1-t2i-api.json', import.meta.url), 'utf8')) as Graph
for (const graph of [...Object.values(templates), ...Object.values(templatesV2)]) {
  if (typeof graph['451']?.inputs.unet_name !== 'string' || graph['900']?.class_type !== 'SaveImage') throw new Error('Qwen 工作流合同不匹配')
}

export class ComfyUIImageProvider implements ImageGenerationProvider {
  private readonly kind: 'qwen' | 'krea'
  private readonly fetchImpl: Fetch
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly signal?: AbortSignal
  private readonly pollInterval: number
  private readonly remoteOutput?: QwenRemoteOutput
  private readonly unetName?: string
  private readonly gpuPattern: RegExp
  private tail: Promise<unknown> = Promise.resolve()
  constructor(options: { kind?: 'qwen' | 'krea'; remoteOutput?: QwenRemoteOutput; fetch?: Fetch; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; signal?: AbortSignal; pollIntervalMs?: number; unetName?: string; gpuPattern?: string } = {}) {
    this.kind = options.kind ?? 'qwen'
    this.remoteOutput = options.remoteOutput
    this.fetchImpl = options.fetch ?? comfyuiFetch
    this.sleep = options.sleep ?? abortableSleep
    this.signal = options.signal
    this.pollInterval = options.pollIntervalMs ?? 2000
    this.unetName = options.unetName
    this.gpuPattern = new RegExp(options.gpuPattern ?? 'cuda', 'i')
  }
  generateImage(input: GenerateImageProviderInput): Promise<GeneratedImageBytes> {
    const signal = input.signal && this.signal ? AbortSignal.any([input.signal, this.signal]) : input.signal ?? this.signal
    const run = this.tail.then(() => {
      signal?.throwIfAborted()
      return this.execute({ ...input, signal })
    })
    this.tail = run.catch(() => {})
    return run
  }
  private async request(route: string, signal?: AbortSignal, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(`${COMFYUI_BASE_URL}${route}`, { ...init, signal: stepSignal(15_000, signal) })
  }
  private async json<T>(route: string, signal?: AbortSignal, init?: RequestInit): Promise<T> {
    const response = await this.request(route, signal, init)
    if (!response.ok) throw new TaskError(`本地 ComfyUI 接口返回 ${response.status}`, response.status, true, response.status >= 500)
    return response.json() as Promise<T>
  }
  private async execute(input: GenerateImageProviderInput): Promise<GeneratedImageBytes> {
    if (this.kind === 'krea') return this.executeKrea(input)
    const id = input.resumeTaskId ?? input.requestId ?? randomUUID()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new TaskError('生成任务标识无效')
    if (input.referenceImages.length > 10 || !['1K', '2K'].includes(input.imageSize ?? '1K')) throw new TaskError('本地 Qwen 支持 1K/2K 和最多十张参考图')
    const edit = input.referenceImages.length > 0
    let execution = input.execution ?? createQwenExecution(input.resumeTaskId ? 'qwen21-v1' : 'qwen21-v2')
    const v2 = execution.workflowVersion === 'qwen21-v2'
    if ((!v2 && execution.workflowVersion !== 'qwen21-v1') || execution.engine !== 'comfyui' || !Number.isSafeInteger(execution.seed) || execution.seed < 0 || execution.steps !== 25 || execution.cfg !== 1 || execution.sampler !== 'euler' || execution.scheduler !== 'simple') throw new TaskError('生成快照无效')
    if (input.resumeTaskId && v2) {
      if (![execution.width, execution.height].every(value => Number.isSafeInteger(value) && value! >= 32 && value! <= 4096 && value! % 32 === 0) || !execution.unetName || ![1024,2048].includes(execution.referenceResolution ?? 0)) throw new TaskError('原任务画布快照缺失，结果待确认；未重复提交',409,true,false)
      return this.poll(id, execution, execution.width!, execution.height!, input.signal)
    }
    if (!v2 && (input.referenceImages.length>1 || input.aspectRatio !== (edit?'source':'1:1'))) throw new TaskError('旧工作流仅支持原有单图比例')
    if (v2 && input.aspectRatio==='source' && !edit) throw new TaskError('跟随参考图需要至少一张参考图')
    const resolution = input.imageSize === '2K' ? 2048 : 1024
    let expectedWidth = resolution, expectedHeight = resolution
    const referenceDimensions = v2 ? await Promise.all(input.referenceImages.map((ref,index) => referenceSize(ref.data,index===0?resolution:1024,index===0 && input.aspectRatio==='source'))) : undefined
    if (v2 && input.aspectRatio!=='source') {
      let output
      try { output=resolveLocalQwenOutputSize(input.imageSize??'1K',input.aspectRatio) } catch(error) { throw new TaskError(error instanceof Error?error.message:'本地 Qwen 参数无效') }
      expectedWidth=output!.width;expectedHeight=output!.height
    } else if (edit && v2) {
      expectedWidth = referenceDimensions![0].width
      expectedHeight = referenceDimensions![0].height
    } else if (edit) {
      let dimensions: Metadata
      try { dimensions = await sharp(input.referenceImages[0].data).metadata() } catch { throw new TaskError('参考图无法解码') }
      const rotated = v2 && (dimensions.orientation ?? 1) >= 5
      const ratio = rotated ? (dimensions.height ?? 0) / (dimensions.width ?? 0) : (dimensions.width ?? 0) / (dimensions.height ?? 0)
      if (!Number.isFinite(ratio) || ratio < 1 / 3 || ratio > 3) throw new TaskError('参考图比例应在 1:3 至 3:1 之间')
      expectedWidth = Math.max(32, Math.round(resolution * Math.sqrt(ratio) / 32) * 32)
      expectedHeight = Math.max(32, Math.round(resolution / Math.sqrt(ratio) / 32) * 32)
    }
    if (!input.resumeTaskId) {
      try {
        const stats = await this.json<Stats>('/system_stats', input.signal)
        if (!stats.devices?.some((device: { name?: string }) => this.gpuPattern.test(device.name ?? ''))) throw Error('GPU unavailable')
      } catch { throw new TaskError('本地 Qwen 当前不可用，尚未提交推理', 503, false, true) }
      const graph = structuredClone((v2 ? templatesV2 : templates)[edit ? 'edit' : 't2i'])
      if (this.unetName) graph['451'].inputs.unet_name = this.unetName
      const referenceResolution = resolution
      if (v2) execution = { ...execution, width: expectedWidth, height: expectedHeight, referenceResolution, referenceDimensions, unetName: String(graph['451'].inputs.unet_name) }
      const encoder = graph[edit ? '474' : '452'].inputs
      encoder.prompt = input.prompt
      encoder.resolution = v2 && edit ? 0 : referenceResolution
      const sampler = graph['458'].inputs
      Object.assign(sampler, { seed: execution.seed, steps: execution.steps, cfg: execution.cfg, sampler_name: execution.sampler, scheduler: execution.scheduler })
      graph['900'].inputs.filename_prefix = `Qwen21/Gallery/${id}/result`
      if (edit) {
        for (const [index, ref] of input.referenceImages.entries()) {
          const form = new FormData()
          const extension = ref.mimeType === 'image/png' ? 'png' : ref.mimeType === 'image/webp' ? 'webp' : 'jpg'
          form.append('image', new Blob([new Uint8Array(ref.data)], { type: ref.mimeType }), `${id}${v2 ? `-${index+1}` : ''}.${extension}`)
          form.append('subfolder', 'banana-gallery')
          let uploaded
          try { uploaded = await this.json<Upload>('/upload/image', input.signal, { method: 'POST', body: form }) } catch { throw new TaskError('参考图上传失败，尚未提交推理', 503, false, true) }
          if (typeof uploaded.name !== 'string' || /[/\\\0]/.test(uploaded.name) || uploaded.subfolder !== 'banana-gallery') throw new TaskError('参考图上传回执无效')
          const nodeId = String(901+index)
          graph[nodeId] = { class_type: 'LoadImage', inputs: { image: `banana-gallery/${uploaded.name}` } }
          if (v2) {
            const scaledId = String(951+index)
            graph[scaledId] = { class_type: 'ImageScale', inputs: { image: [nodeId,0], upscale_method: 'lanczos', ...referenceDimensions![index], crop: 'disabled' } }
            encoder[`images.image_${index+1}`] = [scaledId,0]
          } else encoder[`images.image_${index+1}`] = [nodeId, 0]
        }
        if (v2 && input.aspectRatio!=='source') sampler.latent_image=['456',0]
      }
      if (!edit || (v2 && input.aspectRatio!=='source')) Object.assign(graph['456'].inputs,{width:expectedWidth,height:expectedHeight})
      await this.recordDispatch(input, id, execution)
      let response: Response
      try {
        response = await this.request('/prompt', input.signal, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt_id: id, client_id: `banana-gallery-${id}`, prompt: graph, extra_data: { gallery_task_id: id } }) })
      } catch { return this.poll(id, execution, expectedWidth, expectedHeight, input.signal) }
      if (!response.ok) throw new TaskError('本地 ComfyUI 拒绝工作流，请检查模型和节点配置', response.status, response.status >= 500, false)
      try { if (((await response.json()) as { prompt_id?: string }).prompt_id !== id) throw Error('wrong id') } catch { return this.poll(id, execution, expectedWidth, expectedHeight, input.signal) }
    }
    return this.poll(id, execution, expectedWidth, expectedHeight, input.signal)
  }
  private async executeKrea(input: GenerateImageProviderInput): Promise<GeneratedImageBytes> {
    const id = input.resumeTaskId ?? input.requestId ?? randomUUID()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new TaskError('生成任务标识无效')
    if (input.referenceImages.length || !['1K','2K'].includes(input.imageSize ?? '1K') || input.aspectRatio === 'source') throw new TaskError('本地 Krea 仅支持文生图 1K/2K')
    let execution = input.execution ?? createKreaExecution()
    if (execution.engine !== 'comfyui' || execution.workflowVersion !== 'krea2-turbo-v1' || !Number.isSafeInteger(execution.seed) || execution.seed < 0 || execution.steps !== 8 || execution.cfg !== 1 || execution.sampler !== 'euler' || execution.scheduler !== 'simple') throw new TaskError('Krea 生成快照无效')
    if (input.resumeTaskId) {
      if (![execution.width,execution.height].every(n=>Number.isSafeInteger(n)&&n!>=32&&n!<=4096&&n!%32===0) || execution.unetName !== 'krea2_turbo_fp8_scaled.safetensors') throw new TaskError('原 Krea 任务画布快照缺失，未重复提交',409,true,false)
      return this.poll(id,execution,execution.width!,execution.height!, input.signal)
    }
    let output
    try { output=resolveLocalQwenOutputSize(input.imageSize ?? '1K',input.aspectRatio) } catch { throw new TaskError('本地 Krea 不支持该输出尺寸') }
    if (!output) throw new TaskError('本地 Krea 不支持该输出尺寸')
    try {
      const stats=await this.json<Stats>('/system_stats', input.signal)
      if (!stats.devices?.some(device=>this.gpuPattern.test(device.name ?? ''))) throw Error('device mismatch')
    } catch { throw new TaskError('本地 Krea 当前不可用，尚未提交推理',503,false,true) }
    const graph=structuredClone(kreaTemplate)
    execution={...execution,...output,unetName:String(graph['451'].inputs.unet_name)}
    graph['452'].inputs.text=input.prompt
    Object.assign(graph['456'].inputs,output)
    Object.assign(graph['458'].inputs,{seed:execution.seed,steps:execution.steps,cfg:execution.cfg,sampler_name:execution.sampler,scheduler:execution.scheduler})
    graph['900'].inputs.filename_prefix=`Krea2/Gallery/${id}/result`
    await this.recordDispatch(input, id, execution)
    let response: Response
    try { response=await this.request('/prompt', input.signal, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt_id:id,client_id:`banana-gallery-${id}`,prompt:graph,extra_data:{gallery_task_id:id}})}) }
    catch { return this.poll(id,execution,output.width,output.height, input.signal) }
    if (!response.ok) throw new TaskError('本地 Krea 拒绝工作流，请检查模型与节点',response.status,response.status>=500,false)
    try { if ((await response.json() as {prompt_id?:string}).prompt_id!==id) throw Error('wrong id') }
    catch { return this.poll(id,execution,output.width,output.height, input.signal) }
    return this.poll(id,execution,output.width,output.height, input.signal)
  }
  private async recordDispatch(input: GenerateImageProviderInput, id: string, execution: GenerationExecution) {
    input.signal?.throwIfAborted()
    // Persist both markers together at the dispatch boundary, before POST can reach ComfyUI.
    if (input.onRequestStartedWithUpstream) {
      await input.onRequestStartedWithUpstream(id, execution)
    } else {
      await input.onTaskSubmitted?.(id, execution)
      await input.onRequestStarted?.()
    }
  }
  private async poll(id: string, execution: GenerationExecution, width: number, height: number, signal?: AbortSignal): Promise<GeneratedImageBytes> {
    const deadline = Date.now() + 20 * 60_000
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      const history = await this.json<History>(`/history/${id}`, signal)
      let entry = history[id]
      if (!entry) {
        const queue = await this.json<Queue>('/queue', signal)
        const exists = [...(queue.queue_running ?? []), ...(queue.queue_pending ?? [])].some((row: unknown[]) => row[1] === id)
        if (!exists) {
          entry = (await this.json<History>(`/history/${id}`, signal))[id]
          if (!entry && this.remoteOutput) {
            const image = await this.remoteOutput.find(id, signal)
            if (image) entry = { status: { completed: true }, outputs: { '900': { images: [image] } } }
          }
          if (!entry) throw new TaskError(`原本地 ${this.kind === 'krea' ? 'Krea' : 'Qwen'} 任务已不在队列或历史中，结果待确认；未重复提交`, 409, true, false)
        }
      }
      if (entry?.status?.status_str === 'error') throw new TaskError(`本地 ${this.kind === 'krea' ? 'Krea' : 'Qwen'} 推理失败，请检查 ComfyUI 日志`, 422, false, false)
      if (entry?.status?.completed) {
        const output = entry.outputs?.['900']?.images?.[0]
        if (!output || output.type !== 'output' || typeof output.filename !== 'string' || /[/\\\0]/.test(output.filename) || typeof output.subfolder !== 'string' || output.subfolder.replaceAll('\\', '/') !== `${this.kind === 'krea' ? 'Krea2' : 'Qwen21'}/Gallery/${id}`) throw new TaskError('本地模型输出回执不匹配', 500, true, false)
        const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder, type: 'output' })
        return retrieveGeneratedImage(async () => {
          const response = await this.request(`/view?${query}`, signal)
          if (!response.ok) throw new TaskError('图片已生成，取回暂时失败', 503, true, true)
          const buffer = Buffer.from(await response.arrayBuffer())
          if (buffer.length > 64 * 1024 * 1024) throw new TaskError('本地模型输出文件过大', 500, true, false)
          const meta = await sharp(buffer).metadata()
          if (meta.format !== 'png' || meta.width !== width || meta.height !== height) throw new TaskError('本地模型输出格式或尺寸不匹配', 500, true, false)
          return { buffer, mimeType: 'image/png', execution, ...(this.remoteOutput ? { onSaved: (localPath: string) => this.remoteOutput!.saved(id, buffer, localPath) } : {}) }
        })
      }
      await this.sleep(this.pollInterval, signal)
    }
    throw new TaskError(`本地 ${this.kind === 'krea' ? 'Krea' : 'Qwen'} 等待超时，原任务可能仍在执行`, 504, true, false)
  }
}
