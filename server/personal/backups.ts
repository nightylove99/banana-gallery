import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { GalleryWriteCoordinator } from '../gallery/write-coordinator.js'
import { diskAssetDirectory, diskAssetStat, galleryAssetIndex, isAssetBasename } from '../gallery/disk-asset-integrity'
import { assetKinds, type AssetReference } from '../gallery/resource-files'
import { generationTasksFileFor, generationTasksFilename, readGenerationTaskIndex } from '../gallery/generation-task-storage.js'
import { BackupMediaLease } from '../gallery/backup-media-lease'

interface BackupFile { path: string; bytes: number; sha256: string }
export interface BackupManifest { id: string; createdAt: string; format: 1; manager: 'banana-gallery'; automatic?: boolean; files: BackupFile[] }
export interface AutomaticBackupPolicy { enabled: boolean; intervalHours: number; maxCount: number; maxBytes: number }
export const defaultBackupPolicy: AutomaticBackupPolicy = { enabled: false, intervalHours: 24, maxCount: 11, maxBytes: 20 * 1024 ** 3 }
export interface BackupPaths { dataFile: string; imagesDir: string; referencesDir: string; backupDir: string }
const hash = (buffer: Buffer | string) => createHash('sha256').update(buffer).digest('hex')
const mainIndexFilename = 'gallery-data.json'

/** Keep legacy fingerprints stable; frame split snapshots with two fixed-size digests. */
export function backupIndexFingerprint(main: Buffer, tasks?: Buffer): string {
  return tasks === undefined ? hash(main) : hash(`${hash(main)}\n${hash(tasks)}`)
}
function regularFile(file: string) {
  if (!fs.lstatSync(file).isFile()) throw new Error('备份只接受普通文件，不接受符号链接')
}

const capacityError = '单份完整备份超过自动备份容量上限，请提高上限或选择其他备份位置'

async function fileDigest(file: string): Promise<{ bytes: number; sha256: string }> {
  const digest = createHash('sha256')
  let bytes = 0
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    bytes += chunk.length
    digest.update(chunk)
  }
  return { bytes, sha256: digest.digest('hex') }
}

export class GalleryBackups {
  readonly coordinator: GalleryWriteCoordinator
  readonly paths: BackupPaths
  private readonly backupOperations: GalleryWriteCoordinator
  private lastVerifiedAutomaticId?: string
  constructor(paths: BackupPaths, coordinator?: GalleryWriteCoordinator) {
    this.paths = paths
    const dataFile = path.resolve(paths.dataFile)
    this.coordinator = coordinator ?? new GalleryWriteCoordinator(dataFile, `${dataFile}.lock`)
    // Coordinate retention, pins and offline restores across the app and CLI,
    // without preventing gallery writes while a backup operation is in flight.
    this.backupOperations = new GalleryWriteCoordinator(`${dataFile}.backup`, `${dataFile}.backup.lock`)
  }

