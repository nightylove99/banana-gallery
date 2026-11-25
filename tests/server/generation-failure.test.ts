import {expect,it} from 'vitest'
import {describeImageGenerationFailure as describe,ImageGenerationResponseError,responseRetryDelay,safeGenerationDetail} from '../../server/ai/generation-failure'

it.each([
 [429,'Throttling.AllocationQuota','rate_limit',true],
 [429,'Throttling.RateQuota','rate_limit',true],
 [429,'insufficient_quota','quota',false],
 [503,'AuthenticationError','auth',false],
 [503,'InvalidParameter','invalid_input',false],
 [503,'DataInspectionFailed','blocked',false],
 [200,'SetLimitExceeded','quota',false],
 [200,'Throttling','rate_limit',true],
 [200,'InvalidApiKey','auth',false],
 [500,'InternalError','unavailable',false],
 [502,'','unavailable',false],
 [503,'','unavailable',false],
 [503,'Throttling','unavailable',false],
 [200,'ServiceUnavailable','unavailable',false],
 [200,'ServerOverloaded','unavailable',false],
 [529,'','unavailable',false],
 [504,'','network',false],
] as const)('classifies original status %s and code %s as %s', (status,providerCode,category,retryable)=>{
 const failure=describe(Object.assign(new Error('upstream failure'),{status,providerCode}))
 expect(failure).toMatchObject({category,retryable,httpStatus:status,...(providerCode?{providerCode}:{})})
})
it.each(['NO_IMAGE','IMAGE_OTHER'])('does not invent a policy refusal for %s',code=>{
 expect(describe(new ImageGenerationResponseError(code))).toMatchObject({category:'no_image',retryable:false,uncertain:false})
})
it('reads original quota details and retry delays from Google SDK errors',()=>{
 expect(describe(Object.assign(new Error(JSON.stringify({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'Quota exceeded',details:[{'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaId:'RequestsPerDay'}]}]}})),{status:429}))).toMatchObject({category:'quota',retryable:false})
 expect(describe(Object.assign(new Error('quota'),{status:429,details:[{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'180s'}]})).retryAfterMs).toBe(180000)
})
it('honors numeric and date retry-after values and ignores invalid values',()=>{
 expect(responseRetryDelay(new Response('',{headers:{'Retry-After':'120'}}))).toBe(120000)
 const delay=responseRetryDelay(new Response('',{headers:{'Retry-After':new Date(Date.now()+180000).toUTCString()}}))!
 expect(delay).toBeGreaterThan(178000)
 expect(delay).toBeLessThanOrEqual(180000)
 expect(responseRetryDelay(new Response('',{headers:{'Retry-After':'nonsense'}}))).toBeUndefined()
})
it('redacts credentials and URLs before persisting provider details',()=>{
 const detail=safeGenerationDetail('Authorization: Bearer secret-value api_key=other-secret api key=third-secret key=fourth-secret https://example.com/img?token=secret')
 expect(detail).not.toContain('secret-value');expect(detail).not.toContain('other-secret');expect(detail).not.toContain('third-secret');expect(detail).not.toContain('fourth-secret');expect(detail).not.toContain('example.com')
})
it('reads Retry-After headers from SDK errors',()=>{
 expect(describe(Object.assign(new Error('limited'),{status:429,headers:new Headers({'Retry-After':'180'})})).retryAfterMs).toBe(180000)
})

it('classifies an interrupted response body as network and deduplicates nested causes', () => {
  const socket = Object.assign(new Error('terminated'), { code: 'ECONNRESET' })
  const wrapped = Object.assign(new Error('terminated', { cause: socket }), { code: 'ECONNRESET' })
  expect(describe(new TypeError('terminated', { cause: wrapped }))).toMatchObject({
    category: 'network', uncertain: true, retryable: false, detail: 'terminated (ECONNRESET)',
  })
})

it('keeps sanitized network cause codes, names and messages within the detail limit', () => {
  const inner = Object.assign(new Error('headers timed out at https://example.test/?token=hidden key=private ' + 'x'.repeat(600)), {
    name: 'HeadersTimeoutError', code: 'UND_ERR_HEADERS_TIMEOUT',
  })
  const detail = describe(new TypeError('fetch failed', { cause: inner })).detail!
  expect(detail).toContain('UND_ERR_HEADERS_TIMEOUT')
  expect(detail).toContain('HeadersTimeoutError')
  expect(detail).toContain('headers timed out')
  expect(detail).not.toMatch(/example\.test|hidden|private/)
  expect(detail.length).toBeLessThanOrEqual(500)
})
