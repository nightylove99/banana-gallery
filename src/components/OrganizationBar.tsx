import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { ArrowDownToLine, BookOpen, Columns2, FolderPlus, Heart, HeartOff, Images, Sparkles, Tag, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { fetchImage } from '@/api'
import { exportImages, batchUpdate, updateGroup, type BatchAction, type BatchResult } from '@/lib/organization'
import { cn } from '@/lib/utils'
import type { GalleryImage, ResultGroup } from '@/types'
import { CompareModal } from './CompareModal'
import { NamingSuggestionsModal } from './NamingSuggestionsModal'
import { ActionMenu } from './ui/action-menu'
import { AnchoredPopover } from './ui/anchored-popover'

interface Props {
  onAddToCollection?: (ids: string[], returnFocus: () => void) => void
  onToggleFavorite?: (id: string) => Promise<void> | void
  onDelete?: (id: string) => Promise<void> | void
  hideSelectionBar?: boolean
  images: GalleryImage[]
  allImages: GalleryImage[]
  loadingMore: boolean
  selected: Map<string, number>
  onSelected: Dispatch<SetStateAction<Map<string, number>>>
  selecting: boolean
  onSelecting: (value: boolean) => void
  onChanged: (image: GalleryImage) => void
  groups: ResultGroup[]
  groupId: string
  reloadGroups: () => Promise<void>
}

interface BatchNotice {
  action: BatchAction
  succeeded: number
  failed: BatchResult[]
}

const MAX_BATCH = 500
const MAX_EXPORT = 100
const focusRing = 'focus-visible:outline-2 focus-visible:outline-indigo-400'
const lightButton = `rounded-md px-2 py-1 text-xs text-zinc-300 hover:bg-white/5 hover:text-white disabled:opacity-45 ${focusRing}`
const dockButton = `flex h-9 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-xs font-medium text-zinc-200 hover:bg-white/5 disabled:opacity-40 sm:px-3 ${focusRing}`
const optionButton = `flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs hover:bg-white/5 disabled:opacity-40 ${focusRing}`
const targetsFor = (images: GalleryImage[]) => new Map(images.map(image => [image.id, image.version || 0]))
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

export function OrganizationBar({ onAddToCollection, onToggleFavorite, onDelete, hideSelectionBar = false, images, allImages, loadingMore, selected, onSelected,
  selecting, onSelecting, onChanged, groups, groupId, reloadGroups }: Props) {
  const [tags, setTags] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<BatchNotice | null>(null)
  const [modal, setModal] = useState<'compare' | 'naming' | null>(null)
  const working = useRef(false)
  const scope = useRef(0)
  const dock = useRef<HTMLDivElement>(null)
  const exitButton = useRef<HTMLButtonElement>(null)
  const compareButton = useRef<HTMLButtonElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const collectionButton = useRef<HTMLButtonElement>(null)
  const group = groups.find(item => item.id === groupId)
  const showDock = selecting || selected.size > 0
  const canBatch = !busy && selected.size > 0 && selected.size <= MAX_BATCH
  const canCompare = !busy && selected.size >= 2 && selected.size <= 4
  const selectedById = new Map((showDock ? allImages.filter(image => selected.has(image.id)) : []).map(image => [image.id, image]))
  const selectedImages = [...selected.keys()].flatMap(id => selectedById.get(id) ?? [])
  const source = selectedImages.length === 1 ? selectedImages[0] : null
  const candidates = source?.prompt.trim() ? allImages.filter(image => (
    image.assetType === source.assetType && image.prompt.trim() === source.prompt.trim()
  )) : []
  const tagList = [...new Set(tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))]
  const validTags = tagList.length > 0 && tagList.length <= 50 && tagList.every(tag => tag.length <= 80)

  useEffect(() => { if (selecting && !hideSelectionBar) exitButton.current?.focus({ preventScroll: true }) }, [selecting, hideSelectionBar])
  useEffect(() => () => { scope.current++ }, [])

  const run = async (work: (isCurrent: () => boolean) => Promise<void>, fallback: string) => {
    if (working.current) return
    const currentScope = scope.current
    working.current = true
    setBusy(true)
    try {
      await work(() => currentScope === scope.current)
    } catch (error) {
      toast.error(errorMessage(error, fallback))
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  const execute = (action: BatchAction, retry?: BatchResult[]) => run(async isCurrent => {
    const targets = [...selected].map(([id, version]) => ({ id, version }))
    const refreshFailures: BatchResult[] = []
    if (retry) {
      targets.length = 0
      for (const { id } of retry) {
        try {
          const image = await fetchImage(id, 'no-store')
          onChanged(image)
          targets.push({ id, version: image.version || 0 })
        } catch (error) {
          refreshFailures.push({ id, ok: false, error: errorMessage(error, '无法读取条目') })
        }
      }
    }
    const { results } = targets.length ? await batchUpdate(targets, action) : { results: [] }
    const successful = new Set(results.filter(result => result.ok).map(result => result.id))
    for (const result of results) {
      if (!result.ok || !result.image) continue
      const workCode = result.image.workCode ?? selectedById.get(result.id)?.workCode
      onChanged(result.image.assetType === 'work' && workCode ? { ...result.image, workCode } : result.image)
    }
    if (!isCurrent()) return
    onSelected(previous => {
      const next = new Map(previous)
      for (const { id, version } of targets) {
        if (previous.get(id) !== selected.get(id)) continue
        if (successful.has(id)) next.delete(id)
        else if (previous.has(id)) next.set(id, version)
      }
      return next
    })
    const failed = [...results.filter(result => !result.ok), ...refreshFailures]
    setNotice(failed.length ? { action, succeeded: successful.size, failed } : null)
    if (!failed.length) toast.success(`已完成 ${successful.size} 项`)
  }, '批量操作失败')

  const removeFromCollection = (current: ResultGroup) => run(async isCurrent => {
    await updateGroup(current, { imageIds: current.imageIds.filter(id => !selected.has(id)) })
    if (isCurrent()) onSelected(previous => new Map([...previous].filter(([id]) => !selected.has(id))))
    await reloadGroups()
    toast.success('已移出当前收藏夹')
  }, '更新收藏夹失败')

  const exit = () => {
    scope.current++
    setNotice(null)
    setTags('')
    onSelected(new Map())
    onSelecting(false)
  }

  if (!showDock && !notice && !modal) return null
  return <section aria-label="整理图库" className="shrink-0">
    {showDock && <>
      {!hideSelectionBar && <div className="flex flex-wrap items-center gap-1 border-b border-[#1E2336] bg-[#0d0d14] px-3 py-1.5 sm:px-5">
        <span role="status" className="mr-1 text-xs font-medium tabular-nums text-indigo-200">已选 {selected.size} 项{busy && ' · 处理中'}</span>
        <button type="button" className={lightButton} disabled={busy || loadingMore || !images.length || images.length > MAX_BATCH}
          title={images.length > MAX_BATCH ? '请缩小筛选范围后全选' : undefined} onClick={() => onSelected(targetsFor(images))}>全选当前</button>
        <button type="button" className={lightButton} disabled={busy || !selected.size} onClick={() => onSelected(new Map())}>取消全选</button>
        {candidates.length > 1 && <button type="button" className={lightButton} disabled={busy || loadingMore || candidates.length > MAX_BATCH}
          title={candidates.length > MAX_BATCH ? '同提示词候选超过可一次选择的数量' : undefined}
          onClick={() => onSelected(targetsFor(candidates))}>选中同提示词 ({candidates.length})</button>}
        <button ref={exitButton} type="button" className={cn(lightButton, 'ml-auto')} onClick={exit}>退出多选</button>
      </div>}
      <div className="pointer-events-none absolute inset-x-0 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-30 flex justify-center px-2 sm:px-4">
        <div ref={dock} role="group" aria-label="所选条目操作"
          className="pointer-events-auto relative isolate grid max-w-full grid-cols-3 gap-1 rounded-2xl border border-[#34384f] p-1.5 shadow-xl shadow-black/45 before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-[#14141f]/95 before:backdrop-blur-md sm:flex sm:items-center">
          <AnchoredPopover label="喜欢" above={dock} disabled={!canBatch} className={dockButton}
            trigger={<><Heart size={15} aria-hidden="true" />喜欢</>}>
            {close => <>
              <button className={optionButton} onClick={() => { close(); void execute({ type: 'favorite', value: true }) }}><Heart size={15} aria-hidden="true" />喜欢所选</button>
              <button className={optionButton} onClick={() => { close(); void execute({ type: 'favorite', value: false }) }}><HeartOff size={15} aria-hidden="true" />取消喜欢</button>
            </>}
          </AnchoredPopover>
          <AnchoredPopover label="标签" above={dock} disabled={!canBatch} className={dockButton}
            trigger={<><Tag size={15} aria-hidden="true" />标签</>}>
            {close => <form className="space-y-2 p-2" onSubmit={event => {
              event.preventDefault()
              if (!validTags) return
              close(); setTags(''); void execute({ type: 'addTags', tags: tagList })
            }}>
              <label className="grid gap-1.5 text-xs text-zinc-400">批量标签
                <input data-autofocus value={tags} onChange={event => setTags(event.target.value)} placeholder="输入标签，用逗号分隔"
                  className={`min-w-0 rounded-md border border-[#292d42] bg-[#0d0d14] px-2.5 py-2 text-sm text-zinc-200 ${focusRing}`} />
              </label>
              {tagList.length > 0 && !validTags && <p role="status" className="text-xs text-amber-200">一次最多 50 个标签，每个不超过 80 字。</p>}
              <div className="flex justify-end gap-1.5">
                <button type="button" className={lightButton} disabled={!validTags} onClick={() => { close(); setTags(''); void execute({ type: 'removeTags', tags: tagList }) }}>移除</button>
                <button type="submit" className={cn(lightButton, 'bg-indigo-400/15 text-indigo-200 hover:bg-indigo-400/25')} disabled={!validTags}>添加</button>
              </div>
            </form>}
          </AnchoredPopover>
          {group ? (
            <AnchoredPopover label="收藏夹" above={dock} triggerRef={collectionButton} disabled={!canBatch}
              className={dockButton} trigger={<><FolderPlus size={15} aria-hidden="true" />收藏夹</>}>
              {close => <>
                {onAddToCollection && <button className={optionButton} onClick={() => {
                  close(); onAddToCollection([...selected.keys()], () => collectionButton.current?.focus({ preventScroll: true }))
                }}>加入收藏夹</button>}
                <button className={optionButton} onClick={() => { close(); void removeFromCollection(group) }}>移出当前收藏夹</button>
              </>}
            </AnchoredPopover>
          ) : (
            <button ref={collectionButton} type="button" className={dockButton} disabled={!canBatch || !onAddToCollection}
              onClick={() => onAddToCollection?.([...selected.keys()], () => collectionButton.current?.focus({ preventScroll: true }))}>
              <FolderPlus size={15} aria-hidden="true" />收藏夹
            </button>
          )}
          <button ref={compareButton} type="button" className={cn(dockButton, canCompare && 'bg-indigo-400/15 text-indigo-200 hover:bg-indigo-400/25')}
            disabled={!canCompare} title="选择 2–4 张图片进行对比" onClick={() => setModal('compare')}><Columns2 size={15} aria-hidden="true" />对比</button>
          <button type="button" className={cn(dockButton, 'text-rose-300 hover:bg-rose-400/10 hover:text-rose-200')}
            disabled={!canBatch} onClick={() => void execute({ type: 'trash' })}><Trash2 size={15} aria-hidden="true" />移入回收站</button>
          <ActionMenu label="批量更多操作" above={dock} className={dockButton} disabled={!canBatch} triggerRef={moreButton}>
            <button onClick={() => void execute({ type: 'assetType', value: 'recipe' })}><BookOpen size={15} aria-hidden="true" />改为配方</button>
            <button onClick={() => void execute({ type: 'assetType', value: 'work' })}><Images size={15} aria-hidden="true" />改为作品</button>
            <button aria-disabled={selected.size > MAX_EXPORT} title={selected.size > MAX_EXPORT ? '请选择不超过 100 项生成建议' : undefined}
              onClick={() => selected.size > MAX_EXPORT ? toast.error('请选择不超过 100 项生成建议') : setModal('naming')}><Sparkles size={15} aria-hidden="true" />智能命名建议</button>
            <button aria-disabled={selected.size > MAX_EXPORT} title={selected.size > MAX_EXPORT ? '请选择不超过 100 项导出' : undefined}
              onClick={() => {
                if (selected.size > MAX_EXPORT) { toast.error('请选择不超过 100 项导出'); return }
                void run(async () => {
                  await exportImages([...selected.keys()])
                  toast.success('导出包已交给浏览器下载')
                }, '导出失败')
              }}><ArrowDownToLine size={15} aria-hidden="true" />导出所选 ZIP</button>
          </ActionMenu>
        </div>
      </div>
    </>}
    {selected.size > MAX_BATCH && <p role="status" className="px-3 py-1 text-xs text-amber-200 sm:px-5">选择已超过 500 项，请缩小操作范围。</p>}
    {notice && <div className="flex flex-wrap items-center gap-2 border-b border-amber-400/15 bg-amber-400/5 px-3 py-1.5 text-xs text-amber-100 sm:px-5">
      <p role="alert" className="min-w-0 flex-1 break-words">成功 {notice.succeeded} 项，失败 {notice.failed.length} 项。{notice.failed[0].error}</p>
      <button type="button" disabled={busy} onClick={() => void execute(notice.action, notice.failed)} className={cn(lightButton, 'text-amber-200')}>重试失败项</button>
      <button type="button" aria-label="关闭批量提示" onClick={() => { setNotice(null); exitButton.current?.focus() }} className={lightButton}><X size={14} aria-hidden="true" /></button>
    </div>}
    {modal === 'compare' && <CompareModal
      images={selectedImages}
      onClose={() => setModal(null)}
      returnFocus={() => compareButton.current?.focus()}
      onToggleFavorite={onToggleFavorite}
      onDelete={onDelete ? async id => {
        await onDelete(id)
        onSelected(previous => {
          if (!previous.has(id)) return previous
          const next = new Map(previous)
          next.delete(id)
          return next
        })
      } : undefined}
    />}
    {modal === 'naming' && <NamingSuggestionsModal images={selectedImages} onClose={() => setModal(null)} returnFocus={() => moreButton.current?.focus()}
      onChanged={image => {
        onChanged(image)
        onSelected(previous => {
          const next = new Map(previous)
          if (previous.has(image.id)) next.set(image.id, image.version || 0)
          return next
        })
      }} />}
  </section>
}
