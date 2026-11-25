import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import type { GalleryImage, GalleryResources } from '../../src/types'
import { normalizeGalleryData } from '../gallery-normalize.ts'
import { resourceFiles } from './resource-files'
import { generationTasksFileFor, parseGenerationTaskIndex, readGenerationTaskIndex, splitGenerationResources } from './generation-task-storage.js'
import type { GalleryRepository, GalleryScope, ReadOnlyGalleryResources } from './gallery-repository.js'

interface GalleryData {
  [key: string]: unknown
  images: GalleryImage[]
}

interface Snapshot {
  signature: string
  raw: Record<string, unknown>
  images: GalleryImage[]
  writeSafe: boolean
  permissions: ReturnType<typeof resourceFiles>
  galleryResources: ReadOnlyGalleryResources
  legacyTasks: ReadOnlyGalleryResources
}

type TaskSnapshot = ReturnType<typeof parseGenerationTaskIndex> & { signature: string }

function signatureFor(stat: fs.BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
}

function fileSignature(file: string, followLinks = true): string {
  const statFile = followLinks ? fs.statSync : fs.lstatSync
  const stat = statFile(file, { bigint: true, throwIfNoEntry: false })
  return stat ? signatureFor(stat) : 'missing'
}

function indexImageFiles(permissions: Snapshot['permissions'], images: readonly GalleryImage[]) {
  for (const image of images) {
    permissions.images.add(image.filename)
    for (const filename of image.referenceImages) permissions.references.add(filename)
  }
  return permissions
}

/** Same-directory staging keeps a failed write from truncating the committed index. */
function writeIndex(file: string, serialized: string | Buffer): string | undefined {
  const temporaryFile = `${file}.${randomUUID()}.tmp`
  let staged: fs.BigIntStats
  try {
    const mode = fs.existsSync(file) ? fs.statSync(file).mode : 0o600
    fs.writeFileSync(temporaryFile, serialized, { mode, flag: 'wx' })
    staged = fs.statSync(temporaryFile, { bigint: true })
    if (staged.size !== BigInt(Buffer.byteLength(serialized))) throw new Error('索引临时文件写入不完整')
    fs.renameSync(temporaryFile, file)
  } catch (error) {
    fs.rmSync(temporaryFile, { force: true })
    throw error
  }
  try {
    const committed = fs.statSync(file, { bigint: true })
    // Rename may change ctime. Never tag our replacement with another writer's inode.
    if (committed.dev === staged.dev && committed.ino === staged.ino &&
        committed.size === staged.size && committed.mtimeNs === staged.mtimeNs) return signatureFor(committed)
  } catch {
    // Rename already committed; a later read will recheck disk.
  }
}

function createSnapshot(raw: Record<string, unknown>, signature: string): Snapshot {
  const { images, writeSafe } = normalizeGalleryData(raw)
  const { gallery, tasks } = splitGenerationResources((raw.resources as ReadOnlyGalleryResources) || {})
  const permissions = indexImageFiles(resourceFiles(gallery), images)
  return { signature, raw, images, writeSafe, permissions, galleryResources: gallery, legacyTasks: tasks }
}

export class JsonGalleryRepository implements GalleryRepository {
  private readonly dataFile: string
  private readonly taskFile: string
  private snapshot?: Snapshot
  private taskSnapshot?: TaskSnapshot
  private legacyPermissions?: ReturnType<typeof resourceFiles>

  constructor(dataFile: string) {
    this.dataFile = dataFile
    this.taskFile = generationTasksFileFor(dataFile)
  }

  snapshotRevision(): string {
    return `${fileSignature(this.dataFile)}/${fileSignature(this.taskFile, false)}`
  }

  async listImages(scope?: GalleryScope): Promise<GalleryImage[]> {
    void scope
    return structuredClone(this.readMainIndex().images)
  }

  async hasAssetAccess(scope: GalleryScope | undefined, kind: 'images' | 'references', filename: string): Promise<boolean> {
    void scope
    const snapshot = this.readMainIndex()
    if (!snapshot.writeSafe || (snapshot.raw.schemaVersion !== undefined && snapshot.raw.schemaVersion !== 1)) throw new Error('图库索引损坏或版本不受支持，已阻止资源访问')
    const taskIndex = this.readTaskIndex()
    const taskPermissions = taskIndex?.permissions ?? (this.legacyPermissions ??= resourceFiles(snapshot.legacyTasks))
    return snapshot.permissions[kind].has(filename) || taskPermissions[kind].has(filename)
  }

  async saveImages(images: GalleryImage[], scope?: GalleryScope): Promise<void> {
    void scope
    this.writeData({ images })
  }

  async listResourceScopes(): Promise<GalleryScope[]> {
    return [...new Map((this.readOnlySnapshot().resources.generationTasks || []).map(job => [job.scope.workspaceId, { ...job.scope }])).values()]
  }

  async readResources(): Promise<GalleryResources> {
    return structuredClone(this.readOnlySnapshot().resources) as GalleryResources
  }

  async saveResources(resources: GalleryResources): Promise<void> {
    this.saveMetadata({ resources })
  }

