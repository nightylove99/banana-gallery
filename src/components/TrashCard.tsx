/* eslint-disable react-refresh/only-export-components */
import { useState } from 'react'
import { Check, ImageOff, RotateCcw, Trash2 } from 'lucide-react'
import { imageAssetUrl } from '@/api'
import { assetTitle } from '@/lib/gallery-query'
import { cn } from '@/lib/utils'
import type { TrashItem } from '@/types'

export const trashItemTitle = (item: TrashItem) => assetTitle(item).trim() || item.prompt.trim().slice(0, 60) || '未命名条目'

export function TrashMediaPlaceholder({ pending }: { pending?: boolean }) {
  return <div className="flex h-full flex-col items-center justify-center gap-1 px-3 text-center text-xs text-zinc-400">
    <ImageOff size={20} aria-hidden="true" className="mb-1 text-zinc-500" />
    <span className={pending ? 'text-amber-200' : 'text-zinc-200'}>{pending ? '永久清理未完成' : '图片无法加载'}</span>
    <span className="text-[11px] text-zinc-500">{pending ? '不可恢复，可重试清理' : '元数据保留，仍可恢复'}</span>
  </div>
}

function Thumbnail({ item }: { item: TrashItem }) {
  const [failed, setFailed] = useState(false)
  if (item.purgePending || item.originalMissing || failed) return <TrashMediaPlaceholder pending={item.purgePending} />
  const query = new URLSearchParams({ thumbnail: 'true', size: 'standard' })
  if (item.thumbnailVersion) query.set('v', item.thumbnailVersion)
  return <img
    className="block h-full w-full object-contain transition-transform duration-150 ease-out motion-safe:group-hover:scale-[1.03] motion-reduce:transition-none"
    loading="lazy"
    decoding="async"
    alt=""
    src={`${imageAssetUrl(encodeURIComponent(item.filename))}?${query}`}
    onError={() => setFailed(true)}
  />
}

const actionStyle = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-200 hover:bg-white/10 hover:text-white disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-indigo-300'

export function TrashCard({ item, selecting, selected, disabled, onOpen, onSelect, onRestore, onPurge }: {
  item: TrashItem
  selecting: boolean
  selected: boolean
  disabled: boolean
  onOpen: (opener: HTMLButtonElement) => void
  onSelect: () => void
  onRestore: () => void
  onPurge: (opener: HTMLButtonElement) => void
}) {
  const title = trashItemTitle(item)
  const abnormal = !!item.purgePending || !!item.originalMissing
  const purgeLabel = item.purgePending ? '重试清理' : '永久删除'
  return <li className={cn(
    'group relative aspect-[2/3] min-w-0 overflow-hidden rounded-lg bg-zinc-900',
    abnormal && 'ring-1 ring-amber-500/30',
    selecting && selected && 'ring-2 ring-indigo-400',
  )}>
    <div className="pointer-events-none absolute inset-0">
      <Thumbnail key={JSON.stringify([item.filename, item.thumbnailVersion, item.version])} item={item} />
    </div>
    {selecting ? <>
      <button
        type="button"
        aria-label={`${selected ? '取消选择' : '选择'} ${title}`}
        aria-pressed={selected}
        disabled={disabled}
        onClick={onSelect}
        className="absolute inset-0 cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-300 disabled:cursor-default"
      />
      <label onClick={event => event.stopPropagation()} className="absolute left-2 top-2 z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full">
        <input
          type="checkbox"
          aria-label={`选择 ${title}`}
          checked={selected}
          disabled={disabled}
          onChange={onSelect}
          className="peer sr-only"
        />
        <span aria-hidden="true" className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full border transition-all duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-400 peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-black/60',
          selected
            ? 'border-indigo-400 bg-indigo-500 text-white shadow-md shadow-indigo-950/50'
            : 'border-white/65 bg-black/40 text-transparent backdrop-blur-sm group-hover:border-white group-hover:bg-black/55 group-hover:text-white/50',
        )}>
          <Check size={14} strokeWidth={2.75} />
        </span>
      </label>
      {selected && <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-indigo-500/10" />}
    </> : <>
      <button
        type="button"
        aria-label={`打开 ${title}`}
        disabled={disabled}
        onClick={event => onOpen(event.currentTarget)}
        className="absolute inset-0 cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-300 disabled:cursor-default"
      />
      <div
        role="group"
        aria-label="卡片操作"
        className={cn(
          'absolute inset-x-0 bottom-2 mx-auto flex w-max max-w-[calc(100%-0.5rem)] items-center justify-center rounded-xl border border-white/12 bg-[#0f1018]/85 p-0.5 backdrop-blur-md transition-opacity motion-reduce:transition-none',
          '[@media(hover:hover)_and_(pointer:fine)]:pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100',
        )}
      >
        {!item.purgePending && <>
          <button type="button" aria-label="恢复" title="恢复" disabled={disabled} onClick={onRestore} className={actionStyle}>
            <RotateCcw size={15} aria-hidden="true" />
          </button>
          <span aria-hidden="true" className="h-4 w-px bg-white/15" />
        </>}
        <button
          type="button"
          aria-label={purgeLabel}
          title={purgeLabel}
          disabled={disabled}
          onClick={event => onPurge(event.currentTarget)}
          className={cn(actionStyle, 'hover:text-red-400')}
        >
          <Trash2 size={15} aria-hidden="true" />
        </button>
      </div>
    </>}
  </li>
}
