import { cn } from '@/lib/utils'

const button = 'h-8 rounded-lg px-2 text-xs font-medium whitespace-nowrap text-zinc-200 hover:bg-white/5 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-indigo-400'

export function TrashSelectionBar({ count, total, restorable, disabled, onSelectAll, onRestore, onPurge, onExit }: {
  count: number
  total: number
  restorable: number
  disabled: boolean
  onSelectAll: () => void
  onRestore: () => void
  onPurge: (opener: HTMLButtonElement) => void
  onExit: () => void
}) {
  return <div className="pointer-events-none absolute inset-x-0 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-30 flex justify-center px-2">
    <div role="group" aria-label="所选条目操作"
      className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1 rounded-2xl border border-[#34384f] bg-[#14141f]/95 p-1.5 shadow-xl shadow-black/45 backdrop-blur-md">
      <span className="px-2 text-xs font-medium tabular-nums text-indigo-200">已选 {count} 项</span>
      <button type="button" className={button} disabled={disabled || count === total} onClick={onSelectAll}>全选全部</button>
      <button type="button" className={cn(button, 'text-indigo-200')} disabled={disabled || !restorable} onClick={onRestore}>恢复所选</button>
      <button type="button" className={cn(button, 'text-rose-200')} disabled={disabled || !count} onClick={event => onPurge(event.currentTarget)}>永久删除所选</button>
      <button type="button" className={button} disabled={disabled} onClick={onExit}>退出多选</button>
    </div>
  </div>
}
