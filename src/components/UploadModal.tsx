import { useState, useCallback, useEffect, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { fetchImage, saveImageReferences, uploadImage } from '@/api'
import type { GalleryImage } from '@/types'
import { ImagePlus, X, Loader2, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  extractReferenceImagesFromClipboard,
  splitReferenceImageFiles,
  SUPPORTED_UPLOAD_IMAGE_TYPES,
} from '@/lib/reference-image-input'
import { toast } from 'sonner'

const MAX_UPLOAD_REFERENCE_IMAGES = 10

type PasteTarget = 'main' | 'references' | null

interface UploadModalProps {
  returnFocus?: () => void
  open: boolean
  onClose: () => void
  onUploaded: (img: GalleryImage) => void
}

export function UploadModal({ open, onClose, onUploaded, returnFocus }: UploadModalProps) {
  const [mainFile, setMainFile] = useState<File | null>(null)
  const mainPreviewUrl = useRef<string | null>(null)
  const ownedPreviewUrls = useRef(new Set<string>())
  const [mainPreview, setMainPreview] = useState<string | null>(null)
  const [refFiles, setRefFiles] = useState<File[]>([])
  const [refPreviews, setRefPreviews] = useState<string[]>([])
  const [prompt, setPrompt] = useState('')
  const [tags, setTags] = useState('')
  const [loading, setLoading] = useState(false)
  const uploading = useRef(false)
  const [createdImage, setCreatedImage] = useState<GalleryImage | null>(null)
  const [uploadError, setUploadError] = useState('')
  const [mainDragging, setMainDragging] = useState(false)
  const [refDragging, setRefDragging] = useState(false)
  const [pasteTarget, setPasteTarget] = useState<PasteTarget>(null)
  const mainInputRef = useRef<HTMLInputElement>(null)
  const refInputRef = useRef<HTMLInputElement>(null)

  const createPreview = useCallback((file: File) => {
    const url = URL.createObjectURL(file)
    ownedPreviewUrls.current.add(url)
    return url
  }, [])

  const revokePreview = useCallback((url: string | null) => {
    if (url && ownedPreviewUrls.current.delete(url)) URL.revokeObjectURL(url)
  }, [])

  const revokePreviews = useCallback(() => {
    for (const url of ownedPreviewUrls.current) revokePreview(url)
    mainPreviewUrl.current = null
  }, [revokePreview])
  useEffect(() => revokePreviews, [revokePreviews])

  const handleMainFile = useCallback((file: File) => {
    if (uploading.current || createdImage) return
    revokePreview(mainPreviewUrl.current)
    mainPreviewUrl.current = createPreview(file)
    setMainFile(file)
    setMainPreview(mainPreviewUrl.current)
  }, [createdImage, createPreview, revokePreview])

  const addMainFiles = useCallback((files: Iterable<File>) => {
    const { accepted, rejected } = splitReferenceImageFiles(files, SUPPORTED_UPLOAD_IMAGE_TYPES)

    if (rejected.length > 0) {
      toast.error('仅支持 JPG、PNG、WebP 图片')
    }

    const [file] = accepted
    if (!file) return false

    handleMainFile(file)
    return true
  }, [handleMainFile])

  const handleMainDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setMainDragging(false)
    if (e.dataTransfer.files.length) addMainFiles(e.dataTransfer.files)
  }, [addMainFiles])

  const addRefFiles = useCallback((files: Iterable<File>) => {
    if (uploading.current || createdImage) return 0
    const { accepted, rejected } = splitReferenceImageFiles(files, SUPPORTED_UPLOAD_IMAGE_TYPES)
    const remainingSlots = Math.max(MAX_UPLOAD_REFERENCE_IMAGES - refFiles.length, 0)
    const newFiles = accepted.slice(0, remainingSlots)
    const hitLimit = accepted.length > remainingSlots

    if (rejected.length > 0) {
      toast.error('参考图仅支持 JPG、PNG 或 WebP')
    }
    if (hitLimit) {
      toast.error(`最多支持 ${MAX_UPLOAD_REFERENCE_IMAGES} 张参考图`)
    }
    if (newFiles.length === 0) return 0

    const newPreviews = newFiles.map(createPreview)
    setRefFiles((prev) => [...prev, ...newFiles])
    setRefPreviews((prev) => [
      ...prev,
      ...newPreviews,
    ])
    return newFiles.length
  }, [refFiles.length, createdImage, createPreview])

  const removeRef = (idx: number) => {
    if (uploading.current || createdImage) return
    setRefFiles((prev) => prev.filter((_, i) => i !== idx))
    revokePreview(refPreviews[idx])
    setRefPreviews((prev) => prev.filter((_, i) => i !== idx))
  }

  const handleRefDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setRefDragging(false)
    if (e.dataTransfer.files.length) addRefFiles(e.dataTransfer.files)
  }, [addRefFiles])

  const handlePaste = useCallback((e: ClipboardEvent) => {
    if (!pasteTarget || uploading.current || createdImage) return

    const pastedFiles = extractReferenceImagesFromClipboard(e.clipboardData, SUPPORTED_UPLOAD_IMAGE_TYPES)
    if (pastedFiles.length === 0) return

    e.preventDefault()

    if (pasteTarget === 'main') {
      if (addMainFiles(pastedFiles)) toast.success('已粘贴主图')
      return
    }

    const addedCount = addRefFiles(pastedFiles)
    if (addedCount > 0) {
      toast.success(`已粘贴 ${addedCount} 张参考图`)
    }
  }, [addMainFiles, addRefFiles, pasteTarget, createdImage])

  useEffect(() => {
    if (!open) return

    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [handlePaste, open])

  const handleUpload = async () => {
    if (!mainFile || uploading.current) return
    uploading.current = true
    setLoading(true); setUploadError('')
    try {
      const tagList = tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      const img = createdImage || await uploadImage({ image: mainFile, prompt, tags: tagList })
      setCreatedImage(img)
      let uploadedImage = img
      if (refFiles.length > 0) {
        const base = img.referenceImages
        const current = createdImage ? await fetchImage(img.id, 'no-store') : img
        const sameBase = base.every((name, index) => current.referenceImages[index] === name)
        if (sameBase && current.referenceImages.length === base.length) {
          // The existing whole-list edit checks the original list atomically. Even if
          // the first request is still in flight, replay cannot append the same batch.
          uploadedImage = await saveImageReferences(img.id, [...base, ...refFiles], base, undefined, current.version ?? 0)
        } else if (sameBase && current.referenceImages.length === base.length + refFiles.length &&
          current.version === (img.version ?? 0) + 1) {
          uploadedImage = current
        } else {
          throw new Error('作品参考图已发生变化，没有再次上传；请在作品详情中检查。')
        }
      }
      onUploaded(uploadedImage)
      handleReset(false)
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : '上传失败，请重试')
    } finally {
      uploading.current = false
      setLoading(false)
    }
  }

  const handleReset = (keepCreated = true) => {
    if (uploading.current && keepCreated) return
    if (keepCreated && createdImage) onUploaded(createdImage)
    setCreatedImage(null); setUploadError('')
    revokePreviews()
    setMainFile(null)
    setMainPreview(null)
    setRefFiles([])
    setRefPreviews([])
    setPrompt('')
    setTags('')
    setMainDragging(false)
    setRefDragging(false)
    setPasteTarget(null)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleReset()}>
      <DialogContent hideClose={loading} onCloseAutoFocus={returnFocus ? event => { event.preventDefault(); returnFocus() } : undefined} className="w-[calc(100%-2rem)] max-w-[600px] max-h-[90vh] overflow-y-auto bg-[#0d0d14] border-[#1E2336] text-zinc-200">
        <DialogTitle className="flex items-center gap-2 text-base font-semibold">
          <ImagePlus size={18} />
          导入外部图片
        </DialogTitle>
        <DialogDescription className="text-xs text-zinc-500">
          上传生成的图片，填写提示词和可选的参考图
        </DialogDescription>

        <fieldset disabled={loading || !!createdImage} className="space-y-4 py-2">
          {/* Main image drop zone */}
          <div
            data-testid="main-image-dropzone"
            className={cn(
              'relative flex min-h-[180px] cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed transition-all',
              mainDragging || pasteTarget === 'main'
                ? 'border-zinc-400 bg-zinc-800/60'
                : 'border-zinc-700 hover:border-zinc-500'
            )}
            onPointerEnter={() => setPasteTarget('main')}
            onPointerLeave={() => setPasteTarget(null)}
            onDragOver={(e) => { e.preventDefault(); setMainDragging(true) }}
            onDragLeave={() => setMainDragging(false)}
            onDrop={handleMainDrop}
            onClick={() => !mainFile && mainInputRef.current?.click()}
          >
            <input
              ref={mainInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) addMainFiles(e.target.files)
                e.currentTarget.value = ''
              }}
            />
            {mainPreview ? (
              <div className="relative w-full">
                <img src={mainPreview} alt="preview" className="mx-auto max-h-64 rounded-lg object-contain" />
                <button
                  className="absolute right-2 top-2 rounded-full bg-black/60 p-1 text-white hover:bg-black/80"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (uploading.current || createdImage) return
                    revokePreview(mainPreviewUrl.current)
                    mainPreviewUrl.current = null
                    setMainFile(null)
                    setMainPreview(null)
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-zinc-500">
                <Upload size={28} />
                <p className="text-sm">拖拽、粘贴或点击选择图片</p>
                <p className="text-xs text-zinc-600">支持 JPG、PNG、WebP</p>
              </div>
            )}
          </div>

          {/* Prompt */}
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">提示词</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="粘贴生成时使用的提示词…"
              className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-500 placeholder:text-zinc-600"
            />
          </div>

          {/* Tags */}
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">标签（用逗号分隔）</label>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="例如：巨大娘, 动漫, 东京"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-500 placeholder:text-zinc-600"
            />
          </div>

          {/* Reference images */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs text-zinc-400">
                参考图（可选）
                <span className="ml-1.5 text-zinc-600">
                  点击、拖拽或粘贴添加参考图，最多 {MAX_UPLOAD_REFERENCE_IMAGES} 张
                </span>
              </label>
              <button
                onClick={() => refInputRef.current?.click()}
                disabled={refFiles.length >= MAX_UPLOAD_REFERENCE_IMAGES}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                + 添加参考图
              </button>
              <input
                ref={refInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addRefFiles(e.target.files)
                  e.currentTarget.value = ''
                }}
              />
            </div>
            <div
              data-testid="reference-image-dropzone"
              className={cn(
                'min-h-20 rounded-lg border border-dashed p-2 transition-colors',
                refDragging || pasteTarget === 'references'
                  ? 'border-zinc-400 bg-zinc-800/60'
                  : 'border-zinc-700 bg-zinc-950/30 hover:border-zinc-500'
              )}
              onPointerEnter={() => setPasteTarget('references')}
              onPointerLeave={() => setPasteTarget(null)}
              onDragOver={(e) => { e.preventDefault(); setRefDragging(true) }}
              onDragLeave={() => setRefDragging(false)}
              onDrop={handleRefDrop}
            >
              {refPreviews.length > 0 ? (
                <div className="grid grid-cols-4 gap-2">
                  {refPreviews.map((src, i) => (
                    <div key={i} className="relative aspect-square">
                      <img
                        src={src}
                        alt={`ref ${i + 1}`}
                        className="h-full w-full rounded-md object-cover border border-zinc-700"
                      />
                      <button
                        className="absolute -right-1 -top-1 rounded-full bg-black/80 p-0.5 text-white hover:bg-red-800"
                        onClick={() => removeRef(i)}
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => refInputRef.current?.click()}
                  className="flex h-16 w-full items-center justify-center rounded-md text-xs text-zinc-500 hover:text-zinc-300"
                >
                  点击、拖拽或粘贴参考图
                </button>
              )}
            </div>
          </div>
        </fieldset>
        {uploadError && <div role="alert" className="text-sm text-red-300">{createdImage && <p>主图已保存，参考图尚未完成。重试不会重复创建主图。</p>}<p>{uploadError}</p></div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => handleReset()} disabled={loading} className="text-zinc-400">
            {createdImage ? '保留主图并关闭' : '取消'}
          </Button>
          <Button
            size="sm"
            onClick={handleUpload}
            disabled={!mainFile || loading}
            className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200"
          >
            {loading ? (
              <>
                <Loader2 size={14} className="animate-spin mr-1.5" />
                上传中…
              </>
            ) : (
              createdImage ? '重试参考图' : '上传'
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
