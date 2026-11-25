import { useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { toast } from 'sonner'
import { imageAssetUrl, referenceAssetUrl } from '@/api'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { TrashMediaPlaceholder, trashItemTitle } from './TrashCard'
import type { TrashItem } from '@/types'

const button = 'rounded-lg px-2.5 py-1.5 text-xs font-medium hover:bg-white/10 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-indigo-400'
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long', timeStyle: 'long' })

function Original({ item }: { item: TrashItem }) {
  const [failed, setFailed] = useState(false)
  if (item.purgePending || item.originalMissing || failed) return <TrashMediaPlaceholder pending={item.purgePending} />
  return <img src={imageAssetUrl(encodeURIComponent(item.filename))} alt={trashItemTitle(item)}
    decoding="async" onError={() => setFailed(true)} className="h-full w-full object-contain" />
}

export function TrashPreviewModal({ item, index, total, busy, confirming, actionsDisabled, feedback, onClose, onNavigate, onRestore, onPurge, returnFocus }: {
  item: TrashItem
  index: number
  total: number
  busy: boolean
  confirming: boolean
  actionsDisabled: boolean
  feedback: ReactNode
  onClose: () => void
  onNavigate: (step: -1 | 1) => void
  onRestore: () => void
  onPurge: (opener: HTMLButtonElement) => void
  returnFocus: () => void
}) {
  const closeButton = useRef<HTMLButtonElement>(null)
  const blocked = busy || confirming
  const date = Date.parse(item.deletedAt)
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(item.prompt)
      toast.success('已复制提示词')
    } catch {
      toast.error('无法复制，请手动选择提示词')
    }
  }

  return <Dialog open onOpenChange={open => { if (!open && !blocked) onClose() }}>
    <DialogContent hideClose
      onOpenAutoFocus={event => { event.preventDefault(); closeButton.current?.focus() }}
      onCloseAutoFocus={event => { event.preventDefault(); returnFocus() }}
      onEscapeKeyDown={event => { if (blocked) event.preventDefault() }}
      onKeyDown={event => {
        if (event.defaultPrevented || blocked || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          onNavigate(event.key === 'ArrowLeft' ? -1 : 1)
        }
      }}
      className="flex max-h-[92dvh] w-[calc(100%-1rem)] max-w-6xl flex-col gap-0 overflow-hidden rounded-2xl border-[#292d42] bg-[#101018] p-0 text-zinc-200">
      <header className="flex shrink-0 items-center gap-2 border-b border-[#25293d] px-3 py-2 sm:px-4">
        <button ref={closeButton} type="button" aria-label="关闭预览" aria-disabled={blocked} onClick={() => { if (!blocked) onClose() }} className={button}>
          <X size={18} aria-hidden="true" />
        </button>
        <DialogTitle className="min-w-0 flex-1 truncate text-sm">{trashItemTitle(item)}</DialogTitle>
        <DialogDescription className="sr-only">回收站条目只读预览</DialogDescription>
        <button type="button" aria-label="上一项" disabled={blocked || index === 0} onClick={() => onNavigate(-1)} className={button}><ChevronLeft size={18} aria-hidden="true" /></button>
        <span className="shrink-0 text-xs tabular-nums text-zinc-400">{index + 1} / {total}</span>
        <button type="button" aria-label="下一项" disabled={blocked || index === total - 1} onClick={() => onNavigate(1)} className={button}><ChevronRight size={18} aria-hidden="true" /></button>
      </header>
      <div className="min-h-0 overflow-y-auto overscroll-contain md:grid md:grid-cols-[minmax(0,2fr)_minmax(17rem,1fr)] md:overflow-hidden">
        <div className="h-[45dvh] min-h-36 bg-[#08080f] md:h-[70dvh]">
          <Original key={JSON.stringify([item.id, item.version, item.thumbnailVersion])} item={item} />
        </div>
        <aside key={item.id} className="min-w-0 space-y-4 p-4 md:overflow-y-auto">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-zinc-400">类型</dt><dd>{item.assetType === 'work' ? '作品' : '配方'}</dd>
            <dt className="text-zinc-400">尺寸</dt><dd>{item.width > 0 && item.height > 0 ? `${item.width} × ${item.height}` : '未知'}</dd>
            <dt className="text-zinc-400">标题</dt><dd className="break-words">{item.title?.trim() || item.generation?.title?.trim() || '未命名'}</dd>
            <dt className="text-zinc-400">移入时间</dt><dd>{Number.isFinite(date) ? <time dateTime={item.deletedAt}>{dateFormatter.format(date)}</time> : '日期未知'}</dd>
          </dl>
          <section>
            <div className="mb-1 flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">提示词</h3>
              <button type="button" disabled={!item.prompt || blocked} onClick={() => void copyPrompt()} className={`${button} text-indigo-200`}>复制提示词</button>
            </div>
            <p className="whitespace-pre-wrap break-words rounded-lg bg-white/5 p-3 text-sm leading-relaxed text-zinc-300">{item.prompt || '无提示词'}</p>
          </section>
          {!item.purgePending && !!item.referenceImages.length && <section>
            <h3 className="mb-2 text-sm font-medium">参考图</h3>
            <ul className="grid grid-cols-3 gap-2">
              {item.referenceImages.map((filename, refIndex) => <li key={refIndex} className="min-w-0">
                <img src={referenceAssetUrl(encodeURIComponent(filename))} alt={`参考图 ${refIndex + 1}`} loading="lazy" decoding="async"
                  className="aspect-square w-full rounded-lg bg-[#08080f] object-contain" />
                {item.referenceNotes?.[refIndex] && <p className="mt-1 break-words text-xs text-zinc-400">{item.referenceNotes[refIndex]}</p>}
              </li>)}
            </ul>
          </section>}
        </aside>
      </div>
      <footer className="shrink-0 space-y-2 border-t border-[#25293d] px-3 py-2 sm:px-4">
        {feedback}
        <div className="flex flex-wrap justify-end gap-2">
          {!item.purgePending && <button type="button" disabled={blocked || actionsDisabled} onClick={onRestore} className={`${button} bg-indigo-500/15 text-indigo-200`}>恢复到图库</button>}
          <button type="button" disabled={blocked || actionsDisabled} onClick={event => onPurge(event.currentTarget)} className={`${button} text-rose-200`}>
            {item.purgePending ? '重试清理' : '永久删除'}
          </button>
        </div>
      </footer>
    </DialogContent>
  </Dialog>
}
