import { useRef, useState } from 'react'
import { Sidebar } from '@/components/Sidebar'
import { TrashCard } from '@/components/TrashCard'
import { TrashConfirmDialog } from '@/components/TrashConfirmDialog'
import { TrashPreviewModal } from '@/components/TrashPreviewModal'
import { TrashSelectionBar } from '@/components/TrashSelectionBar'
import { useGallery } from '@/hooks/useGallery'
import { useTrash, type TrashTarget } from '@/hooks/useTrash'
import { cn } from '@/lib/utils'
import type { TrashItem } from '@/types'

const button = 'rounded-lg px-2.5 py-1.5 text-xs font-medium whitespace-nowrap hover:bg-white/5 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-indigo-400'
const snapshot = (items: readonly TrashItem[]): TrashTarget[] => items.map(({ id, version }) => ({ id, version }))

interface Confirmation {
  kind: 'clear' | 'purge' | 'retry'
  targets: TrashTarget[]
}

export default function TrashPage() {
  const gallery = useGallery()
  const { items, loading, readError, actionError, status, busy, reload, run } = useTrash()
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirmation | null>(null)
  const previewOpener = useRef<HTMLButtonElement | null>(null)
  const confirmOpener = useRef<HTMLButtonElement | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const selectButton = useRef<HTMLButtonElement>(null)

  const previewIndex = items.findIndex(item => item.id === previewId)
  const preview = items[previewIndex]
  const pending = items.filter(item => item.purgePending)
  const recoverable = items.filter(item => !item.purgePending)
  const selectedItems = items.filter(item => selected.has(item.id))
  const recoverableSelection = selectedItems.filter(item => !item.purgePending)
  const disabled = loading || busy || !!readError

  const exitSelection = () => {
    setSelected(new Set())
    setSelecting(false)
    selectButton.current?.focus()
  }
  const toggleSelected = (id: string) => setSelected(previous => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const afterSuccess = (id: string) => {
    setSelected(previous => {
      if (!previous.has(id)) return previous
      const next = new Set(previous)
      next.delete(id)
      return next
    })
    if (id === previewId) setPreviewId((items[previewIndex + 1] ?? items[previewIndex - 1])?.id ?? null)
  }
  const restore = (targets: TrashItem[]) => void run('restore', snapshot(targets), afterSuccess)
  const requestPurge = (kind: Confirmation['kind'], targets: TrashItem[], opener: HTMLButtonElement) => {
    confirmOpener.current = opener
    setConfirm({ kind, targets: snapshot(targets) })
  }
  const purgeOne = (item: TrashItem, opener: HTMLButtonElement) =>
    requestPurge(item.purgePending ? 'retry' : 'purge', [item], opener)

  const feedback = <>
    {status && <p role="status" className="text-xs text-indigo-200">{status}</p>}
    {actionError && <p role="alert" className="text-xs text-rose-200">{actionError}</p>}
    {readError && <div className="flex flex-wrap items-center gap-2 text-xs text-rose-200">
      <p role="alert">{readError}</p>
      <button type="button" disabled={busy} onClick={() => void reload()} className={cn(button, 'underline')}>重试读取</button>
    </div>}
  </>

  return <div className="dark flex h-dvh w-screen overflow-hidden bg-[#0a0a10] text-zinc-200">
    <Sidebar currentPage="trash" assetType={gallery.assetType} filter={gallery.filter}
      onAssetTypeChange={gallery.setAssetType} onFilterChange={gallery.setFilter} tags={gallery.tags}
      workCount={gallery.workCount} recipeCount={gallery.recipeCount} favoriteCount={gallery.favoriteCount} />
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[#1e2336] px-3 py-3 sm:px-5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <h1 ref={heading} tabIndex={-1} className="text-sm font-semibold text-white">回收站</h1>
          <span className="text-xs tabular-nums text-zinc-400">{items.length} 项</span>
          <p className="text-xs text-zinc-400">不会自动清空，永久删除后无法在图库内恢复</p>
        </div>
        <div className="flex items-center gap-1">
          <button ref={selectButton} type="button" disabled={disabled || (!selecting && !items.length)}
            onClick={() => selecting ? exitSelection() : setSelecting(true)} className={button}>{selecting ? '退出多选' : '选择'}</button>
          <button type="button" disabled={disabled || !recoverable.length} onClick={() => restore(recoverable)} className={cn(button, 'text-indigo-200')}>全部恢复</button>
          <button type="button" disabled={disabled || !items.length} onClick={event => requestPurge('clear', items, event.currentTarget)}
            className={cn(button, 'text-rose-200')}>清空回收站</button>
        </div>
      </header>
      {!!pending.length && <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 border-b border-amber-300/15 bg-amber-400/5 px-3 py-1.5 text-xs text-amber-200 sm:px-5">
        <p>{pending.length} 项永久清理未完成，不可恢复。</p>
        <button type="button" disabled={disabled} onClick={event => requestPurge('retry', pending, event.currentTarget)} className={button}>重试清理</button>
      </div>}
      {!preview && (status || actionError || readError) && <div className="shrink-0 space-y-1 border-b border-[#1e2336] px-3 py-2 sm:px-5">{feedback}</div>}
      <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-5', selecting && 'pb-28 sm:pb-20')}>
        {loading && !items.length ? <p role="status" className="py-12 text-center text-sm text-zinc-400">正在读取回收站…</p>
          : !items.length && !readError ? <p className="py-12 text-center text-sm text-zinc-400">回收站是空的</p>
          : <ul aria-label="回收站条目" className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
            {items.map(item => <TrashCard key={item.id} item={item} selecting={selecting} selected={selected.has(item.id)} disabled={disabled}
              onOpen={opener => { previewOpener.current = opener; setPreviewId(item.id) }}
              onSelect={() => toggleSelected(item.id)} onRestore={() => restore([item])}
              onPurge={opener => purgeOne(item, opener)} />)}
          </ul>}
      </div>
      {selecting && <TrashSelectionBar count={selectedItems.length} total={items.length} restorable={recoverableSelection.length} disabled={disabled}
        onSelectAll={() => setSelected(new Set(items.map(item => item.id)))} onRestore={() => restore(recoverableSelection)}
        onPurge={opener => requestPurge('purge', selectedItems, opener)} onExit={exitSelection} />}
    </main>
    {preview && <TrashPreviewModal item={preview} index={previewIndex} total={items.length} busy={busy} confirming={!!confirm} actionsDisabled={disabled}
      feedback={feedback} onClose={() => setPreviewId(null)}
      onNavigate={step => { const next = items[previewIndex + step]; if (next) setPreviewId(next.id) }}
      onRestore={() => restore([preview])}
      onPurge={opener => purgeOne(preview, opener)}
      returnFocus={() => (previewOpener.current?.isConnected ? previewOpener.current : heading.current)?.focus({ preventScroll: true })} />}
    {confirm && <TrashConfirmDialog kind={confirm.kind} count={confirm.targets.length} onCancel={() => setConfirm(null)}
      onConfirm={() => { setConfirm(null); void run('purge', confirm.targets, afterSuccess) }}
      returnFocus={() => {
        const opener = confirmOpener.current
        if (opener?.isConnected && !opener.disabled) opener.focus({ preventScroll: true })
        else if (!preview) heading.current?.focus({ preventScroll: true })
      }} />}
  </div>
}
