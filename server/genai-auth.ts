import fs from 'fs'
import { GoogleGenAI } from '@google/genai'

const DEFAULT_GCP_LOCATION = 'global'

export type GenAIAuthStrategy =
  | {
      mode: 'vertex'
      credentialPath: string
      project: string
      location: string
    }
  | {
      mode: 'apiKey'
      apiKey: string
    }

interface ResolveGenAIAuthStrategyOptions {
  env?: NodeJS.ProcessEnv
  fileExists?: (targetPath: string) => boolean
  readFile?: (targetPath: string) => string
}

export function resolveApiKey({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}) {
  const envApiKey = env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim()
  if (envApiKey) return envApiKey

  throw new Error('未找到可用的 Gemini API Key。请设置 GEMINI_API_KEY 或 GOOGLE_API_KEY。')
}

function readProjectIdFromCredentialFile(
  credentialPath: string,
  readFile: (targetPath: string) => string,
): string | null {
  try {
    const parsed: unknown = JSON.parse(readFile(credentialPath))
    const projectId =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { project_id?: unknown }).project_id
        : undefined
    return typeof projectId === 'string' && projectId.trim() ? projectId.trim() : null
  } catch {
    return null
  }
}

export function resolveGenAIAuthStrategy({
  env = process.env,
  fileExists = fs.existsSync,
  readFile = (targetPath: string) => fs.readFileSync(targetPath, 'utf8'),
}: ResolveGenAIAuthStrategyOptions = {}): GenAIAuthStrategy {
  const credentialPath = env.BANANA_GALLERY_SERVICE_ACCOUNT_PATH?.trim()
    || env.GOOGLE_APPLICATION_CREDENTIALS?.trim()

  if (credentialPath && fileExists(credentialPath)) {
    const project = env.GOOGLE_CLOUD_PROJECT?.trim()
      || readProjectIdFromCredentialFile(credentialPath, readFile)
    if (!project) {
      throw new Error('服务账号 JSON 缺少可读取的 project_id；请检查文件或设置 GOOGLE_CLOUD_PROJECT。')
    }
    return {
      mode: 'vertex',
      credentialPath,
      project,
      location: env.GOOGLE_CLOUD_LOCATION?.trim() || DEFAULT_GCP_LOCATION,
    }
  }

  return { mode: 'apiKey', apiKey: resolveApiKey({ env }) }
}

export function applyVertexEnvironment(
  strategy: Extract<GenAIAuthStrategy, { mode: 'vertex' }>,
  env: NodeJS.ProcessEnv = process.env,
) {
  // 显式写入环境变量，便于本地排查，也兼容 SDK 的默认发现逻辑。
  env.GOOGLE_APPLICATION_CREDENTIALS = strategy.credentialPath
  env.GOOGLE_GENAI_USE_VERTEXAI = 'true'
  env.GOOGLE_CLOUD_PROJECT = strategy.project
  env.GOOGLE_CLOUD_LOCATION = strategy.location
}

export function createGoogleGenAI(
  strategy = resolveGenAIAuthStrategy(),
  credentials?: { client_email: string; private_key: string },
) {
  // Give each client its own auth options. Hot reload must not mutate process.env
  // or let an in-flight request pick up a newly uploaded private key.
  const ai = strategy.mode === 'vertex'
    ? new GoogleGenAI({
        vertexai: true,
        project: strategy.project,
        location: strategy.location,
        googleAuthOptions: credentials ? { credentials } : { keyFilename: strategy.credentialPath },
      })
    : new GoogleGenAI({ vertexai: false, apiKey: strategy.apiKey })
  return { ai, strategy }
}
