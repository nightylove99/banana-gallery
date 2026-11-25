import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Folder } from 'lucide-react'
import type { GalleryAssetType, GalleryImage, ResultGroup } from '@/types'
import { useThumbnail } from '@/hooks/useThumbnail'
import { getThumbnailLoader } from '@/lib/thumbnail-loader'
import { ImageCard } from './ImageCard'
export type GridDensity = 'compact' | 'standard' | 'roomy'
export interface CollectionPreview { group: ResultGroup; count: number; cover?: GalleryImage; assetType: GalleryAssetType }
export interface GalleryAnchor { id: string; offset: number; kind?: 'image' | 'collection'; index?: number; top?: number }
export interface GalleryGridHandle { getAnchor: () => GalleryAnchor | null; restoreAnchor: (anchor: GalleryAnchor) => boolean; scrollToImage: (id: string, offset?: number, focus?: boolean) => boolean }
interface GalleryGridProps {
  images: GalleryImage[]; loading: boolean; emptyTitle: string; emptyDescription: string
  onOpen: (image: GalleryImage) => void; onToggleFavorite: (id: string) => void
  selected?: Map<string, number>; onSelect?: (image: GalleryImage) => void
  density?: GridDensity; fit?: 'cover' | 'contain'
  collections?: CollectionPreview[]; onOpenCollection?: (id: string) => void
  onAddToCollection?: (image: GalleryImage) => void
  onExtractRecipe?: (id: string) => void
  onDelete?: (id: string) => void
  pendingActions?: ReadonlySet<string>
}
export const GalleryGrid = forwardRef<GalleryGridHandle, GalleryGridProps>(function GalleryGrid({ images, loading, emptyTitle, emptyDescription, onOpen, onToggleFavorite, density = 'standard', fit = 'cover', selected, onSelect, collections = [], onOpenCollection, onAddToCollection, onExtractRecipe, onDelete, pendingActions }, ref) {
  const root = useRef<HTMLDivElement>(null)
  const [loadedThumbnails] = useState(() => new Set<string>())
  const lastTop = useRef(0)
  const lastTime = useRef(0)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const prefetches = useRef(new Map<string, AbortController>())
  const [viewport, setViewport] = useState({ width: 1000, height: 800, top: 0, direction: 'down' as 'up' | 'down', fast: false, speed: 0 })
  const saveData = !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData
  useEffect(() => {
    const element = root.current, container = element?.parentElement
    if (!element || !container) return
    const measure = () => {
      const top = container.scrollTop
      const direction = top < lastTop.current ? 'up' : 'down'
      const now = performance.now(), speed = Math.abs(top - lastTop.current) / Math.max(16, now-lastTime.current)
      const height = container.clientHeight || 800, fast = speed > height*2/1000
      lastTime.current = now
      lastTop.current = top
      setViewport({ width: container.clientWidth || 1000, height, top, direction, fast, speed })
      clearTimeout(settleTimer.current)
      if (fast) settleTimer.current=setTimeout(()=>setViewport(current=>({...current,fast:false,speed:0})),150)
    }
    let frame: number | null = null
    const scheduleMeasure = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => { frame = null; measure() })
    }
    measure(); container.addEventListener('scroll', scheduleMeasure, { passive: true })
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleMeasure) : null; observer?.observe(container)
    return () => {
      container.removeEventListener('scroll', scheduleMeasure)
      observer?.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
      clearTimeout(settleTimer.current)
    }
  }, [])
  const columns = Math.max(1, Math.floor((viewport.width - 40 + 12) / ({ compact: 150, standard: 220, roomy: 320 }[density] + 12)))
  const rowHeight = ((viewport.width - 40 - (columns - 1) * 12) / columns) * 1.5 + 12
  const total = collections.length + images.length
  const rows = Math.ceil(total / columns)
  const visibleStart = Math.min(Math.max(0,rows-1),Math.max(0, Math.floor((viewport.top - 20) / rowHeight)))
  const visibleEnd = Math.min(rows, Math.ceil((viewport.top + viewport.height - 20) / rowHeight))
  const visibleRows = Math.max(1, visibleEnd - visibleStart)
  const maxWindowRows = Math.max(visibleRows, Math.floor(120 / columns))
  const forwardScreens = Math.max(2,Math.min(6,Math.ceil(viewport.speed * (getThumbnailLoader()?.latencyMs || 200) / viewport.height)+1))
  const forwardRows = Math.min(visibleRows * forwardScreens, Math.max(0, maxWindowRows - visibleRows * 2))
  const beforeRows = saveData ? 0 : viewport.direction === 'up' ? forwardRows : visibleRows
  const afterRows = saveData ? 0 : viewport.direction === 'down' ? forwardRows : visibleRows
  const start = total > 60 ? Math.max(0, visibleStart - beforeRows) : 0
  const end = total > 60 ? Math.min(rows, visibleEnd + afterRows) : rows
  useEffect(() => {
    const loader=getThumbnailLoader(), desired=new Map<string,{filename:string;version:string}>()
    if(loader && !saveData && !loading) {
      const aheadStart=viewport.direction==='down' ? visibleEnd : Math.max(0,visibleStart-visibleRows*forwardScreens)
      const aheadEnd=viewport.direction==='down' ? Math.min(rows,visibleEnd+visibleRows*forwardScreens) : visibleStart
      for(let index=aheadStart*columns;index<aheadEnd*columns && desired.size<120;index++) {
        const image=index<collections.length ? collections[index]?.cover : images[index-collections.length]
        if(image?.thumbnailVersion)desired.set(JSON.stringify([image.filename,image.thumbnailVersion,viewport.fast]),{filename:image.filename,version:image.thumbnailVersion})
      }
    }
    for(const [key,controller] of prefetches.current)if(!desired.has(key)){controller.abort();prefetches.current.delete(key)}
    if(loader)for(const [key,image] of desired)if(!prefetches.current.has(key)){
      const controller=new AbortController();prefetches.current.set(key,controller)
      void loader.acquire({...image,size:viewport.fast?'preview':'standard',priority:'background'},controller.signal).then(lease=>lease.release(),()=>{})
    }
  },[images,collections,columns,rows,visibleStart,visibleEnd,visibleRows,forwardScreens,viewport.direction,viewport.fast,saveData,loading])
  useEffect(()=>{
    const requests=prefetches.current
    return ()=>{for(const controller of requests.values())controller.abort();requests.clear()}
  },[])
  useImperativeHandle(ref, () => {
    const scrollToIndex = (index: number, offset = 0, focusId?: string) => {
      const container = root.current?.parentElement
      if (index < 0 || !container) return false
      const top = Math.max(0, 20 + Math.floor(index / columns) * rowHeight - offset)
      container.scrollTop = top
      // The browser clamps near the end. Virtualization must use the actual position.
      const actualTop = container.scrollTop
      const direction = actualTop < lastTop.current ? 'up' : 'down'
      const now = performance.now(), speed = Math.abs(actualTop-lastTop.current)/Math.max(16,now-lastTime.current)
      const fast = speed > viewport.height*2/1000
      lastTop.current = actualTop; lastTime.current = now
      setViewport(current => ({ ...current, top: actualTop, direction, fast, speed }))
      clearTimeout(settleTimer.current)
      if (fast) settleTimer.current = setTimeout(() => setViewport(current => ({...current, fast:false, speed:0})), 150)
      if (focusId) requestAnimationFrame(() => document.getElementById(`asset-${focusId}`)?.focus({ preventScroll:true }))
      return true
    }
    return {
      getAnchor() {
        const container = root.current?.parentElement
        if (!container || !total) return null
        const index = Math.min(total-1, Math.max(0, Math.floor((container.scrollTop-20)/rowHeight)*columns))
        const collection = collections[index], image = images[index-collections.length]
        return { id: collection?.group.id || image.id, kind: collection ? 'collection' : 'image', index, top: container.scrollTop, offset: 20 + Math.floor(index/columns)*rowHeight-container.scrollTop }
      },
      restoreAnchor(anchor) {
        const found = anchor.kind === 'collection' ? collections.findIndex(item => item.group.id === anchor.id) : images.findIndex(image => image.id === anchor.id)
        const index = found >= 0 ? found + (anchor.kind === 'collection' ? 0 : collections.length) : Math.max(0, Math.min(total-1, anchor.index || 0))
        return scrollToIndex(index, anchor.offset)
      },
      scrollToImage(id, offset = 0, focus = false) {
        const index = images.findIndex(image => image.id === id)
        return index >= 0 && scrollToIndex(index + collections.length, offset, focus ? id : undefined)
      },
    }
  }, [images, collections, total, columns, rowHeight, viewport.height])
  return <div ref={root} style={{ height: total ? 20 + rows * rowHeight : 256, position: 'relative' }} data-gallery-grid>
    {loading ? <div className="flex h-64 items-center justify-center text-zinc-500">加载中…</div> : total === 0 ? <div className="flex h-64 flex-col items-center justify-center gap-3 px-5 text-center text-zinc-500"><span className="text-4xl">🍌</span><p>{emptyTitle}</p><p className="text-sm">{emptyDescription}</p></div> : <div style={{ position: 'absolute', top: 20 + start * rowHeight, left: 20, right: 20, display: 'grid', gridTemplateColumns: `repeat(${columns},minmax(0,1fr))`, gap: 12 }}>
      {Array.from({ length: (end - start) * columns }, (_, offset) => {
        const index = start * columns + offset
        const row = Math.floor(index / columns)
        const fetchPriority = row >= visibleStart && row < visibleEnd ? 'high' : 'low'
        const collection = collections[index]
        if (collection) return <CollectionCard key={`collection-${collection.group.id}-${collection.cover?.filename}-${collection.cover?.thumbnailVersion}`} collection={collection} fit={fit} fetchPriority={fetchPriority} preview={viewport.fast} prepare={!saveData || fetchPriority==='high'} onOpen={() => onOpenCollection?.(collection.group.id)} />
        const image = images[index - collections.length]
        const thumbnailKey=image ? `${image.filename}:${image.thumbnailVersion || ''}` : ''
        return image ? <ImageCard key={`${image.id}:${thumbnailKey}`} image={image} fit={fit} loading="eager" fetchPriority={fetchPriority} preview={viewport.fast} prepare={!saveData || fetchPriority==='high'} initiallyLoaded={loadedThumbnails.has(thumbnailKey)} onImageLoad={() => loadedThumbnails.add(thumbnailKey)} selected={selected?.has(image.id)} onSelect={onSelect} onOpen={onOpen} onToggleFavorite={onToggleFavorite} onAddToCollection={onAddToCollection}
          compact={density === 'compact'} onExtractRecipe={onExtractRecipe} onDelete={onDelete}
          extracting={pendingActions?.has(`extract:${image.id}`)} deleting={pendingActions?.has(`delete:${image.id}`)} /> : null
      })}
    </div>}
  </div>
})
function CollectionCard({ collection: { group, count, cover, assetType }, onOpen, fit, fetchPriority, preview, prepare }: { collection: CollectionPreview; onOpen: () => void; fit: 'cover' | 'contain'; fetchPriority: 'high' | 'low'; preview:boolean;prepare:boolean }) {
  const [failed, setFailed] = useState(false)
  const thumbnail=useThumbnail(cover,{preview,priority:fetchPriority,enabled:prepare})
  return <button data-collection-id={group.id} aria-label={`打开收藏夹 ${group.name}`} onClick={onOpen} className="group relative aspect-[2/3] overflow-hidden rounded-lg border border-indigo-400/20 bg-[#171726] text-left transition-colors hover:border-indigo-400/60 focus-visible:outline-2 focus-visible:outline-indigo-400">
    {cover && !failed && !thumbnail.error ? <img src={thumbnail.src} data-thumbnail-size={thumbnail.size} alt="" decoding="async" loading="eager" fetchPriority={fetchPriority} onError={() => setFailed(true)} className={`h-full w-full ${fit === 'contain' ? 'object-contain' : 'object-cover'} opacity-80 transition-transform duration-300 motion-safe:group-hover:scale-[1.03]`} /> : <div className="flex h-full items-center justify-center pb-12 text-indigo-300/30"><Folder size={64} strokeWidth={1} /></div>}
    <div className="absolute inset-0 bg-gradient-to-t from-[#11111e] via-transparent to-black/20" />
    <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded-md bg-black/50 px-2 py-1 text-xs text-indigo-100"><Folder size={13} />收藏夹</span>
    <div className="absolute inset-x-0 bottom-0 space-y-1 p-4"><p className="line-clamp-2 font-medium text-white">{group.name}</p><p className="text-xs text-zinc-400">{count} 张{assetType === 'work' ? '作品' : '配方'}</p></div>
  </button>
}
