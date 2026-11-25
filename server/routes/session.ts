import { Router } from 'express'

import type { UserAuthMode } from '../config/env.js'

export function createSessionRouter(userAuthMode: UserAuthMode) {
  const router = Router()

  router.get('/api/session', (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Auth-Mode', userAuthMode)
    if (!req.authSession) {
      res.status(401).json({ error: 'UNAUTHORIZED', authMode: userAuthMode })
      return
    }

    res.json(req.authSession)
  })

  router.post('/api/logout', (_req, res) => {
    if (userAuthMode === 'cloudflare_access') {
      res.json({ logoutUrl: '/cdn-cgi/access/logout' })
      return
    }

    res.status(204).end()
  })

  return router
}
