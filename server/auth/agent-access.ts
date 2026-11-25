import type { RequestHandler } from 'express'

// Fail closed for Agent credentials, including routes added later. The legacy
// paths here are only those needed by existing CLI/asset consumers.
const readRoutes = [
  /^\/api\/(?:session|account\/summary|generation\/models|images)\/?$/i,
  /^\/api\/gallery\/works\/by-code\/[^/]+\/context\/?$/i,
  /^\/api\/assets\/(?:images|references)\/[^/]+\/?$/i,
  /^\/api\/(?:generation-tasks|v1\/tasks)(?:\/(?:by-key\/)?[^/]+)?\/?$/i,
  /^\/api\/v1\/(?:models|works|recipes|works\/[^/]+\/context)\/?$/i,
]
const writeRoutes = [
  /^\/api\/(?:generation-tasks|references\/upload|v1\/(?:tasks|references\/upload|recipes))\/?$/i,
]

export const enforceAgentAccess: RequestHandler = (req, res, next) => {
  if (req.authKind !== 'agent') return next()
  res.set('Cache-Control', 'private, no-store')
  const rules = req.method === 'GET' || req.method === 'HEAD' ? readRoutes : req.method === 'POST' ? writeRoutes : []
  if (rules.some(route => route.test(req.path))) return next()
  res.status(403).json({ error: 'This operation is not allowed for Agent tokens', code: 'AGENT_FORBIDDEN' })
}
