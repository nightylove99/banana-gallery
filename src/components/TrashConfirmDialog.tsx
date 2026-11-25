import { useRef } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

const button = 'rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-indigo-400'
const labels = {
  clear: { title: '清空回收站', confirm: '确认清空' },
  purge: { title: '永久删除', confirm: '确认永久删除' },
  retry: { title: '重试清理', confirm: '确认重试清理' },
}

export function TrashConfirmDialog({ kind, count, onCancel, onConfirm, returnFocus }: {
  kind: keyof typeof labels
  count: number
  onCancel: () => void
  onConfirm: () => void
  returnFocus: () => void
}) {
  const cancel = useRef<HTMLButtonElement>(null)
  const { title, confirm } = labels[kind]
  return <Dialog open onOpenChange={open => { if (!open) onCancel() }}>
    <DialogContent hideClose
      className="z-[60] w-[calc(100%-2rem)] max-w-sm rounded-xl border-[#34384f] bg-[#15151f] text-zinc-200"
      onOpenAutoFocus={event => { event.preventDefault(); cancel.current?.focus() }}
      onCloseAutoFocus={event => { event.preventDefault(); returnFocus() }}>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription className="leading-relaxed text-zinc-400">
        {kind === 'retry' ? `继续永久清理 ${count} 项？` : `永久删除 ${count} 项？`}清理后无法在图库内恢复。
      </DialogDescription>
      <div className="flex justify-end gap-2">
        <button ref={cancel} type="button" className={cn(button, 'bg-white/5 hover:bg-white/10')} onClick={onCancel}>取消</button>
        <button type="button" className={cn(button, 'bg-rose-500/20 text-rose-200 hover:bg-rose-500/30')} onClick={onConfirm}>{confirm}</button>
      </div>
    </DialogContent>
  </Dialog>
}
