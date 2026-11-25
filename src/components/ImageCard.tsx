import { CopyWorkCodeButton } from './CopyWorkCodeButton'
import { useState } from 'react'
import { ArrowUpRight, Check, Ellipsis, FolderPlus, Heart, Sparkles, Trash2 } from 'lucide-react'
import { generateFromAssetHref } from '@/lib/generate-state'
import { cn } from '@/lib/utils'
import { useThumbnail } from '@/hooks/useThumbnail'
import { assetTitle } from '@/lib/gallery-query'
import type { GalleryImage } from '@/types'

interface ImageCardProps {
  onAddToCollection?: (image: GalleryImage) => void
  onExtractRecipe?: (id: string) => void
  onDelete?: (id: string) => void
  extracting?: boolean
  deleting?: boolean
  compact?: boolean
  selected?: boolean
  onSelect?: (image: GalleryImage) => void
  fit?: 'cover' | 'contain'
  image: GalleryImage
  onOpen: (image: GalleryImage) => void
  onToggleFavorite: (id: string) => void
  loading?: 'eager' | 'lazy'
  fetchPriority?: 'high' | 'low' | 'auto'
  initiallyLoaded?: boolean
  onImageLoad?: () => void
  preview?: boolean
  prepare?: boolean
}

export function ImageCard({
  image, onOpen, onToggleFavorite, fit = 'cover', selected, onSelect, onAddToCollection,
  onExtractRecipe, onDelete, extracting, deleting, compact, loading = 'lazy',
  fetchPriority = 'auto', initiallyLoaded = false, onImageLoad, preview = false, prepare = true,
}: ImageCardProps) {
  const [dockOpen, setDockOpen] = useState(false)
  const [loaded, setLoaded] = useState(initiallyLoaded)
  const [loadError, setLoadError] = useState(false)
  const [retry, setRetry] = useState(0)
  const thumbnail = useThumbnail(image, { preview, priority: fetchPriority, retry, enabled: prepare })
  const failed = loadError || (!!thumbnail.error && !thumbnail.src)
  const ready = loaded || thumbnail.ready
  const imageLabel = assetTitle(image) || image.prompt.slice(0, 60).trim()
  const activateCard = () => (onSelect ? onSelect(image) : onOpen(image))

  const actionStyle = cn(
    'flex h-8 shrink-0 items-center justify-center rounded-md text-zinc-200 hover:bg-white/10 hover:text-white disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-indigo-300',
    compact ? 'w-[22px] [@media(hover:none)]:w-8' : 'w-8',
  )
  const likeLabel = image.favorited ? '取消喜欢' : '喜欢'
  const dockId = `asset-actions-${image.id}`

  return (
    <div
      className={cn(
        'group relative aspect-[2/3] overflow-hidden rounded-lg',
        failed ? 'flex flex-col items-center justify-center gap-1 bg-zinc-900 px-3 py-8 ring-1 ring-amber-500/30' : ready ? 'bg-zinc-900' : 'bg-zinc-800 animate-pulse',
        onSelect && selected && 'ring-2 ring-indigo-400',
      )}
    >
      <button
        type="button"
        id={`asset-${image.id}`}
        data-asset-id={image.id}
        aria-label={`${onSelect ? selected ? '取消选择' : '选择' : '打开'} ${imageLabel || '图片'}`}
        aria-pressed={onSelect ? !!selected : undefined}
        className={cn(
          'cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-300',
          failed ? 'flex flex-col items-center gap-1 text-center text-zinc-500 after:absolute after:inset-0' : 'block h-full w-full',
        )}
        onClick={() => { setDockOpen(false); activateCard() }}
      >
        {failed ? <>
          <span className="text-lg" aria-hidden>⚠️</span>
          <span className="text-xs leading-snug">{thumbnail.error || '图片文件缺失或无法加载'}</span>
        </> : <img
          src={thumbnail.src}
          data-thumbnail-size={thumbnail.size}
          decoding="async"
          alt={imageLabel}
          loading={loading}
          fetchPriority={fetchPriority}
          onLoad={() => { setLoaded(true); onImageLoad?.() }}
          onError={() => { setLoadError(true); setLoaded(true) }}
          className={cn(
            'block h-full w-full',
            fit === 'contain' ? 'object-contain' : 'object-cover',
            'transition-[opacity,transform] duration-150 ease-out',
            'motion-safe:group-hover:scale-[1.03] motion-reduce:transition-none',
            ready ? 'opacity-100' : 'opacity-0',
          )}
        />}
      </button>

      {failed && <button type="button" onClick={() => { setLoadError(false); setLoaded(false); setRetry(value => value + 1) }}
        className="relative rounded bg-zinc-800 px-3 py-2 text-xs text-zinc-300">重试加载</button>}
      {thumbnail.error && thumbnail.src && !loadError && <button aria-label="重试清晰图" title={thumbnail.error} onClick={() => setRetry(value => value + 1)} className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded bg-black/75 px-3 py-2 text-xs text-zinc-200">重试清晰图</button>}
      {onSelect && <label onClick={event => event.stopPropagation()} className="absolute left-2 top-2 z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full">
        <input aria-label={`选择 ${imageLabel || image.id}`} type="checkbox" checked={!!selected} onChange={() => onSelect(image)} className="peer sr-only" />
        <span aria-hidden="true" className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full border transition-all duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-400 peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-black/60',
          selected
            ? 'border-indigo-400 bg-indigo-500 text-white shadow-md shadow-indigo-950/50'
            : 'border-white/65 bg-black/40 text-transparent backdrop-blur-sm group-hover:border-white group-hover:bg-black/55 group-hover:text-white/50',
        )}>
          <Check size={14} strokeWidth={2.75} />
        </span>
      </label>}
      {onSelect && selected && <div aria-hidden className="pointer-events-none absolute inset-0 bg-indigo-500/10" />}

      {!onSelect && <>
        <button type="button" aria-label={dockOpen ? '收起卡片操作' : '展开卡片操作'} aria-expanded={dockOpen} aria-controls={dockId}
          onClick={() => setDockOpen(open => !open)}
          className="absolute right-1.5 top-1.5 z-10 hidden h-7 w-7 items-center justify-center rounded-md bg-[#0f1018]/85 text-zinc-200 [@media(hover:none)]:flex">
          <Ellipsis size={16} />
        </button>
        <div id={dockId} role="group" aria-label="卡片操作"
          className={cn(
            'absolute inset-x-0 bottom-2 mx-auto flex w-max max-w-[calc(100%-0.5rem)] flex-wrap items-center justify-center gap-y-0.5 rounded-xl border border-white/12 bg-[#0f1018]/85 p-0.5 backdrop-blur-md transition-opacity motion-reduce:transition-none',
            'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100',
            dockOpen ? '[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100' : '[@media(hover:none)]:hidden',
          )}>
          <button type="button" aria-label={likeLabel} title={likeLabel} aria-pressed={!!image.favorited}
            className={actionStyle} onClick={() => onToggleFavorite(image.id)}>
            <Heart size={15} className={cn(image.favorited && 'fill-rose-400 text-rose-400')} />
          </button>
          {onAddToCollection && <button type="button" aria-label="加入收藏夹" title="加入收藏夹"
            className={actionStyle} onClick={() => onAddToCollection(image)}><FolderPlus size={15} /></button>}
          {image.assetType !== 'recipe' && onExtractRecipe && <button type="button" aria-label="提炼成配方" title="提炼成配方"
            className={actionStyle} disabled={extracting} onClick={() => onExtractRecipe(image.id)}><Sparkles size={15} /></button>}
          {image.workCode && <CopyWorkCodeButton code={image.workCode} iconOnly className={actionStyle} />}
          <a href={generateFromAssetHref(image.id)} target="_blank" rel="noopener" aria-label="另开进生成页" title="另开进生成页"
            className={actionStyle} onClick={event => event.stopPropagation()}><ArrowUpRight size={15} /></a>
          {onDelete && <div className="flex shrink-0 items-center">
            <span aria-hidden className="h-4 w-px bg-white/15" />
            <button type="button" aria-label="移入回收站" title="移入回收站" className={cn(actionStyle, 'hover:text-red-400')}
              disabled={deleting} onClick={() => onDelete(image.id)}><Trash2 size={15} /></button>
          </div>}
        </div>
      </>}
    </div>
  )
}
