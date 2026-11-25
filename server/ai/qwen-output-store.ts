import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

export interface RemoteQwenImage { filename: string; subfolder: string; type: string }
export interface QwenRemoteOutput {
  find(id: string, signal?: AbortSignal): Promise<RemoteQwenImage | undefined>
  saved(id: string, buffer: Buffer, localPath: string): Promise<void>
}
interface Pending { id: string; sha256: string; localPath: string }
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const digest = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex')

/** Only acknowledged, locally verified images may be removed remotely. */
export class QwenOutputStore implements QwenRemoteOutput {
  private flushing = false
  private readonly options: {
    pendingDir: string
    hasPersistedResult?: (localPath: string) => Promise<boolean>
    remote: (action: 'find' | 'delete', id: string, sha256?: string, signal?: AbortSignal) => Promise<{ image?: RemoteQwenImage; deleted?: boolean }>
    warn?: (message: string) => void
  }
  constructor(options: QwenOutputStore['options']) { this.options = options }
  async find(id: string, signal?: AbortSignal) {
    if (!validId.test(id)) throw Error('Invalid Qwen task ID')
    return (await this.options.remote('find', id, undefined, signal)).image
  }
  async saved(id: string, buffer: Buffer, localPath: string) {
    if (!validId.test(id) || !path.isAbsolute(localPath)) throw Error('Invalid Qwen saved result')
    const pending: Pending = { id, sha256: digest(buffer), localPath }
    if (digest(await fs.readFile(localPath)) !== pending.sha256) throw Error('Mac image verification failed; remote copy retained')
    await fs.mkdir(this.options.pendingDir, { recursive: true, mode: 0o700 })
    const target = path.join(this.options.pendingDir, `${id}.json`)
    await fs.writeFile(`${target}.tmp`, JSON.stringify(pending), { mode: 0o600 })
    await fs.rename(`${target}.tmp`, target)
    await this.retry()
  }
  async retry() {
    if (this.flushing) return
    this.flushing = true
    try {
      const files = await fs.readdir(this.options.pendingDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      for (const filename of files.filter(name => name.endsWith('.json'))) {
        try {
          const recordPath = path.join(this.options.pendingDir, filename)
          const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as Pending
          if (!validId.test(record.id) || filename !== `${record.id}.json` || !/^[a-f0-9]{64}$/.test(record.sha256) || !path.isAbsolute(record.localPath)) throw Error('Invalid cleanup record')
          // Older versions could leave a cleanup record before the task write.
          if (this.options.hasPersistedResult && !await this.options.hasPersistedResult(record.localPath)) continue
          if (digest(await fs.readFile(record.localPath)) !== record.sha256) throw Error('Mac image changed; remote copy retained')
          const result = await this.options.remote('delete', record.id, record.sha256)
          if (result.deleted !== true) throw Error('Remote deletion not confirmed')
          await fs.unlink(recordPath)
        } catch {
          this.options.warn?.('远端副本暂未清理，将在连接恢复且 Mac 原图校验通过后继续清理')
        }
      }
    } finally { this.flushing = false }
  }
}
