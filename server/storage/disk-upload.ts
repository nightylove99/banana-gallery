import fs from 'node:fs'
import path from 'node:path'
import type { Request, RequestHandler, Response } from 'express'
import multer from 'multer'

type UploadFile = Express.Multer.File
const allocatedPaths = new WeakMap<Request, Set<string>>()

export function uploadDiskStorage(
  destination: string | ((file: UploadFile) => string),
  filename: (file: UploadFile) => string,
) {
  const directory = typeof destination === 'string' ? () => destination : destination
  return multer.diskStorage({
    destination: (_req, file, done) => done(null, directory(file)),
    filename: (req, file, done) => {
      const name = filename(file)
      allocatedPaths.get(req)?.add(path.join(directory(file), name))
      done(null, name)
    },
  })
}

/** Own the request's files until the handler publishes them, including failures before the write lock is acquired. */
export function handleDiskUpload(
  parse: RequestHandler,
  handle: (req: Request, res: Response, keepFiles: () => void) => Promise<unknown>,
): RequestHandler {
  return async (req, res) => {
    const paths = new Set<string>()
    allocatedPaths.set(req, paths)
    let committed = false
    try {
      await new Promise<void>((resolve, reject) => {
        parse(req, res, error => error ? reject(error) : resolve())
      })
      if (!res.destroyed) await handle(req, res, () => { committed = true })
    } finally {
      allocatedPaths.delete(req)
      if (!committed) {
        // Include both partially written files known before parsing finished,
        // and final paths after handlers have renamed or converted uploads.
        const files = Array.isArray(req.files) ? req.files : Object.values(req.files ?? {}).flat()
        for (const file of [req.file, ...files]) {
          if (file?.path) paths.add(file.path)
        }
        for (const filePath of paths) {
          try {
            fs.rmSync(filePath, { force: true })
          } catch (error) {
            console.error('[upload] 未能回收未提交的上传文件', (error as NodeJS.ErrnoException).code)
          }
        }
      }
    }
  }
}
