import path from 'node:path'

/** Legacy installs keep their existing paths; distributed installs opt into external data. */
export function resolveRuntimePaths(projectRoot: string, env: NodeJS.ProcessEnv = process.env) {
  const configured = env.BANANA_GALLERY_DATA_DIR?.trim()
  if (configured && !path.isAbsolute(configured)) {
    throw new Error('BANANA_GALLERY_DATA_DIR 必须是绝对路径')
  }
  const dataRoot = configured || projectRoot
  for (const directory of ['public', 'dist']) {
    const relative = path.relative(path.join(projectRoot, directory), dataRoot)
    if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
      throw new Error('BANANA_GALLERY_DATA_DIR 不能位于应用的 public 或 dist 目录中')
    }
  }
  const backupDir = env.BANANA_GALLERY_BACKUP_DIR?.trim() || path.join(dataRoot, 'backups')
  if (!path.isAbsolute(backupDir)) throw new Error('BANANA_GALLERY_BACKUP_DIR 必须是绝对路径')
  return {
    backupDir,
    dataFile: path.join(dataRoot, 'gallery-data.json'),
    imagesDir: path.join(dataRoot, 'public', 'images'),
    referencesDir: path.join(dataRoot, 'public', 'references'),
    distDir: path.join(projectRoot, 'dist'),
  }
}
