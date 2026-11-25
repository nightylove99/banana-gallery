import fs from 'node:fs'
import path from 'node:path'

import express, { type Express } from 'express'

const PROTECTED_PREFIXES = ['/api', '/images', '/references', '/cdn-cgi']

export function attachStaticApp(app: Express, staticDir: string) {
  const resolvedStaticDir = path.resolve(staticDir)
  const indexFile = path.join(resolvedStaticDir, 'index.html')
  if (!fs.existsSync(indexFile)) {
    throw new Error(`找不到前端构建文件：${indexFile}；请先运行 npm run build`)
  }

  app.use(express.static(resolvedStaticDir, {
    index: false,
    setHeaders: (res, filePath) => {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow')
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      }
    },
  }))

  app.use((req, res, next) => {
    if (
      (req.method !== 'GET' && req.method !== 'HEAD')
      || PROTECTED_PREFIXES.some((prefix) => (
        req.path === prefix || req.path.startsWith(`${prefix}/`)
      ))
    ) {
      next()
      return
    }

    res.setHeader('X-Robots-Tag', 'noindex, nofollow')
    res.setHeader('Cache-Control', 'no-store')
    res.sendFile(indexFile)
  })
}
