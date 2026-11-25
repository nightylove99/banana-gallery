import { RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react'

export function SessionRecoveryPage({ cloudflareAccess, connectionError }: { cloudflareAccess: boolean; connectionError?: string | null }) {
  const needsAccessLogin = cloudflareAccess && !connectionError
  const title = needsAccessLogin
    ? '需要重新验证 Cloudflare Access'
    : '暂时无法确认登录状态'
  const description = needsAccessLogin
    ? '当前访问凭据已经失效。重新连接后会由 Cloudflare 完成身份验证。'
    : connectionError ?? '登录状态校验没有成功。请重新连接；如果仍然失败，请检查网络和服务状态。'
  const Icon = needsAccessLogin ? ShieldCheck : TriangleAlert

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0a0a10] px-6 text-zinc-100">
      <div className="w-full max-w-md rounded-3xl border border-[#1E2336] bg-[#0d0d14] p-8 text-center shadow-2xl shadow-black/30">
        <div className="mx-auto mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-600/15 text-indigo-300">
          <Icon size={20} />
        </div>
        <h1 className="text-2xl font-semibold text-white">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-500">{description}</p>
        <button
          type="button"
          onClick={() => needsAccessLogin ? window.location.assign('/cdn-cgi/access/logout') : window.location.reload()}
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-indigo-500"
        >
          <RefreshCw size={16} />
          {needsAccessLogin ? '重新通过 Cloudflare 验证' : '重新连接'}
        </button>
      </div>
    </div>
  )
}
