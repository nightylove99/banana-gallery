import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { BackupMediaLease } from '../gallery/backup-media-lease.js'
import type { AssetKind } from '../gallery/resource-files.js'
import type { AssetStorage } from './asset-storage.js'

interface DiskAssetStorageOptions {
  imagesDir: string
  referencesDir: string
  backupDataFile?: string
}

export class DiskAssetStorage implements AssetStorage {
  private readonly options: DiskAssetStorageOptions
  private readonly backupLease?: BackupMediaLease

  constructor(options: DiskAssetStorageOptions) {
    this.options = options
    if (options.backupDataFile) this.backupLease = new BackupMediaLease(options.backupDataFile)
    this.ensureDirectories()
  }

  async ensureDirectories(): Promise<void> {
    fs.mkdirSync(this.options.imagesDir, { recursive: true })
    fs.mkdirSync(this.options.referencesDir, { recursive: true })
  }

  getImagesDir(): string {
    return this.options.imagesDir
  }

  getReferencesDir(): string {
    return this.options.referencesDir
  }

  getImagePath(filename: string): string {
    return path.join(this.options.imagesDir, filename)
  }

  getReferencePath(filename: string): string {
    return path.join(this.options.referencesDir, filename)
  }

  async copyImageFrom(sourcePath: string): Promise<string> {
    const extension = path.extname(sourcePath)
    const filename = `${randomUUID()}${extension}`
    fs.copyFileSync(sourcePath, this.getImagePath(filename))
    return filename
  }

  async finalizeImage(filename: string): Promise<void> {
    void filename
    // 本地磁盘模式下文件已直接落盘，不需要额外同步。
  }

  async finalizeReferences(filenames: string[]): Promise<void> {
    void filenames
    // 本地磁盘模式下文件已直接落盘，不需要额外同步。
  }

  async deleteImage(filename: string): Promise<void> {
    this.deleteIfExists('images', this.options.imagesDir, filename)
  }

  async deleteReferences(filenames: string[]): Promise<void> {
    for (const filename of filenames) {
      this.deleteIfExists('references', this.options.referencesDir, filename)
    }
  }

  private deleteIfExists(kind: AssetKind, dir: string, filename: string): void {
    const filePath = path.join(dir, filename)
    if (fs.existsSync(filePath) && !this.backupLease?.preserveDeletion(kind, dir, filename)) {
      fs.unlinkSync(filePath)
    }
  }
}