  readMetadata(): Record<string, unknown> {
    const main = this.readMainIndex()
    const { images, ...metadata } = main.raw
    void images
    const taskIndex = this.readTaskIndex()
    if (taskIndex) metadata.resources = { ...main.galleryResources, ...taskIndex.tasks }
    return structuredClone(metadata)
  }

  /** Borrowed read-only data for internal projections. Never mutate nested records. */
  readOnlySnapshot(): { revision: string; images: readonly Readonly<GalleryImage>[]; resources: ReadOnlyGalleryResources } {
    const main = this.readMainIndex()
    const taskIndex = this.readTaskIndex()
    return {
      revision: `${main.signature}/${taskIndex?.signature ?? 'missing'}`,
      images: main.images,
      resources: { ...main.galleryResources, ...(taskIndex?.tasks ?? main.legacyTasks) },
    }
  }

  saveMetadata(updates: Record<string, unknown>): void {
    this.writeData({ ...updates, images: this.readMainIndex().images })
  }

  private readMainIndex(): Snapshot {
    const signature = fileSignature(this.dataFile)
    if (this.snapshot?.signature === signature) return this.snapshot
    this.snapshot = undefined
    this.legacyPermissions = undefined
    const raw = signature === 'missing' ? { images: [] } : JSON.parse(fs.readFileSync(this.dataFile, 'utf8'))
    return this.snapshot = createSnapshot(raw, signature)
  }

  private readTaskIndex(): TaskSnapshot | undefined {
    const signature = fileSignature(this.taskFile, false)
    if (this.taskSnapshot?.signature === signature) return this.taskSnapshot
    this.taskSnapshot = undefined
    if (signature === 'missing') return
    const raw = readGenerationTaskIndex(this.dataFile)
    if (raw) return this.taskSnapshot = { ...parseGenerationTaskIndex(raw), signature }
  }

  private writeData(data: GalleryData): void {
    const snapshot = this.readMainIndex(), existing = snapshot.raw
    if (existing.schemaVersion !== undefined && existing.schemaVersion !== 1) throw new Error('图库数据版本高于当前支持范围，请使用匹配版本')
    if (!snapshot.writeSafe) throw new Error('图库索引包含损坏记录，已阻止覆盖，请先恢复或修复')

    const taskIndex = this.readTaskIndex()
    const previousTasks = taskIndex?.tasks ?? snapshot.legacyTasks
    const hasResourceUpdate = Object.hasOwn(data, 'resources')
    const { gallery, tasks } = hasResourceUpdate
      ? splitGenerationResources((data.resources as ReadOnlyGalleryResources) || {})
      : { gallery: snapshot.galleryResources, tasks: previousTasks }
    const taskChanged = !isDeepStrictEqual(tasks, previousTasks)
    const mainChanged = data.images !== snapshot.images ||
      Object.keys(data).some(key => key !== 'images' && key !== 'resources') ||
      !isDeepStrictEqual(gallery, snapshot.galleryResources)

    const serializedTasks = taskChanged ? JSON.stringify(tasks) : undefined
    const validatedTasks = serializedTasks === undefined ? undefined : parseGenerationTaskIndex(serializedTasks)
    let main: { serialized: string; validated: Snapshot } | undefined
    if (mainChanged) {
      const images = data.images.map(image => { const result = { ...image }; delete result.thumbnailVersion; return result })
      const replacement: GalleryData = { ...existing, schemaVersion: 1, ...data, images }
      if (hasResourceUpdate || existing.resources !== undefined) {
        replacement.resources = taskIndex || taskChanged ? gallery : { ...gallery, ...snapshot.legacyTasks }
      }
      const serialized = JSON.stringify(replacement, null, 2)
      let validated: Snapshot
      try {
        validated = createSnapshot(JSON.parse(serialized), '')
        if (!taskIndex && !validatedTasks) resourceFiles(validated.legacyTasks)
      } catch (cause) {
        throw new Error('新图库索引的资源记录损坏，已拒绝写入', { cause })
      }
      if (!validated.writeSafe || validated.raw.schemaVersion !== 1) {
        throw new Error('新图库索引包含损坏记录或不支持的版本，已拒绝写入')
      }
      main = { serialized, validated }
    }

    const originalTaskBytes = main && taskChanged && taskIndex ? readGenerationTaskIndex(this.dataFile) : undefined
    if (serializedTasks !== undefined && validatedTasks) {
      const signature = writeIndex(this.taskFile, serializedTasks)
      this.taskSnapshot = signature ? { ...validatedTasks, signature } : undefined
    }
    if (main) {
      try {
        const signature = writeIndex(this.dataFile, main.serialized)
        this.snapshot = signature ? { ...main.validated, signature } : undefined
        this.legacyPermissions = undefined
      } catch (error) {
        // A combined save is rare. If installing the main index fails, roll
        // back the already published task index (or restore legacy fallback).
        if (taskChanged) {
          this.taskSnapshot = undefined
          try {
            if (originalTaskBytes) writeIndex(this.taskFile, originalTaskBytes)
            else fs.rmSync(this.taskFile, { force: true })
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], '写入图库失败，且无法恢复原任务索引')
          }
        }
        throw error
      }
    }
  }
}
