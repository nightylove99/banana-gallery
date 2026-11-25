import path from 'node:path'
import fs from 'node:fs'
import { readGenerationTaskIndex } from '../server/gallery/generation-task-storage.js'
import { GalleryBackups, backupIndexFingerprint } from '../server/personal/backups.js'
import { loadProjectEnvFile } from '../server/config/load-env.js'
import { resolveRuntimePaths } from '../server/config/runtime-paths.js'
const projectRoot = path.resolve(import.meta.dirname, '..')
loadProjectEnvFile({ projectRoot, fileName: process.env.BANANA_GALLERY_ENV_FILE || '.env' })
const paths = resolveRuntimePaths(projectRoot)
const service = new GalleryBackups(paths)
const [command, id, option, target] = process.argv.slice(2)
try {
  if (command === 'backup-info') {
    const { raw, tasks } = await service.coordinator.run(() => ({
      raw: fs.existsSync(paths.dataFile) ? fs.readFileSync(paths.dataFile) : Buffer.from('{"images":[]}'),
      tasks: readGenerationTaskIndex(paths.dataFile),
    }))
    const assetBytes = [paths.imagesDir, paths.referencesDir].reduce((total, dir) => total + (
      fs.existsSync(dir) ? fs.readdirSync(dir).reduce((sum, name) => {
        const stat = fs.lstatSync(path.join(dir, name))
        return sum + (stat.isFile() ? stat.size : 0)
      }, 0) : 0
    ), raw.length + (tasks?.length ?? 0))
    console.log(JSON.stringify({ fingerprint: backupIndexFingerprint(raw, tasks), assetBytes }))
  } else if (command === 'backup') console.log(JSON.stringify(await service.create(), null, 2))
  else if (command === 'verify' && id) { await service.verify(id); console.log(`备份校验通过：${id}`) }
  else if (command === 'restore' && id && option === '--to' && target) {
    await service.restoreTo(id, path.resolve(target)); console.log(`已恢复到：${path.resolve(target)}`)
  } else if (command === 'restore' && id && option === '--in-place' && process.env.BANANA_GALLERY_OFFLINE_RESTORE === 'true') {
    const result = await service.restoreInPlace(id); console.log(`恢复完成；恢复前的全部数据保留在：${result.recoveryDir}`)
  } else throw new Error('用法：./gallery.sh backup | verify <备份编号> | restore <备份编号> --to <空目录> | restore <备份编号> --in-place（须停服）')
} catch (error) {
  console.error(error instanceof Error ? error.message : '备份操作失败')
  process.exitCode = 1
}
