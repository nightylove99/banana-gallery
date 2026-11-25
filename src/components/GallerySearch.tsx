import { useId, useRef, type ReactNode, type Ref } from 'react'
import { ArrowDownUp, CalendarDays, ChevronDown, CircleDot, Cpu, Layers, Pin, Search, Tag, X } from 'lucide-react'
import type { GalleryImage } from '@/types'
import { assetModel, assetSource, gallerySourceLabel, type GalleryQuery } from '@/lib/gallery-query'
import { IMAGE_GENERATION_MODEL_DEFINITIONS, imageGenerationModelKey } from '@/lib/image-generation-providers'
import { AnchoredPopover } from './ui/anchored-popover'
import { cn } from '@/lib/utils'

const sorts = { newest: '最新优先', oldest: '最早优先', updated: '最近修改' }
const states = { unnamed: '未命名', untagged: '无标签', recent: '最近 7 天' }
const pill = 'inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-indigo-400'
const inactivePill = 'border-[#1E2336] bg-[#101018] text-zinc-300 hover:border-[#343953] hover:bg-[#161622]'
const activePill = 'border-indigo-400/30 bg-indigo-400/10 text-indigo-200 hover:bg-indigo-400/15'
const modelLabel = (model: string) => model === 'unknown' ? '未记录'
  : IMAGE_GENERATION_MODEL_DEFINITIONS.find(item => imageGenerationModelKey(item.provider, item.model) === model)?.label || model

function FilterPill({ name, icon, value, active = !!value, children }: {
  name: string; icon: ReactNode; value?: string; active?: boolean; children: ReactNode
}) {
  return <AnchoredPopover label={value ? `${name}：${value}` : name} className={cn(pill, active ? activePill : inactivePill)}
    trigger={<>{icon}<span className="max-w-32 truncate">{value || name}</span><ChevronDown size={12} className="opacity-70" aria-hidden="true" /></>}>
    {() => children}
  </AnchoredPopover>
}

function Options({ label, options, value, onChange }: {
  label: string; options: Array<[string, string]>; value: string; onChange: (value: string) => void
}) {
  const name = useId()
  return <fieldset>
    <legend className="px-2 pb-1 pt-1.5 text-xs font-medium text-zinc-400">{label}</legend>
    {options.map(([key, text]) => <label key={key} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm hover:bg-white/5 has-[:checked]:bg-indigo-400/10 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-indigo-400">
      <input type="radio" name={name} value={key} checked={value === key} onChange={() => onChange(key)} className="accent-indigo-500" />
      <span className="break-all">{text}</span>
    </label>)}
  </fieldset>
}

