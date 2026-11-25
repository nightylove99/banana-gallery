import path from 'node:path'
import { createHash } from 'node:crypto'
import { QwenOutputStore } from './qwen-output-store.ts'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { COMFYUI_BASE_URL, comfyuiFetch, ComfyUIImageProvider } from './comfyui-image-provider.ts'

export interface ComfyUIStatus { available: boolean; reason?: string }
interface Options {
  cleanupDir?: string
  hasPersistedResult?: (localPath: string) => Promise<boolean>
  host?: string
  remotePort?: number
  startCmd?: string
  outputHelperCommand?: string
  gpuPattern?: string
  unetName?: string
  startTimeoutMs?: number
  spawn?: typeof spawn
  execFile?: typeof execFile
  fetch?: typeof comfyuiFetch
  portAvailable?: () => Promise<boolean>
  warn?: (message: string) => void
}
/** Gallery 固定拥有的本机回环端口，COMFYUI_BASE_URL 也指向它 */
const LOCAL_PORT = 18488
const DEFAULT_REMOTE_PORT = 8188
const DEFAULT_START_TIMEOUT_MS = 180_000
function portAvailable(): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(LOCAL_PORT, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}
export class ComfyUIRuntime {
  readonly provider: ComfyUIImageProvider
  readonly kreaProvider: ComfyUIImageProvider
  private readonly options: Options
  private readonly controller = new AbortController()
  private child?: ChildProcess
  private timer?: ReturnType<typeof setTimeout>
  private monitor?: ReturnType<typeof setInterval>
  private readonly outputStore?: QwenOutputStore
  private readonly kreaOutputStore?: QwenOutputStore
  private stopped = false
  private connecting = false
  private started = false
  private startingService = false
  private serviceAttempted = false
  private retry = 0
  private nextServiceAttempt = 0
  private cached: ComfyUIStatus = { available: false, reason: '本地 Qwen 连接尚未启用' }
  private checkedAt = 0
  private statusRequest?: Promise<ComfyUIStatus>
  private readonly socket = fileURLToPath(new URL('../../.banana-gallery.qwen.sock', import.meta.url))
  constructor(options: Options = {}) {
    this.options = options
    if (options.host && options.cleanupDir && options.outputHelperCommand) this.outputStore = new QwenOutputStore({
      pendingDir: path.join(options.cleanupDir, createHash('sha256').update(options.host).digest('hex').slice(0, 16)),
      hasPersistedResult: options.hasPersistedResult,
      remote: (action, id, sha256, signal) => this.remoteOutput(action, id, sha256, undefined, signal),
      warn: options.warn,
    })
    if (options.host && options.cleanupDir && options.outputHelperCommand) this.kreaOutputStore = new QwenOutputStore({
      pendingDir: path.join(options.cleanupDir, createHash('sha256').update(options.host).digest('hex').slice(0, 16), 'Krea2'),
      hasPersistedResult: options.hasPersistedResult,
      remote: (action, id, sha256, signal) => this.remoteOutput(action, id, sha256, 'Krea2', signal),
      warn: options.warn,
    })
    this.provider = new ComfyUIImageProvider({ remoteOutput: this.outputStore, fetch: options.fetch, signal: this.controller.signal, unetName: options.unetName, gpuPattern: options.gpuPattern })
    this.kreaProvider = new ComfyUIImageProvider({ kind: 'krea', remoteOutput: this.kreaOutputStore, fetch: options.fetch, signal: this.controller.signal, gpuPattern: options.gpuPattern })
  }
  private get host() { return this.options.host ?? '' }
  private get remotePort() { return this.options.remotePort ?? DEFAULT_REMOTE_PORT }
  start() {
    if (this.started || this.stopped || !this.options.host) return
    this.started = true
    void this.connect()
    this.monitor = setInterval(() => {
      void this.outputStore?.retry().catch(() => this.options.warn?.('远端清理记录暂不可读'))
      void this.kreaOutputStore?.retry().catch(() => this.options.warn?.('Krea 远端清理记录暂不可读'))
      void this.status(true).then(status => {
        if (!status.available && this.child && !this.startingService && !this.serviceAttempted && Date.now() >= this.nextServiceAttempt) void this.startService()
      })
    }, 5000)
    this.monitor.unref()
  }
  private async connect() {
    if (this.stopped || this.child || this.connecting) return
    this.connecting = true
    try {
      if (!await (this.options.portAvailable ?? portAvailable)()) {
        this.cached = { available: false, reason: `Gallery 端口 ${LOCAL_PORT} 已占用，请检查其他进程` }; this.schedule(); return
      }
      if (this.stopped) return
      this.cached = { available: false, reason: `正在连接 ${this.host}` }
      const child = (this.options.spawn ?? spawn)('ssh', ['-M', '-S', this.socket, '-N', '-o', 'ControlMaster=yes', '-o', 'ControlPersist=no', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-L', `127.0.0.1:${LOCAL_PORT}:127.0.0.1:${this.remotePort}`, this.host], { stdio: ['ignore', 'ignore', 'pipe'] })
      this.child = child
      this.serviceAttempted = false
      child.stderr?.on('data', () => { /* SSH diagnostics can include local identities; expose only status. */ })
      const lost = () => {
        if (this.child !== child) return
        this.child = undefined; this.checkedAt = 0
        this.cached = { available: false, reason: `${this.host} 连接已断开，正在重连` }
        this.schedule()
      }
      child.once('error', lost); child.once('close', lost)
    } catch {
      this.cached = { available: false, reason: `无法启动 ${this.host} SSH 连接` }; this.schedule()
    } finally { this.connecting = false }
  }
  private schedule() {
    if (this.stopped || this.timer) return
    const delay = [2000, 5000, 10_000, 30_000][Math.min(this.retry++, 3)]
    this.timer = setTimeout(() => { this.timer = undefined; void this.connect() }, delay); this.timer.unref()
  }
  async status(force = false): Promise<ComfyUIStatus> {
    if (!this.options.host || !this.child || this.stopped) return this.cached
    if (!force && Date.now() - this.checkedAt < 5000) return this.cached
    if (this.statusRequest) return this.statusRequest
    this.statusRequest = (async () => {
      try {
        const pattern = this.options.gpuPattern ? new RegExp(this.options.gpuPattern, 'i') : /cuda/i
        const response = await (this.options.fetch ?? comfyuiFetch)(`${COMFYUI_BASE_URL}/system_stats`, { signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(2000)]) })
        const stats = await response.json() as { devices?: Array<{ name?: string }> }
        if (!response.ok || !stats.devices?.some((d: { name?: string }) => pattern.test(d.name ?? ''))) throw Error('device mismatch')
        this.cached = { available: true }; this.retry = 0; this.serviceAttempted = false
      } catch { this.cached = { available: false, reason: `${this.host} 当前不可用` } }
      this.checkedAt = Date.now(); return this.cached
    })().finally(() => { this.statusRequest = undefined })
    return this.statusRequest
  }
  async kreaStatus(): Promise<ComfyUIStatus> {
    const status=await this.status()
    if (!status.available) return status
    try {
      const checks=[['UNETLoader','unet_name','krea2_turbo_fp8_scaled.safetensors'],['CLIPLoader','clip_name','qwen3vl_4b_fp8_scaled.safetensors'],['VAELoader','vae_name','qwen_image_vae.safetensors']]
      await Promise.all(checks.map(async([node,field,file])=>{
        const response=await (this.options.fetch ?? comfyuiFetch)(`${COMFYUI_BASE_URL}/object_info/${node}`,{signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(3000)])})
        const info=await response.json() as Record<string,{input?:{required?:Record<string,unknown[]>}}>
        const names=info[node]?.input?.required?.[field]?.[0]
        if (!response.ok || !Array.isArray(names) || !names.includes(file)) throw Error('missing model')
      }))
      return {available:true}
    } catch { return {available:false,reason:'本地 Krea 权重或节点尚未就绪'} }
  }
  private async remoteOutput(action: 'find' | 'delete', id: string, sha256?: string, family?: 'Krea2', signal?: AbortSignal) {
    if (!/^[a-f0-9-]{36}$/.test(id) || (sha256 && !/^[a-f0-9]{64}$/.test(sha256))) throw Error('Invalid remote output request')
    const command = `${this.options.outputHelperCommand} ${action} ${id}${sha256 ? ` ${sha256}` : ''}${family ? ` ${family}` : ''}`
    return new Promise<{ image?: { filename: string; subfolder: string; type: string }; deleted?: boolean }>((resolve, reject) => {
      (this.options.execFile ?? execFile)('ssh', ['-S', this.socket, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', this.host, command], { timeout: 15_000, signal: signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal, maxBuffer: 64 * 1024 }, (error, stdout) => {
        if (error) { reject(error); return }
        try { resolve(JSON.parse(String(stdout))) } catch { reject(Error('Invalid remote output reply')) }
      })
    })
  }
  private async startService() {
    const startCmd = this.options.startCmd
    if (!startCmd) return
    this.startingService = true
    this.serviceAttempted = true
    this.nextServiceAttempt = Date.now() + 30_000
    try {
      await new Promise<void>((resolve, reject) => {
        (this.options.execFile ?? execFile)('ssh', ['-S', this.socket, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', this.host, startCmd], { timeout: this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS, signal: this.controller.signal }, error => error ? reject(error) : resolve())
      })
    } catch { if (!this.stopped) this.options.warn?.(`本地 Qwen（${this.host}）服务尚未恢复；保留图库与其他供应商运行`) }
    finally { this.startingService = false }
  }
  stop() {
    this.stopped = true; clearTimeout(this.timer); clearInterval(this.monitor)
    this.controller.abort(); this.child?.kill('SIGTERM'); this.child = undefined
    this.cached = { available: false, reason: `${this.host || '本地 Qwen'} 连接已停止` }
  }
}
