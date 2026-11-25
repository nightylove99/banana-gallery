import { assertLoopbackBind, type UserAuthMode } from './config/env.js'

interface RuntimeServer {
  closeIdleConnections?: () => void
  close: (callback?: (error?: Error) => void) => unknown
}

interface ListenableApp {
  listen: (port: number, host: string, callback?: (error?: Error) => void) => RuntimeServer
}

interface StartRuntimeListenersOptions {
  app: ListenableApp
  authMode: UserAuthMode
  localPort: number
  remoteAccessPort: number
  bindHost: string
  log?: (message: string) => void
}

export function startRuntimeListeners({
  app,
  authMode,
  localPort,
  remoteAccessPort,
  bindHost,
  log = console.log,
}: StartRuntimeListenersOptions) {
  assertLoopbackBind(authMode, bindHost)
  if (authMode === 'cloudflare_access' && localPort === remoteAccessPort) {
    throw new Error('REMOTE_ACCESS_PORT 不能与 PORT 相同')
  }

  // Use a literal loopback address even if the OS resolves localhost differently.
  const host = bindHost === 'localhost' ? '127.0.0.1' : bindHost
  const urlHost = host === '::1' ? '[::1]' : host
  const servers = [app.listen(localPort, host, (error) => {
    if (error) throw error
    log(`🍌 Banana Gallery local server running on http://${urlHost}:${localPort}`)
  })]

  if (authMode === 'cloudflare_access') {
    servers.push(app.listen(remoteAccessPort, host, (error) => {
      if (error) throw error
      log(`🔒 Banana Gallery remote origin running on http://${urlHost}:${remoteAccessPort}`)
    }))
  }

  return servers
}
