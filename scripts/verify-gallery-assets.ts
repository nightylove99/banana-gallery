/**
 * 校验图库索引以及作品、生成历史、素材库引用的磁盘资源。
 * 退出码：0 无缺失；1 有缺失或校验失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { inspectGalleryDiskAssets } from '../server/gallery/disk-asset-integrity.ts'
import { generationTasksFileFor, readGenerationTaskIndex } from '../server/gallery/generation-task-storage.ts'
import { resolveRuntimePaths } from '../server/config/runtime-paths.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { dataFile, imagesDir, referencesDir } = resolveRuntimePaths(ROOT)

if (!fs.existsSync(dataFile) && !fs.existsSync(generationTasksFileFor(dataFile))) {
  console.log('[verify-gallery-assets] 无 gallery-data.json，跳过')
  process.exit(0)
}

try {
  const raw: unknown = fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile, 'utf8')) : { images: [] }
  const { imageCount, missing } = inspectGalleryDiskAssets(raw, imagesDir, referencesDir, readGenerationTaskIndex(dataFile))
  if (missing.length === 0) {
    console.log(`[verify-gallery-assets] OK（${imageCount} 条图库条目，并已检查生成历史与素材库）`)
  } else {
    console.error(`[verify-gallery-assets] ${missing.length} 个索引引用的资源在磁盘上不存在：`)
    for (const { kind, filename, ownerId } of missing.slice(0, 50)) {
      console.error(`  · ${kind}\t${filename}\t(条目 ${ownerId})`)
    }
    if (missing.length > 50) console.error(`  … 另有 ${missing.length - 50} 条`)
    process.exitCode = 1
  }
} catch (error) {
  console.error('[verify-gallery-assets] 无法校验图库索引和资源：', error instanceof Error ? error.message : error)
  process.exitCode = 1
}
