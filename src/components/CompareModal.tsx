import { useEffect, useState } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, Heart, Info, Trash2, X } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { imageAssetUrl, referenceAssetUrl } from '@/api'
import { assetTitle } from '@/lib/gallery-query'
import { cn } from '@/lib/utils'
import type { GalleryImage } from '@/types'

interface CompareModalProps {
  images: GalleryImage[]
  onClose: () => void
  returnFocus?: () => void
  onToggleFavorite?: (id: string) => Promise<void> | void
  onDelete?: (id: string) => Promise<void> | void
}

const dockAction = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-200 hover:bg-white/10 hover:text-white disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-indigo-300'

export function CompareModal({ images, onClose, returnFocus, onToggleFavorite, onDelete }: CompareModalProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showInfo, setShowInfo] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)

  const expandedIndex = expandedId ? images.findIndex(image => image.id === expandedId) : -1
  const expandedImage = expandedIndex >= 0 ? images[expandedIndex] : null

  useEffect(() => {
    if (images.length === 0) onClose()
  }, [images.length, onClose])

  useEffect(() => {
    if (!expandedImage) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'ArrowLeft' && expandedIndex > 0) {
        event.preventDefault()
        setExpandedId(images[expandedIndex - 1].id)
      } else if (event.key === 'ArrowRight' && expandedIndex < images.length - 1) {
        event.preventDefault()
        setExpandedId(images[expandedIndex + 1].id)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [expandedImage, expandedIndex, images])

  if (images.length === 0) return null

  const promptDiff = new Set(images.map(image => image.prompt)).size > 1
  const refDiff = new Set(images.map(image => JSON.stringify(image.referenceImages))).size > 1
  const modelDiff = new Set(images.map(image => `${image.generation?.provider || ''}:${image.generation?.model || ''}`)).size > 1
  const paramDiff = new Set(images.map(image => `${image.generation?.aspectRatio || `${image.width}x${image.height}`}:${image.generation?.imageSize || image.generation?.quality || ''}`)).size > 1
  const hasAnyDiff = promptDiff || refDiff || modelDiff || paramDiff

  const gridClass = images.length === 1
    ? 'grid-cols-1'
    : images.length === 2
      ? 'grid-cols-1 md:grid-cols-2'
      : images.length === 3
        ? 'grid-cols-1 md:grid-cols-3'
        : 'grid-cols-2 grid-rows-2'

  const infoColsClass = images.length === 1
    ? 'grid-cols-1'
    : images.length === 2
      ? 'grid-cols-1 md:grid-cols-2'
      : images.length === 3
        ? 'grid-cols-1 md:grid-cols-3'
        : 'grid-cols-1 md:grid-cols-2 xl:grid-cols-4'

  const handleToggleFavorite = async (id: string) => {
    if (!onToggleFavorite || pendingId) return
    setPendingId(id)
    try { await onToggleFavorite(id) }
    finally { setPendingId(null) }
  }

  const handleDelete = async (id: string) => {
    if (!onDelete || pendingId) return
    setPendingId(id)
    try {
      const idx = images.findIndex(image => image.id === id)
      const next = images[idx + 1] ?? images[idx - 1] ?? null
      await onDelete(id)
      if (expandedId === id) setExpandedId(next?.id ?? null)
    } finally {
      setPendingId(null)
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent
        hideClose
        onCloseAutoFocus={returnFocus ? event => { event.preventDefault(); returnFocus() } : undefined}
        onEscapeKeyDown={event => {
          if (expandedImage) {
            event.preventDefault()
            setExpandedId(null)
          }
        }}
        className="flex h-[94dvh] w-[96vw] max-w-none flex-col gap-0 overflow-hidden rounded-2xl border border-white/10 bg-[#090910] p-0 text-zinc-200 shadow-2xl"
      >
        {/* Minimal single-row header */}
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#1e2336] px-4 py-2.5 sm:px-5">
          <div className="flex min-w-0 items-baseline gap-2.5">
            {expandedImage ? (
              <button
                type="button"
                onClick={() => setExpandedId(null)}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-indigo-300 hover:bg-white/5 hover:text-indigo-200 focus-visible:outline-2 focus-visible:outline-indigo-400"
              >
                <ArrowLeft size={14} aria-hidden="true" />
                返回并排对比
              </button>
            ) : null}
            <DialogTitle className="text-sm font-medium text-white">
              {expandedImage ? `${assetTitle(expandedImage) || `图 ${expandedIndex + 1}`} · ${expandedIndex + 1} / ${images.length}` : `对比 ${images.length} 张`}
            </DialogTitle>
            <DialogDescription className="hidden text-xs text-zinc-500 sm:inline">
              {expandedImage ? '按左右方向键切换，Esc 返回并排' : '点击任意图片放大看大图'}
            </DialogDescription>
          </div>
          <div className="flex items-center gap-1.5">
            {!expandedImage && (
              <button
                type="button"
                aria-pressed={showInfo}
                onClick={() => setShowInfo(value => !value)}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-indigo-400',
                  showInfo ? 'bg-indigo-500/15 text-indigo-200' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100',
                )}
              >
                <Info size={14} aria-hidden="true" />
                参数与提示词
                {hasAnyDiff && <span aria-label="存在差异" className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
              </button>
            )}
            <button
              type="button"
              aria-label="关闭对比"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/5 hover:text-white focus-visible:outline-2 focus-visible:outline-indigo-400"
            >
              <X size={17} aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* Main stage */}
        {expandedImage ? (
          <div className="relative flex min-h-0 flex-1 items-center justify-center bg-[#06060b] p-4 sm:p-6">
            <img
              src={imageAssetUrl(expandedImage.filename)}
              alt={assetTitle(expandedImage) || `对比大图 ${expandedIndex + 1}`}
              onClick={() => setExpandedId(null)}
              className="max-h-full max-w-full cursor-zoom-out object-contain select-none"
            />
            {expandedIndex > 0 && (
              <button
                type="button"
                aria-label="上一张"
                onClick={() => setExpandedId(images[expandedIndex - 1].id)}
                className="absolute left-3 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/60 text-zinc-200 backdrop-blur-sm hover:bg-black/80 hover:text-white focus-visible:outline-2 focus-visible:outline-indigo-400"
              >
                <ChevronLeft size={20} aria-hidden="true" />
              </button>
            )}
            {expandedIndex < images.length - 1 && (
              <button
                type="button"
                aria-label="下一张"
                onClick={() => setExpandedId(images[expandedIndex + 1].id)}
                className="absolute right-3 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/60 text-zinc-200 backdrop-blur-sm hover:bg-black/80 hover:text-white focus-visible:outline-2 focus-visible:outline-indigo-400"
              >
                <ChevronRight size={20} aria-hidden="true" />
              </button>
            )}
            {(onToggleFavorite || onDelete) && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center rounded-xl border border-white/12 bg-[#0f1018]/85 p-0.5 backdrop-blur-md">
                {onToggleFavorite && (
                  <button
                    type="button"
                    aria-label={expandedImage.favorited ? '取消喜欢' : '喜欢'}
                    title={expandedImage.favorited ? '取消喜欢' : '喜欢'}
                    aria-pressed={!!expandedImage.favorited}
                    disabled={pendingId === expandedImage.id}
                    onClick={() => void handleToggleFavorite(expandedImage.id)}
                    className={dockAction}
                  >
                    <Heart size={15} className={cn(expandedImage.favorited && 'fill-rose-400 text-rose-400')} />
                  </button>
                )}
                {onToggleFavorite && onDelete && <span aria-hidden="true" className="h-4 w-px bg-white/15" />}
                {onDelete && (
                  <button
                    type="button"
                    aria-label="移入回收站"
                    title="移入回收站"
                    disabled={pendingId === expandedImage.id}
                    onClick={() => void handleDelete(expandedImage.id)}
                    className={cn(dockAction, 'hover:text-red-400')}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className={cn('grid min-h-0 flex-1 gap-2 bg-[#06060b] p-2 sm:gap-3 sm:p-3', gridClass)}>
              {images.map((image, index) => {
                const title = assetTitle(image) || `图 ${index + 1}`
                const busy = pendingId === image.id
                return (
                  <figure
                    key={image.id}
                    className="group relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-xl bg-[#0c0c14]"
                  >
                    <button
                      type="button"
                      aria-label={`放大查看 ${title}`}
                      onClick={() => setExpandedId(image.id)}
                      className="flex h-full w-full cursor-zoom-in items-center justify-center focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-400"
                    >
                      <img
                        src={imageAssetUrl(image.filename)}
                        alt={title}
                        className="h-full w-full object-contain select-none"
                      />
                    </button>
                    {(onToggleFavorite || onDelete) && (
                      <div
                        role="group"
                        aria-label={`${title} 操作`}
                        className={cn(
                          'absolute bottom-2.5 left-1/2 -translate-x-1/2 flex items-center rounded-xl border border-white/12 bg-[#0f1018]/85 p-0.5 backdrop-blur-md transition-opacity motion-reduce:transition-none',
                          '[@media(hover:hover)_and_(pointer:fine)]:pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100',
                        )}
                      >
                        {onToggleFavorite && (
                          <button
                            type="button"
                            aria-label={image.favorited ? '取消喜欢' : '喜欢'}
                            title={image.favorited ? '取消喜欢' : '喜欢'}
                            aria-pressed={!!image.favorited}
                            disabled={busy}
                            onClick={() => void handleToggleFavorite(image.id)}
                            className={dockAction}
                          >
                            <Heart size={15} className={cn(image.favorited && 'fill-rose-400 text-rose-400')} />
                          </button>
                        )}
                        {onToggleFavorite && onDelete && <span aria-hidden="true" className="h-4 w-px bg-white/15" />}
                        {onDelete && (
                          <button
                            type="button"
                            aria-label="移入回收站"
                            title="移入回收站"
                            disabled={busy}
                            onClick={() => void handleDelete(image.id)}
                            className={cn(dockAction, 'hover:text-red-400')}
                          >
                            <Trash2 size={15} />
                          </button>
                        )}
                      </div>
                    )}
                  </figure>
                )
              })}
            </div>

            {showInfo && (
              <section
                aria-label="参数与提示词对比"
                className="max-h-[34dvh] shrink-0 overflow-y-auto border-t border-[#1e2336] bg-[#0d0d14] p-3 sm:p-4"
              >
                <div className={cn('grid gap-3', infoColsClass)}>
                  {images.map((image, index) => (
                    <div key={image.id} className="min-w-0 space-y-2 rounded-xl border border-zinc-800/80 bg-[#101018] p-3 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium text-zinc-100">{assetTitle(image) || `图 ${index + 1}`}</span>
                        <span className="shrink-0 tabular-nums text-zinc-500">#{index + 1}</span>
                      </div>
                      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-zinc-400">
                        <dt className={cn(modelDiff && 'text-amber-300')}>模型</dt>
                        <dd className="truncate text-zinc-200">{image.generation?.model || image.generation?.provider || '未记录'}</dd>
                        <dt className={cn(paramDiff && 'text-amber-300')}>参数</dt>
                        <dd className="truncate text-zinc-200">
                          {image.generation?.aspectRatio || (image.width && image.height ? `${image.width}×${image.height}` : '未记录')}
                          {image.generation?.imageSize || image.generation?.quality ? ` · ${image.generation?.imageSize || image.generation?.quality}` : ''}
                        </dd>
                        <dt className={cn(refDiff && 'text-amber-300')}>参考图</dt>
                        <dd className="text-zinc-200">{image.referenceImages.length} 张</dd>
                      </dl>
                      {image.referenceImages.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {image.referenceImages.map((filename, refIdx) => (
                            <img
                              key={`${filename}-${refIdx}`}
                              src={`${referenceAssetUrl(filename)}?thumbnail=true`}
                              alt={`图 ${index + 1} 参考图 ${refIdx + 1}`}
                              className="h-10 w-10 rounded bg-black/50 object-contain"
                            />
                          ))}
                        </div>
                      )}
                      <div>
                        <p className={cn('mb-1 text-[11px]', promptDiff ? 'text-amber-300' : 'text-zinc-500')}>
                          提示词{promptDiff ? ' · 有差异' : ''}
                        </p>
                        <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-[#090910] p-2 text-zinc-300">
                          {image.prompt || '无提示词'}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
