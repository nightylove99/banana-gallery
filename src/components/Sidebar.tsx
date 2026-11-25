import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { useLocation, useNavigate } from 'react-router-dom'
import { Folder, LayoutGrid, Plus, Menu, BookOpen, Heart, Images, LogOut, Settings, Sparkles, Tag, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useSession } from '@/auth/useSession'
import { useGallery } from '@/hooks/useGallery'
import { getTagsForAssetType } from '@/lib/gallery-view'
import { galleryQueryFromParams, galleryQueryToParams } from '@/lib/gallery-query'
import { fetchAccountSummary } from '@/api'
import type { AccountSummary, GalleryAssetType, ViewFilter } from '@/types'

interface SidebarProps {
  collections?: { id: string; name: string; count: number }[]
  collectionId?: string
  overview?: boolean
  onOverview?: () => void
  onOpenCollection?: (id: string) => void
  onNewCollection?: () => void
  onOpenTrash?: () => void
  currentPage: 'gallery' | 'generate' | 'settings' | 'trash'
  assetType: GalleryAssetType
  filter: ViewFilter
  onAssetTypeChange: (assetType: GalleryAssetType) => void
  onFilterChange: (f: ViewFilter) => void
  tags: string[]
  workCount: number
  recipeCount: number
  favoriteCount: number
  accountSummary?: AccountSummary | null
  onSignOut?: () => Promise<void> | void
}

