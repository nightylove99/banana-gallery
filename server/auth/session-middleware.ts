import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import type { AppSession } from '../../src/types.js'
import { CloudflareAccessJwksUnavailableError, type CloudflareAccessVerifier } from './cloudflare-access-verifier.js'

declare module 'express-serve-static-core' {
  interface Request {
    authSession?: AppSession | null
    authKind?: 'agent'
  }
}

export function createSessionAttacher(options: {
  agent?: { token: string; session: AppSession }
  localAuthSession?: AppSession
  cloudflareAccess?: {
    verifier: Pick<CloudflareAccessVerifier, 'verify'>
    localSession: AppSession
    localAccessPort: number
    remoteAccessPort: number
  }
}) {
  const agent = options.agent
  const digest = (token: string) => createHash('sha256').update(token).digest()
  const configuredDigest = agent && digest(agent.token)
  return async (req: Request, res: Response, next: NextFunction) => {
    const authorization = req.get('Authorization')
    if (authorization && /^Bearer(?:\s|$)/i.test(authorization)) {
      const token = /^Bearer[ \t]+([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization)?.[1]
      if (!token || !agent || !configuredDigest || !timingSafeEqual(digest(token), configuredDigest)) {
        res.set('Cache-Control', 'private, no-store').set('WWW-Authenticate', 'Bearer')
        res.status(401).json({ error: 'Invalid or unconfigured Agent token', code: 'INVALID_AGENT_TOKEN' })
        return
      }
      // Preserve the owner's resource scope, but never its interactive permissions.
      req.authSession = agent.session
      req.authKind = 'agent'
      next()
      return
    }

    if (options.localAuthSession) {
      req.authSession = options.localAuthSession
      next()
      return
    }

    if (options.cloudflareAccess) {
      const rawAssertion = req.headers['cf-access-jwt-assertion']
      const assertion = Array.isArray(rawAssertion) ? rawAssertion[0] : rawAssertion
      try {
        req.authSession = await resolveCloudflareAccessSession({
          listenerPort: req.socket.localPort,
          localAccessPort: options.cloudflareAccess.localAccessPort,
          remoteAccessPort: options.cloudflareAccess.remoteAccessPort,
          assertion,
          verifier: options.cloudflareAccess.verifier,
          localSession: options.cloudflareAccess.localSession,
        })
      } catch (error) {
        if (!(error instanceof CloudflareAccessJwksUnavailableError)) throw error
        res.status(503).json({ error: error.message, code: 'CLOUDFLARE_ACCESS_JWKS_UNAVAILABLE' })
        return
      }
      next()
      return
    }

    req.authSession = null
    next()
  }
}

export async function resolveCloudflareAccessSession(options: {
  listenerPort: number | undefined
  localAccessPort: number
  remoteAccessPort: number
  assertion: string | undefined
  verifier: Pick<CloudflareAccessVerifier, 'verify'>
  localSession: AppSession
}): Promise<AppSession | null> {
  if (options.listenerPort === options.localAccessPort) {
    return options.localSession
  }

  if (options.listenerPort !== options.remoteAccessPort) {
    return null
  }

  const identity = await options.verifier.verify(options.assertion)
  if (!identity) return null

  return {
    ...options.localSession,
    user: {
      ...options.localSession.user,
      email: identity.email,
    },
  }
}
