import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveGenAIAuthStrategy, type GenAIAuthStrategy } from '../genai-auth.js'
import { OPENAI_IMAGE_DEFAULT_BASE_URL } from '../ai/openai-compatible-image-provider.ts'
import { OPENAI_IMAGE_DEFAULT_MODEL } from '../../src/lib/image-generation-providers.ts'
import type { ProviderConfigStatus } from '../../src/types'

export const SERVICE_ACCOUNT_MAX_BYTES = 256 * 1024

type StoredConfig = {
  google?: { apiKey?: string; location?: string }
  openaiCompatible?: { apiKey?: string; baseUrl?: string; model?: string }
}
type ServiceAccount = {
  type: 'service_account'
  project_id: string
  client_email: string
  private_key: string
}

export class ProviderConfigError extends Error {}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderConfigError(message)
  return value as Record<string, unknown>
}

function serviceAccount(value: unknown): ServiceAccount {
  const body = object(value, '请选择 Google 服务账号 JSON 文件')
  if (body.type !== 'service_account') throw new ProviderConfigError('JSON 的 type 必须为 service_account')
  const { project_id, client_email, private_key } = body
  if (typeof project_id !== 'string' || !project_id.trim()) throw new ProviderConfigError('服务账号 JSON 缺少 project_id')
  if (typeof client_email !== 'string' || !client_email.trim()) throw new ProviderConfigError('服务账号 JSON 缺少 client_email')
  if (typeof private_key !== 'string' || !private_key.trim()) throw new ProviderConfigError('服务账号 JSON 缺少 private_key')
  // Use only the fields needed for Google's standard service-account flow.
  return { type: 'service_account', project_id: project_id.trim(), client_email: client_email.trim(), private_key }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    // JSON.parse errors can contain snippets of credentials.
    throw new Error('无法读取本机生图凭据')
  }
}

function writePrivateJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx', flush: true })
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function isSafeBaseUrl(value: string) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/[?#]/.test(value)
  } catch {
    return false
  }
}

function field(
  value: unknown,
  current: string | undefined,
  error: string,
  valid: (value: string) => boolean,
) {
  if (value === null) return undefined
  if (value === undefined || (typeof value === 'string' && !value.trim())) return current
  if (typeof value !== 'string' || !valid(value.trim())) throw new ProviderConfigError(error)
  return value.trim()
}

const keyIsValid = (key: string) => /^[!-~]{1,4096}$/.test(key)
const masked = (key: string | undefined) => key ? (key.length > 4 ? `...${key.slice(-4)}` : '...') : undefined

export class ProviderConfig {
  private readonly configFile: string
  private readonly accountFile: string
  private readonly env: NodeJS.ProcessEnv

  constructor(dataFile: string, env: NodeJS.ProcessEnv = process.env) {
    this.env = env
    this.configFile = path.join(path.dirname(dataFile), '.provider-config.json')
    this.accountFile = path.join(path.dirname(dataFile), '.vertex-service-account.json')
  }

  private read(): StoredConfig {
    const value = readJson(this.configFile)
    return value === undefined ? {} : object(value, '本机生图凭据格式无效') as StoredConfig
  }

  update(input: unknown) {
    const body = object(input, '生图凭据格式无效')
    const previous = this.read()
    const google = body.google === undefined ? {} : object(body.google, 'Google 凭据格式无效')
    const openai = body.openaiCompatible === undefined ? {} : object(body.openaiCompatible, 'OpenAI 兼容配置格式无效')
    const next: StoredConfig = {
      google: {
        apiKey: field(google.apiKey, previous.google?.apiKey, 'Google API Key 格式无效', keyIsValid),
        location: field(google.location, previous.google?.location, 'Vertex 区域格式无效', value => /^[a-z0-9-]{1,64}$/.test(value)),
      },
      openaiCompatible: {
        apiKey: field(openai.apiKey, previous.openaiCompatible?.apiKey, 'OpenAI API Key 格式无效', keyIsValid),
        baseUrl: field(openai.baseUrl, previous.openaiCompatible?.baseUrl, 'Base URL 必须是 HTTP(S) 地址，不能含账号、密码、查询参数或片段', value => value.length <= 2048 && isSafeBaseUrl(value)),
        model: field(openai.model, previous.openaiCompatible?.model, '模型名格式无效', value => value.length <= 200 && [...value].every(character => character >= ' ' && character.charCodeAt(0) !== 127)),
      },
    }
    if (google.clearServiceAccount !== undefined && typeof google.clearServiceAccount !== 'boolean') {
      throw new ProviderConfigError('清除服务账号的参数无效')
    }
    writePrivateJson(this.configFile, next)
    if (google.clearServiceAccount) {
      try {
        fs.rmSync(this.accountFile, { force: true })
      } catch (error) {
        writePrivateJson(this.configFile, previous)
        throw error
      }
    }
  }