export function GallerySearch({ images, query, onChange, onClear, searchInputRef, displayOptions }: {
  searchInputRef?: Ref<HTMLInputElement>
  images: GalleryImage[]
  query: GalleryQuery
  onChange: (query: GalleryQuery) => void
  onClear: () => void
  displayOptions?: ReactNode
}) {
  const searchBox = useRef<HTMLDivElement>(null)
  const selectedTags = query.tags || []
  const models = [...new Set([...images.map(assetModel), ...(query.model ? [query.model] : [])])].sort()
  const sources = [...new Set([...images.map(assetSource), ...(query.source ? [query.source] : [])])].sort()
  const tags = [...new Set([...images.flatMap(image => image.tags), ...selectedTags])].sort((a, b) => a.localeCompare(b))
  const update = (next: Partial<GalleryQuery>) => onChange({ ...query, ...next })
  const removeTag = (tag: string) => update({ tags: selectedTags.filter(item => item !== tag) })
  const chips: Array<{ key: string; label: string; clear: () => void }> = []
  if (query.q?.trim()) chips.push({ key: 'q', label: query.q.trim(), clear: () => update({ q: '' }) })
  if (query.sort && query.sort !== 'newest') chips.push({ key: 'sort', label: sorts[query.sort], clear: () => update({ sort: 'newest' }) })
  if (query.inbox) chips.push({ key: 'inbox', label: states[query.inbox], clear: () => update({ inbox: undefined }) })
  if (query.model) chips.push({ key: 'model', label: modelLabel(query.model), clear: () => update({ model: '' }) })
  if (query.source) chips.push({ key: 'source', label: gallerySourceLabel(query.source), clear: () => update({ source: '' }) })
  if (query.dateFrom) chips.push({ key: 'from', label: `自 ${query.dateFrom}`, clear: () => update({ dateFrom: '' }) })
  if (query.dateTo) chips.push({ key: 'to', label: `至 ${query.dateTo}`, clear: () => update({ dateTo: '' }) })
  for (const tag of selectedTags) chips.push({ key: `tag:${tag}`, label: tag, clear: () => removeTag(tag) })
  if (query.pinned) chips.push({ key: 'pinned', label: '只看置顶', clear: () => update({ pinned: false }) })
  if (query.favorites) chips.push({ key: 'favorites', label: '只看喜欢', clear: () => update({ favorites: false }) })
  if (query.pinFirst === false) chips.push({ key: 'pinFirst', label: '置顶不优先', clear: () => update({ pinFirst: undefined }) })
  const focusSearch = () => searchBox.current?.querySelector('input')?.focus({ preventScroll: true })
  const dateClass = 'min-w-0 rounded-lg border border-[#292d42] bg-[#0d0d14] px-2.5 py-2 text-sm text-zinc-200 scheme-dark focus-visible:outline-2 focus-visible:outline-indigo-400'
  return <section aria-label="图库搜索与筛选" className="space-y-2.5 border-b border-[#1E2336] px-3 py-3 sm:px-5">
    <div ref={searchBox} role="search" className="flex min-h-10 items-center gap-2.5 rounded-xl border border-[#25293d] bg-[#11111a] px-3 text-zinc-400 focus-within:border-indigo-400/60 focus-within:ring-2 focus-within:ring-indigo-400/15">
      <Search size={17} className="shrink-0" aria-hidden="true" />
      <input ref={searchInputRef} type="search" aria-label="搜索图库" aria-description="支持提示词、标题、备注、标签和作品编号" placeholder="搜提示词、标题、备注、标签、#作品编号"
        value={query.q || ''} onChange={event => update({ q: event.target.value })}
        className="min-w-0 flex-1 bg-transparent py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 [&::-webkit-search-cancel-button]:appearance-none" />
      {!!query.q && <button type="button" aria-label="清空搜索" onClick={() => { update({ q: '' }); focusSearch() }}
        className="grid size-7 shrink-0 place-items-center rounded-md text-zinc-400 hover:bg-white/5 hover:text-white focus-visible:outline-2 focus-visible:outline-indigo-400"><X size={15} aria-hidden="true" /></button>}
    </div>
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="筛选条件">
      <FilterPill name="排序" icon={<ArrowDownUp size={13} aria-hidden="true" />} value={sorts[query.sort || 'newest']} active={!!query.sort && query.sort !== 'newest'}>
        <Options label="排序" options={Object.entries(sorts)} value={query.sort || 'newest'} onChange={sort => update({ sort: sort as GalleryQuery['sort'] })} />
      </FilterPill>
      <FilterPill name="待整理" icon={<CircleDot size={13} aria-hidden="true" />} value={query.inbox && states[query.inbox]}>
        <Options label="待整理状态" options={ [['', '全部'], ...Object.entries(states)] } value={query.inbox || ''} onChange={inbox => update({ inbox: (inbox || undefined) as GalleryQuery['inbox'] })} />
      </FilterPill>
      <FilterPill name="模型" icon={<Cpu size={13} aria-hidden="true" />} value={query.model ? modelLabel(query.model) : undefined}>
        <Options label="模型" options={ [['', '全部模型'], ...models.map((model): [string, string] => [model, modelLabel(model)])] } value={query.model || ''} onChange={model => update({ model })} />
      </FilterPill>
      <FilterPill name="来源" icon={<Layers size={13} aria-hidden="true" />} value={query.source ? gallerySourceLabel(query.source) : undefined}>
        <Options label="来源" options={ [['', '全部来源'], ...sources.map((source): [string, string] => [source, gallerySourceLabel(source)])] } value={query.source || ''} onChange={source => update({ source })} />
      </FilterPill>
      <FilterPill name="日期范围" icon={<CalendarDays size={13} aria-hidden="true" />} active={!!(query.dateFrom || query.dateTo)}>
        <div className="grid gap-2 p-2 text-xs text-zinc-400">
          <label className="grid gap-1.5">开始日期<input type="date" value={query.dateFrom || ''} max={query.dateTo || undefined} onChange={event => update({ dateFrom: event.target.value })} className={dateClass} /></label>
          <label className="grid gap-1.5">结束日期<input type="date" value={query.dateTo || ''} min={query.dateFrom || undefined} onChange={event => update({ dateTo: event.target.value })} className={dateClass} /></label>
        </div>
      </FilterPill>
      <FilterPill name="标签" icon={<Tag size={13} aria-hidden="true" />} value={selectedTags.length ? `${selectedTags.length} 个标签` : undefined}>
        <fieldset>
          <legend className="px-2 pb-1 pt-1.5 text-xs font-medium text-zinc-400">同时包含以下标签</legend>
          {tags.length ? tags.map(tag => <label key={tag} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm hover:bg-white/5 has-[:checked]:text-indigo-200 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-indigo-400">
            <input type="checkbox" checked={selectedTags.includes(tag)} onChange={event => event.target.checked ? update({ tags: [...selectedTags, tag] }) : removeTag(tag)} className="size-4 shrink-0 accent-indigo-500" />
            <span className="break-all">{tag}</span>
          </label>) : <p className="px-2 py-2 text-sm text-zinc-400">当前图库暂无标签</p>}
        </fieldset>
      </FilterPill>
      <button type="button" aria-pressed={!!query.pinned} onClick={() => update({ pinned: !query.pinned })}
        className={cn(pill, query.pinned ? 'border-amber-400/30 bg-amber-400/10 text-amber-200 hover:bg-amber-400/15' : inactivePill)}>
        <Pin size={13} aria-hidden="true" />只看置顶
      </button>
      {displayOptions}
    </div>
    {chips.length > 0 && <div role="group" aria-label="已启用筛选" className="flex max-h-[18dvh] flex-wrap items-center gap-1.5 overflow-y-auto">
      {chips.map(chip => <button key={chip.key} type="button" aria-label={`取消筛选：${chip.label}`} title={chip.label}
        onClick={() => { chip.clear(); focusSearch() }}
        className="inline-flex max-w-full items-center gap-1 rounded-md bg-indigo-400/10 px-2 py-1 text-xs text-indigo-200 hover:bg-indigo-400/20 focus-visible:outline-2 focus-visible:outline-indigo-400">
        <span className="max-w-48 truncate">{chip.label}</span><X size={12} aria-hidden="true" />
      </button>)}
      <button type="button" onClick={() => { onClear(); focusSearch() }} className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/5 hover:text-white focus-visible:outline-2 focus-visible:outline-indigo-400">重置全部</button>
    </div>}
  </section>
}
