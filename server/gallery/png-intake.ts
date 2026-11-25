import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { IMAGE_FINAL_MAX_BYTES, PNG_INPUT_MAX_BYTES } from '../../src/lib/image-intake-policy.js'
import { readSharpInput } from '../storage/sharp-input.js'

export const PNG_CONVERSION_THRESHOLD = 5_000_000

interface IncomingImage {
  path: string
  filename: string
  mimetype: string
  size: number
}

export class ImageIntakeError extends Error {}

/** Check actual bytes before staging a local import or decoding an uploaded image. */
export async function validateIncomingImageSize(source: string | FileHandle): Promise<number> {
  const file = typeof source === 'string' ? await fs.open(source, 'r') : source
  try {
    const { size } = await file.stat()
    const signature = Buffer.alloc(8)
    await file.read(signature, 0, signature.length, 0)
    const png = signature.equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    if (size > (png ? PNG_INPUT_MAX_BYTES : IMAGE_FINAL_MAX_BYTES)) {
      throw new ImageIntakeError(png ? 'PNG 原图不能超过 100 MiB' : '非 PNG 图片不能超过 25 MiB')
    }
    return size
  } finally {
    if (typeof source === 'string') await file.close()
  }
}

/** Metadata alone can succeed even when the compressed pixels are truncated. */
export async function inspectIncomingImage(source: string | Buffer) {
  try {
    const image = sharp(await readSharpInput(source), { failOn: 'warning', animated: true })
    const { format, width, height, pageHeight } = await image.metadata()
    if (!width || !height || (format !== 'jpeg' && format !== 'png' && format !== 'webp')) {
      throw new Error('Unsupported image format')
    }
    await image.stats()
    return { width, height: pageHeight ?? height, format }
  } catch {
    throw new ImageIntakeError('上传文件不是有效、可解码的 JPG、PNG 或 WebP 图片')
  }
}

// Parse chunk boundaries: searching arbitrary bytes could mistake image data for acTL.
function isStaticPng(bytes: Buffer): boolean {
  if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return false
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    if (offset + length + 12 > bytes.length) return false
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (type === 'acTL') return false
    if (type === 'IEND') return true
    offset += length + 12
  }
  return false
}

/** Normalize only a new, uncommitted intake file; existing library files must not call this. */
export async function normalizeIncomingPng(file: IncomingImage): Promise<string> {
  if (file.size <= PNG_CONVERSION_THRESHOLD) return 'small'
  let temporaryPath: string | undefined
  let jpegPath: string | undefined
  try {
    const original = await fs.readFile(file.path)
    if (!isStaticPng(original)) return 'animation-or-invalid'
    const image = sharp(original, { failOn: 'warning' })
    if (!(await image.stats()).isOpaque) return 'transparent'
    const jpeg = await image.keepMetadata().jpeg({ quality: 92 }).toBuffer()
    if (jpeg.length >= original.length) return 'not-smaller'

    const filename = `${path.parse(file.filename).name}-${randomUUID()}.jpg`
    jpegPath = path.join(path.dirname(file.path), filename)
    temporaryPath = `${jpegPath}.tmp`
    await fs.writeFile(temporaryPath, jpeg, { flag: 'wx' })
    await fs.rename(temporaryPath, jpegPath)
    temporaryPath = undefined
    // The PNG remains intact until the complete JPEG is present. If unlink fails, roll back.
    await fs.unlink(file.path)
    Object.assign(file, { path: jpegPath, filename, mimetype: 'image/jpeg', size: jpeg.length })
    jpegPath = undefined
    return 'converted'
  } catch {
    // Conversion is an optimization. Preserve the original and its existing validation path.
    console.warn('[png-intake] 未能转换新 PNG，保留原文件')
    return 'failed'
  } finally {
    for (const candidate of [temporaryPath, jpegPath]) {
      if (candidate) await fs.rm(candidate, { force: true }).catch(() => {
        console.warn('[png-intake] 转换临时文件清理失败')
      })
    }
  }
}

export async function normalizeIncomingPngFiles(files: IncomingImage[]): Promise<void> {
  try {
    for (const file of files) file.size = await validateIncomingImageSize(file.path)
    // Decode sequentially to bound memory when a batch contains multiple camera-size PNGs.
    for (const file of files) {
      const result = await normalizeIncomingPng(file)
      if (file.size > IMAGE_FINAL_MAX_BYTES) {
        const reason = result === 'transparent' ? '图片含透明像素，保留 PNG 后超过 25 MiB'
          : result === 'animation-or-invalid' ? '动态或无效 PNG 无法自动转换，原图超过 25 MiB'
          : result === 'failed' ? 'PNG 转换失败，原图超过 25 MiB'
          : result === 'not-smaller' ? 'PNG 转换未能减小体积，原图超过 25 MiB'
          : 'PNG 转换后仍超过 25 MiB'
        throw new ImageIntakeError(reason)
      }
    }
  } catch (error) {
    // These are uncommitted copies only. Clean the whole batch, including earlier JPEGs.
    await Promise.all(files.map(file => fs.rm(file.path, { force: true })))
    throw error
  }
}
