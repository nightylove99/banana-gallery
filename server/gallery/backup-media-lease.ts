import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { AssetKind } from './resource-files'

interface MediaLease {
  pid: number
  files: Record<AssetKind, string[]>
}

/**
 * Indexed media is immutable; new assets get new filenames. A gallery writer
 * removing a captured file moves it aside atomically rather than unlinking it.
 * The lease is on disk because a snapshot may be captured by the offline CLI
 * while the app is serving requests. The backup lock serializes lease owners.
 */
export class BackupMediaLease {
  private readonly marker: string
  private readonly directoryName: string

  constructor(dataFile: string) {
    const absolute = path.resolve(dataFile)
    this.marker = `${absolute}.backup-media.json`
    this.directoryName = `.banana-backup-media-${createHash('sha256').update(absolute).digest('hex').slice(0, 24)}`
  }

  /** Publication and retirement use the same gallery lock as indexed deletes. */
  publish(files: MediaLease['files']): void {
    const temporary = `${this.marker}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, files }), { mode: 0o600 })
      fs.renameSync(temporary, this.marker)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }

  retire(): void {
    fs.rmSync(this.marker, { force: true })
  }

  preservedDirectory(dir: string): string {
    return path.join(dir, this.directoryName)
  }

  preservedFile(dir: string, filename: string): string {
    return path.join(this.preservedDirectory(dir), filename)
  }

  preserveDeletion(kind: AssetKind, dir: string, filename: string): boolean {
    let lease: MediaLease
    try {
      lease = JSON.parse(fs.readFileSync(this.marker, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (!lease.files[kind].includes(filename)) return false
    try {
      process.kill(lease.pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
    const preserved = this.preservedFile(dir, filename)
    // If the name was reused, keep the first (captured) version.
    if (fs.lstatSync(preserved, { throwIfNoEntry: false })) return false
    fs.mkdirSync(this.preservedDirectory(dir), { recursive: true, mode: 0o700 })
    fs.renameSync(path.join(dir, filename), preserved)
    return true
  }
}
