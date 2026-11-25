import type { ReactElement } from 'react'

import { useSession } from './useSession'
import { SessionRecoveryPage } from './SessionRecoveryPage'

export function RequireAuth({ children }: { children: ReactElement }) {
  const { session, loading, authMode, error } = useSession()

  if (loading && !session) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#0a0a10] text-zinc-500">
        正在校验登录状态…
      </div>
    )
  }

  if (!session) {
    return <SessionRecoveryPage connectionError={error} cloudflareAccess={authMode === 'cloudflare_access'} />
  }

  return children
}
