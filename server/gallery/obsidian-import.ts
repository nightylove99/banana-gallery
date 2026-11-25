import fs from 'node:fs'
import path from 'node:path'
import { inspectIncomingImage, ImageIntakeError, validateIncomingImageSize } from './png-intake.js'

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

export async function readObsidianAttachment(root: string, attachment: string) {
  if (path.isAbsolute(attachment) || attachment.split(/[\\/]/).includes('..')) return
  const candidate = path.resolve(root, attachment)
  if (!isInside(root, candidate)) return

  let file
  try {
    const resolved = fs.realpathSync(candidate)
    if (!isInside(root, resolved) || !fs.statSync(resolved).isFile()) return
    // Do not follow a symlink substituted between resolution and opening. Verify
    // the opened inode against the path again before reading any image bytes.
    file = await fs.promises.open(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const opened = await file.stat()
    const currentPath = fs.realpathSync(candidate)
    if (!isInside(root, currentPath) || !opened.isFile()) return
    const current = fs.statSync(currentPath)
    if (opened.dev !== current.dev || opened.ino !== current.ino) return
    const size = await validateIncomingImageSize(file)
    const buffer = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await file.read(buffer, offset, size - offset, offset)
      if (!bytesRead) return
      offset += bytesRead
    }
    const metadata = await inspectIncomingImage(buffer).catch(() => undefined)
    if (metadata) return { buffer, ...metadata }
  } catch (error) {
    // Keep intake size/normalization errors visible, as with other intake routes.
    if (error instanceof ImageIntakeError) throw error
  } finally {
    await file?.close()
  }
}
