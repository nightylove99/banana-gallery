import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GenerationTaskScope } from '../../src/types'
import { isAssetBasename } from './disk-asset-integrity.js'
import type { AssetStorage } from '../storage/asset-storage.js'
import type { GalleryWriteCoordinator } from './write-coordinator.js'

const ttlMs = 2 * 60 * 60_000
const cleanupIntervalMs = 10 * 60_000

interface Receipt {
  scope: GenerationTaskScope
  key?: string
  filenames: string[]
  expiresAt: number
}

export class ReferenceUploadReceipts {
  private readonly file: string
  private readonly storage: AssetStorage
  private nextCleanupAt = -Infinity

  constructor(dataFile: string, storage: AssetStorage) {
    this.storage = storage
    this.file = path.basename(dataFile) === 'gallery-data.json'
      ? path.join(path.dirname(dataFile), '.pending-reference-uploads.json')
      : `${dataFile}.pending-reference-uploads.json`
  }

  private read(): Receipt[] {
    let value: unknown
    try {
      value = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    if (!Array.isArray(value) || !value.every((entry: Receipt) =>
      typeof entry?.scope?.userId === 'string' && typeof entry.scope.workspaceId === 'string' &&
      Number.isFinite(entry.expiresAt) && Array.isArray(entry.filenames) && entry.filenames.length > 0 &&
      entry.filenames.every(filename => isAssetBasename(filename) && /^ref_[a-f0-9-]{36}/.test(filename)))) {
      throw new Error('参考图上传回执损坏')
    }
    return value
  }

  private write(entries: Receipt[]): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify(entries), { flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, this.file)
    } catch (error) {
      fs.rmSync(temporary, { force: true })
      throw error
    }
  }

  private live(scope: GenerationTaskScope): Receipt[] {
    const now = Date.now()
    return this.read().filter(entry => entry.expiresAt > now &&
      entry.scope.userId === scope.userId && entry.scope.workspaceId === scope.workspaceId)
  }

  filenamesFor(scope: GenerationTaskScope, key: string | undefined): string[] | undefined {
    if (key === undefined) return
    return this.live(scope).find(entry => entry.key === key && entry.filenames.every(filename =>
      fs.lstatSync(this.storage.getReferencePath(filename), { throwIfNoEntry: false })?.isFile()))?.filenames
  }

  canClaim(scope: GenerationTaskScope, filename: string): boolean {
    return this.live(scope).some(entry => entry.filenames.includes(filename))
  }

  /** Serialize receipt publication with quota checks and orphan collection. */
  record(scope: GenerationTaskScope, key: string | undefined, filenames: string[]): void {
    // Retain older receipts with missing bytes until expiry so their surviving files are still collectible.
    this.write([{ scope, key, filenames, expiresAt: Date.now() + ttlMs }, ...this.read()])
  }

  async collectExpired(
    coordinator: GalleryWriteCoordinator,
    isReferenced: (scope: GenerationTaskScope, filename: string) => Promise<boolean>,
  ): Promise<void> {
    const now = Date.now()
    if (now < this.nextCleanupAt) return
    this.nextCleanupAt = now + cleanupIntervalMs
    if (!this.read().some(entry => entry.expiresAt <= now)) return
    await coordinator.run(async () => {
      const entries = this.read()
      const remaining = entries.filter(entry => entry.expiresAt > now)
      if (remaining.length === entries.length) return
      // Recheck while holding the same lock as task submission and reference-library writes.
      for (const entry of entries) {
        if (entry.expiresAt > now) continue
        for (const filename of entry.filenames) {
          if (!await isReferenced(entry.scope, filename)) await this.storage.deleteReferences([filename])
        }
      }
      this.write(remaining)
    })
  }
}