  upload(input: unknown) {
    writePrivateJson(this.accountFile, serviceAccount(input))
  }

  resolve() {
    const stored = this.read()
    const accountValue = readJson(this.accountFile)
    const credentials = accountValue === undefined ? undefined : serviceAccount(accountValue)
    const location = stored.google?.location || this.env.GOOGLE_CLOUD_LOCATION?.trim() || 'global'
    const googleKey = stored.google?.apiKey || this.env.GEMINI_API_KEY?.trim() || this.env.GOOGLE_API_KEY?.trim()
    let google: GenAIAuthStrategy | undefined
    if (credentials) {
      google = { mode: 'vertex', credentialPath: this.accountFile, project: credentials.project_id, location }
    } else {
      try {
        google = resolveGenAIAuthStrategy({ env: { ...this.env, GEMINI_API_KEY: googleKey, GOOGLE_CLOUD_LOCATION: location } })
      } catch {
        // No usable Google credentials. Keep other channels available.
      }
    }

    let clientEmail = credentials?.client_email
    if (!credentials && google?.mode === 'vertex') {
      try {
        const value = readJson(google.credentialPath) as { client_email?: unknown } | undefined
        if (typeof value?.client_email === 'string') clientEmail = value.client_email
      } catch { /* Environment credentials may rely on separately configured project metadata. */ }
    }
    const openai = {
      openaiImageApiKey: stored.openaiCompatible?.apiKey || this.env.OPENAI_IMAGE_API_KEY?.trim() || undefined,
      openaiImageBaseUrl: stored.openaiCompatible?.baseUrl || this.env.OPENAI_IMAGE_BASE_URL?.trim() || OPENAI_IMAGE_DEFAULT_BASE_URL,
      openaiImageModel: stored.openaiCompatible?.model || this.env.OPENAI_IMAGE_MODEL?.trim() || OPENAI_IMAGE_DEFAULT_MODEL,
    }
    const status: Pick<ProviderConfigStatus, 'google' | 'openaiCompatible'> = {
      google: {
        apiKeyConfigured: Boolean(googleKey),
        apiKeyMasked: masked(googleKey),
        apiKeySource: stored.google?.apiKey ? 'ui' : googleKey ? 'env' : 'none',
        serviceAccountConfigured: google?.mode === 'vertex',
        serviceAccountSource: credentials ? 'ui' : google?.mode === 'vertex' ? 'env' : 'none',
        projectId: google?.mode === 'vertex' ? google.project : undefined,
        clientEmail,
        location,
        activeMode: google?.mode ?? 'none',
      },
      openaiCompatible: {
        configured: Boolean(openai.openaiImageApiKey),
        source: Object.values(stored.openaiCompatible ?? {}).some(Boolean)
          ? 'ui' : openai.openaiImageApiKey || this.env.OPENAI_IMAGE_BASE_URL?.trim() || this.env.OPENAI_IMAGE_MODEL?.trim() ? 'env' : 'none',
        apiKeyConfigured: Boolean(openai.openaiImageApiKey),
        apiKeyMasked: masked(openai.openaiImageApiKey),
        // Legacy environment URLs still work, but never publish embedded credentials.
        baseUrl: isSafeBaseUrl(openai.openaiImageBaseUrl) ? openai.openaiImageBaseUrl : '',
        model: openai.openaiImageModel,
      },
    }
    return { google, openai, credentials, status }
  }

  status() {
    return this.resolve().status
  }
}
