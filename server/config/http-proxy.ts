import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

const loopback = '127.0.0.1,localhost,[::1]'

export function configureHttpProxy(env: NodeJS.ProcessEnv = process.env, log = console.log) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') delete env.NODE_TLS_REJECT_UNAUTHORIZED

  const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY ?? httpsProxy
  if (!httpProxy && !httpsProxy) return

  const origins = new Set<string>()
  for (const value of [httpProxy, httpsProxy]) {
    if (!value) continue
    const url = URL.parse(value)
    if (!url || !['http:', 'https:'].includes(url.protocol)) throw new Error('HTTP 代理地址无效')
    origins.add(url.origin)
  }
  const configuredNoProxy = (env.no_proxy ?? env.NO_PROXY ?? '').split(/[,\s]+/)
  const noProxy = configuredNoProxy.includes('*') ? '*' : [
    loopback, ...configuredNoProxy,
  ].filter(Boolean).join(',')
  const agent = new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy })
  // Keep Node's fetch and FormData together; only change the transport.
  setGlobalDispatcher(agent)
  for (const origin of origins) log(`[proxy] 已启用 HTTP(S) 代理: ${origin}`)
  return agent
}
