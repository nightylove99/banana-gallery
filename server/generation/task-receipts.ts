import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GenerationTask } from '../../src/types'
import type { AssetStorage } from '../storage/asset-storage'
import type { GenerationReceipt } from './task-queue'

export function generationTaskReceipts(dataFile: string, storage: AssetStorage) {
  const directory = path.join(path.dirname(dataFile), '.generation-receipts')
  const receiptPath = (id: string) => path.join(directory, `${id}.json`)
  return {
    // Publish the receipt first. Recovery accepts it only once the final image exists.
    write(id: string, receipt: GenerationReceipt) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      const file = receiptPath(id)
      const temporary = path.join(directory, `.${id}.${randomUUID()}.tmp`)
      try {
        fs.writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600, flag: 'wx', flush: true })
        fs.renameSync(temporary, file)
      } finally {
        fs.rmSync(temporary, { force: true })
      }
    },
    async read(job: GenerationTask): Promise<GenerationReceipt | undefined> {
      if (!/^[\w-]{1,128}$/.test(job.id)) return
      try {
        const receipt = JSON.parse(await fs.promises.readFile(receiptPath(job.id), 'utf8')) as GenerationReceipt | null
        if (!receipt) return
        const { result, outputBytes, completedAt } = receipt
        if (!result || !['.png', '.jpg', '.webp'].some(ext => result.filename === `gen_${job.id}${ext}`) ||
          result.provider !== job.input.provider || result.model !== job.input.model ||
          !Number.isSafeInteger(result.width) || result.width <= 0 ||
          !Number.isSafeInteger(result.height) || result.height <= 0 ||
          typeof outputBytes !== 'number' || !Number.isSafeInteger(outputBytes) || outputBytes <= 0 ||
          typeof completedAt !== 'string' || !Number.isFinite(Date.parse(completedAt))) return
        const image = await fs.promises.lstat(storage.getImagePath(result.filename))
        if (image.isFile() && image.size === outputBytes) return receipt
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
    async remove(id: string) {
      await fs.promises.rm(receiptPath(id), { force: true })
    },
  }
}
