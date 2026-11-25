import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey,
} from 'node:crypto'

interface CloudflareAccessIdentity {
  email: string
}

interface CloudflareJwk extends JsonWebKey {
  kid?: string
  alg?: string
  use?: string
}

interface CloudflareJwks {
  keys: CloudflareJwk[]
}

interface CloudflareAccessVerifierOptions {
  teamDomain: string
  audience: string
  allowedEmails: string[]
  now?: () => number
  fetchJwks?: () => Promise<CloudflareJwks>
  jwksCacheTtlMs?: number
}

interface JwtHeader {
  alg?: unknown
  kid?: unknown
}

interface JwtPayload {
  iss?: unknown
  aud?: unknown
  email?: unknown
  exp?: unknown
  nbf?: unknown
}

const DEFAULT_JWKS_CACHE_TTL_MS = 60 * 60 * 1000
const MAX_JWKS_STALE_MS = 24 * 60 * 60 * 1000
const CLOCK_TOLERANCE_SECONDS = 30
const MAX_ASSERTION_LENGTH = 16 * 1024

export class CloudflareAccessJwksUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Cloudflare Access 验签服务暂不可用', { cause })
    this.name = 'CloudflareAccessJwksUnavailableError'
  }
}

export class CloudflareAccessVerifier {
  private readonly teamDomain: string
  private readonly audience: string
  private readonly allowedEmails: Set<string>
  private readonly now: () => number
  private readonly fetchJwks: () => Promise<CloudflareJwks>
  private readonly jwksCacheTtlMs: number
  private cachedJwks: { value: CloudflareJwks; expiresAt: number } | null = null

  private refreshing?: Promise<CloudflareJwks>

  constructor({
    teamDomain,
    audience,
    allowedEmails,
    now = Date.now,
    fetchJwks,
    jwksCacheTtlMs = DEFAULT_JWKS_CACHE_TTL_MS,
  }: CloudflareAccessVerifierOptions) {
    this.teamDomain = normalizeTeamDomain(teamDomain)
    this.audience = audience
    this.allowedEmails = new Set(allowedEmails.map((email) => email.trim().toLowerCase()))
    this.now = now
    this.fetchJwks = fetchJwks ?? (() => fetchCloudflareJwks(this.teamDomain))
    this.jwksCacheTtlMs = jwksCacheTtlMs
  }

  async verify(assertion: string | undefined): Promise<CloudflareAccessIdentity | null> {
    if (!assertion || assertion.length > MAX_ASSERTION_LENGTH) return null

    try {
      const segments = assertion.split('.')
      if (segments.length !== 3) return null

      const [encodedHeader, encodedPayload, encodedSignature] = segments
      const header = decodeJson<JwtHeader>(encodedHeader)
      const payload = decodeJson<JwtPayload>(encodedPayload)
      if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null

      const nowSeconds = Math.floor(this.now() / 1000)
      if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp < nowSeconds - CLOCK_TOLERANCE_SECONDS) {
        return null
      }
      if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || payload.nbf > nowSeconds + CLOCK_TOLERANCE_SECONDS)) {
        return null
      }
      if (payload.iss !== `https://${this.teamDomain}`) return null
      if (!audienceIncludes(payload.aud, this.audience)) return null
      if (typeof payload.email !== 'string') return null

      const email = payload.email.trim().toLowerCase()
      if (!this.allowedEmails.has(email)) return null

      const jwk = await this.findSigningKey(header.kid)
      if (!jwk) return null

      const publicKey = createPublicKey({ key: jwk, format: 'jwk' })
      const validSignature = verifySignature(
        'RSA-SHA256',
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        publicKey,
        Buffer.from(encodedSignature, 'base64url'),
      )
      return validSignature ? { email } : null
    } catch (error) {
      if (error instanceof CloudflareAccessJwksUnavailableError) throw error
      return null
    }
  }

  private async findSigningKey(kid: string) {
    const find = (value?: CloudflareJwks) => value?.keys.find(candidate => candidate.kid === kid && candidate.kty === 'RSA')
    const cached = this.cachedJwks
    const key = find(cached?.value)
    if (key && cached!.expiresAt > this.now()) return key
    try {
      return find(await this.refreshJwks())
    } catch (error) {
      if (key && this.now() - cached!.expiresAt <= MAX_JWKS_STALE_MS) return key
      throw error
    }
  }

  private refreshJwks() {
    if (!this.refreshing) {
      this.refreshing = Promise.resolve().then(() => this.fetchJwks()).then(value => {
        if (!Array.isArray(value?.keys) || !value.keys.some(key => key?.kty === 'RSA' && key.kid && key.n && key.e)) {
          throw new Error('INVALID_CLOUDFLARE_JWKS')
        }
        this.cachedJwks = { value, expiresAt: this.now() + this.jwksCacheTtlMs }
        return value
      }).catch(error => {
        throw new CloudflareAccessJwksUnavailableError(error)
      }).finally(() => { this.refreshing = undefined })
    }
    return this.refreshing
  }
}

function normalizeTeamDomain(value: string) {
  return value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '')
}

function decodeJson<T>(encoded: string): T {
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T
}

function audienceIncludes(value: unknown, expected: string) {
  if (typeof value === 'string') return value === expected
  return Array.isArray(value) && value.some((item) => item === expected)
}

async function fetchCloudflareJwks(teamDomain: string): Promise<CloudflareJwks> {
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(8_000) })
  if (!response.ok) {
    throw new Error(`CLOUDFLARE_JWKS_FETCH_FAILED:${response.status}`)
  }
  return response.json() as Promise<CloudflareJwks>
}
