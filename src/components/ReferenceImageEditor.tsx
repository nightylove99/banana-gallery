import { IMAGE_INPUT_LIMIT_MESSAGE, imageInputMaxBytes } from '../lib/image-intake-policy'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { ArrowLeft, ArrowRight, Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { referenceAssetUrl, saveImageReferences } from '@/api'
import { extractReferenceImagesFromClipboard, isEditablePasteTarget, splitReferenceImageFiles, SUPPORTED_UPLOAD_IMAGE_TYPES } from '@/lib/reference-image-input'
import { ReferenceImageNote, ReferenceImageSection, ReferenceImageThumbnail, type PreviewReferenceImage } from './ReferenceImagePreview'
import type { GalleryImage } from '@/types'

type DraftReference = { key: string; value: string | File; url: string; note?: string }
export interface ReferenceImageEditorHandle {
  discard: () => void
  isDirty: () => boolean
  isSaving: () => boolean
  save: () => Promise<GalleryImage | undefined>
}
interface Props {
  image: GalleryImage
  ref?: Ref<ReferenceImageEditorHandle>
  onSaved?: (image: GalleryImage) => void
  onPreview: PreviewReferenceImage
}
const buttonClass = 'inline-flex items-center justify-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed'
const MAX_REFERENCES = 14

export function ReferenceImageEditor({ image, ref, onSaved, onPreview }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<DraftReference[]>([])
  const [base, setBase] = useState<string[]>([])
  const [baseNotes, setBaseNotes] = useState<string[]>([])
  const [baseVersion, setBaseVersion] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const savingRef = useRef(false)
  const addInput = useRef<HTMLInputElement>(null)
  const replaceInput = useRef<HTMLInputElement>(null)
  const replaceKey = useRef<string | null>(null)
  const draggedKey = useRef<string | null>(null)
  const urls = useRef(new Set<string>())
  const dropzone = useRef<HTMLDivElement>(null)
  const dirty = editing && (draft.length !== base.length || draft.some((item, index) => item.value !== base[index] || (item.note || '') !== (baseNotes[index] || '')))

  useEffect(() => {
    const currentUrls = urls.current
    return () => { currentUrls.forEach(url => URL.revokeObjectURL(url)); currentUrls.clear() }
  }, [])
  useEffect(() => {
    const active = new Set(draft.map(item => item.url))
    for (const url of urls.current) {
      if (!active.has(url)) { URL.revokeObjectURL(url); urls.current.delete(url) }
    }
  }, [draft])
  useEffect(() => {
    if (!dirty) return
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [dirty])

  function start() {
    setBase([...image.referenceImages]); setBaseNotes(image.referenceNotes || []); setBaseVersion(image.version || 0)
    setDraft(image.referenceImages.map((name, index) => ({ key: `old-${index}`, value: name, url: referenceAssetUrl(name), note: image.referenceNotes?.[index] })))
    setError('')
    setEditing(true)
  }
  function cancel() { setDraft([]); setError(''); setEditing(false) }
  async function save() {
    if (savingRef.current) return undefined
    if (!dirty) { cancel(); return image }
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      const updated = await saveImageReferences(image.id, draft.map(item => item.value), base, draft.map(item => item.note || ''), baseVersion)
      onSaved?.(updated)
      cancel()
      toast.success('参考图片已更新')
      return updated
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '参考图片保存失败，请重试')
      return undefined
    } finally { savingRef.current = false; setSaving(false) }
  }
  useImperativeHandle(ref, () => ({ discard: cancel, isDirty: () => dirty, isSaving: () => savingRef.current, save }))

  function addFiles(files: Iterable<File>, replacement?: string | null) {
    if (savingRef.current) return
    const { accepted, rejected } = splitReferenceImageFiles(files, SUPPORTED_UPLOAD_IMAGE_TYPES)
    const valid = accepted.filter(file => file.size <= imageInputMaxBytes(file.type))
    const available = replacement ? 1 : Math.max(0, MAX_REFERENCES - draft.length)
    const selected = valid.slice(0, available)
    setError(rejected.length ? '仅支持 JPG、PNG、WebP 图片' : valid.length !== accepted.length ? IMAGE_INPUT_LIMIT_MESSAGE : valid.length > available ? (replacement ? '每次只能替换一张参考图' : '最多支持 14 张参考图') : '')
    if (!selected.length) return
    const items = selected.map(file => {
      const url = URL.createObjectURL(file)
      urls.current.add(url)
      return { key: crypto.randomUUID(), value: file, url }
    })
    setDraft(current => replacement ? current.map(item => item.key === replacement ? items[0] : item) : [...current, ...items])
  }
  function move(from: number, to: number) {
    if (savingRef.current || from < 0 || to < 0 || to >= draft.length) return
    setDraft(current => {
      const next = [...current]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    })
  }
  const displayed = editing ? draft : image.referenceImages.map((name, index) => ({ key: `old-${index}`, value: name, url: referenceAssetUrl(name), note: image.referenceNotes?.[index] }))
  return (
    <ReferenceImageSection count={displayed.length} actions={
        editing ? <div className="flex gap-1">
          <button type="button" className={buttonClass} aria-label="取消编辑参考图片" onClick={cancel} disabled={saving}><X size={12} />取消</button>
          <button type="button" className={`${buttonClass} bg-zinc-800 text-zinc-200`} aria-label="保存参考图片" onClick={() => void save()} disabled={saving}><Check size={12} />{saving ? '保存中…' : '保存'}</button>
        </div> : <button type="button" className={buttonClass} aria-label={displayed.length ? '编辑参考图片' : '添加参考图'} onClick={start}><Pencil size={12} />{displayed.length ? '编辑' : '添加参考图'}</button>}
    >
      <div ref={dropzone} data-testid="reference-editor-dropzone" tabIndex={editing ? 0 : undefined}
        className={`space-y-2 rounded-lg outline-none ${editing ? 'border border-dashed p-2 focus:border-indigo-400' : ''} ${dragging ? 'border-indigo-400 bg-indigo-500/10' : 'border-zinc-700'}`}
        onPaste={event => {
          if (!editing || saving || isEditablePasteTarget(event.target)) return
          const files = extractReferenceImagesFromClipboard(event.clipboardData, SUPPORTED_UPLOAD_IMAGE_TYPES)
          if (files.length) { event.preventDefault(); event.stopPropagation(); addFiles(files) }
        }}
        onDragOver={event => { if (editing && !saving) { event.preventDefault(); if (Array.from(event.dataTransfer.types).includes('Files')) setDragging(true) } }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
        onDrop={event => {
          if (!editing || saving) return
          event.preventDefault(); event.stopPropagation(); setDragging(false)
          if (event.dataTransfer.files.length) addFiles(Array.from(event.dataTransfer.files))
        }}>
        <div className="grid grid-cols-3 gap-2">
          {displayed.map((item, index) => <div key={item.key} draggable={editing && !saving}
            onDragStart={event => { draggedKey.current = item.key; event.dataTransfer.setData('text/plain', item.key); event.dataTransfer.effectAllowed = 'move' }}
            onDragEnd={() => { draggedKey.current = null }}
            onDrop={event => {
              if (!editing || saving || event.dataTransfer.files.length || !draggedKey.current) return
              event.preventDefault(); event.stopPropagation()
              move(draft.findIndex(ref => ref.key === draggedKey.current), index)
              draggedKey.current = null
            }}>
            <ReferenceImageThumbnail src={item.url} index={index} onPreview={onPreview} />
            {editing ? <input aria-label={`编辑参考图 ${index+1} 用途`} value={item.note || ''} maxLength={500} onChange={event => setDraft(items => items.map(ref => ref.key === item.key ? {...ref,note:event.target.value} : ref))} placeholder="用途备注" className="mt-1 w-full rounded bg-zinc-900 p-1 text-xs"/> : <ReferenceImageNote note={item.note} />}
            {editing && <div className="mt-1 space-y-0.5">
              <div className="flex justify-between">
                <button type="button" className={buttonClass} aria-label={`替换参考图 ${index + 1}`} disabled={saving} onClick={() => { replaceKey.current = item.key; replaceInput.current?.click() }}>替换</button>
                <button type="button" className={buttonClass} aria-label={`删除参考图 ${index + 1}`} disabled={saving} onClick={() => setDraft(current => current.filter(ref => ref.key !== item.key))}><Trash2 size={12} /></button>
              </div>
              <div className="flex justify-between">
                <button type="button" className={buttonClass} aria-label={`前移参考图 ${index + 1}`} disabled={saving || index === 0} onClick={() => move(index, index - 1)}><ArrowLeft size={12} /></button>
                <button type="button" className={buttonClass} aria-label={`后移参考图 ${index + 1}`} disabled={saving || index === draft.length - 1} onClick={() => move(index, index + 1)}><ArrowRight size={12} /></button>
              </div>
            </div>}
          </div>)}
        </div>
        {!displayed.length && <p className="py-3 text-center text-xs text-zinc-500">{editing ? '拖入或粘贴图片，也可以点击下方添加' : '暂无参考图'}</p>}
        {editing && <>
          <button type="button" className="flex w-full items-center justify-center gap-1 rounded-md bg-zinc-800/60 py-2 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40" disabled={saving || draft.length >= MAX_REFERENCES} onClick={() => addInput.current?.click()}><Plus size={14} />添加参考图</button>
          <p className="text-[11px] leading-relaxed text-zinc-500">PNG 原图 ≤ 100 MiB，JPG / WebP ≤ 25 MiB，转换后每张须 ≤ 25 MiB，最多 14 张。点击此区域后可粘贴；拖动图片可排序。</p>
          <input ref={addInput} type="file" multiple accept="image/jpeg,image/png,image/webp" aria-label="选择新增参考图" className="hidden" disabled={saving} onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; dropzone.current?.focus() }} />
          <input ref={replaceInput} type="file" accept="image/jpeg,image/png,image/webp" aria-label="选择替换参考图" className="hidden" disabled={saving} onChange={event => { addFiles(Array.from(event.target.files ?? []), replaceKey.current); event.target.value = ''; replaceKey.current = null; dropzone.current?.focus() }} />
        </>}
      </div>
      {error && <p role="alert" className="text-xs leading-relaxed text-red-400">{error}</p>}
    </ReferenceImageSection>
  )
}
