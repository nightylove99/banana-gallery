/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { fetchSession, logoutSession } from '@/api'
import type { AppSession, UserAuthMode } from '@/types'
import { activateThumbnailSession, clearThumbnailSession, thumbnailSessionTabId } from '@/lib/thumbnail-loader'

interface SessionContextValue {
  session: AppSession | null
  loading: boolean
  authMode: UserAuthMode | null
  error: string | null
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AppSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [authMode, setAuthMode] = useState<UserAuthMode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)

  const refresh = useCallback(async () => {
    const epoch = ++request.current
    setLoading(true)
    setError(null)
    try {
      const result = await fetchSession()
      if (epoch !== request.current) return
      if (result.session) await activateThumbnailSession(result.authMode || 'cloudflare_access', result.session)
      else await clearThumbnailSession()
      if (epoch !== request.current) return
      setSession(result.session)
      setAuthMode(result.authMode)
    } catch (cause) {
      if (epoch !== request.current) return
      setError(cause instanceof Error ? cause.message : '获取登录状态失败')
    } finally {
      if (epoch === request.current) setLoading(false)
    }
  }, [])

  const signOut = useCallback(async () => {
    const { logoutUrl } = await logoutSession()
    await clearThumbnailSession()
    request.current++; setSession(null)
    if (logoutUrl) {
      window.location.assign(logoutUrl)
      return
    }
    await refresh()
  }, [refresh])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const invalidate = (broadcast: boolean) => {
      request.current++; setSession(null); setLoading(false); setError(null)
      void clearThumbnailSession(broadcast)
    }
    const expired = () => invalidate(true)
    const storage = (event: StorageEvent) => { if (event.key === 'banana-thumbnail-session-reset' && event.newValue) invalidate(false) }
    let channel: BroadcastChannel | undefined
    try { channel = new BroadcastChannel('banana-thumbnail-session'); channel.onmessage = event => { if (event.data?.type === 'clear' && event.data?.source !== thumbnailSessionTabId) invalidate(false) } } catch { /* Storage events remain available. */ }
    window.addEventListener('banana-session-expired', expired)
    window.addEventListener('storage', storage)
    return () => { window.removeEventListener('banana-session-expired', expired); window.removeEventListener('storage', storage); channel?.close() }
  }, [])

  const value = useMemo(() => ({
    session,
    loading,
    authMode,
    error,
    refresh,
    signOut,
  }), [authMode, error, loading, refresh, session, signOut])

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSession() {
  const context = useContext(SessionContext)
  if (!context) {
    throw new Error('useSession 必须在 SessionProvider 内使用')
  }
  return context
}
