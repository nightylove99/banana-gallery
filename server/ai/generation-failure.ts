import type { GenerationFailure, GenerationResponseEvidence } from '../../src/types.ts'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}

export function safeGenerationDetail(value: string): string {
  return value.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer ***')
    .replace(/((?:(?:api[_ -]?)?key|token|secret|authorization)["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi, '$1***')
    .replace(/https?:\/\/[^\s"<>]+/gi, '[服务地址]')
    .slice(0, 500)
}

export function imageResponseDetail(body: unknown): string {
  return safeGenerationDetail(typeof body === 'string' ? body : JSON.stringify(body) ?? '')
}

export function responseRetryDelay(response: Response): number | undefined {
  const value = response.headers.get('retry-after')
  if (!value) return undefined
  const delay = /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay >= 0 ? delay : undefined
}

export class ImageGenerationResponseError extends Error {
  readonly phase = 'response'
  readonly status = 200
  readonly providerCode: string
  readonly providerMessage: string
  readonly requestId?: string
  readonly responseEvidence?: GenerationResponseEvidence
  constructor(providerCode: string, providerMessage = '', requestId?: string, responseEvidence?: GenerationResponseEvidence) {
    super(`${providerCode}: ${providerMessage || '未返回图片，原因未说明'}`)
    this.providerCode = providerCode
    this.providerMessage = providerMessage
    this.requestId = requestId
    this.responseEvidence = responseEvidence
  }
}

export async function retrieveGeneratedImage<T>(download: () => Promise<T>): Promise<T> {
  try { return await download() } catch (cause) {
    throw Object.assign(cause instanceof Error ? cause : new Error('图片结果取回失败'), { phase: 'download' })
  }
}

function networkCauseDetails(error: unknown, message: string): string[] {
  const seen = new Set([error])
  const parts: string[] = []
  const known = [safeGenerationDetail(message).toLowerCase()]
  for (let cause = record(error).cause; cause && !seen.has(cause); cause = record(cause).cause) {
    seen.add(cause)
    const { code, name, message: causeMessage } = record(cause)
    for (const value of [code, name, typeof cause === 'string' ? cause : causeMessage]) {
      if (typeof value !== 'string' || /^(?:Error|TypeError)$/i.test(value)) continue
      const detail = safeGenerationDetail(value.trim())
      const normalized = detail.toLowerCase()
      if (!detail || known.some(existing => existing.includes(normalized))) continue
      known.push(normalized)
      parts.push(detail)
    }
  }
  return parts
}

export function describeImageGenerationFailure(error: unknown): GenerationFailure {
  const outer = record(error)
  const originalMessage = error instanceof Error ? error.message : '服务未提供错误详情'
  let body: Record<string, unknown> = {}
  try { body = record(JSON.parse(originalMessage)) } catch { /* SDKs may return plain text. */ }
  const sdkBody = record(outer.error)
  const parsed = Object.keys(body).length ? body : sdkBody
  const nested = Object.keys(record(parsed.error)).length ? record(parsed.error) : parsed
  const statusValue = outer.status ?? outer.statusCode ?? nested.code ?? outer.code
  const httpStatus = typeof statusValue === 'number' ? statusValue : /^\d{3}$/.test(String(statusValue)) ? Number(statusValue) : undefined
  const providerCode = String(outer.providerCode ?? nested.status ?? (typeof nested.code === 'string' ? nested.code : nested.type) ?? (typeof outer.code === 'string' ? outer.code : ''))
  const message = String(outer.providerMessage ?? nested.message ?? originalMessage)
  const details = outer.details ?? nested.details
  let serializedDetails = ''
  try { serializedDetails = JSON.stringify(details ?? '') } catch { /* Invalid diagnostics must not prevent settlement. */ }
  const evidence = `${providerCode} ${message} ${serializedDetails}`
  const causeDetails = networkCauseDetails(error, message)
  let category: GenerationFailure['category'] = 'unknown'
  let explanation = '生成失败，服务未说明具体原因'
  let retryable = false
  let uncertain = !(httpStatus && httpStatus < 500)
  if (outer.phase === 'download' || /IMAGE_DOWNLOAD_FAILED|DASHSCOPE_EMPTY_IMAGE|UNTRUSTED_IMAGE_URL|INVALID_IMAGE_DATA_URL/.test(evidence)) {
    category = 'download'; explanation = '图片结果取回失败，未重新提交生成'
  } else if (/IMAGE_NOT_FOUND|IMAGE_PAYLOAD_MISSING|EMPTY_IMAGE|NO_IMAGE|IMAGE_OTHER/.test(evidence) || outer.phase === 'response' && !/SAFETY|PROHIBITED|RECITATION|BLOCKLIST|SPII/.test(providerCode)) {
    category = 'no_image'; explanation = '未返回图片，原因未说明'; uncertain = false
  } else if (/SAFETY|PROHIBITED_CONTENT|RECITATION|BLOCKLIST|SPII|DataInspectionFailed|data_inspection_failed|SensitiveContentDetected|(?:Input|Output)(?:Text|Image)RiskDetection|content_policy_violation|content_filter|ContentFilter|ResponsibleAIPolicyViolation|blocked for potentially violating safety policies/i.test(evidence)) {
    category = 'blocked'; explanation = '本次生成被服务的内容策略拦截，请调整提示词或参考图'; uncertain = false
  } else if ((/SetLimitExceeded|per[ _-]?day|daily.{0,30}(?:quota|limit)|(?:quota|limit).{0,30}daily|insufficient_credits|insufficient_balance|billing_hard_limit_reached|insufficient_quota|ServiceOverdue|Arrearage|AccountOverdue|balance.{0,20}(?:insufficient|depleted)|余额不足|每日.{0,10}(?:额度|限额)/i.test(evidence) && !/Throttling\.AllocationQuota/i.test(providerCode)) || httpStatus === 402) {
    category = 'quota'; explanation = '额度或余额不足，请检查账户额度、账单或等待额度恢复'; uncertain = false
  } else if (httpStatus === 401 || httpStatus === 403 || /API_KEY_INVALID|InvalidApiKey|InvalidAccessKey|Unauthorized|AccessDenied|AuthenticationError|_NOT_CONFIGURED|UnavailableError/i.test(`${evidence} ${outer.name}`)) {
    category = 'auth'; explanation = '模型凭据、权限或配置不可用，请检查设置后再生成'; uncertain = false
  } else if (/ValidationError/.test(String(outer.name)) || /InvalidParameter|INVALID_ARGUMENT|invalid_request_error|BadRequest/.test(providerCode) || [400, 404, 413, 422].includes(httpStatus ?? 0)) {
    category = 'invalid_input'; explanation = '请求参数、模型或参考图不符合服务要求，请调整后再生成'; uncertain = false
  } else if (httpStatus === 429 || (httpStatus === undefined || httpStatus < 500) && /Throttling|rate_limit_exceeded|TooManyRequests/i.test(providerCode)) {
    category = 'rate_limit'; explanation = '请求频率或资源用量受限'; retryable = true; uncertain = false
  } else if ([500, 502, 503, 529].includes(httpStatus ?? 0) || /^(InternalError|ServiceUnavailable|ServerOverloaded)$/.test(providerCode)) {
    category = 'unavailable'; explanation = '生成服务暂时故障或繁忙'; uncertain = true
  } else if ([408, 504].includes(httpStatus ?? 0) || /timeout|timed out|fetch failed|network|ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|socket|aborted|UND_ERR|\bterminated\b/i.test(`${evidence} ${causeDetails.join(' ')}`)) {
    category = 'network'; explanation = '请求超时或连接中断，无法确认生成结果；未重新提交生成'; uncertain = true
  } else if (httpStatus && httpStatus >= 500) {
    category = 'unavailable'; explanation = '生成服务暂时故障或繁忙'; uncertain = true
  }
  let headerDelay: number | undefined
  const headers = outer.headers
  if (headers && typeof headers === 'object') {
    try { headerDelay = responseRetryDelay({ headers: new Headers(headers as ConstructorParameters<typeof Headers>[0]) } as Response) } catch { /* malformed SDK headers */ }
  }
  let retryAfterMs = typeof outer.retryAfterMs === 'number' ? outer.retryAfterMs : undefined
  if (Array.isArray(details)) for (const detail of details) {
    const info = record(detail)
    if (String(info['@type']).endsWith('google.rpc.RetryInfo')) {
      const duration = String(info.retryDelay ?? '').match(/^(\d+(?:\.\d+)?)s$/)
      if (duration) retryAfterMs = Math.max(retryAfterMs ?? 0, Number(duration[1]) * 1000)
    }
  }
  if (headerDelay !== undefined) retryAfterMs = Math.max(retryAfterMs ?? 0, headerDelay)
  const causeSuffix = category === 'network' && causeDetails.length ? ` (${causeDetails.join('; ').slice(0, 300)})` : ''
  return {
    ...(error instanceof ImageGenerationResponseError && error.responseEvidence ? { responseEvidence: error.responseEvidence } : {}),
    category, message: explanation, retryable, uncertain,
    ...(httpStatus ? { httpStatus } : {}),
    ...(providerCode ? { providerCode: safeGenerationDetail(providerCode) } : {}),
    ...(typeof (outer.requestId ?? nested.requestId) === 'string' ? { requestId: safeGenerationDetail(String(outer.requestId ?? nested.requestId)) } : {}),
    detail: safeGenerationDetail(message).slice(0, 500 - causeSuffix.length) + causeSuffix,
    ...(Number.isFinite(retryAfterMs) && retryAfterMs! >= 0 ? { retryAfterMs } : {}),
  }
}
