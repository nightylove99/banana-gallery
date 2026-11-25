import { CopyWorkCodeButton } from './CopyWorkCodeButton'
import { createReferenceAsset } from '@/lib/reference-library'
import { useEffect, useState, useRef, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChevronLeft, ChevronRight, FolderPlus, Pin, Heart, Download, Copy, Check, ChevronDown, ChevronUp, X, Plus, Sparkles, Trash2, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { createRecipeFromImage, imageAssetUrl } from '@/api'
import { buildGeneratePageState } from '@/lib/generate-state'
import { cn } from '@/lib/utils'
import { ReferenceImageEditor, type ReferenceImageEditorHandle } from './ReferenceImageEditor'
import { ReferenceImagePreview } from './ReferenceImagePreview'
import { alternateDetailAction, iconAction, mainDetailAction, relatedDetailAction, secondaryAction } from './detail-action-styles'
import { formatImageGenerationSource } from '@/lib/image-generation-providers'
import { assetTitle, assetNotes, assetSource, gallerySourceLabel } from '@/lib/gallery-query'
import type { GalleryImage } from '@/types'

type ZoomImage = {
  src: string
  alt: string
  width?: number
  height?: number
  closeOnClick?: boolean
}

const MAX_PROMPT_LENGTH = 20_000
const parameterChip = 'rounded-md border border-indigo-400/15 bg-indigo-400/10 px-2 py-1 font-medium text-indigo-100'

interface DetailModalProps {
  readOnly?: boolean
  primaryActions?: ReactNode | ((guard: (action: () => void) => void, requestDeleteConfirmation: () => void) => ReactNode)
  requestDuration?: string
  generationContext?: ReactNode
  deleteConfirmation?: { message: string; label: string }
  onAddToCollection?: (image: GalleryImage) => void
  image: GalleryImage | null
  onClose: () => void
  onToggleFavorite?: (id: string) => void
  onUpdateTags?: (id: string, tags: string[], expectedVersion?: number) => Promise<GalleryImage | void> | void
  onUpdatePrompt?: (id: string, prompt: string, expectedVersion?: number) => Promise<GalleryImage | void> | void
  onUpdateMetadata?: (id: string, updates: Partial<GalleryImage>, expectedVersion?: number) => Promise<GalleryImage>
  onReload?: () => Promise<void>
  onPrevious?: () => void
  onNext?: () => void
  positionLabel?: string
  onReferencesUpdated?: (image: GalleryImage) => void
  onExtractRecipe?: (id: string) => void
  extracting?: boolean
  relatedImages?: GalleryImage[]
  onOpenRelated?: (image: GalleryImage) => void
  keepOpenAfterDelete?: boolean
  onDelete?: (id: string) => Promise<void> | void
}

export function DetailModal({
  image, readOnly = false, primaryActions, requestDuration, generationContext, deleteConfirmation,
  onClose,
  onToggleFavorite, onAddToCollection,
  onUpdateTags,
  onUpdatePrompt,
  onUpdateMetadata, onReload, onPrevious, onNext, positionLabel,
  onReferencesUpdated,
  onExtractRecipe, extracting,
  onDelete, keepOpenAfterDelete, relatedImages = [], onOpenRelated,
}: DetailModalProps) {
  const navigate = useNavigate()
  const [promptExpanded, setPromptExpanded] = useState(true)
  const [copied, setCopied] = useState(false)
  const [zoomImage, setZoomImage] = useState<ZoomImage | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [newTag, setNewTag] = useState('')
  const [addingTag, setAddingTag] = useState(false)
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null)
  const currentImageId = useRef(image?.id)
  currentImageId.current = image?.id
  const confirmDelete = deleteTargetId !== null && deleteTargetId === image?.id
  const [deleting, setDeleting] = useState(false)
  const [mobileView, setMobileView] = useState<'image' | 'info'>('image')
  const [operationError, setOperationError] = useState<string | null>(null)
  const [editingPrompt, setEditingPrompt] = useState(false)
  const [draftPrompt, setDraftPrompt] = useState('')
  const [draftTitle, setDraftTitle] = useState('')
  const [draftNotes, setDraftNotes] = useState('')
  const [savingMetadata, setSavingMetadata] = useState(false)
  const navigateRef = useRef<((direction: 'previous' | 'next') => void) | null>(null)
  const [savingPrompt, setSavingPrompt] = useState(false)
  const referenceEditor = useRef<ReferenceImageEditorHandle>(null)
  const [pendingAction, setPendingAction] = useState<((latest: GalleryImage) => void) | null>(null)
  const [savingBeforeLeave, setSavingBeforeLeave] = useState(false)
  const tagInputRef = useRef<HTMLInputElement>(null)
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setDeleteTargetId(null)
    setMoreOpen(false)
    setAddingTag(false)
    setNewTag('')
    setOperationError(null)
  }, [image?.id])

  useEffect(() => {
    setPromptExpanded(true)
    setCopied(false)
    setEditingPrompt(false)
    setDraftPrompt(image?.prompt ?? '')
    setSavingPrompt(false)
  }, [image?.id, image?.prompt])

  useEffect(() => {
    if (!editingPrompt) return
    promptTextareaRef.current?.focus()
  }, [editingPrompt])

  const persistedTitle = image ? assetTitle(image) : ''
  const persistedNotes = image ? assetNotes(image) : ''
  useEffect(() => {
    setDraftTitle(persistedTitle); setDraftNotes(persistedNotes)
  }, [image?.id, persistedTitle, persistedNotes])
  useEffect(() => {
    if (!image || zoomImage || pendingAction) return
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || target?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        if (!confirmDelete) navigateRef.current?.(event.key === 'ArrowLeft' ? 'previous' : 'next')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [image, zoomImage, pendingAction, confirmDelete])

  const pendingTag = image && addingTag && !image.tags.includes(newTag.trim()) ? newTag.trim() : ''
  const textDirty = !!image && (!!pendingTag || draftTitle.trim() !== persistedTitle || draftNotes.trim() !== persistedNotes || (editingPrompt && draftPrompt.trim() !== image.prompt))
  useEffect(() => {
    if (!image || readOnly || !(textDirty || savingPrompt || savingMetadata || savingBeforeLeave)) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [image, readOnly, textDirty, savingPrompt, savingMetadata, savingBeforeLeave])

  if (!image) return null

  const metadataDirty = draftTitle.trim() !== assetTitle(image) || draftNotes.trim() !== assetNotes(image)
  const requestAction = (action: (latest: GalleryImage) => void) => {
    if (deleting) return
    if (readOnly) { action(image); return }
    if (referenceEditor.current?.isSaving() || savingPrompt || savingMetadata) return
    if (referenceEditor.current?.isDirty() || (editingPrompt && draftPrompt.trim() !== image.prompt) || metadataDirty || pendingTag) setPendingAction(() => action)
    else action(image)
  }
  const closeDetail = () => {
    setDeleteTargetId(null)
    onClose()
  }
  const requestClose = () => requestAction(closeDetail)
  const requestDeleteConfirmation = () => requestAction(latest => {
    if (latest.id === currentImageId.current) setDeleteTargetId(latest.id)
  })
  navigateRef.current = direction => { const action = direction === 'previous' ? onPrevious : onNext; if (action) requestAction(action) }

  const imgSrc = imageAssetUrl(image.filename)
  const isLongPrompt = image.prompt.length > 200
  const isRecipe = image.assetType === 'recipe'
  const zoomImageClass = getZoomImageClass(zoomImage)
  const generationSource = image.generation?.provider
    ? formatImageGenerationSource(
        image.generation.provider,
        image.generation.model,
      )
    : image.generation?.model || (image.sourceFile === 'gemini-web'
      ? 'Google · 模型未记录（网页导入）'
      : null)
  const recordedSource = assetSource(image)
  const recordedSourceLabel = recordedSource === 'unknown' ? null : gallerySourceLabel(recordedSource)

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(image.prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { toast.error('复制失败，请选中提示词手动复制') }
  }

  const handleStartPromptEdit = () => {
    setDraftPrompt(image.prompt)
    setPromptExpanded(true)
    setEditingPrompt(true)
  }

  const handleCancelPromptEdit = () => {
    setDraftPrompt(image.prompt)
    setEditingPrompt(false)
  }

  const handleSavePrompt = async (base = image) => {
    if (!onUpdatePrompt) return
    const nextPrompt = draftPrompt.trim()
    if (!nextPrompt) {
      toast.error('提示词不能为空')
      return
    }
    if (nextPrompt.length > MAX_PROMPT_LENGTH) {
      toast.error(`提示词不能超过 ${MAX_PROMPT_LENGTH} 个字符`)
      return
    }
    if (nextPrompt === image.prompt) {
      setEditingPrompt(false)
      return base
    }

    setSavingPrompt(true)
    try {
      const updated = await onUpdatePrompt(image.id, nextPrompt, base.version || 0)
      setEditingPrompt(false)
      toast.success('提示词已更新')
      return updated || { ...base, prompt: nextPrompt }
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : '提示词更新失败')
      toast.error(error instanceof Error ? error.message : '提示词更新失败')
    } finally {
      setSavingPrompt(false)
    }
  }

  const handleSaveMetadata = async (base = image) => {
    if (!onUpdateMetadata || !metadataDirty) return base
    setSavingMetadata(true)
    try {
      const updated = await onUpdateMetadata(image.id, { title: draftTitle.trim(), notes: draftNotes.trim() }, base.version || 0)
      setOperationError(null); return updated
    } catch (error) { setOperationError(error instanceof Error ? error.message : '标题与备注保存失败') }
    finally { setSavingMetadata(false) }
  }

  const handleDownload = () => {
    const a = document.createElement('a')
    a.href = imgSrc
    a.download = image.filename
    a.click()
  }

  const handleAddTag = async (base = image) => {
    if (!pendingTag || !onUpdateTags) return base
    const tags = [...base.tags, pendingTag]
    try {
      const updated = await onUpdateTags(base.id, tags, base.version || 0)
      setNewTag('')
      setAddingTag(false)
      setOperationError(null)
      return updated || { ...base, tags }
    } catch (error) { setOperationError(error instanceof Error ? error.message : '标签保存失败') }
  }

  const handleRemoveTag = async (tag: string) => {
    if (!onUpdateTags) return
    try {
      await onUpdateTags(image.id, image.tags.filter(t => t !== tag), image.version || 0)
      setOperationError(null)
    } catch (error) { setOperationError(error instanceof Error ? error.message : '标签保存失败') }
  }

  const createdDate = new Date(image.createdAt).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })

  const generation = image.generation
  const ratio = generation?.aspectRatio === 'source' ? '跟随参考图' : generation?.aspectRatio === 'auto' ? '自动' : generation?.aspectRatio
  const moreCount = Number(!!persistedTitle) + Number(!!persistedNotes) + Number(!!image.pinned) + image.tags.length
  const moreId = `asset-metadata-${image.id}`
  const favoriteLabel = image.favorited ? '取消喜欢' : '喜欢'
  const generateLabel = isRecipe ? '用此配方生成' : '转入生成'

  return (
    <>
      {!readOnly && <Dialog open={!!pendingAction} onOpenChange={open => { if (!open && !savingBeforeLeave) setPendingAction(null) }}>
        <DialogContent hideClose className="max-w-sm border-zinc-700 bg-zinc-900 text-zinc-200">
          <DialogTitle>修改尚未保存</DialogTitle>
          <DialogDescription>保存本次修改后继续，或放弃修改。</DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={savingBeforeLeave} onClick={() => setPendingAction(null)}>继续编辑</Button>
            <Button variant="ghost" disabled={savingBeforeLeave} onClick={() => {
              const action = pendingAction
              referenceEditor.current?.discard()
              setDraftPrompt(image.prompt)
              setDraftTitle(assetTitle(image)); setDraftNotes(assetNotes(image))
              setEditingPrompt(false)
              setNewTag(''); setAddingTag(false)
              setPendingAction(null)
              action?.(image)
            }}>放弃修改</Button>
            <Button disabled={savingBeforeLeave} onClick={async () => {
              setSavingBeforeLeave(true)
              let updated = referenceEditor.current?.isDirty() ? await referenceEditor.current.save() : image
              if (updated && editingPrompt && draftPrompt.trim() !== image.prompt) updated = await handleSavePrompt(updated)
              if (updated && metadataDirty) updated = await handleSaveMetadata(updated)
              if (updated && pendingTag) updated = await handleAddTag(updated)
              setSavingBeforeLeave(false)
              if (!updated) { setPendingAction(null); return }
              const action = pendingAction
              setPendingAction(null)
              action?.(updated)
            }}>{savingBeforeLeave ? '保存中…' : '保存并继续'}</Button>
          </div>
        </DialogContent>
      </Dialog>}
      <Dialog open={!!image} onOpenChange={(open) => !open && requestClose()}>
        <DialogContent
          hideClose
          className={cn(
            "max-w-[92vw] max-h-[96dvh] w-[1240px] p-0 bg-[#0d0d14] border-[#1E2336] gap-0",
            !zoomImage && "overflow-hidden"
          )}
          onPointerDownOutside={(event) => {
            if (zoomImage) event.preventDefault()
          }}
          onEscapeKeyDown={(event) => {
            if (!zoomImage) return
            event.preventDefault()
            setZoomImage(null)
          }}
        >
          <DialogTitle className="sr-only">{assetTitle(image) || image.prompt.slice(0, 50)}</DialogTitle>
          <DialogDescription className="sr-only">
            查看{isRecipe ? '配方' : '作品'}详情、提示词、参考图和相关操作。
          </DialogDescription>

          <div className="grid h-[86dvh] min-h-0 grid-rows-[auto_minmax(0,1fr)] md:h-[85vh] md:grid-cols-[minmax(0,1fr)_420px]">
            <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[#1E2336] px-3 py-2 md:col-start-2 md:row-start-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2">
                <span className="whitespace-nowrap text-sm font-medium text-zinc-200">{readOnly ? '本次生成快照' : isRecipe ? '配方详情' : '作品详情'}</span>
                {!isRecipe && image.workCode && <CopyWorkCodeButton code={image.workCode} className="min-h-8 px-1 text-[11px] text-zinc-400 hover:bg-white/5 hover:text-zinc-200" />}
              </div>
              <button aria-label="关闭详情" onClick={requestClose} className={cn(iconAction, 'ml-auto h-8 w-8 hover:text-white md:order-last')}><X size={16} /></button>
              <div className="flex shrink-0 flex-wrap gap-1 md:hidden">
                <button className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200" aria-pressed={mobileView === 'image'} onClick={() => setMobileView('image')}>图片</button>
                <button className="rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200" aria-pressed={mobileView === 'info'} onClick={() => setMobileView('info')}>提示词与操作</button>
              </div>
              {(onPrevious || onNext || positionLabel) && <div className="ml-auto flex shrink-0 items-center gap-1 text-xs text-zinc-400">
                {onPrevious || onNext ? <button aria-label="上一张" title="上一张（←）" disabled={!onPrevious} onClick={() => navigateRef.current?.('previous')} className="flex h-8 w-6 shrink-0 items-center justify-center rounded-lg hover:bg-white/5 hover:text-white disabled:opacity-30 sm:w-8"><ChevronLeft size={16} /></button> : null}
                <span className="shrink-0 whitespace-nowrap tabular-nums">{positionLabel}</span>
                {onPrevious || onNext ? <button aria-label="下一张" title="下一张（→）" disabled={!onNext} onClick={() => navigateRef.current?.('next')} className="flex h-8 w-6 shrink-0 items-center justify-center rounded-lg hover:bg-white/5 hover:text-white disabled:opacity-30 sm:w-8"><ChevronRight size={16} /></button> : null}
              </div>}
            </header>
            {/* Left: Image viewer */}
            <div className={cn("relative min-h-0 min-w-0 items-center justify-center overflow-hidden bg-[#101010] md:col-start-1 md:row-span-2 md:row-start-1 md:flex", mobileView==='image'?'flex':'hidden')}>
              <button
                type="button"
                className="flex h-full w-full cursor-zoom-in items-center justify-center"
                aria-label="查看大图"
                onClick={(event) => {
                  const img = event.currentTarget.querySelector('img')
                  setZoomImage({
                    src: imgSrc,
                    alt: '作品大图',
                    closeOnClick: true,
                    width: image.width > 0 ? image.width : img?.naturalWidth,
                    height: image.height > 0 ? image.height : img?.naturalHeight,
                  })
                }}
              >
                <img
                  src={imgSrc}
                  alt={image.prompt.slice(0, 80)}
                  className="max-h-full max-w-full object-contain shadow-2xl"
                />
              </button>
            </div>

            {/* Right: Info panel */}
            <div className={cn("min-h-0 w-full flex-col overflow-y-auto border-l border-[#1E2336] md:col-start-2 md:row-start-2 md:w-[420px] md:flex", mobileView === 'info' ? 'flex' : 'hidden')}>
              <div className="@container space-y-2 border-b border-[#1E2336] px-4 py-3">
                {typeof primaryActions === 'function' ? primaryActions(requestAction, requestDeleteConfirmation) : primaryActions ?? <>
                  <div aria-label="常用操作" className="flex items-center gap-1.5">
                    <button onClick={handleCopyPrompt} disabled={!image.prompt}
                      className={mainDetailAction}>
                      {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制提示词' : '复制提示词'}
                    </button>
                    <button onClick={() => requestAction(latest => {
                      closeDetail(); navigate('/generate', { state: buildGeneratePageState(latest) })
                    })} className={alternateDetailAction}>
                      <Sparkles size={14} className="shrink-0" />{generateLabel}
                    </button>
                    {onToggleFavorite && <button aria-label={favoriteLabel} title={favoriteLabel} aria-pressed={image.favorited} onClick={() => onToggleFavorite(image.id)} className={cn(iconAction, 'hover:text-rose-400')}>
                      <Heart size={16} className={image.favorited ? 'fill-rose-400 text-rose-400' : ''} />
                    </button>}
                    {onDelete && <button aria-label="移入回收站" title="移入回收站" onClick={requestDeleteConfirmation} className={cn(iconAction, 'hover:bg-red-950/40 hover:text-red-400')}><Trash2 size={16} /></button>}
                  </div>
                  <div aria-label="其他操作" className={cn('grid grid-cols-2 gap-1', isRecipe ? '@min-[250px]:grid-cols-3' : '@min-[315px]:grid-cols-4')}>
                    {onAddToCollection && <button aria-label="加入收藏夹" title="加入收藏夹" onClick={() => onAddToCollection(image)} className={secondaryAction}><FolderPlus size={14} />收藏夹</button>}
                    {!isRecipe && <button aria-label="提炼成配方" title="提炼成配方" disabled={extracting} onClick={() => requestAction(async latest => {
                      if (onExtractRecipe) { onExtractRecipe(latest.id); return }
                      try { await createRecipeFromImage(latest.id); toast.success('已提炼为配方') }
                      catch { toast.error('提炼失败，请重试') }
                    })} className={secondaryAction}><Sparkles size={14} />提炼配方</button>}
                    <button aria-label="用这张图继续修改" title="用这张图继续修改" onClick={() => requestAction(async latest => {
                      try {
                        const { asset } = await createReferenceAsset('images', latest.filename, latest.title || latest.prompt.slice(0, 50) || '作品主图')
                        const filename = asset.versions.find(version => version.id === asset.currentVersionId)!.filename
                        closeDetail(); navigate('/generate', { state: { ...buildGeneratePageState(latest), referenceImages: [filename], referenceNotes: ['基于这张结果继续修改'] } })
                      } catch (error) { toast.error(error instanceof Error ? error.message : '加入参考图失败') }
                    })} className={secondaryAction}><Pencil size={14} />继续修改</button>
                    <button aria-label="下载图片" onClick={handleDownload} className={secondaryAction}><Download size={14} />下载</button>
                  </div>
                </>}
              </div>

              {operationError && <div role="alert" className="px-4 py-3 text-sm text-red-300">{operationError}{onReload && <button onClick={() => requestAction(() => void onReload())} className="ml-3 underline">重新读取条目</button>}</div>}
              {/* 删除确认 */}
              {confirmDelete && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-red-900/50 bg-red-950/30 px-4 py-2.5">
                  <span className="text-xs text-red-400">{deleteConfirmation?.message ?? '移入回收站？之后可以恢复。'}</span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setDeleteTargetId(null)}
                      className="rounded px-2 py-1 text-xs text-zinc-400 hover:text-white transition-colors"
                    >
                      取消
                    </button>
                    <button
                      onClick={() => {
                        const targetId = deleteTargetId
                        requestAction(async latest => {
                          if (targetId !== latest.id || targetId !== currentImageId.current) return
                          setDeleting(true)
                          setOperationError(null)
                          try {
                            await onDelete?.(targetId)
                            if (targetId === currentImageId.current) {
                              setDeleteTargetId(null)
                              if (!keepOpenAfterDelete) closeDetail()
                            }
                          } catch (error) {
                            setOperationError(error instanceof Error ? error.message : '删除失败，请重试')
                          } finally { setDeleting(false) }
                        })
                      }}
                      disabled={deleting}
                      className="rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-500 transition-colors"
                    >
                      {deleteConfirmation?.label ?? '删除'}
                    </button>
                  </div>
                </div>
              )}

              <section aria-label="生成参数与来源" className="space-y-2 border-b border-[#1E2336] px-4 py-3 text-xs">
                <div className="flex flex-wrap gap-1.5">
                  {generationSource && <span className={parameterChip}><span className="sr-only">生成来源：</span>{generationSource}</span>}
                  {generation?.imageSize && <span className={parameterChip}><span className="sr-only">生成分辨率：</span>{generation.imageSize}</span>}
                  {ratio && <span className={parameterChip}><span className="sr-only">生成比例：</span>{ratio}</span>}
                  {generation?.quality && <span className={parameterChip}><span className="sr-only">生成质量：</span>{generation.quality[0].toUpperCase() + generation.quality.slice(1)}</span>}
                  {image.width > 0 && image.height > 0 && <span className={parameterChip}><span className="sr-only">实际像素：</span>{image.width} × {image.height}</span>}
                  {requestDuration && <span className={parameterChip}><span className="sr-only">请求</span>用时 {requestDuration}</span>}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-zinc-400">
                  <span>创建时间：{createdDate}</span>
                  {!readOnly && <span>类型：{isRecipe ? '配方' : '作品'}</span>}
                  {generationContext}
                  {image.sourceUrl && /^https?:\/\//i.test(image.sourceUrl) && <a href={image.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-indigo-300 hover:text-indigo-200">打开原网页 ↗</a>}
                  {image.capturedAt && <span>采集时间：{new Date(image.capturedAt).toLocaleString()}</span>}
                  {recordedSourceLabel && <span>来源：{recordedSourceLabel}</span>}
                  {relatedImages.map(related => <button key={related.id} onClick={() => requestAction(() => onOpenRelated?.(related))}
                    className={relatedDetailAction}>
                    {related.id === image.sourceAssetId ? '来源：' : '后续：'}{assetTitle(related) || related.prompt.slice(0, 20)}
                  </button>)}
                </div>
              </section>

              {readOnly ? <ReferenceImagePreview image={image} onPreview={setZoomImage} /> : <ReferenceImageEditor
                key={image.id}
                ref={referenceEditor}
                image={image}
                onSaved={onReferencesUpdated}
                onPreview={setZoomImage}
              />}

              {/* Prompt */}
              <div className="border-b border-[#1E2336] px-4 py-4 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-zinc-200">提示词</h3>
                  {editingPrompt ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label="取消编辑提示词"
                        onClick={handleCancelPromptEdit}
                        disabled={savingPrompt}
                        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <X size={12} />
                        取消
                      </button>
                      <button
                        type="button"
                        aria-label="保存提示词"
                        onClick={() => void handleSavePrompt()}
                        disabled={savingPrompt || !draftPrompt.trim()}
                        className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-200 transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Check size={12} />
                        {savingPrompt ? '保存中' : '保存'}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={handleCopyPrompt}
                        disabled={readOnly && !image.prompt}
                        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:text-white transition-colors"
                      >
                        {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                        {copied ? '已复制' : readOnly ? '复制提示词' : '复制'}
                      </button>
                      {!readOnly && <button
                        type="button"
                        aria-label="编辑提示词"
                        onClick={handleStartPromptEdit}
                        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 transition-colors hover:text-white"
                      >
                        <Pencil size={12} />
                        编辑
                      </button>}
                    </div>
                  )}
                </div>
                <div className="relative">
                  {editingPrompt ? (
                    <textarea
                      ref={promptTextareaRef}
                      aria-label="编辑提示词"
                      value={draftPrompt}
                      onChange={(event) => setDraftPrompt(event.target.value)}
                      maxLength={MAX_PROMPT_LENGTH}
                      className="min-h-[180px] w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm leading-relaxed text-zinc-200 outline-none transition-colors focus:border-zinc-500"
                    />
                  ) : (
                    <>
                      <p
                        className={cn(
                          'text-sm leading-relaxed text-zinc-400 whitespace-pre-wrap',
                          !promptExpanded && isLongPrompt && 'line-clamp-5'
                        )}
                      >
                        {image.prompt}
                      </p>
                      {isLongPrompt && (
                        <button
                          onClick={() => setPromptExpanded(!promptExpanded)}
                          className="mt-1 flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                        >
                          {promptExpanded ? (
                            <>
                              <ChevronUp size={12} /> 收起
                            </>
                          ) : (
                            <>
                              <ChevronDown size={12} /> 展开全文
                            </>
                          )}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {!readOnly && <section className="border-b border-[#1E2336]">
                <button type="button" aria-expanded={moreOpen} aria-controls={moreId} onClick={() => setMoreOpen(open => !open)}
                  className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-left text-xs text-zinc-400 hover:text-zinc-200">
                  {moreOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  <span className="font-medium text-zinc-200">更多信息</span>
                  <span>标题 · 备注 · 标签 · 置顶</span>
                  {textDirty ? <span className="ml-auto text-amber-300">有未保存修改</span> : moreCount > 0 && <span className="ml-auto">已填写 {moreCount} 项</span>}
                </button>
                <div id={moreId} hidden={!moreOpen}>
                  {onUpdateMetadata && <section className="space-y-2 border-b border-zinc-800 p-4">
                    <label className="block text-xs text-zinc-500">标题<input aria-label="标题" value={draftTitle} maxLength={200} onChange={event => setDraftTitle(event.target.value)} placeholder="给这份配方或作品起个名字" className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 p-2 text-sm text-zinc-200" /></label>
                    <label className="block text-xs text-zinc-500">备注<textarea aria-label="备注" value={draftNotes} maxLength={10000} onChange={event => setDraftNotes(event.target.value)} placeholder="使用心得、待调整的地方…" rows={2} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 p-2 text-sm text-zinc-200" /></label>
                    <button disabled={!metadataDirty || savingMetadata} onClick={() => void handleSaveMetadata()} className="rounded bg-indigo-600 px-3 py-2 text-xs text-white disabled:opacity-40">保存标题与备注</button>
                    <button onClick={async () => { try { await onUpdateMetadata(image.id, { pinned: !image.pinned }, image.version || 0) } catch (error) { setOperationError(error instanceof Error ? error.message : '置顶失败') } }} className="flex items-center gap-1 p-2 text-xs text-zinc-400"><Pin size={14} />{image.pinned ? '取消置顶' : '置顶常用'}</button>
                  </section>}

                  {/* Tags */}
                  <div className="border-b border-[#1E2336] px-4 py-4 space-y-2">
                    <h3 className="text-sm font-semibold text-zinc-200">标签</h3>
                    <div className="flex flex-wrap gap-1.5">
                      {image.tags.map((tag) => (
                        <Badge
                          key={tag}
                          variant="secondary"
                          className="group gap-1 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 cursor-default"
                        >
                          {tag}
                          <button
                            onClick={() => handleRemoveTag(tag)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity"
                            aria-label={`删除标签 ${tag}`}
                          >
                            <X size={10} />
                          </button>
                        </Badge>
                      ))}

                      {addingTag ? (
                        <div className="flex items-center gap-1">
                          <input
                            ref={tagInputRef}
                            value={newTag}
                            onChange={(e) => setNewTag(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void handleAddTag()
                              if (e.key === 'Escape') {
                                setAddingTag(false)
                                setNewTag('')
                              }
                            }}
                            autoFocus
                            placeholder="标签名"
                            className="h-6 w-24 rounded border border-zinc-600 bg-zinc-800 px-2 text-xs text-zinc-200 outline-none focus:border-zinc-400"
                          />
                          <button onClick={() => void handleAddTag()} className="text-xs text-zinc-400 hover:text-white">
                            <Check size={12} />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setAddingTag(true) }}
                          className="flex items-center gap-1 rounded-full border border-dashed border-zinc-600 px-2 py-0.5 text-xs text-zinc-500 hover:border-zinc-400 hover:text-zinc-300 transition-colors"
                        >
                          <Plus size={10} />
                          添加
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </section>}
            </div>
          </div>
          {/* 图片放大层：必须在 DialogContent 内部渲染，才处于 Radix 的模态作用域内，
              否则会被 Radix 的 hideOthers (aria-hidden/inert) 标记为不可交互。
              利用 top-1/2 left-1/2 + -translate 技巧突破父元素 transform，覆盖整个视口。 */}
          {zoomImage && (
            <div
              className="fixed top-1/2 left-1/2 h-screen w-screen -translate-x-1/2 -translate-y-1/2 z-[60] flex items-center justify-center bg-black/80"
              onClick={() => setZoomImage(null)}
            >
              <img
                src={zoomImage.src}
                alt={zoomImage.alt}
                width={zoomImage.width}
                height={zoomImage.height}
                className={cn('block object-contain shadow-2xl', zoomImage.closeOnClick && 'cursor-zoom-out', zoomImageClass)}
                onClick={(event) => { if (!zoomImage.closeOnClick) event.stopPropagation() }}
              />
              <Button
                size="icon"
                variant="ghost"
                className="absolute right-4 top-4 text-white"
                aria-label="关闭大图"
                onClick={(event) => {
                  event.stopPropagation()
                  setZoomImage(null)
                }}
              >
                <X size={20} />
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function getZoomImageClass(zoomImage: ZoomImage | null) {
  if (
    !zoomImage?.width ||
    !zoomImage.height ||
    zoomImage.width <= 0 ||
    zoomImage.height <= 0 ||
    typeof window === 'undefined'
  ) {
    return 'max-h-screen max-w-screen'
  }

  const imageAspect = zoomImage.width / zoomImage.height
  const viewportAspect = window.innerWidth / window.innerHeight

  return imageAspect >= viewportAspect
    ? 'h-auto w-screen'
    : 'h-screen w-auto'
}
