import type { RequestHandler } from 'express'

// Preserve the existing 100 MiB limit for a single PNG plus multipart framing.
export const referenceUploadMaxBytes = 101 * 1024 * 1024
const uploadTooLarge = '单次参考图上传总大小不能超过 101 MiB，请把图片分批上传'

export function boundReferenceUpload(intake: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (!req.is('multipart/form-data')) return intake(req, res, next)
    if (Number(req.get('Content-Length')) > referenceUploadMaxBytes) {
      res.status(413).json({ error: uploadTooLarge })
      return
    }
    let received = 0
    let exceeded = false
    const count = (chunk: Buffer) => {
      received += chunk.length
      if (received <= referenceUploadMaxBytes || exceeded) return
      exceeded = true
      // Multer unpipes the multipart parser, removes partial files and drains the request.
      req.emit('error', new Error(uploadTooLarge))
    }
    req.prependListener('data', count)
    intake(req, res, error => {
      req.removeListener('data', count)
      if (exceeded) res.status(413).json({ error: uploadTooLarge })
      else next(error)
    })
  }
}