  list(): BackupManifest[] {
    if (!fs.existsSync(this.paths.backupDir)) return []
    return fs.readdirSync(this.paths.backupDir).filter(id => /^backup-[\w-]+$/.test(id)).flatMap(id => {
      try { return [this.manifest(id)] }
      catch { return [] }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async create(automatic = false): Promise<BackupManifest> {
    return this.backupOperations.run(() => this.createSnapshot(automatic))
  }

  private readIndex(): Buffer {
    try {
      return fs.readFileSync(this.paths.dataFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return Buffer.from('{"images":[]}')
    }
  }

  private async createSnapshot(automatic: boolean, maxBytes = Infinity): Promise<BackupManifest> {
    const { dataFile, imagesDir, referencesDir, backupDir } = this.paths
    const dirs = { images: imagesDir, references: referencesDir }
    const lease = new BackupMediaLease(dataFile)
    const id = `backup-${new Date().toISOString().replace(/[^\dT]/g, '-')}-${randomUUID().slice(0, 8)}`
    const staging = path.join(backupDir, `.pending-${id}`)

    const clearPreserved = async () => {
      for (const dir of Object.values(dirs)) {
        if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
          await fs.promises.rm(lease.preservedDirectory(dir), { recursive: true, force: true })
        }
      }
    }
    // The backup lock guarantees that any earlier lease was abandoned.
    await this.coordinator.run(() => lease.retire())
    await clearPreserved()
    await fs.promises.mkdir(backupDir, { recursive: true, mode: 0o700 })
    await fs.promises.mkdir(staging, { mode: 0o700 })
    try {
      const { indexes, references } = await this.coordinator.run(() => {
        const raw = this.readIndex()
        const tasks = readGenerationTaskIndex(dataFile)
        if (raw.length + (tasks?.length ?? 0) > maxBytes) throw new Error(capacityError)
        const { files: references } = galleryAssetIndex(JSON.parse(raw.toString('utf8')), tasks)
        const indexes: Array<[string, Buffer]> = [[mainIndexFilename, raw]]
        if (tasks) indexes.push([generationTasksFilename, tasks])
        lease.publish({ images: [...references.images.keys()], references: [...references.references.keys()] })
        return { indexes, references }
      })

      const files: BackupFile[] = []
      let bytes = 0
      try {
        for (const [filename, raw] of indexes) {
          await fs.promises.writeFile(path.join(staging, filename), raw, { mode: 0o600 })
          files.push({ path: filename, bytes: raw.length, sha256: hash(raw) })
          bytes += raw.length
        }
        for (const kind of assetKinds) {
          const dir = dirs[kind]
          if (references[kind].size === 0) continue
          diskAssetDirectory(dir)
          await fs.promises.mkdir(path.join(staging, 'public', kind), { recursive: true, mode: 0o700 })
          for (const reference of references[kind].values()) {
            const entry = await this.copyAsset(reference, dir, lease, staging, maxBytes - bytes)
            if (!entry) continue
            bytes += entry.bytes
            files.push(entry)
          }
        }
      } finally {
        await this.coordinator.run(() => lease.retire())
        await clearPreserved()
      }
      const manifest: BackupManifest = { id, createdAt: new Date().toISOString(), manager: 'banana-gallery', format: 1, ...(automatic ? { automatic: true } : {}), files }
      await fs.promises.writeFile(path.join(staging, 'backup-info.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
      const verified = await this.verifyDirectory(id, staging)
      await fs.promises.rename(staging, path.join(backupDir, id))
      if (automatic) this.lastVerifiedAutomaticId = id
      return verified
    } catch (error) {
      await fs.promises.rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  private async copyAsset(
    { kind, filename, required }: AssetReference,
    dir: string, lease: BackupMediaLease, staging: string, remainingBytes: number,
  ): Promise<BackupFile | undefined> {
    const relative = `public/${kind}/${filename}`
    const dest = path.join(staging, relative)
    const preserved = lease.preservedFile(dir, filename)
    const copy = async (source: string) => {
      const stat = diskAssetStat(source)
      if (!stat) return undefined
      if (stat.size > remainingBytes) throw new Error(capacityError)
      // FICLONE falls back to an ordinary copy across volumes or on filesystems
      // without copy-on-write cloning. Hash the source, then verify the copy.
      await fs.promises.copyFile(source, dest, fs.constants.COPYFILE_FICLONE)
      await fs.promises.chmod(dest, 0o600)
      const digest = await fileDigest(source)
      const after = await fs.promises.stat(source)
      if (digest.bytes !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs ||
        after.ino !== stat.ino || after.dev !== stat.dev) throw new Error(`备份时源文件发生变化：${relative}`)
      return { path: relative, ...digest }
    }
    let entry: BackupFile | undefined
    if (diskAssetStat(preserved)) {
      entry = await copy(preserved)
    } else {
      // A writer may move the file before open, during copy, or while we hash
      // it. The preserved name is authoritative even if the live name reappears.
      try {
        entry = await copy(path.join(dir, filename))
      } catch (error) {
        if (!diskAssetStat(preserved)) throw error
      }
      if (diskAssetStat(preserved)) entry = await copy(preserved)
    }
    if (!entry && required) throw new Error(`索引引用的图片缺失：${relative}`)
    return entry
  }

  async runAutomatic(policy: AutomaticBackupPolicy): Promise<BackupManifest | null> {
    if (!policy.enabled) return null
    return this.backupOperations.run(async () => {
      const previous = this.list().filter(snapshot => snapshot.automatic === true)
      const last = previous[0]
      if (last && (Date.now() - Date.parse(last.createdAt) < policy.intervalHours * 3600_000 ||
        await this.coordinator.run(() => {
          const tasks = readGenerationTaskIndex(this.paths.dataFile)
          return last.files.find(file => file.path === mainIndexFilename)?.sha256 === hash(this.readIndex()) &&
            last.files.find(file => file.path === generationTasksFilename)?.sha256 === (tasks && hash(tasks))
        }))) {
        // Older versions could publish before verification. Verify a candidate
        // before trusting it to suppress a retry, once per service instance.
        if (this.lastVerifiedAutomaticId === last.id) return null
        try {
          await this.verify(last.id)
          this.lastVerifiedAutomaticId = last.id
          return null
        } catch { /* A corrupt snapshot must never suppress a replacement. */ }
      }
      const snapshot = await this.createSnapshot(true, policy.maxBytes)
      const keep = [snapshot, ...previous]
      let total = keep.reduce((sum, item) => sum + item.files.reduce((bytes, file) => bytes + file.bytes, 0), 0)
      while (keep.length > 1 && (keep.length > policy.maxCount || total > policy.maxBytes)) {
        const oldest = keep.pop()!
        // 只清理由本程序标记的自动快照；手动备份、恢复前目录和未知文件不参与。
        const known = this.manifest(oldest.id)
        if (known.automatic !== true) throw new Error('备份归属变化，已停止清理')
        await fs.promises.rm(path.join(this.paths.backupDir, oldest.id), { recursive: true })
        total -= oldest.files.reduce((sum, file) => sum + file.bytes, 0)
      }
      return snapshot
    })
  }

  async restoreTo(id: string, target: string): Promise<void> {
    return this.backupOperations.run(async () => {
      const manifest = await this.verify(id)
      if (!path.isAbsolute(target)) throw new Error('恢复目标必须是绝对路径的空目录')
      if (fs.existsSync(target) && (fs.lstatSync(target).isSymbolicLink() || !fs.statSync(target).isDirectory() || fs.readdirSync(target).length)) throw new Error('恢复目标必须是空目录')
      const staging = `${target}.restore-${randomUUID()}`
      await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 })
      try {
        for (const entry of manifest.files) {
          const buffer = await fs.promises.readFile(path.join(this.paths.backupDir, id, entry.path))
          if (hash(buffer) !== entry.sha256) throw new Error('备份复制时校验失败')
          const dest = path.join(staging, entry.path)
          await fs.promises.mkdir(path.dirname(dest), { recursive: true })
          await fs.promises.writeFile(dest, buffer, { mode: 0o600 })
        }
        await fs.promises.mkdir(path.join(staging, 'public/images'), { recursive: true })
        await fs.promises.mkdir(path.join(staging, 'public/references'), { recursive: true })
        if (fs.existsSync(target)) fs.rmdirSync(target) // Nonempty targets fail without removing their files.
        await fs.promises.rename(staging, target)
      } finally { await fs.promises.rm(staging, { recursive: true, force: true }) }
    })
  }

  /** Offline only: the CLI checks service ownership before calling this operation. */
  async restoreInPlace(id: string): Promise<{ recoveryDir: string }> {
    return this.backupOperations.run(async () => {
      const recoveryRoot = path.join(path.dirname(this.paths.dataFile), 'recovery')
      fs.mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 })
      const staging = path.join(recoveryRoot, `.restore-${randomUUID()}`)
      await this.restoreTo(id, staging)
      try {
        return await this.coordinator.run(() => {
          const recoveryDir = path.join(recoveryRoot, `before-restore-${randomUUID()}`)
          fs.mkdirSync(recoveryDir, { mode: 0o700 })
          const swaps: Array<{ original: string; saved: string; installed: boolean; moved: boolean }> = []
          try {
            // Replace index last; any error restores every earlier rename.
            for (const [relative, original] of [
              ['public/images', this.paths.imagesDir],
              ['public/references', this.paths.referencesDir],
              [generationTasksFilename, generationTasksFileFor(this.paths.dataFile)],
              [mainIndexFilename, this.paths.dataFile],
            ]) {
              const saved = path.join(recoveryDir, relative)
              fs.mkdirSync(path.dirname(saved), { recursive: true })
              fs.mkdirSync(path.dirname(original), { recursive: true })
              const swap = { original, saved, installed: false, moved: false }; swaps.push(swap)
              if (fs.existsSync(original)) { fs.renameSync(original, saved); swap.moved = true }
              const incoming = path.join(staging, relative)
              if (relative !== generationTasksFilename || fs.existsSync(incoming)) {
                fs.renameSync(incoming, original); swap.installed = true
              }
            }
            return { recoveryDir }
          } catch (error) {
            for (const swap of swaps.reverse()) {
              if (swap.installed) fs.rmSync(swap.original, { recursive: true, force: true })
              if (swap.moved) fs.renameSync(swap.saved, swap.original)
            }
            throw error
          }
        })
      } finally { await fs.promises.rm(staging, { recursive: true, force: true }) }
    })
  }

  private manifest(id: string, dir = path.join(this.paths.backupDir, id)): BackupManifest {
    if (!/^backup-[\w-]+$/.test(id)) throw new Error('备份编号无效')
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('备份目录不能是符号链接')
    const file = path.join(dir, 'backup-info.json'); regularFile(file)
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as BackupManifest
    if (manifest?.id !== id || manifest.format !== 1 || manifest.manager !== 'banana-gallery' ||
      !Number.isFinite(Date.parse(manifest.createdAt)) || !Array.isArray(manifest.files) ||
      manifest.files.some(entry => !entry || typeof entry.path !== 'string' ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256))) {
      throw new Error('备份格式不受支持')
    }
    return manifest
  }

  async verify(id: string): Promise<BackupManifest> {
    try {
      return await this.verifyDirectory(id, path.join(this.paths.backupDir, id))
    } catch (error) {
      if (this.lastVerifiedAutomaticId === id) this.lastVerifiedAutomaticId = undefined
      throw error
    }
  }

  private async verifyDirectory(id: string, dir: string): Promise<BackupManifest> {
    const manifest = this.manifest(id, dir)
    const names = new Set<string>()
    let main: Buffer | undefined
    let tasks: Buffer | undefined
    for (const entry of manifest.files) {
      const parts = entry.path.split('/')
      if (!(entry.path === mainIndexFilename || entry.path === generationTasksFilename || (parts.length === 3 && parts[0] === 'public' && ['images', 'references'].includes(parts[1]) && isAssetBasename(parts[2])))) throw new Error('备份文件路径无效')
      if (names.has(entry.path)) throw new Error('备份清单包含重复文件')
      names.add(entry.path)
      let file = dir
      for (const part of parts) {
        file = path.join(file, part)
        if (fs.lstatSync(file).isSymbolicLink()) throw new Error('备份不能包含符号链接')
      }
      regularFile(file)
      if (entry.path === mainIndexFilename || entry.path === generationTasksFilename) {
        const raw = await fs.promises.readFile(file)
        if (raw.length !== entry.bytes || hash(raw) !== entry.sha256) throw new Error(`备份校验失败：${entry.path}`)
        if (entry.path === mainIndexFilename) main = raw
        else tasks = raw
      } else {
        const actual = await fileDigest(file)
        if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new Error(`备份校验失败：${entry.path}`)
      }
    }
    if (!main) throw new Error('备份缺少索引')
    if (!tasks && fs.existsSync(path.join(dir, generationTasksFilename))) throw new Error('备份清单缺少任务索引')
    const index = galleryAssetIndex(JSON.parse(main.toString('utf8')), tasks)
    for (const kind of assetKinds) {
      for (const { filename, required } of index.files[kind].values()) {
        if (required && !names.has(`public/${kind}/${filename}`)) throw new Error(`备份缺少索引引用的文件：public/${kind}/${filename}`)
      }
    }
    return manifest
  }
}