export function Sidebar({
  currentPage, collections, collectionId, overview, onOverview, onOpenCollection, onNewCollection, onOpenTrash,
  assetType,
  filter,
  onAssetTypeChange,
  onFilterChange,
  tags,
  workCount,
  recipeCount,
  favoriteCount,
  accountSummary,
  onSignOut,
}: SidebarProps) {
  const gallery = useGallery()
  const [open, setOpen] = useState(false)
  const [mobile, setMobile] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(max-width: 767px)'); const change = () => setMobile(media.matches)
    media.addEventListener('change', change); return () => media.removeEventListener('change', change)
  }, [])
  const navigate = useNavigate()
  const location = useLocation()
  const { session, signOut } = useSession()
  const [loadedAccount, setLoadedAccount] = useState<{ key: string; value: AccountSummary } | null>(null)
  const sessionKey = session ? JSON.stringify([session.user.id, session.workspace.id]) : null
  useEffect(() => {
    if (accountSummary !== undefined || !sessionKey) return
    let active = true
    void fetchAccountSummary().then(value => { if (active) setLoadedAccount({ key: sessionKey, value }) }).catch(() => {})
    return () => { active = false }
  }, [accountSummary, sessionKey])
  const viewKey = session ? `banana-gallery-view:${JSON.stringify([session.user.id, session.workspace.id])}:query` : null
  let savedQuery = galleryQueryFromParams(new URLSearchParams())
  try { if (viewKey) savedQuery = galleryQueryFromParams(new URLSearchParams(JSON.parse(window.localStorage.getItem(viewKey) || '""'))) } catch { /* Optional browser preference. */ }
  const returnQuery = currentPage === 'trash' ? (location.state as { gallerySearch?: string } | null)?.gallerySearch : undefined
  if (returnQuery) savedQuery = galleryQueryFromParams(new URLSearchParams(returnQuery))
  const browsingType = currentPage === 'gallery' ? assetType : savedQuery.assetType || assetType
  const resolvedCollections = useMemo(() => {
    if (collections) return collections
    const ids = new Set(gallery.allImages.filter(image => image.assetType === browsingType && !image.deletedAt).map(image => image.id))
    return gallery.groups.filter(group => (group.assetType || 'recipe') === browsingType).map(group => ({ id: group.id, name: group.name, count: group.imageIds.filter(id => ids.has(id)).length }))
  }, [collections, gallery.allImages, gallery.groups, browsingType])
  const resolvedTags = currentPage === 'gallery' ? tags : getTagsForAssetType(gallery.allImages, browsingType)
  const resolvedFavoriteCount = currentPage === 'gallery' ? favoriteCount : gallery.allImages.filter(image => image.assetType === browsingType && image.favorited && !image.deletedAt).length
  const resolvedAccount = accountSummary === undefined ? (loadedAccount?.key === sessionKey ? loadedAccount.value : null) : accountSummary

  const canSignOut = currentPage !== 'settings' && !!session && resolvedAccount?.runtimeMode === 'personal-remote'

  const openAssetType = (nextAssetType: GalleryAssetType) => {
    const nextFilter: ViewFilter = 'all'

    if (currentPage === 'gallery') {
      onAssetTypeChange(nextAssetType)
      if (!onOverview && (nextAssetType !== assetType || nextFilter !== filter)) {
        onFilterChange(nextFilter)
      }
      return
    }

    if (returnQuery && nextAssetType === browsingType) {
      navigate({ pathname: '/', search: returnQuery }, { replace: true })
      return
    }
    navigate(`/?${galleryQueryToParams(nextAssetType === browsingType ? { ...savedQuery, assetType: nextAssetType } : { view: 'overview', assetType: nextAssetType })}`)
  }

  const openFilter = (nextFilter: ViewFilter) => {
    if (currentPage === 'gallery') {
      onFilterChange(nextFilter)
      return
    }

    navigate(`/?${galleryQueryToParams({ view: 'all', assetType: browsingType, favorites: nextFilter === 'favorites', tags: nextFilter.startsWith('tag:') ? [nextFilter.slice(4)] : [] })}`)
  }

  const content = (
    <aside onClick={event => { if ((event.target as HTMLElement).closest('button')) setOpen(false) }} className="flex h-dvh w-56 shrink-0 flex-col border-r border-[#1E2336] bg-[#0d0d14]">
      {/* Brand */}
      <div className="flex items-center gap-2 px-4 py-5">
        <img src="/icon.svg" alt="" className="h-7 w-7 rounded-lg" />
        <span className="text-lg font-semibold text-white">Banana Gallery</span>
      </div>

      <div className="px-3 pb-3">
        {currentPage === 'generate' ? (
          <div
            aria-current="page"
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-500 px-3 py-3 text-sm font-medium text-white shadow-lg shadow-indigo-950/40"
          >
            <Sparkles size={16} />
            生成图片
          </div>
        ) : (
          <button
            onClick={() => navigate('/generate')}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-3 py-3 text-sm font-medium text-white shadow-lg shadow-indigo-950/40 transition-colors hover:bg-indigo-500"
          >
            <Sparkles size={16} />
            生成图片
          </button>
        )}
      </div>

      {/* Main nav */}
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-2 pb-4">
        <div className="mb-1 px-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
          资源分区
        </div>
        <NavItem
          icon={<Images size={16} />}
          label="作品"
          count={workCount}
          active={currentPage === 'gallery' && assetType === 'work'}
          onClick={() => openAssetType('work')}
        />
        <NavItem
          icon={<BookOpen size={16} />}
          label="配方"
          count={recipeCount}
          active={currentPage === 'gallery' && assetType === 'recipe'}
          onClick={() => openAssetType('recipe')}
        />

        <div className="mt-4 mb-1 px-2 text-xs font-medium text-zinc-500 uppercase tracking-wider">
          当前浏览
        </div>
        <NavItem icon={<LayoutGrid size={16} />} label="概览" active={currentPage === 'gallery' && !!overview} onClick={() => onOverview ? onOverview() : navigate(`/?assetType=${browsingType}&view=overview`)} />
        <NavItem
          icon={<Images size={16} />}
          label={browsingType === 'work' ? '全部作品' : '全部配方'}
          count={browsingType === 'work' ? workCount : recipeCount}
          active={currentPage === 'gallery' && !overview && !collectionId && filter === 'all'}
          onClick={() => openFilter('all')}
        />
        {(<NavItem
            icon={<Heart size={16} />}
            label="喜欢"
            count={resolvedFavoriteCount}
            active={currentPage === 'gallery' && !collectionId && filter === 'favorites'}
            onClick={() => openFilter('favorites')}
          />
        )}
        <NavItem
          icon={<Trash2 size={16} />}
          label="回收站"
          count={gallery.trashCount}
          pageLink
          active={currentPage === 'trash'}
          onClick={() => {
            if (currentPage !== 'trash') (onOpenTrash ?? (() => navigate('/trash')))()
          }}
        />
        <NavItem
          icon={<Settings size={16} />}
          label="设置"
          active={currentPage === 'settings'}
          onClick={() => navigate('/settings', { state: { assetType } })}
        />

        <div className="mt-4 mb-1 flex items-center justify-between px-2 text-xs font-medium text-zinc-500">
          <span>收藏夹</span>
          <button aria-label="新建收藏夹" title="新建收藏夹" className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white" onClick={() => onNewCollection ? onNewCollection() : navigate(`/?assetType=${browsingType}&view=overview`, { state: { newCollection: true } })}><Plus size={15} /></button>
        </div>
        {resolvedCollections.length ? resolvedCollections.map(collection => <NavItem key={collection.id} icon={<Folder size={15} />} label={collection.name} count={collection.count} active={currentPage === 'gallery' && collectionId === collection.id} onClick={() => onOpenCollection ? onOpenCollection(collection.id) : navigate(`/?${galleryQueryToParams({ view: 'all', assetType: browsingType, groupId: collection.id })}`)} />) : gallery.groupsLoading && collections === undefined ? <p className="px-2 text-xs text-zinc-600">正在读取收藏夹…</p> : <p className="px-2 text-xs text-zinc-600">点击 ＋ 新建一个系列</p>}
        {collections === undefined && gallery.groupsError && <p role="alert" className="px-2 text-xs text-amber-300">{gallery.groupsError}<button onClick={() => void gallery.reloadGroups().catch(() => {})} className="ml-1 underline">重试收藏夹</button></p>}
        {/* Tags section */}
        <div className="mt-4 mb-1 px-2 text-xs font-medium text-zinc-500 uppercase tracking-wider">
          标签
        </div>
        {resolvedTags.length === 0 ? (
          <p className="px-2 text-xs text-zinc-600 italic">暂无标签</p>
        ) : (
          resolvedTags.map((tag) => (
            <NavItem
              key={tag}
              icon={<Tag size={14} />}
              label={tag}
              active={currentPage === 'gallery' && !collectionId && filter === `tag:${tag}`}
              onClick={() => openFilter(`tag:${tag}` as ViewFilter)}
            />
          ))
        )}
      </nav>

      {canSignOut && (
        <div className="border-t border-[#1E2336] p-2">
          <button type="button" onClick={async () => {
            try { await (onSignOut ?? signOut)() }
            catch (error) { toast.error(error instanceof Error ? error.message : '退出登录失败') }
          }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-400 hover:bg-white/5 hover:text-white focus-visible:outline-2 focus-visible:outline-indigo-400">
            <LogOut size={15} aria-hidden="true" />
            退出登录
          </button>
        </div>
      )}
    </aside>
  )
  if (!mobile) return content
  return <div className="w-11 shrink-0 border-r border-[#1E2336] bg-[#0d0d14] pt-3">
    <button aria-label="打开导航" onClick={()=>setOpen(true)} className="p-3 text-zinc-300"><Menu size={20}/></button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="left-0 top-0 h-dvh w-56 max-w-[85vw] translate-x-0 translate-y-0 gap-0 border-[#1E2336] bg-[#0d0d14] p-0"><DialogTitle className="sr-only">导航</DialogTitle><DialogDescription className="sr-only">图库、生成、设置与分类</DialogDescription>{content}</DialogContent></Dialog>
  </div>
}

function NavItem({
  icon,
  label,
  count,
  pageLink,
  active,
  onClick,
}: {
  icon: ReactNode
  label: string
  count?: number
  pageLink?: boolean
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      aria-current={pageLink && active ? 'page' : undefined}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors',
        active
          ? 'bg-zinc-800 text-white'
          : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
      )}
    >
      <span className={cn(active ? 'text-white' : 'text-zinc-500')}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span className="text-xs tabular-nums text-zinc-500">{count}</span>
      )}
    </button>
  )
}
