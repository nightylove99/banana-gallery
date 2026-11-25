import { useGalleryPosition } from '@/hooks/useGalleryPosition'
import { CollectionDialog, CollectionManager } from '@/components/CollectionDialog'
import { fetchPreferences, preferenceRequest } from '@/lib/preferences'
import { OrganizationBar } from '@/components/OrganizationBar'
import type { ResultGroup } from '@/types'
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { CheckSquare, ChevronDown, FolderCog, Heart, History, RefreshCw, Search, ImagePlus } from 'lucide-react'
import { ActionMenu } from '@/components/ui/action-menu'
import { Sidebar } from '@/components/Sidebar'
import { GalleryGrid, type GalleryGridHandle, type GridDensity } from '@/components/GalleryGrid'
import { GallerySearch } from '@/components/GallerySearch'
import { DetailModal } from '@/components/DetailModal'
import { UploadModal } from '@/components/UploadModal'
import { useGallery } from '@/hooks/useGallery'
import { useSession } from '@/auth/useSession'
import { getEmptyState, getHeaderTitle } from '@/lib/gallery-view'
import { assetTitle, galleryQueryFromParams, galleryQueryToParams, type GalleryQuery } from '@/lib/gallery-query'
import type { GalleryAssetType, GalleryImage, PersonalPreferences, ViewFilter } from '@/types'
import { toast } from 'sonner'
import { createRecipeFromImage, fetchImage, restoreImage, imageAssetUrl } from '@/api'
function readPreference<T>(key: string, fallback: T): T { try { const raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback } catch { return fallback } }
function writePreference(key: string, value: unknown) { try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* Preference failure does not block gallery use. */ } }
export default function GalleryPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const routeState = location.state as { filter?: ViewFilter; assetType?: GalleryAssetType; newCollection?: boolean; openImageId?: string } | null
  const { session } = useSession()
  const storageKey = session ? `banana-gallery-view:${JSON.stringify([session.user.id, session.workspace.id])}` : null
  const [controlsOpen, setControlsOpen] = useState(false)
  const controlsToggleRef = useRef<HTMLButtonElement>(null)
  const galleryMenuRef = useRef<HTMLButtonElement>(null)
  const selectModeRef = useRef<HTMLButtonElement>(null)
  const exitSelectRef = useRef<HTMLButtonElement>(null)
  const restoreSelectionFocus = useRef(false)
  const collectionReturnFocus = useRef<(() => void) | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (controlsOpen) searchInputRef.current?.focus({ preventScroll: true }) }, [controlsOpen])
  const [density, setDensity] = useState<GridDensity>(() => storageKey ? readPreference(storageKey + ':density', 'standard') : 'standard')
  const [fit, setFit] = useState<'cover' | 'contain'>(() => storageKey ? readPreference(storageKey + ':fit', 'cover') : 'cover')
  type Appearance = NonNullable<PersonalPreferences['gallery']>
  const appearanceWrites = useRef(Promise.resolve())
  const appearanceEdits = useRef(new Set<keyof Appearance>())

  useEffect(() => {
    if (!storageKey) return
    let active = true
    void fetchPreferences().then(({ gallery }) => {
      if (!active || !gallery) return
      if (!appearanceEdits.current.has('density')) setDensity(readPreference(storageKey + ':density', gallery.density))
      if (!appearanceEdits.current.has('fit')) setFit(readPreference(storageKey + ':fit', gallery.fit))
    }).catch(() => {})
    return () => { active = false }
  }, [storageKey])

  function persistAppearance<K extends keyof Appearance>(key: K, value: Appearance[K]) {
    if (!storageKey) return
    appearanceEdits.current.add(key)
    writePreference(`${storageKey}:${key}`, value)
    // Preserve the order of rapid changes and avoid overwriting the other
    // control from a different browser or an earlier server snapshot.
    appearanceWrites.current = appearanceWrites.current.then(async () => {
      await preferenceRequest('/preferences', 'PATCH', { gallery: { [key]: value } })
    }).catch(() => {})
  }
  const [collectionImages, setCollectionImages] = useState<string[] | null>(() => routeState?.newCollection ? [] : null)
  const [managingCollection, setManagingCollection] = useState(false)
  const [selected, setSelected] = useState<Map<string, number>>(new Map())
  const [selecting, setSelecting] = useState(false)
  useEffect(() => {
    if (selecting) {
      exitSelectRef.current?.focus({ preventScroll: true })
      return
    }
    if (!restoreSelectionFocus.current) return
    restoreSelectionFocus.current = false
    selectModeRef.current?.focus({ preventScroll: true })
  }, [selecting])
  const gridRef = useRef<GalleryGridHandle>(null)
  const [initialQuery] = useState(() => galleryQueryFromParams(new URLSearchParams(location.search || (storageKey ? readPreference(storageKey + ':query', '') : ''))))
  const gallery = useGallery(initialQuery)
  const { setAssetType, setFilter, setQuery, groups, groupsLoading, groupsError, reloadGroups, setGroups } = gallery
  const sidebarTag = gallery.filter.startsWith('tag:') ? gallery.filter.slice(4) : ''
  const viewQuery = { ...gallery.query, assetType: gallery.assetType, favorites: gallery.filter === 'favorites', tags: [...new Set([...(gallery.query.tags || []), ...(sidebarTag ? [sidebarTag] : [])])].sort() }
  const hasImageFilters = [viewQuery.q?.trim(), viewQuery.inbox, viewQuery.source, viewQuery.model, viewQuery.dateFrom, viewQuery.dateTo, viewQuery.pinned, viewQuery.favorites, viewQuery.tags.length].some(Boolean)
  const activeConditionCount = [
    viewQuery.q?.trim(), viewQuery.inbox, viewQuery.source, viewQuery.model, viewQuery.dateFrom, viewQuery.dateTo,
    viewQuery.pinned, viewQuery.favorites, viewQuery.pinFirst === false, viewQuery.sort && viewQuery.sort !== 'newest',
  ].filter(Boolean).length + viewQuery.tags.length
  const updateSearch = (query: GalleryQuery) => {
    setQuery(query)
    if (!sidebarTag || !query.tags?.includes(sidebarTag)) setFilter(query.favorites ? 'favorites' : 'all')
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0
  }
  const activeGroup = groups.find(group => group.id === gallery.query.groupId && (group.assetType || 'recipe') === gallery.assetType)
  const overview = gallery.query.view !== 'all' && !gallery.query.groupId && gallery.filter === 'all' && !hasImageFilters
  const collections = useMemo(() => {
    const images = new Map(gallery.allImages.filter(image => image.assetType === gallery.assetType && !image.deletedAt).map(image => [image.id, image]))
    return groups.filter(group => (group.assetType || 'recipe') === gallery.assetType).map(group => {
      const members = group.imageIds.flatMap(id => images.get(id) ? [images.get(id)!] : [])
      return { group, count: members.length, cover: images.get(group.coverId || '') || members[0], assetType: gallery.assetType }
    })
  }, [groups, gallery.allImages, gallery.assetType])
  const visibleImages = useMemo(() => {
    if (gallery.query.groupId) {
      const members = new Set(activeGroup?.imageIds)
      return gallery.images.filter(image => members.has(image.id))
    }
    if (overview && !groupsError) {
      const collected = new Set(groups.filter(group => (group.assetType || 'recipe') === gallery.assetType).flatMap(group => group.imageIds))
      return gallery.images.filter(image => !collected.has(image.id))
    }
    return gallery.images
  }, [gallery.images, gallery.query.groupId, activeGroup, overview, groups, groupsError, gallery.assetType])
  const pendingActionsRef = useRef(new Set<string>())
  const [pendingActions, setPendingActions] = useState<ReadonlySet<string>>(new Set())
  const [selectedImage, setSelectedImage] = useState<GalleryImage | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [recentIds, setRecentIds] = useState<string[]>(() => storageKey ? readPreference(storageKey + ':recent', []) : [])
  const scrollContainer = useRef<HTMLDivElement>(null)
  const detailOffset = useRef(0)
  const viewValue = galleryQueryToParams(viewQuery).toString()
  const { capture: capturePosition, requestRestore } = useGalleryPosition({ storageKey, query: viewValue, content: visibleImages, ready: !gallery.loading && !gallery.loadingMore && !gallery.error && !groupsLoading && !groupsError, grid: gridRef, container: scrollContainer })
  const resetSelection = () => { setSelected(new Map()); setSelecting(false) }
  const openOverview = () => { setQuery({ view: 'overview' }); setFilter('all'); resetSelection() }
  const openCollection = (groupId: string) => { setQuery({ groupId, view: 'all' }); setFilter('all'); resetSelection() }
  const openFilter = (filter: ViewFilter) => { setQuery({ view: 'all' }); setFilter(filter); resetSelection() }
  const switchAssetType = (assetType: GalleryAssetType) => { setAssetType(assetType); setFilter('all'); if (assetType !== gallery.assetType) setQuery({ view: 'overview' }); resetSelection() }
  const saveCollection = (group: ResultGroup) => {
    setGroups(previous => previous.some(item => item.id === group.id) ? previous.map(item => item.id === group.id ? group : item) : [...previous, group])
    if (selecting) restoreSelectionFocus.current = true
    resetSelection()
    toast.success(collectionImages?.length ? '已加入收藏夹' : '收藏夹已保存')
  }
  const addToCollection = (ids: string[], returnFocus?: () => void) => {
    if (groupsLoading || groupsError) { toast.error('请先刷新收藏夹后重试'); return }
    collectionReturnFocus.current = returnFocus ?? null
    setCollectionImages(ids)
  }
  const lastUrl = useRef(location.search)
  const skipUrlWrite = useRef(false)

  useEffect(() => {
    if (location.search === lastUrl.current) return
    const query = galleryQueryFromParams(new URLSearchParams(location.search))
    lastUrl.current = location.search; skipUrlWrite.current = true
    setQuery(query); setAssetType(query.assetType || 'recipe'); setFilter(query.favorites ? 'favorites' : 'all')
  }, [location.search, setAssetType, setFilter, setQuery])
  useEffect(() => {
    if (skipUrlWrite.current) { skipUrlWrite.current = false; return }
    if (routeState?.openImageId) return
    const query = { ...gallery.query, assetType: gallery.assetType, favorites: gallery.filter === 'favorites', tags: [...new Set([...(gallery.query.tags || []), ...(gallery.filter.startsWith('tag:') ? [gallery.filter.slice(4)] : [])])] }
    const value = galleryQueryToParams(query).toString()
    if (storageKey) writePreference(storageKey + ':query', value)
    if (`?${value}` !== location.search) { lastUrl.current = `?${value}`; navigate({ pathname: location.pathname, search: value }, { replace: true, state: location.state }) }
  }, [gallery.query, gallery.assetType, gallery.filter, location.pathname, location.search, location.state, navigate, routeState?.openImageId, storageKey])
  useEffect(() => {
    const state = routeState
    if (state?.openImageId || (!state?.filter && !state?.assetType && !state?.newCollection)) return
    if (state.assetType) setAssetType(state.assetType)
    if (state.filter) { setFilter(state.filter); setQuery({ view: 'all' }) }
    navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null })
  }, [routeState, location.pathname, location.search, navigate, setAssetType, setFilter, setQuery])
  const remember = (image: GalleryImage) => {
    setRecentIds(previous => {
      const ids = [image.id, ...previous.filter(id => id !== image.id)].slice(0, 30)
      if (storageKey) writePreference(storageKey + ':recent', ids)
      return ids
    })
  }
  const openImage = (image: GalleryImage) => {
    const card = document.getElementById(`asset-${image.id}`)
    const container = scrollContainer.current
    const offset = card && container ? card.getBoundingClientRect().top - container.getBoundingClientRect().top : 0
    detailOffset.current = offset >= 0 && offset < (container?.clientHeight || 0) ? offset : 0
    capturePosition()
    remember(image); setSelectedImage(image)
  }
  const findRouteImage = useEffectEvent((id: string) => gallery.allImages.find(image => image.id === id))
  const openRouteImage = useEffectEvent((image: GalleryImage, fetched: boolean) => {
    if (fetched) gallery.addImage(image)
    setAssetType(image.assetType)
    openImage(image)
  })
  useEffect(() => {
    const id = routeState?.openImageId
    if (!id) return

    const { pathname, search, hash } = location
    const assetType = routeState.assetType
    if (assetType) setAssetType(assetType)
    let active = true
    void (async () => {
      try {
        const cached = findRouteImage(id)
        const image = cached ?? await fetchImage(id, 'no-store')
        if (!active) return
        if (image.id !== id || image.deletedAt || (assetType && image.assetType !== assetType)) throw new Error('作品已移入回收站或不存在')
        openRouteImage(image, !cached)
      } catch {
        if (active) toast.error('无法打开作品，可能已移入回收站或读取失败')
      } finally {
        if (active) navigate({ pathname, search, hash }, { replace: true, state: null })
      }
    })()
    return () => { active = false }
  }, [location, routeState, navigate, setAssetType])
  const closeImage = () => {
    const id = selectedImage?.id; setSelectedImage(null)
    setTimeout(() => {
      if (id) gridRef.current?.scrollToImage(id, detailOffset.current, true)
    }, 0)
  }
  const runCardAction = async (key: string, action: () => Promise<void>, failure: string) => {
    const pending = pendingActionsRef.current
    if (pending.has(key)) return
    pending.add(key)
    setPendingActions(new Set(pending))
    try { await action() }
    catch (error) { toast.error(error instanceof Error ? `${failure}：${error.message}` : failure) }
    finally { pending.delete(key); setPendingActions(new Set(pending)) }
  }
  const extractRecipe = (id: string) => runCardAction(`extract:${id}`, async () => {
    const recipe = await createRecipeFromImage(id)
    gallery.addImage(recipe)
    toast.success('已提炼为配方', { action: { label: '查看配方', onClick: () => {
      setAssetType('recipe')
      setFilter('all')
      setQuery({ view: 'all' })
      resetSelection()
      openImage(recipe)
    } } })
  }, '提炼失败，请重试')
  const removeWithUndo = async (id: string) => {
    const { moved, version } = await gallery.removeImage(id)
    if (!moved) return
    toast.success('已移入回收站', { action: { label: '撤销', onClick: () => {
      void restoreImage(id, version).then(gallery.addImage)
        .catch(error => toast.error(error instanceof Error ? error.message : '恢复失败'))
        .finally(() => { void gallery.refreshTrashCount() })
    } } })
  }
  const deleteCard = (id: string) => runCardAction(`delete:${id}`, () => removeWithUndo(id), '移入回收站失败，请重试')
  const selectedIndex = visibleImages.findIndex(image => image.id === selectedImage?.id)
  useEffect(() => {
    if (!selectedImage) return
    const neighbors = [visibleImages[selectedIndex-1], visibleImages[selectedIndex+1]].filter(Boolean)
    const preloads = neighbors.map(image => { const preload=new Image(); preload.src=imageAssetUrl(image.filename); return preload })
    return () => { for (const preload of preloads) preload.src='' }
  }, [selectedImage, selectedIndex, visibleImages])
  const emptyState = getEmptyState(gallery.assetType, gallery.filter)
  const selectionMode = selecting || selected.size > 0
  const singleSelected = selected.size === 1 ? gallery.allImages.find(image => selected.has(image.id)) : null
  const samePromptCandidates = singleSelected?.prompt.trim()
    ? gallery.allImages.filter(image => image.assetType === singleSelected.assetType && image.prompt.trim() === singleSelected.prompt.trim())
    : []
  const selectionBusy = gallery.loading || gallery.loadingMore || groupsLoading
  const exitSelection = () => {
    restoreSelectionFocus.current = true
    setSelected(new Map())
    setSelecting(false)
  }
  return <div className="flex h-screen w-screen overflow-hidden bg-[#0a0a10] text-zinc-200 dark">
    <Sidebar currentPage="gallery" onOpenTrash={() => {
      capturePosition()
      navigate('/trash', { state: { gallerySearch: viewValue } })
    }} assetType={gallery.assetType} filter={gallery.filter} onAssetTypeChange={switchAssetType} onFilterChange={openFilter} overview={overview} onOverview={openOverview} collections={collections.map(({ group, count }) => ({ id: group.id, name: group.name, count }))} collectionId={gallery.query.groupId} onOpenCollection={openCollection} onNewCollection={() => addToCollection([])} tags={gallery.tags} workCount={gallery.workCount} recipeCount={gallery.recipeCount} favoriteCount={gallery.favoriteCount} />
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="relative z-20 flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[#1E2336] px-5 py-3">
        {selectionMode ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <span role="status" className="mr-1.5 text-sm font-medium tabular-nums text-indigo-200">已选 {selected.size} 项</span>
            <button type="button" disabled={selectionBusy || !visibleImages.length || visibleImages.length > 500}
              title={visibleImages.length > 500 ? '请缩小筛选范围后全选' : undefined}
              onClick={() => setSelected(new Map(visibleImages.map(image => [image.id, image.version || 0])))}
              className="rounded-lg px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-white/5 hover:text-white disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-indigo-400">全选当前</button>
            <button type="button" disabled={!selected.size}
              onClick={() => setSelected(new Map())}
              className="rounded-lg px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-white/5 hover:text-white disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-indigo-400">取消全选</button>
            {samePromptCandidates.length > 1 && (
              <button type="button" disabled={selectionBusy || samePromptCandidates.length > 500}
                title={samePromptCandidates.length > 500 ? '同提示词候选超过可一次选择的数量' : undefined}
                onClick={() => setSelected(new Map(samePromptCandidates.map(image => [image.id, image.version || 0])))}
                className="rounded-lg px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-white/5 hover:text-white disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-indigo-400">选中同提示词 ({samePromptCandidates.length})</button>
            )}
          </div>
        ) : (
          <h1 className="flex min-w-0 flex-wrap items-baseline gap-1.5 text-sm font-medium text-zinc-200">{gallery.filter === 'favorites' && <Heart size={13} className="fill-rose-400 text-rose-400" />}{gallery.query.groupId ? activeGroup?.name || '收藏夹' : overview ? '概览' : getHeaderTitle(gallery.assetType, gallery.filter)}{!gallery.loading && <span className="ml-1 text-xs font-normal text-zinc-500">{overview && collections.length > 0 ? `${collections.length} 个收藏夹 · ${visibleImages.length} 张` : `${visibleImages.length} 张`}</span>}</h1>
        )}
        <div className="flex min-w-0 items-center gap-1">
          <button ref={controlsToggleRef} aria-label={activeConditionCount ? `搜索与显示，${activeConditionCount} 项条件已启用` : '搜索与显示'} aria-expanded={controlsOpen} aria-controls="gallery-controls" title={controlsOpen ? '收起搜索与显示（Esc），保留当前条件' : '展开搜索、筛选与显示选项'} onClick={() => setControlsOpen(open => !open)} className={`inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-indigo-400 ${controlsOpen || activeConditionCount ? 'bg-indigo-500/10 text-indigo-300' : 'text-zinc-400 hover:bg-zinc-900 hover:text-white'}`}>
            <Search size={15} aria-hidden="true" />搜索与显示
            {activeConditionCount > 0 && <span aria-hidden="true" className="rounded-full bg-indigo-500/20 px-1.5 text-xs tabular-nums">{activeConditionCount}</span>}
            <ChevronDown size={14} aria-hidden="true" className={`transition-transform duration-150 motion-reduce:transition-none ${controlsOpen ? 'rotate-180' : ''}`} />
          </button>
          {selectionMode ? (
            <button ref={exitSelectRef} type="button" onClick={exitSelection} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white/5 px-3 text-sm text-zinc-200 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-indigo-400">退出多选</button>
          ) : (
            <>
              <button ref={selectModeRef} type="button" onClick={() => setSelecting(true)} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm text-zinc-400 hover:bg-white/5 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-indigo-400"><CheckSquare size={15} aria-hidden="true" />多选整理</button>
              <select aria-label="网格密度" title="网格密度" value={density} onChange={event => { const value = event.target.value as GridDensity; setDensity(value); persistAppearance('density', value) }} className="h-8 rounded-lg border border-white/10 bg-[#101018] px-2 text-xs text-zinc-300 transition-colors hover:border-white/20 hover:text-white focus-visible:outline-2 focus-visible:outline-indigo-400">
                <option value="compact">紧凑</option>
                <option value="standard">标准</option>
                <option value="roomy">宽松</option>
              </select>
              <select aria-label="图片构图" title="图片构图" value={fit} onChange={event => { const value = event.target.value as 'cover' | 'contain'; setFit(value); persistAppearance('fit', value) }} className="h-8 rounded-lg border border-white/10 bg-[#101018] px-2 text-xs text-zinc-300 transition-colors hover:border-white/20 hover:text-white focus-visible:outline-2 focus-visible:outline-indigo-400">
                <option value="cover">填充裁切</option>
                <option value="contain">完整构图</option>
              </select>
              {activeGroup && <button aria-label="管理收藏夹" onClick={() => setManagingCollection(true)} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm text-zinc-400 hover:bg-white/5 hover:text-zinc-100"><FolderCog size={15} /><span className="hidden sm:inline">管理收藏夹</span><span className="sr-only sm:hidden">管理收藏夹</span></button>}
              <ActionMenu label="图库更多操作" triggerRef={galleryMenuRef}>
                {recentIds.length > 0 && <div className="mb-1 border-b border-zinc-700/60 px-3 pb-2 pt-2">
                  <label className="mb-2 flex items-center gap-2 text-xs text-zinc-500"><History size={14} />最近浏览</label>
                  <select aria-label="最近浏览" value="" onChange={event => { const image = gallery.allImages.find(image => image.id === event.target.value); if (image) { setAssetType(image.assetType); setFilter('all'); setQuery({ view: 'all' }); openImage(image) } }} className="w-full rounded-md border border-zinc-700/60 bg-zinc-900 p-2 text-xs text-zinc-300"><option value="">选择最近浏览的条目</option>{recentIds.flatMap(id => { const image = gallery.allImages.find(image => image.id === id); return image ? [<option key={id} value={id}>{assetTitle(image) || image.prompt.slice(0, 25)}</option>] : [] })}</select>
                  <button aria-label="清空最近浏览" onClick={() => { setRecentIds([]); if (storageKey) writePreference(storageKey + ':recent', []) }} className="mt-1 text-zinc-500">清空浏览记录</button>
                </div>}
                <button aria-label="刷新图库" onClick={() => { void gallery.reload().catch(() => {}); void reloadGroups().catch(() => {}) }}><RefreshCw size={14} />刷新图库</button>
                <button onClick={() => setUploadOpen(true)}><ImagePlus size={14} aria-hidden="true" />导入外部图片</button>
              </ActionMenu>
            </>
          )}
        </div>
      </header>
      {gallery.query.groupId && <div className="flex items-center gap-3 border-b border-zinc-800 px-5 py-2 text-xs text-zinc-400"><button onClick={openOverview} className="text-indigo-300 hover:text-indigo-200">← 返回概览</button><span>当前收藏夹 · {gallery.assetType === 'work' ? '作品' : '配方'}</span><button onClick={() => openFilter('all')} className="ml-auto">浏览全部图片</button></div>}
      {groupsError && <div role="alert" className="flex items-center justify-between bg-amber-950/40 px-5 py-2 text-sm text-amber-200"><span>{groupsError}</span><button onClick={() => void reloadGroups().catch(() => {})}>重试收藏夹</button></div>}
      {gallery.error && <div role="alert" className="flex items-center justify-between bg-red-950/40 px-5 py-2 text-sm text-red-300"><span>{gallery.error}，已有内容会保留。</span><button onClick={() => { void gallery.reload().catch(() => {}); void reloadGroups().catch(() => {}) }}>重试刷新</button></div>}
      {gallery.pendingImages && <div role="status" className="flex items-center justify-between bg-indigo-950/50 px-5 py-2 text-sm text-indigo-200"><span>{gallery.pendingCount ? `新增 ${gallery.pendingCount} 张` : '图库内容有更新'}</span><button onClick={() => {
        capturePosition()
        requestRestore(); gallery.applyPending()
      }}>加载更新</button></div>}
      {gallery.loadingMore && <div role="status" className="px-5 py-1 text-xs text-zinc-400">正在加载：{gallery.allImages.length} / {gallery.total} 条，筛选结果仍在补全…</div>}
      <div id="gallery-controls" hidden={!controlsOpen} className="relative z-10 max-h-[45dvh] shrink-0 overflow-y-auto" onKeyDown={event => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.target instanceof HTMLSelectElement) return
        event.preventDefault(); event.stopPropagation(); setControlsOpen(false); controlsToggleRef.current?.focus({ preventScroll: true })
      }}>
        <GallerySearch searchInputRef={searchInputRef} images={gallery.allImages.filter(image => image.assetType === gallery.assetType)}
          query={viewQuery} onChange={updateSearch} onClear={() => updateSearch({ groupId: gallery.query.groupId, view: gallery.query.view })} />
      </div>
      <OrganizationBar key={JSON.stringify([gallery.assetType, gallery.query.groupId, gallery.query.view, gallery.filter])} hideSelectionBar onAddToCollection={addToCollection}
        onToggleFavorite={async id => { try { await gallery.toggleFavorite(id) } catch (error) { toast.error(error instanceof Error ? error.message : '喜欢操作失败') } }}
        onDelete={deleteCard}
        images={visibleImages} allImages={gallery.allImages} loadingMore={gallery.loading || gallery.loadingMore || groupsLoading}
        selected={selected} onSelected={setSelected} selecting={selecting} onSelecting={value => {
          if (!value) restoreSelectionFocus.current = true
          setSelecting(value)
        }} onChanged={gallery.replaceImage} groups={groups.filter(group => (group.assetType || 'recipe') === gallery.assetType)}
        groupId={gallery.query.groupId || ''} reloadGroups={reloadGroups} />
      <div ref={scrollContainer} className={`flex-1 overflow-y-auto ${selecting || selected.size > 0 ? 'pb-[calc(5.25rem+max(0.75rem,env(safe-area-inset-bottom)))] sm:pb-[calc(3.25rem+max(0.75rem,env(safe-area-inset-bottom)))]' : ''}`} onScroll={() => { if (!selectedImage) capturePosition() }}>
        {gallery.query.groupId && !activeGroup && !groupsLoading && !groupsError && <button onClick={openOverview} className="m-5 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200">返回概览</button>}
        <GalleryGrid onExtractRecipe={extractRecipe} onDelete={deleteCard} pendingActions={pendingActions} collections={overview && !groupsError ? collections : []} onOpenCollection={openCollection} onAddToCollection={image => addToCollection([image.id])} selected={selected} onSelect={selecting ? image=>setSelected(previous=>{const next=new Map(previous);if(next.has(image.id))next.delete(image.id);else next.set(image.id,image.version||0);return next}) : undefined} ref={gridRef} density={density} fit={fit} images={visibleImages} loading={gallery.loading || groupsLoading} emptyTitle={gallery.query.groupId && !activeGroup && !groupsLoading ? '收藏夹不存在或已被删除' : activeGroup && !hasImageFilters ? '这个收藏夹还没有当前类型的图片' : gallery.allImages.length ? '没有匹配的条目' : emptyState.title} emptyDescription={gallery.query.groupId && !hasImageFilters ? '可以返回概览选择图片加入，或切换作品 / 配方。' : gallery.allImages.length ? '试试减少关键词或清除筛选条件。' : emptyState.description} onOpen={openImage} onToggleFavorite={async id => { try { await gallery.toggleFavorite(id) } catch (error) { toast.error(error instanceof Error ? error.message : '喜欢操作失败') } }} />
      </div>
    </main>
    <DetailModal onAddToCollection={image => addToCollection([image.id])} relatedImages={selectedImage ? gallery.allImages.filter(image=>image.id===selectedImage.sourceAssetId||image.sourceAssetId===selectedImage.id) : []} onOpenRelated={openImage} image={selectedImage} onClose={closeImage} keepOpenAfterDelete
      onPrevious={selectedIndex > 0 ? () => openImage(visibleImages[selectedIndex - 1]) : undefined}
      onNext={selectedIndex >= 0 && selectedIndex < visibleImages.length - 1 ? () => openImage(visibleImages[selectedIndex + 1]) : undefined}
      positionLabel={selectedIndex >= 0 ? `${selectedIndex + 1} / ${visibleImages.length}` : '当前条目不在筛选范围'}
      onReload={async () => { if (!selectedImage) return; try { const updated = await fetchImage(selectedImage.id); gallery.replaceImage(updated); setSelectedImage(updated) } catch (error) { toast.error(error instanceof Error ? error.message : '读取失败') } }}
      onToggleFavorite={async id => { try { const updated = await gallery.toggleFavorite(id); if (updated) setSelectedImage(previous => previous?.id === id ? updated : previous) } catch (error) { toast.error(error instanceof Error ? error.message : '喜欢操作失败') } }}
      onUpdateMetadata={async (id, updates, version) => { const updated = await gallery.updateImage(id, updates, version); setSelectedImage(previous => previous?.id === id ? updated : previous); return updated }}
      onUpdateTags={async (id, tags, version) => { const updated = await gallery.updateImage(id, { tags }, version); setSelectedImage(previous => previous?.id === id ? updated : previous); return updated }}
      onUpdatePrompt={async (id, prompt, version) => { const updated = await gallery.updateImage(id, { prompt }, version); setSelectedImage(previous => previous?.id === id ? updated : previous); return updated }}
      onReferencesUpdated={updated => { gallery.replaceImage(updated); setSelectedImage(previous => previous?.id === updated.id ? updated : previous) }}
      onExtractRecipe={extractRecipe} extracting={!!selectedImage && pendingActions.has(`extract:${selectedImage.id}`)}
      onDelete={async id => { const next = visibleImages[selectedIndex + 1] || visibleImages[selectedIndex - 1] || null; await removeWithUndo(id); if (next) openImage(next); else setSelectedImage(null) }} />
    {collectionImages !== null && <CollectionDialog assetType={gallery.allImages.find(image => image.id === collectionImages[0])?.assetType || gallery.assetType} imageIds={collectionImages} groups={groups} onSaved={saveCollection} onRefresh={reloadGroups} onClose={() => setCollectionImages(null)}
      returnFocus={collectionReturnFocus.current ? () => {
        if (selectModeRef.current) selectModeRef.current.focus({ preventScroll: true })
        else collectionReturnFocus.current?.()
        collectionReturnFocus.current = null
      } : undefined} />}
    {managingCollection && activeGroup && <CollectionManager group={activeGroup} images={gallery.allImages.filter(image => image.assetType === gallery.assetType)} onSaved={saveCollection} onRefresh={reloadGroups} onDeleted={() => { setGroups(previous => previous.filter(group => group.id !== activeGroup.id)); openOverview(); toast.success('已删除收藏夹，图片已保留') }} onClose={() => setManagingCollection(false)} />}
    <UploadModal returnFocus={() => galleryMenuRef.current?.focus({ preventScroll: true })} open={uploadOpen} onClose={() => setUploadOpen(false)} onUploaded={image => { gallery.addImage(image); toast.success('上传成功！') }} />
  </div>
}
