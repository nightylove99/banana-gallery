import { withWorkCode } from '../gallery/work-code'
import { ImageIntakeError, normalizeIncomingPngFiles } from '../gallery/png-intake.js'
import { IMAGE_INPUT_LIMIT_MESSAGE, PNG_INPUT_MAX_BYTES } from '../../src/lib/image-intake-policy.js'
import { resourceFiles } from '../gallery/resource-files'
import { randomUUID } from 'node:crypto'
import { Router, type ErrorRequestHandler, type RequestHandler } from 'express'
import multer from 'multer'
import { handleDiskUpload, uploadDiskStorage } from '../storage/disk-upload.js'
import sharp from 'sharp'
import { readSharpInput } from '../storage/sharp-input.js'
import { GalleryWriteCoordinator } from '../gallery/write-coordinator.js'
import type { GalleryRepository } from '../gallery/gallery-repository.js'
import type { AssetStorage } from '../storage/asset-storage.js'

class ReferenceEditError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export function createImageReferencesRouter({ galleryRepository, assetStorage, writeCoordinator = new GalleryWriteCoordinator('references') }: {
  galleryRepository: GalleryRepository
  assetStorage: AssetStorage
  writeCoordinator?: GalleryWriteCoordinator
}) {
  const router = Router()
  const upload = multer({
    storage: uploadDiskStorage(
      assetStorage.getReferencesDir(),
      file => `ref_${randomUUID()}.${({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[file.mimetype]}`,
    ),
    limits: { fileSize: PNG_INPUT_MAX_BYTES + 1, files: 14, fields: 4, fieldSize: 64 * 1024 },
    fileFilter: (_req, file, done) => {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
        done(new ReferenceEditError(400, '仅支持 JPG、PNG、WebP 图片'))
      } else done(null, true)
    },
  }).array('references', 14)
  // 串行提交同一 workspace 的参考图编辑，避免校验与保存之间互相覆盖。
  const pending = new Map<string, Promise<void>>()
  const handleUploadError: ErrorRequestHandler = (error, _req, res, next) => {
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? IMAGE_INPUT_LIMIT_MESSAGE : '上传内容超过限制，最多支持 14 张参考图'
      res.status(400).json({ error: message })
    } else next(error)
  }
  const authorizeUpload: RequestHandler = async (req, res, next) => {
    if (!req.authSession) { res.status(401).json({ error: 'UNAUTHORIZED' }); return }
    const scope = { workspaceId: req.authSession.workspace.id, ownerUserId: req.authSession.user.id, userId: req.authSession.user.id }
    if (!(await galleryRepository.listImages(scope)).some(image => image.id === req.params.id && !image.deletedAt)) {
      res.status(404).json({ error: 'Not found' }); return
    }
    next()
  }
  router.put('/:id/references', authorizeUpload, handleDiskUpload(upload, async (req, res, keepFiles) => writeCoordinator.run(async () => {
    const session = req.authSession!
    const scope = { workspaceId: session.workspace.id, ownerUserId: session.user.id, userId: session.user.id }
    const previous = pending.get(scope.workspaceId) ?? Promise.resolve()
    let release!: () => void
    const finished = new Promise<void>(resolve => { release = resolve })
    pending.set(scope.workspaceId, finished)
    await previous
    const files = (req.files ?? []) as Express.Multer.File[]
    try {
      const body = req.body ?? {}
      const invalidField = ['expectedVersion', 'order', 'baseReferences', 'referenceNotes']
        .find(field => body[field] !== undefined && typeof body[field] !== 'string')
      if (invalidField) throw new ReferenceEditError(400, `${invalidField} 必须是单个文本字段`)
      const images = await galleryRepository.listImages(scope)
      const image = images.find(item => item.id === req.params.id && !item.deletedAt)
      if (!image) throw new ReferenceEditError(404, '条目不存在')
      if (body.expectedVersion !== undefined && (!/^\d+$/.test(body.expectedVersion) || Number(body.expectedVersion) !== (image.version || 0))) throw new ReferenceEditError(409, '条目已在其他窗口修改，请重新打开详情后再编辑')
      let order: unknown
      let base: unknown
      try { order = JSON.parse(body.order); base = JSON.parse(body.baseReferences) } catch {
        throw new ReferenceEditError(400, '参考图列表格式错误')
      }
      if (!Array.isArray(base) || !base.every(item => typeof item === 'string')) throw new ReferenceEditError(400, '原参考图列表格式错误')
      if (JSON.stringify(base) !== JSON.stringify(image.referenceImages)) throw new ReferenceEditError(409, '参考图已在其他窗口修改，请重新打开详情后再编辑')
      if (!Array.isArray(order) || order.length > Math.max(14, image.referenceImages.length)) throw new ReferenceEditError(400, '最多支持 14 张参考图')
      await normalizeIncomingPngFiles(files)
      const usedUploads = new Set<number>()
      const usedNames = new Map<string, number>()
      const filenames = order.map((item: unknown) => {
        if (!item || typeof item !== 'object') throw new ReferenceEditError(400, '参考图列表格式错误')
        const entry = item as { filename?: unknown; upload?: unknown }
        if (typeof entry.filename === 'string' && entry.upload === undefined && image.referenceImages.includes(entry.filename) && (usedNames.get(entry.filename) || 0) < image.referenceImages.filter(name => name === entry.filename).length) {
          usedNames.set(entry.filename, (usedNames.get(entry.filename) || 0) + 1)
          return entry.filename
        }
        if (entry.filename === undefined && typeof entry.upload === 'number' && Number.isInteger(entry.upload) && files[entry.upload] && !usedUploads.has(entry.upload)) {
          usedUploads.add(entry.upload)
          return files[entry.upload].filename
        }
        throw new ReferenceEditError(400, '参考图无效或不属于当前条目')
      })
      let referenceNotes: string[] | undefined
      if (body.referenceNotes !== undefined) {
        try { referenceNotes = JSON.parse(body.referenceNotes) } catch { throw new ReferenceEditError(400, '参考图用途格式错误') }
        if (!Array.isArray(referenceNotes) || referenceNotes.length !== filenames.length || referenceNotes.some(note => typeof note !== 'string' || note.length > 500)) throw new ReferenceEditError(400, '参考图用途与顺序不匹配')
      } else if (image.referenceNotes) {
        const remaining = image.referenceImages.map((filename,index) => ({filename,note:image.referenceNotes?.[index] || ''}))
        referenceNotes = filenames.map(filename => { const index = remaining.findIndex(item => item.filename === filename); return index < 0 ? '' : remaining.splice(index,1)[0].note })
      }
      if (usedUploads.size !== files.length) throw new ReferenceEditError(400, '存在未使用的上传文件')
      for (const file of files) {
        try {
          const image = sharp(await readSharpInput(file.path))
          const metadata = await image.metadata()
          if (!metadata.width || !metadata.height || !['jpeg', 'png', 'webp'].includes(metadata.format ?? '')) throw new Error('format')
          await image.resize(1, 1).toBuffer()
        } catch { throw new ReferenceEditError(400, '上传文件不是有效的 JPG、PNG 或 WebP 图片') }
      }
      const protectedReferences = resourceFiles(await galleryRepository.readResources?.(scope)).references
      const removed = [...new Set(image.referenceImages)].filter(name => !filenames.includes(name) && !protectedReferences.has(name) && !images.some(other => other.id !== image.id && other.referenceImages.includes(name)))
      // 逐张完成上传，任何失败都先等待当前上传结束，再回收本次文件。
      for (const file of files) await assetStorage.finalizeReferences([file.filename])
      // 上传可能耗时；重新读取以保留期间发生的提示词、标签等修改。
      const latest = await galleryRepository.listImages(scope)
      const index = latest.findIndex(item => item.id === image.id)
      if (index < 0 || JSON.stringify(latest[index].referenceImages) !== JSON.stringify(base)) throw new ReferenceEditError(409, '条目已发生变化，请重新打开详情后再编辑')
      const updated = { ...latest[index], referenceImages: filenames, ...(referenceNotes ? {referenceNotes} : {}), version: (latest[index].version || 0) + 1, updatedAt: new Date().toISOString() }
      latest[index] = updated
      await galleryRepository.saveImages(latest, scope)
      keepFiles()
      for (const name of removed) {
        // 保存期间可能生成共享配方，删除前再次确认引用。
        try {
          const current = await galleryRepository.listImages(scope)
          if (current.some(item => item.referenceImages.includes(name))) continue
          await assetStorage.deleteReferences([name])
        } catch { console.error('参考图已保存，但旧文件清理失败') }
      }
      res.json(withWorkCode(updated))
    } catch (error) {
      const status = error instanceof ReferenceEditError ? error.status : error instanceof ImageIntakeError ? 400 : 500
      res.status(status).json({ error: error instanceof ReferenceEditError || error instanceof ImageIntakeError ? error.message : '参考图片保存失败，请重试' })
    } finally {
      release()
      if (pending.get(scope.workspaceId) === finished) pending.delete(scope.workspaceId)
    }
  })), handleUploadError)
  return router
}
