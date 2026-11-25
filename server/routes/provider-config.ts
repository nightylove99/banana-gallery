import express, { type Request, type RequestHandler } from 'express'
import { ProviderConfigError, SERVICE_ACCOUNT_MAX_BYTES, type ProviderConfig } from '../personal/provider-config.ts'
import type { ProviderConfigStatus } from '../../src/types'

export function createProviderConfigRouter(options: {
  store: ProviderConfig
  canManage: (req: Request) => boolean
  status: () => Omit<ProviderConfigStatus, 'canManage'>
  refresh: () => void
}) {
  const router = express.Router()
  router.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store')
    if (req.authKind === 'agent') return res.status(403).json({ error: 'Agent 不能访问生图凭据' })
    if (!req.authSession) return res.status(401).json({ error: 'UNAUTHORIZED' })
    if (req.method !== 'GET' && req.method !== 'HEAD' && !options.canManage(req)) {
      return res.status(403).json({ error: '请在本机入口修改生图凭据' })
    }
    next()
  })

  const sendStatus: RequestHandler = (req, res) => {
    res.json({ ...options.status(), canManage: options.canManage(req) })
  }
  function save(write: (body: unknown) => void): RequestHandler {
    return (req, res, next) => {
      if (!req.is('application/json')) return res.status(415).json({ error: '请以 JSON 格式提交生图凭据' })
      try {
        write(req.body)
        options.refresh()
        sendStatus(req, res, next)
      } catch (error) {
        if (error instanceof ProviderConfigError) return res.status(400).json({ error: error.message })
        res.status(500).json({ error: '无法保存本机生图凭据' })
      }
    }
  }

  router.get('/', sendStatus)
  router.put('/', express.json({ limit: '32kb' }), save(body => options.store.update(body)))
  router.post('/service-account', express.json({ limit: SERVICE_ACCOUNT_MAX_BYTES }), save(body => options.store.upload(body)))
  // Never delegate malformed JSON to Express's default error logger.
  // Express recognizes error handlers by their four-argument signature.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleParseError: express.ErrorRequestHandler = (error, _req, res, _next) => {
    const tooLarge = error.status === 413
    res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? '文件或凭据超过大小限制' : '无法解析 JSON，请检查文件格式',
    })
  }
  router.use(handleParseError)
  return router
}
