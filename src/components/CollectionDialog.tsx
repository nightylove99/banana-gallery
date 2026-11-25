import { useState } from 'react'
import { Check, Folder, Plus } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog'
import { createGroup, updateGroup, dissolveGroup } from '@/lib/organization'
import { assetTitle } from '@/lib/gallery-query'
import type { GalleryImage, ResultGroup, GalleryAssetType } from '@/types'

const inputClass = 'w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400 focus:outline-none'
const buttonClass = 'rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40'

export function CollectionDialog({ assetType, imageIds, groups: allGroups, onSaved, onClose, onRefresh, returnFocus }: {
  assetType: GalleryAssetType; imageIds: string[]; groups: ResultGroup[]; onSaved: (group: ResultGroup) => void
  onClose: () => void; onRefresh: () => Promise<void>; returnFocus?: () => void
}) {
  const groups = allGroups.filter(group => (group.assetType || 'recipe') === assetType)
  const adding = imageIds.length > 0
  const [creating, setCreating] = useState(!adding || groups.length === 0)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (group?: ResultGroup) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const saved = group
        ? await updateGroup(group, { imageIds: [...new Set([...group.imageIds, ...imageIds])] })
        : await createGroup(name.trim(), imageIds, assetType)
      onSaved(saved); onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存失败，请重试')
      // Refresh versions after a conflict; keep the selection and name for an explicit retry.
      try { await onRefresh() } catch { /* The inline error and retry remain available. */ }
    } finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent onCloseAutoFocus={returnFocus ? event => { event.preventDefault(); returnFocus() } : undefined} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') event.stopPropagation() }} hideClose={busy} className="max-h-[85dvh] overflow-y-auto border-zinc-800 bg-[#0d0d14] text-zinc-100">
      <DialogTitle>{adding ? '加入收藏夹' : '新建收藏夹'}</DialogTitle>
      <DialogDescription>{adding ? `已选择 ${imageIds.length} 张图片，点选下方收藏夹即可加入。` : '给一个系列起个名字，之后可以随时添加图片。'}</DialogDescription>
      {adding && groups.length > 0 && <div className="max-h-64 space-y-1 overflow-y-auto">
        {groups.map(group => {
          const included = imageIds.filter(id => group.imageIds.includes(id)).length
          const count = new Set([...group.imageIds, ...imageIds]).size
          const allIncluded = included === imageIds.length
          return <button key={group.id} type="button" disabled={busy || allIncluded || count > 500} onClick={() => void save(group)} className="flex w-full items-center justify-between gap-3 rounded-xl border border-transparent bg-zinc-900/60 px-3 py-2.5 text-left transition-colors hover:border-zinc-700 hover:bg-zinc-800/80 disabled:opacity-45">
            <span className="flex min-w-0 items-center gap-2.5">
              <Folder size={16} className="shrink-0 text-indigo-300" aria-hidden="true" />
              <span className="truncate text-sm font-medium text-zinc-100">{group.name}</span>
              <span className="shrink-0 text-xs tabular-nums text-zinc-500">{group.imageIds.length} 张</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 text-xs text-zinc-400">
              {allIncluded ? <><Check size={13} className="text-indigo-400" aria-hidden="true" />已加入</> : count > 500 ? '超过 500 张上限' : included ? '部分已加入' : '加入'}
            </span>
          </button>
        })}
      </div>}
      {adding && groups.length === 0 && <p className="text-xs text-zinc-500">当前还没有收藏夹，直接新建一个并加入。</p>}
      {creating ? (
        <form onSubmit={event => { event.preventDefault(); if (name.trim()) void save() }} className={adding && groups.length > 0 ? 'space-y-3 border-t border-zinc-800 pt-4' : 'space-y-3'}>
          <label className="block space-y-2 text-sm">
            <span className="text-zinc-300">{adding ? '新建收藏夹名称' : '收藏夹名称'}</span>
            <input autoFocus maxLength={100} disabled={busy} className={inputClass} value={name} onChange={event => setName(event.target.value)} placeholder="例如：地球系列、居家系列" />
          </label>
          {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={buttonClass} disabled={busy} onClick={() => { if (adding && groups.length > 0) { setCreating(false); setName(''); setError('') } else onClose() }}>取消</button>
            <button className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40" disabled={busy || !name.trim() || imageIds.length > 500}>{busy ? '保存中…' : adding ? '创建并加入' : '创建'}</button>
          </div>
        </form>
      ) : (
        <div className="space-y-3 border-t border-zinc-800 pt-3">
          {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
          <button type="button" disabled={busy || imageIds.length > 500} onClick={() => setCreating(true)} className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-700 px-3 py-2.5 text-sm text-indigo-300 transition-colors hover:border-indigo-400/60 hover:bg-indigo-500/10 disabled:opacity-40">
            <Plus size={15} aria-hidden="true" />新建收藏夹并加入
          </button>
          <div className="flex justify-end">
            <button type="button" className={buttonClass} disabled={busy} onClick={onClose}>取消</button>
          </div>
        </div>
      )}
    </DialogContent>
  </Dialog>
}

export function CollectionManager({ group, images, onSaved, onDeleted, onClose, onRefresh }: {
  group: ResultGroup; images: GalleryImage[]; onSaved: (group: ResultGroup) => void
  onDeleted: () => void; onClose: () => void; onRefresh: () => Promise<void>
}) {
  const [name, setName] = useState(group.name)
  const [coverId, setCoverId] = useState(group.coverId || '')
  const [bestId, setBestId] = useState(group.bestId || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const members = images.filter(image => group.imageIds.includes(image.id) && !image.deletedAt)
  const labelFor = (image: GalleryImage) => assetTitle(image) || image.prompt.slice(0, 30) || image.id
  const run = async (deleting = false) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      if (deleting) { await dissolveGroup(group); onDeleted() }
      else onSaved(await updateGroup(group, { name: name.trim(), coverId: coverId || null, bestId: bestId || null }))
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作失败')
      try { await onRefresh() } catch { /* Keep draft for retry. */ }
    } finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent hideClose={busy} className="max-h-[85dvh] overflow-y-auto border-zinc-800 bg-[#0d0d14] text-zinc-100">
      <DialogTitle>管理收藏夹</DialogTitle>
      <DialogDescription>修改「{group.name}」的名称和封面。删除收藏夹会保留所有图片。</DialogDescription>
      <form onSubmit={event => { event.preventDefault(); void run() }} className="space-y-4">
        <label className="block space-y-2 text-sm"><span>收藏夹名称</span><input className={inputClass} maxLength={100} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <label className="block space-y-2 text-sm"><span>收藏夹封面</span><select className={inputClass} value={coverId} disabled={busy} onChange={event => setCoverId(event.target.value)}><option value="">自动选择第一张可用图片</option>{coverId && !members.some(i => i.id === coverId) && <option value={coverId}>保留原封面（暂不可用）</option>}{members.map(image => <option key={image.id} value={image.id}>{labelFor(image)}</option>)}</select></label>
        <details className="text-sm text-zinc-400"><summary className="cursor-pointer">更多操作</summary><label className="mt-3 block space-y-2"><span>最佳结果</span><select className={inputClass} value={bestId} disabled={busy} onChange={event => setBestId(event.target.value)}><option value="">未选择</option>{bestId && !members.some(i => i.id === bestId) && <option value={bestId}>保留原结果（暂不可用）</option>}{members.map(image => <option key={image.id} value={image.id}>{labelFor(image)}</option>)}</select></label></details>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <div className="flex flex-wrap justify-between gap-2 border-t border-zinc-800 pt-4"><button type="button" className="text-xs text-red-300 disabled:opacity-40" disabled={busy} onClick={() => void run(true)}>删除收藏夹（保留图片）</button><button className={buttonClass} disabled={busy || !name.trim()}>{busy ? '保存中…' : '保存修改'}</button></div>
      </form>
    </DialogContent>
  </Dialog>
}
