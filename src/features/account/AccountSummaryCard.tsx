import type { AccountSummary } from '@/types'

interface AccountSummaryCardProps {
  account: AccountSummary
  onSignOut: () => Promise<void> | void
}

export function AccountSummaryCard({ account, onSignOut }: AccountSummaryCardProps) {
  const remote = account.runtimeMode === 'personal-remote'
  return (
    <section className="space-y-2 rounded-2xl border border-zinc-800 bg-[#0d0d14] p-5">
      <h2 className="text-sm font-semibold">个人自用</h2>
      <p className="text-sm text-zinc-400">
        {remote ? `远程访问 · ${account.user.email}` : '本机入口 · 图库、历史与素材由你自己管理'}
      </p>
      {remote && (
        <button onClick={() => void onSignOut()} className="text-sm text-indigo-300">重新验证远程访问</button>
      )}
    </section>
  )
}
