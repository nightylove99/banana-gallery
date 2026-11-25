import fs from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'

interface LoadProjectEnvFileOptions {
  projectRoot: string
  fileName?: string
  env?: NodeJS.ProcessEnv
  fileExists?: (targetPath: string) => boolean
}

export function loadProjectEnvFile({
  projectRoot,
  fileName = '.env',
  env = process.env,
  fileExists = fs.existsSync,
}: LoadProjectEnvFileOptions) {
  if (path.basename(fileName) !== fileName) {
    throw new Error('环境文件名必须是项目根目录下的文件名')
  }

  const envFilePath = path.join(projectRoot, fileName)
  if (!fileExists(envFilePath)) {
    return null
  }

  const parsedEnv = parseEnv(fs.readFileSync(envFilePath, 'utf8'))
  for (const [key, value] of Object.entries(parsedEnv)) {
    if (env[key] === undefined) {
      env[key] = value
    }
  }

  return envFilePath
}
