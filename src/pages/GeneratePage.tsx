import { formatImageGenerationSource } from '@/lib/image-generation-providers'
import { CopyWorkCodeButton } from '@/components/CopyWorkCodeButton'
import { RetryableImage } from '@/components/RetryableImage'
import { DetailModal } from '@/components/DetailModal'
import { alternateDetailAction, iconAction, mainDetailAction, relatedDetailAction, secondaryAction } from '@/components/detail-action-styles'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { readPendingQueries, reconcileQueries, resumeResultQuery } from '@/lib/generation-query'
import { canGenerateAgain, historyRetryKey } from '@/lib/generation-task-actions'
import { GenerationDownloads, downloadGenerationResult } from '@/lib/generation-downloads'
import { createReferenceAsset } from '@/lib/reference-library'
import { GenerationHistory, type GenerationHistoryMeta } from '@/components/GenerationHistory'
import { generationTaskDuration, generationTaskSettings } from '@/lib/generation-task-display'
import { taskRequest, taskAsImage, readPendingSubmissions, persistSubmission, clearSubmission, readSubmission, withSubmissionLock, isSubmissionUnconfirmed, type PendingSubmission } from '@/lib/generation-tasks'
import type { GalleryImage, GenerationTask } from '@/types'
import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useSession } from '@/auth/useSession'
import { useGenerationDrafts } from '@/hooks/useGenerationDrafts'
import type { DraftContent, DraftReference } from '@/lib/generation-drafts'
import {
  Check,
  Heart,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Plus,
  X,
  Sparkles,
  Download,
  Save,
  Loader2,
  ImageIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Sidebar } from '@/components/Sidebar'
import { presentationForHttpActionError } from '@/lib/http-error-presentation'
import { buildGeneratePageState, buildGenerationSnapshot, parseGenerateFromAsset } from '@/lib/generate-state'
import { SUPPORTED_RESOLUTIONS } from '@/lib/image-utils'
import {
  GOOGLE_NANO_BANANA_2_1_MODEL,
  IMAGE_GENERATION_MODEL_DEFINITIONS,
  defaultModelForProvider,
  isImageGenerationProviderName,
  generationAspectRatios,
  resolveLocalQwenOutputSize,
  imageGenerationModelKey,
  normalizeImageGenerationModelKey,
  normalizeGenerationDefaults,
  migrateSeedreamResolution,
  isRetiredSeedreamRequest,
  type ImageGenerationQuality,
} from '@/lib/image-generation-providers'
import {
  PROMPT_DEFAULT_HEIGHT,
  resizePromptTextarea,
} from '@/lib/prompt-textarea'
import { useGallery } from '@/hooks/useGallery'
import {
  extractReferenceImagesFromClipboard,
  hasDraggedFiles,
  isEditablePasteTarget,
  referenceUploadError,
} from '@/lib/reference-image-input'
import {
  uploadGenerateRefs,
  imageAssetUrl,
  referenceAssetUrl,
  saveGeneratedToGallery,
  fetchImage,
  fetchGenerationModels,
  ApiConnectionError,
  ApiHttpError,
} from '@/api'
import type {
  GenerationModelStatus,
  GeneratePageState,
} from '@/types'

interface RefImage extends DraftReference {
  previewUrl: string
}

interface ActionErrorBanner {
  title: string
  detail: string | null
  unavailableSource?: Pick<GenerationTask['input'], 'sourceAssetId' | 'sourceTaskId'>
}

// 顶部结果、历史结果和参考图共用原大图浮层；结果图可手动补下载。
type LightboxImage = {
  downloadFilename?: string
  src: string
  alt: string
}

export default function GeneratePage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [sourceUnavailable, setSourceUnavailable] = useState(false)
  const { session } = useSession()
  const gallery = useGallery()
  const [recentWorkLimit, setRecentWorkLimit] = useState(30)
  const recentWorkEndRef = useRef<HTMLButtonElement>(null)
  const [recentTasks, setRecentTasks] = useState<GenerationTask[]>([])
  const [requestFullHistory, setRequestFullHistory] = useState(false)
  const [fullHistoryRetryKey, setFullHistoryRetryKey] = useState(0)
  const [historyMeta, setHistoryMeta] = useState<GenerationHistoryMeta>({ hasMore: false, loadingFull: false, fullError: '' })
  const [previewWorkId, setPreviewWorkId] = useState<string | null>(null)
  const previewTrigger = useRef<HTMLButtonElement | null>(null)
  const [detailWorkId, setDetailWorkId] = useState<string | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const detailFlight = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const promptToolbarRef = useRef<HTMLElement>(null)
  const generationSettingsRef = useRef<HTMLDivElement>(null)
  const mainScrollRef = useRef<HTMLElement>(null)
  const resultSectionRef = useRef<HTMLDivElement>(null)
  const dragDepthRef = useRef(0)
  const draggedRefId = useRef<string | null>(null)
  // 拖动结束的那一下 click 不当成「看大图」，避免拖完手一松就弹浮层。
  const lastRefDragEndRef = useRef(0)
  const restoredModelRef = useRef(false)
  const legacyRestoredProviderRef = useRef<GenerationModelStatus['provider'] | undefined>(undefined)
  const preferredAspectRatioRef = useRef<string | null>(null)

  const [prompt, setPrompt] = useState('')
  const [refs, setRefs] = useState<RefImage[]>([])
  const [draggingRefId, setDraggingRefId] = useState<string | null>(null)
  const [dragOverRefId, setDragOverRefId] = useState<string | null>(null)
  const [aspectRatio, setAspectRatio] = useState('1:1')
  const [imageSize, setImageSize] = useState('2K')
  const [quality, setQuality] = useState<ImageGenerationQuality>('high')
  const [selectedModelKey, setSelectedModelKey] = useState(
    imageGenerationModelKey('google', GOOGLE_NANO_BANANA_2_1_MODEL),
  )
  const [defaultSettings, setDefaultSettings] = useState<import('@/types').PersonalPreferences['defaultGeneration']>()
  const [modelStatus, setModelStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [modelReload, setModelReload] = useState(0)
  const modelDefaultsLoaded = useRef(false)
  const [modelOptions, setModelOptions] = useState<GenerationModelStatus[]>([])
  const [generating, setGenerating] = useState(false)
  const [uploadProgress, setUploadProgress] = useState('')
  const [submissionNotice, setSubmissionNotice] = useState('')
  const generatingClick = useRef<AbortController | null>(null)
  const latestDraftContent = useRef<DraftContent | null>(null)
  const [sourceTaskId, setSourceTaskId] = useState<string | undefined>()
  const [sourceAssetId, setSourceAssetId] = useState<string | undefined>(undefined)
  const [result, setResult] = useState<(NonNullable<GenerationTask['result']> & { taskId?: string; referenceFilenames: string[]; sourceAssetId?: string; automaticWork?: boolean }) | null>(null)
  const [savingAsset, setSavingAsset] = useState(false)
  const savingAssetRef = useRef(false)
  const [savedResults, setSavedResults] = useState<Record<string, string[]>>({})
  const resultKey = JSON.stringify([session?.user.id, session?.workspace.id, result?.taskId, result?.filename])
  const savedAssetTypes = savedResults[resultKey] || []
  const currentResultKey = useRef(resultKey)
  currentResultKey.current = resultKey
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null)
  const lightboxOpener = useRef<HTMLElement | null>(null)
  const [actionBanner, setActionBanner] = useState<ActionErrorBanner | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [promptCollapsed, setPromptCollapsed] = useState(false)
  const [promptToggleEnabled, setPromptToggleEnabled] = useState(false)

  useEffect(() => {
    let request: AbortController | undefined
    const refresh = async () => {
      if (request) return
      const controller = new AbortController()
      request = controller
      try {
        const providers = await fetchGenerationModels(controller.signal)
        if (controller.signal.aborted) return
        setModelOptions(providers.models)
        setModelStatus('ready')
        if (modelDefaultsLoaded.current) return
        modelDefaultsLoaded.current = true
        setDefaultSettings(providers.defaultSettings)
        if (legacyRestoredProviderRef.current) {
          const legacyProvider = legacyRestoredProviderRef.current
          const restoredModel =
            providers.defaultModel.provider === legacyProvider
              ? providers.defaultModel.model
              : defaultModelForProvider(legacyProvider)
          setSelectedModelKey(
            imageGenerationModelKey(legacyProvider, restoredModel),
          )
          legacyRestoredProviderRef.current = undefined
        } else if (!restoredModelRef.current) {
          const defaultModel = providers.models.find(
            (model) =>
              model.provider === providers.defaultModel.provider &&
              model.model === providers.defaultModel.model,
          )
          setSelectedModelKey(
            imageGenerationModelKey(
              providers.defaultModel.provider,
              providers.defaultModel.model,
            ),
          )
          if (providers.defaultSettings) {
            setAspectRatio(providers.defaultSettings.aspectRatio);setImageSize(providers.defaultSettings.imageSize || '2K');setQuality(providers.defaultSettings.quality || 'high')
          } else if (defaultModel) {
            if (defaultModel.defaultResolution) setImageSize(defaultModel.defaultResolution)
            setAspectRatio(
              aspectRatioForModel(
                defaultModel,
                preferredAspectRatioRef.current,
              ),
            )
          }
        }
      } catch {
        if (!controller.signal.aborted) setModelStatus('error')
      } finally { request = undefined }
    }
    void refresh()
    const timer = setInterval(() => { if (!document.hidden) void refresh() }, 15_000)
    window.addEventListener('focus', refresh)
    return () => {
      request?.abort()
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [modelReload])

  const applyDraft = useCallback((draft: DraftContent) => {
    const fromPoe = ('provider' in draft && draft.provider === 'poe') || draft.selectedModelKey?.startsWith('poe:')
    const migrated = fromPoe ? normalizeGenerationDefaults({
      provider: 'poe', model: '', aspectRatio: draft.aspectRatio, imageSize: draft.imageSize,
    }) : undefined
    const modelKey = migrated
      ? imageGenerationModelKey(migrated.provider, migrated.model)
      : normalizeImageGenerationModelKey(draft.selectedModelKey)
    restoredModelRef.current = true
    preferredAspectRatioRef.current = migrated?.aspectRatio ?? draft.aspectRatio
    setSourceTaskId(draft.sourceTaskId)
    setSourceAssetId(draft.sourceAssetId)
    setPrompt(draft.prompt); setPromptCollapsed(false); setPromptToggleEnabled(false)
    setAspectRatio(preferredAspectRatioRef.current)
    setImageSize(migrated?.imageSize ?? (modelKey.startsWith('seedream:') ? migrateSeedreamResolution(draft.imageSize) : draft.imageSize))
    setQuality(migrated ? 'high' : draft.quality)
    setSelectedModelKey(modelKey)
    setRefs(draft.refs.map(ref => ({ ...ref, previewUrl: ref.file ? URL.createObjectURL(ref.file) : ref.serverFilename ? referenceAssetUrl(ref.serverFilename) : '' })))
  }, [])
  const draftScope = session ? JSON.stringify([session.user.id, session.workspace.id]) : null
  const fromAsset = parseGenerateFromAsset(location.search)
  const historyDraftId = (location.state as { generationTabDraftId?: string } | null)?.generationTabDraftId
  const incomingDraft = useMemo(() => {
    const state = location.state as (GeneratePageState & { resolution?: string }) | null
    return state && !historyDraftId ? draftFromPageState(state) : null
  }, [location.state, historyDraftId])
  const loadIndependent = useMemo(() => {
    if (fromAsset === null) return undefined
    return async () => {
      if (!fromAsset.trim()) return null
      try {
        const image = await fetchImage(fromAsset, 'no-store')
        return image.id === fromAsset && !image.deletedAt ? draftFromPageState(buildGeneratePageState(image)) : null
      } catch (error) {
        if (error instanceof ApiHttpError && [400, 404, 410].includes(error.status)) return null
        throw new Error('读取来源条目失败，请检查网络后重试', { cause: error })
      }
    }
  }, [fromAsset])
  const historyNavigation = useRef(0)
  const draftRevision = useRef(0)
  const draftContent = useMemo<DraftContent>(() => ({ sourceTaskId, sourceAssetId, prompt, refs, selectedModelKey, aspectRatio, imageSize, quality }), [sourceTaskId, sourceAssetId, prompt, refs, selectedModelKey, aspectRatio, imageSize, quality])
  useLayoutEffect(() => {
    draftRevision.current++
    latestDraftContent.current = draftContent
  }, [draftContent])
  const drafts = useGenerationDrafts({
    scope: draftScope, content: draftContent, incoming: incomingDraft, onRestore: applyDraft,
    loadIndependent, historyDraftId,
  })
  const { activeId, drafts: availableDrafts, ready, resolvedIndependent } = drafts
  useEffect(() => {
    if (resolvedIndependent) {
      const params = new URLSearchParams(location.search)
      params.delete('fromAsset')
      setSourceUnavailable(resolvedIndependent.id === null)
      navigate({ pathname: location.pathname, search: params.toString(), hash: location.hash }, {
        replace: true, state: resolvedIndependent.id ? { generationTabDraftId: resolvedIndependent.id } : null,
      })
    } else if (!loadIndependent && historyDraftId && ready && historyDraftId !== activeId &&
      availableDrafts.some(draft => draft.id === activeId)) {
      navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, {
        replace: true, state: { generationTabDraftId: activeId },
      })
    }
  }, [activeId, availableDrafts, historyDraftId, loadIndependent, location.hash, location.pathname, location.search, navigate, ready, resolvedIndependent])
  const openHistoryDraft = async (value: DraftContent) => {
    if (uploadProgress || !await drafts.openDraft(value)) return false
    requestAnimationFrame(() => {
      if (mainScrollRef.current) mainScrollRef.current.scrollTop = 0
      promptRef.current?.focus({ preventScroll: true })
    })
    return true
  }
  const refUrls = useRef<string[]>([])
  useEffect(() => {
    const urls = refs.filter(ref => ref.previewUrl.startsWith('blob:')).map(ref => ref.previewUrl)
    for (const url of refUrls.current) if (!urls.includes(url)) URL.revokeObjectURL(url)
    refUrls.current = urls
  }, [refs])
  useEffect(() => () => { for (const url of refUrls.current) URL.revokeObjectURL(url) }, [])

  useEffect(() => {
    if (!loadIndependent && drafts.ready && !drafts.pendingIncoming && incomingDraft) window.history.replaceState({ ...window.history.state, usr: null }, '')
  }, [drafts.ready, drafts.pendingIncoming, incomingDraft, loadIndependent])

  const fallbackModelOptions = useMemo<GenerationModelStatus[]>(
    () =>
      IMAGE_GENERATION_MODEL_DEFINITIONS.map((definition) => ({
        ...definition,
        supportedResolutions: [...definition.supportedResolutions],
        supportedQualities: [...definition.supportedQualities],
        supportedAspectRatios: [...definition.supportedAspectRatios],
        available: false,
      })),
    [],
  )
  const effectiveModelOptions =
    modelOptions.length > 0 ? modelOptions : fallbackModelOptions
  const selectedModel = useMemo(
    () =>
      effectiveModelOptions.find(
        (option) =>
          imageGenerationModelKey(option.provider, option.model) === selectedModelKey,
      ) ?? {
        ...(fallbackModelOptions.find(option => imageGenerationModelKey(option.provider, option.model) === selectedModelKey)
          ?? fallbackModelOptions[0]),
        available: false, label: '草稿中的模型已不可用，请重新选择',
      },
    [effectiveModelOptions, fallbackModelOptions, selectedModelKey],
  )
  const maxReferenceImages = selectedModel.maxReferenceImages
  const supportedResolutions = SUPPORTED_RESOLUTIONS.filter((resolution) =>
    selectedModel.supportedResolutions.includes(resolution),
  )
  const supportedAspectRatios = useMemo(() => generationAspectRatios(selectedModel, refs.length), [selectedModel, refs.length])
  const [firstReferenceGeometry,setFirstReferenceGeometry] = useState<{url:string;width:number;height:number}|null>(null)
  const firstReferenceUrl=refs[0]?.previewUrl
  useEffect(()=>{
    if(selectedModel.provider!=='qwen-local'||!firstReferenceUrl)return
    let cancelled=false
    const image=new window.Image()
    image.onload=()=>{if(!cancelled)setFirstReferenceGeometry({url:firstReferenceUrl,width:image.naturalWidth,height:image.naturalHeight})}
    image.onerror=()=>{if(!cancelled)setFirstReferenceGeometry(null)}
    image.src=firstReferenceUrl
    return ()=>{cancelled=true;image.onload=null;image.onerror=null}
  },[firstReferenceUrl,selectedModel.provider])
  const expectedLocalOutput=useMemo(()=>{
    if(selectedModel.provider!=='qwen-local'&&selectedModel.provider!=='krea-local')return null
    try{return resolveLocalQwenOutputSize(imageSize,aspectRatio,firstReferenceGeometry?.url===firstReferenceUrl?firstReferenceGeometry:undefined)}
    catch{return null} // Invalid restored parameters are normalized by the existing model effect.
  },[selectedModel.provider,imageSize,aspectRatio,firstReferenceGeometry,firstReferenceUrl])

  useEffect(() => {
    if (
      selectedModel.parameterMode === 'resolution' &&
      !selectedModel.supportedResolutions.includes(imageSize)
    ) {
      setImageSize(
        selectedModel.defaultResolution ? selectedModel.defaultResolution : selectedModel.supportedResolutions.includes('2K')
          ? '2K'
          : selectedModel.supportedResolutions[0] ?? '1K',
      )
    }
    if (!supportedAspectRatios.includes(aspectRatio)) {
      setAspectRatio(
        aspectRatioForModel(
          { ...selectedModel, supportedAspectRatios: [...supportedAspectRatios], defaultAspectRatio: supportedAspectRatios[0] },
          preferredAspectRatioRef.current,
        ),
      )
    }
    if (
      selectedModel.parameterMode === 'quality' &&
      !selectedModel.supportedQualities.includes(quality)
    ) {
      setQuality('high')
    }
  }, [aspectRatio, imageSize, quality, selectedModel, supportedAspectRatios])

  // 提示词框在绘制前只测量一次，并保留主内容区的滚动位置。
  const updatePromptHeight = useCallback(() => {
    const el = promptRef.current
    if (!el) return
    let collapsedHeight: number | undefined
    if (promptCollapsed && generationSettingsRef.current) {
      const inputBounds = el.getBoundingClientRect()
      const settingsBounds = generationSettingsRef.current.getBoundingClientRect()
      const availableHeight = settingsBounds.bottom - inputBounds.top
      if (settingsBounds.left > inputBounds.right && availableHeight > 0) {
        collapsedHeight = availableHeight
      }
    }
    const contentHeight = resizePromptTextarea(el, {
      collapsed: promptCollapsed,
      collapsedHeight,
      scrollContainer: mainScrollRef.current,
    })
    if (contentHeight <= PROMPT_DEFAULT_HEIGHT && promptToggleEnabled) {
      setPromptCollapsed(false)
      setPromptToggleEnabled(false)
    }
  }, [promptCollapsed, promptToggleEnabled])

  useLayoutEffect(() => {
    updatePromptHeight()
  }, [prompt, updatePromptHeight])

  useEffect(() => {
    window.addEventListener('resize', updatePromptHeight)
    const observer = promptCollapsed && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updatePromptHeight)
      : null
    if (generationSettingsRef.current) observer?.observe(generationSettingsRef.current, { box: 'border-box' })
    if (promptToolbarRef.current) observer?.observe(promptToolbarRef.current, { box: 'border-box' })
    return () => {
      window.removeEventListener('resize', updatePromptHeight)
      observer?.disconnect()
    }
  }, [promptCollapsed, updatePromptHeight])

  const addFiles = useCallback((files: FileList | File[]) => {
    if (!ready || drafts.switching) return 0
    const accepted: File[] = []
    for (const file of Array.from(files)) {
      const error = referenceUploadError(file)
      if (error) toast.error(`${file.name}：${error}`)
      else accepted.push(file)
    }
    const remaining = Math.max(0, maxReferenceImages - refs.length)
    if (accepted.length > remaining) toast.error(`${selectedModel.label} 最多支持 ${maxReferenceImages} 张参考图`)
    const additions = accepted.slice(0, remaining).map(file => ({
      id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file),
    }))
    if (additions.length) setRefs(previous => [...previous, ...additions])
    return additions.length
  }, [drafts.switching, maxReferenceImages, ready, refs.length, selectedModel.label])

  const addFilesRef = useRef(addFiles)
  addFilesRef.current = addFiles

  const removeRef = useCallback((id: string) => {
    setRefs((prev) => {
      const item = prev.find((r) => r.id === id)
      if (item?.file) URL.revokeObjectURL(item.previewUrl)
      return prev.filter((r) => r.id !== id)
    })
  }, [])

  // 拖动排序只调整 refs 数组顺序；提交与草稿都以该顺序为准。
  const moveRef = useCallback((fromId: string, toId: string) => {
    if (fromId === toId) return
    setRefs((prev) => {
      const from = prev.findIndex((ref) => ref.id === fromId)
      const to = prev.findIndex((ref) => ref.id === toId)
      if (from < 0 || to < 0) return prev
      const next = [...prev]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    })
  }, [])

  const endRefDrag = useCallback(() => {
    draggedRefId.current = null
    lastRefDragEndRef.current = Date.now()
    setDraggingRefId(null)
    setDragOverRefId(null)
  }, [])

  useEffect(() => {
    const resetDragState = () => {
      dragDepthRef.current = 0
      setDragActive(false)
    }

    if (lightbox || previewWorkId) {
      resetDragState()
      return
    }

    const handleDragEnter = (event: DragEvent) => {
      if (!hasDraggedFiles(event.dataTransfer)) return
      event.preventDefault()
      dragDepthRef.current += 1
      setDragActive(true)
    }

    const handleDragOver = (event: DragEvent) => {
      if (!hasDraggedFiles(event.dataTransfer)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }

    const handleDragLeave = (event: DragEvent) => {
      if (!hasDraggedFiles(event.dataTransfer)) return
      event.preventDefault()
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) setDragActive(false)
    }

    const handleDrop = (event: DragEvent) => {
      if (!hasDraggedFiles(event.dataTransfer)) return
      event.preventDefault()
      const files = event.dataTransfer?.files
      resetDragState()
      if (files?.length) addFilesRef.current(files)
    }

    window.addEventListener('dragenter', handleDragEnter)
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('dragleave', handleDragLeave)
    window.addEventListener('drop', handleDrop)
    window.addEventListener('dragend', resetDragState)
    window.addEventListener('blur', resetDragState)

    return () => {
      window.removeEventListener('dragenter', handleDragEnter)
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('dragleave', handleDragLeave)
      window.removeEventListener('drop', handleDrop)
      window.removeEventListener('dragend', resetDragState)
      window.removeEventListener('blur', resetDragState)
      resetDragState()
    }
  }, [lightbox, previewWorkId])

  const handlePaste = useCallback((e: ClipboardEvent) => {
    // 保留输入框里的正常粘贴体验，只在页面空白区域接管图片粘贴。
    if (isEditablePasteTarget(e.target)) return

    const clipboard = e.clipboardData
    const imageTypes = [...Array.from(clipboard?.items ?? []), ...Array.from(clipboard?.files ?? [])]
      .map(item => item.type).filter(type => type.startsWith('image/'))
    const pastedFiles = extractReferenceImagesFromClipboard(clipboard, imageTypes)
    if (pastedFiles.length === 0) return

    e.preventDefault()
    const addedCount = addFilesRef.current(pastedFiles)
    if (addedCount > 0) {
      toast.success(`已粘贴 ${addedCount} 张参考图`)
    }
  }, [])

  useEffect(() => {
    // 生成页挂载期间监听全局粘贴，方便直接把剪贴板图片追加到参考图区。
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [handlePaste])

  const taskScope = session ? JSON.stringify([session.user.id, session.workspace.id]) : ''
  const currentTaskScope = useRef(taskScope)
  currentTaskScope.current = taskScope
  const submissionFlight = useRef<{ scope: string; key: string; controller: AbortController; promise: Promise<void> } | null>(null)
  useEffect(() => () => {
    submissionFlight.current?.controller.abort()
    generatingClick.current?.abort()
  }, [taskScope])
  const [pendingQueryIds,setPendingQueryIds] = useState<string[]>([])
  useEffect(() => { try { setPendingQueryIds(taskScope?Object.keys(readPendingQueries(taskScope)):[]) } catch(error) { toast.error(error instanceof Error?error.message:'结果获取记录读取失败') } }, [taskScope])
  const autoDownloads = useMemo(() => new GenerationDownloads(taskScope, {
    storage: () => window.localStorage,
    lock: async (name, work) => {
      if (navigator.locks) await navigator.locks.request(name, work)
      else await work()
    },
  }), [taskScope])
  const downloadErrorShown = useRef(false)
  useEffect(() => { downloadErrorShown.current = false }, [taskScope])
  const onDownloadError = () => {
    if (!downloadErrorShown.current) { toast.error('自动下载未能触发，可从作品中手动下载'); downloadErrorShown.current = true }
  }
  const [historyRevision, setHistoryRevision] = useState(0)
  const [pendingSubmission, setPendingSubmission] = useState<PendingSubmission | null>(null)
  const pendingRef = useRef(pendingSubmission)
  pendingRef.current = pendingSubmission
  const [missingReceiptKey, setMissingReceiptKey] = useState<string | null>(null)
  const [receiptReadFailed, setReceiptReadFailed] = useState(false)
  const recoveredReceiptKeys = useRef(new Set<string>())
  useEffect(() => {
    setPendingSubmission(null)
    setMissingReceiptKey(null)
    setSubmissionNotice('')
    setReceiptReadFailed(false)
    recoveredReceiptKeys.current.clear()
    try {
      const receipts = taskScope ? readPendingSubmissions(taskScope) : []
      recoveredReceiptKeys.current = new Set(receipts.map(receipt => receipt.key))
      setPendingSubmission(receipts[0] ?? null)
    } catch (error) {
      setReceiptReadFailed(true)
      setActionBanner({ title: '提交记录读取失败', detail: error instanceof Error ? error.message : null })
    }
  }, [taskScope])

  const finishSubmission = (key: string) => {
    clearSubmission(taskScope, key)
    if (currentTaskScope.current !== taskScope) return
    recoveredReceiptKeys.current.delete(key)
    const next = recoveredReceiptKeys.current.size
      ? readPendingSubmissions(taskScope).find(receipt => recoveredReceiptKeys.current.has(receipt.key))
      : undefined
    pendingRef.current = next ?? null
    setPendingSubmission(next ?? null)
  }

  const acceptSubmission = (pending: PendingSubmission, job: Pick<GenerationTask, 'id'>, conflict = false) => {
    if (currentTaskScope.current !== taskScope) return
    finishSubmission(pending.key)
    void autoDownloads.watch(job.id).catch(onDownloadError)
    setSubmissionNotice('')
    setActionBanner(null)
    setHistoryRevision(n => n + 1)
    toast.success(conflict ? '该提交已在另一标签页接单' : '任务已提交，可继续编辑下一份草稿')
  }

  const uploadLocalReferences = async (
    localRefs: RefImage[], signal: AbortSignal, onUploaded?: (ref: RefImage, filename: string) => void,
  ) => {
    const filenamesById = new Map<string, string>()
    if (!localRefs.length) return filenamesById
    try {
      for (const [index, ref] of localRefs.entries()) {
        signal.throwIfAborted()
        setUploadProgress(`正在上传参考图 ${index + 1}/${localRefs.length}…`)
        const uploadKey = ref.uploadKey ?? ref.id
        const { filenames } = await uploadGenerateRefs([ref.file!], { uploadKey, signal })
        if (filenames.length !== 1 || !filenames[0]) throw new Error('参考图上传结果不完整，请重试')
        const filename = filenames[0]
        filenamesById.set(ref.id, filename)

        // Each acknowledged upload is stored before the next request begins.
        const editor = latestDraftContent.current
        if (editor && currentTaskScope.current === taskScope && editor.refs.some(item => item.id === ref.id && item.file === ref.file)) {
          const next = (editor.refs as RefImage[]).map(item => item.id === ref.id ? { ...item, serverFilename: filename, uploadKey } : item)
          latestDraftContent.current = { ...editor, refs: next }
          setRefs(next)
          await drafts.persist({ ...editor, refs: next })
        }
        onUploaded?.(ref, filename)
      }
      return filenamesById
    } finally { setUploadProgress('') }
  }

  const sendSubmission = (receipt: PendingSubmission, localRefs = refs, mode: 'new' | 'check' | 'retry' = 'new'): Promise<void> => {
    const active = submissionFlight.current
    if (active) {
      if (active.scope === taskScope && active.key === receipt.key) return active.promise
      return Promise.reject(new Error('还有提交正在核对，请稍后重试'))
    }
    const controller = new AbortController()
    const { signal } = controller
    let pending = receipt
    const post = async () => {
      const job = await taskRequest<GenerationTask>('', { key: pending.key, ...pending.input }, { signal })
      if (!job?.id || job.key !== pending.key) throw new ApiConnectionError('提交回执不完整，请核对接单状态')
      return job
    }
    const check = async (conflict = false) => {
      setSubmissionNotice('尚未确认是否接单，正在核对')
      setMissingReceiptKey(null)
      try {
        const job = await readSubmission(pending.key, signal)
        if (signal.aborted) return 'unavailable'
        if (job) {
          acceptSubmission(pending, job, conflict)
          return 'found'
        }
        setMissingReceiptKey(pending.key)
        setSubmissionNotice('没有查到这次接单记录，可以用原提交标识重试')
        return 'missing'
      } catch (error) {
        if (!signal.aborted) {
          const detail = error instanceof Error ? error.message : '请稍后重试'
          setSubmissionNotice(`尚未确认是否接单：${detail}`)
        }
        return 'unavailable'
      }
    }
    const repairReferences = async (error: ApiHttpError) => {
      const expired = new Map<string, RefImage>()
      for (const name of error.referenceFilenames ?? pending.input.referenceFilenames) {
        const id = pending.localReferenceIds?.[name]
        const ref = localRefs.find(item => item.file && (id ? item.id === id : item.serverFilename === name))
        if (ref) expired.set(name, ref)
      }
      if (!expired.size) throw error
      const namesById = new Map([...expired].map(([name, ref]) => [ref.id, name]))
      const repairs = [...expired].map(([name, ref]) => ({
        ...ref,
        // Every tab repairing the same expired receipt will get the same replacement.
        uploadKey: `${ref.id}:${name}`,
      }))
      await uploadLocalReferences(repairs, signal, (ref, replacement) => {
        const name = namesById.get(ref.id)!
        const localReferenceIds = { ...pending.localReferenceIds, [replacement]: ref.id }
        delete localReferenceIds[name]
        const referenceFilenames = pending.input.referenceFilenames.map(filename => filename === name ? replacement : filename)
        pending = { ...pending, localReferenceIds, input: { ...pending.input, referenceFilenames } }
        persistSubmission(taskScope, pending)
        setPendingSubmission(pending)
      })
    }
    const promise = Promise.resolve().then(() => withSubmissionLock(taskScope, receipt.key, async () => {
      if (signal.aborted) return
      if (mode !== 'new') {
        // The other tab may have saved repaired reference receipts while we waited.
        pending = readPendingSubmissions(taskScope).find(item => item.key === pending.key) ?? pending
      }
      const retired = isRetiredSeedreamRequest(pending.input.provider, pending.input.model, pending.input.imageSize)
      if (mode !== 'new' || retired) {
        const status = await check(pending.conflicted)
        if (status !== 'missing') return
        if (mode === 'check' && !retired && !pending.conflicted) return
        if (retired) {
          finishSubmission(pending.key)
          setSubmissionNotice('')
          throw new Error('历史中没有这次提交。旧 Seedream 模型或档位已下线，请用 5.5 草稿重新提交。')
        }
        if (pending.conflicted) {
          finishSubmission(pending.key)
          setSubmissionNotice('冲突的任务记录已不存在，可以重新提交草稿')
          return
        }
      }
      setMissingReceiptKey(null)
      setSubmissionNotice('')
      try {
        let job: GenerationTask
        try { job = await post() }
        catch (error) {
          if (!(error instanceof ApiHttpError) || error.code !== 'REFERENCE_UNAVAILABLE') throw error
          await repairReferences(error)
          job = await post()
        }
        if (!signal.aborted) acceptSubmission(pending, job)
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof ApiHttpError && error.code === 'TASK_KEY_CONFLICT') {
          pending = { ...pending, conflicted: true }
          persistSubmission(taskScope, pending)
          pendingRef.current = pending
          setPendingSubmission(pending)
          if (await check(true) === 'missing') {
            finishSubmission(pending.key)
            setSubmissionNotice('冲突的任务记录已不存在，可以重新提交草稿')
          }
        } else if (isSubmissionUnconfirmed(error)) {
          await check()
        } else {
          if (error instanceof ApiHttpError && error.status >= 400 && error.status < 500 && ![401, 409, 429].includes(error.status)) {
            finishSubmission(pending.key)
          }
          throw error
        }
      }
    }, signal)).catch(error => {
      if (!signal.aborted) throw error
    }).finally(() => {
      if (submissionFlight.current?.controller === controller) submissionFlight.current = null
    })
    submissionFlight.current = { scope: taskScope, key: receipt.key, promise, controller }
    return promise
  }
  const checkPending = useRef<(pending: PendingSubmission) => void>(() => {})
  checkPending.current = pending => {
    void sendSubmission(pending, refs, 'check').catch(error => {
      const detail = error instanceof Error ? error.message : '请稍后重试'
      setSubmissionNotice(`尚未确认是否接单：${detail}`)
    })
  }
  const pendingKey = pendingSubmission?.key
  useEffect(() => {
    if (!pendingKey) return
    const check = () => { if (pendingRef.current) checkPending.current(pendingRef.current) }
    check()
    window.addEventListener('online', check)
    return () => window.removeEventListener('online', check)
  }, [pendingKey])

  const handleHistoryTasks = (jobs: GenerationTask[], options?: { fullHistory?: boolean }) => {
    setRecentTasks(jobs)
    if (options?.fullHistory) {
      const sync = workSync.current
      if (taskScope && sync.scope === taskScope) {
        for (const job of jobs) {
          if (job.workAssetId) sync.seen.add(job.workAssetId)
        }
      }
      return
    }
    syncRecentWorks(jobs)
    const pending = pendingRef.current
    const accepted = pending && jobs.find(job => job.key === pending.key)
    if (pending && accepted) {
      acceptSubmission(pending, accepted, pending.conflicted)
      if (submissionFlight.current?.key === accepted.key) submissionFlight.current.controller.abort()
    }
    if (taskScope) {
      void autoDownloads.observe(jobs).catch(onDownloadError)
      try {
        const ids = reconcileQueries(taskScope, jobs)
        setPendingQueryIds(previous => JSON.stringify(previous) === JSON.stringify(ids) ? previous : ids)
      } catch { /* Keep unreadable query receipts intact. */ }
    }
  }

  const retryHistoryGeneration = async (job: GenerationTask) => {
    const { provider } = job.input
    if (!isImageGenerationProviderName(provider) || !canGenerateAgain(job)) throw new Error('这项任务不能直接重新生成，请查看原因或另开草稿')
    if (generating) throw new Error('正在提交其它任务，请稍后再试')
    if (receiptReadFailed) throw new Error('提交记录无法读取，已暂停新提交')
    const existing = pendingSubmission
    if (existing && existing.historyTaskId !== job.id) throw new Error('请先核对上一次提交，当前草稿可以继续编辑')
    if (existing) { await sendSubmission(existing, refs, 'retry'); return }
    const pending = { key: historyRetryKey(job), historyTaskId: job.id, input: { ...structuredClone(job.input), provider } }
    persistSubmission(taskScope, pending)
    setPendingSubmission(pending)
    await sendSubmission(pending)
  }
  const resumeHistoryResult = async(job:GenerationTask) => {
    void autoDownloads.watch(job.id).catch(onDownloadError)
    try {
      setPendingQueryIds(previous=>[...new Set([...previous,job.id])])
      await resumeResultQuery(taskScope,job)
    } finally {
      void autoDownloads.watch(job.id).catch(onDownloadError)
      if(currentTaskScope.current===taskScope){try{setPendingQueryIds(Object.keys(readPendingQueries(taskScope)))}catch{/* Preserve unreadable receipts for recovery. */}setHistoryRevision(n=>n+1)}
    }
  }
  const retrySubmission = async () => {
    if (!pendingSubmission || generating) return
    setGenerating(true)
    try { await sendSubmission(pendingSubmission, refs, 'retry'); setActionBanner(null) }
    catch (error) {
      if (!showUnavailableSource(error, pendingSubmission.input)) {
        toast.error(error instanceof Error ? error.message : '尚未确认，请保留提交记录重试')
      }
    }
    finally { setGenerating(false) }
  }
  const showUnavailableSource = (error: unknown, source: Pick<GenerationTask['input'], 'sourceAssetId' | 'sourceTaskId'>) => {
    if (!(error instanceof ApiHttpError) || error.code !== 'SOURCE_TASK_UNAVAILABLE' ||
      (!source.sourceTaskId && !source.sourceAssetId) || currentTaskScope.current !== taskScope) return false
    const { sourceAssetId, sourceTaskId } = source
    setActionBanner({
      title: '来源历史或作品已不可用',
      detail: '可解除来源绑定，保留当前草稿的提示词和参考图，作为新任务提交。',
      unavailableSource: { sourceAssetId, sourceTaskId },
    })
    return true
  }
  const handleGenerate = async (detachSource = false) => {
    if (generating || generatingClick.current) return
    if (receiptReadFailed) { toast.error('提交记录无法读取，已暂停新提交'); return }
    if (pendingSubmission || submissionFlight.current) { toast.error('请先核对上一次提交'); return }
    if (refs.some(ref => ref.fileMissing && !ref.serverFilename)) { toast.error('有参考图文件未恢复，请重新添加或移除后再生成'); return }
    const promptSnapshot = prompt.trim()
    if (!promptSnapshot) {
      toast.error('请输入提示词')
      return
    }
    if (modelStatus !== 'ready' || !selectedModel.available) {
      toast.error(`${selectedModel.label} 尚未配置`)
      return
    }
    if (refs.length > maxReferenceImages) {
      toast.error(
        `${selectedModel.label} 最多支持 ${maxReferenceImages} 张参考图，请先移除多余图片`,
      )
      return
    }

    const generationRefs = refs.map((ref) => ({ ...ref }))
    const generationSettings = {
      aspectRatio,
      imageSize,
      quality,
      provider: selectedModel.provider,
      model: selectedModel.model,
      parameterMode: selectedModel.parameterMode,
    }
    const newFiles = generationRefs.filter((ref) => ref.file && !ref.serverFilename)
    const promptIsLong =
      (promptRef.current?.scrollHeight ?? PROMPT_DEFAULT_HEIGHT) >
      PROMPT_DEFAULT_HEIGHT

    setPromptCollapsed(promptIsLong)
    setPromptToggleEnabled(promptIsLong)
    const controller = new AbortController()
    generatingClick.current = controller
    setGenerating(true)
    setActionBanner(null)
    setSubmissionNotice('')

    try {
      if (newFiles.length) {
        setUploadProgress(`正在上传参考图 1/${newFiles.length}…`)
        await drafts.persist(draftContent, false)
      }
      const uploadedFilenames = await uploadLocalReferences(newFiles, controller.signal)
      if (currentTaskScope.current !== taskScope) return

      const submittedRefs = generationRefs.map(ref => ({
        ...ref, serverFilename: ref.serverFilename ?? uploadedFilenames.get(ref.id),
      }))
      const referenceFilenames = submittedRefs.flatMap(ref => ref.serverFilename ? [ref.serverFilename] : [])

      if (detachSource) {
        setSourceAssetId(undefined)
        setSourceTaskId(undefined)
      }
      const pending: PendingSubmission = {
        key: crypto.randomUUID(),
        localReferenceIds: Object.fromEntries(submittedRefs.flatMap(ref => ref.file && ref.serverFilename ? [[ref.serverFilename, ref.id]] : [])),
        input: {
          sourceAssetId: detachSource ? undefined : sourceAssetId,
          sourceTaskId: detachSource ? undefined : sourceTaskId,
          referenceNotes: generationRefs.map(ref => ref.note || ''),
          prompt: promptSnapshot,
          referenceFilenames,
          aspectRatio: generationSettings.aspectRatio,
          ...(generationSettings.parameterMode === 'resolution'
            ? { imageSize: generationSettings.imageSize }
            : {}),
          provider: generationSettings.provider,
          model: generationSettings.model,
          ...(generationSettings.parameterMode === 'quality'
            ? { quality: generationSettings.quality }
            : {}),
        },
      }
      persistSubmission(taskScope, pending); setPendingSubmission(pending)
      await sendSubmission(pending, submittedRefs)
    } catch (err) {
      if (controller.signal.aborted) return
      if (!detachSource && showUnavailableSource(err, { sourceAssetId, sourceTaskId })) return
      const message = err instanceof Error ? err.message : '未知错误'
      const status = err instanceof ApiHttpError ? err.status : undefined
      const { title, detail } = presentationForHttpActionError(status, message)
      setActionBanner({ title, detail })
      toast.error(detail ? `生成失败：${detail}` : `生成失败：${title}`)
    } finally {
      if (generatingClick.current === controller) generatingClick.current = null
      setUploadProgress('')
      setGenerating(false)
    }
  }

  const handleSaveAsset = async (assetType: 'work' | 'recipe') => {
    if (!result || savingAssetRef.current || savedAssetTypes.includes(assetType)) return
    savingAssetRef.current = true
    setSavingAsset(true)
    setActionBanner(null)
    try {
      await saveGeneratedToGallery({
        taskId: result.taskId,
        sourceAssetId: result.sourceAssetId,
        filename: result.filename,
        prompt: result.prompt,
        width: result.width,
        height: result.height,
        referenceFilenames: result.referenceFilenames,
        assetType,
        generation: buildGenerationSnapshot({
          aspectRatio: result.aspectRatio,
          ...(result.imageSize ? { imageSize: result.imageSize } : {}),
          execution: result.execution,
          provider: result.provider,
          model: result.model,
          ...(result.quality ? { quality: result.quality } : {}),
        }),
      })
      setSavedResults(previous => ({ ...previous, [resultKey]: [...new Set([...(previous[resultKey] || []), assetType])] }))
      toast.success(assetType === 'recipe' ? '已存为配方！' : '已保存为作品！')
    } catch (err) {
      const message = err instanceof Error ? err.message : '保存失败'
      const status = err instanceof ApiHttpError ? err.status : undefined
      const { title, detail } = presentationForHttpActionError(status, message)
      if (currentResultKey.current === resultKey) setActionBanner({ title, detail })
      toast.error(detail ?? title)
    } finally {
      savingAssetRef.current = false
      setSavingAsset(false)
    }
  }

  const downloadOriginal = (filename: string, src?: string) => {
    try { downloadGenerationResult(filename, src) }
    catch { toast.error('未能交给浏览器下载，请重试') }
  }
  const handleDownload = () => { if (result) downloadOriginal(result.filename) }

  const remainingReferenceSlots = Math.max(maxReferenceImages - refs.length, 0)
  // 落点提示画在目标哪一侧，取决于拖动方向：向下拖落在目标之后，向上拖落在目标之前。
  const draggingIndex = draggingRefId ? refs.findIndex((ref) => ref.id === draggingRefId) : -1


  const historyRecipeKey = (job: GenerationTask) => JSON.stringify([session?.user.id, session?.workspace.id, job.id, job.result?.filename])
  const saveHistoryRecipe = async (job: GenerationTask) => {
    if (!job.result) return
    const key = historyRecipeKey(job)
    if (savedResults[key]?.includes('recipe')) return
    await saveGeneratedToGallery({taskId:job.id,sourceAssetId:job.input.sourceAssetId,filename:job.result.filename,prompt:job.input.prompt,width:job.result.width,height:job.result.height,referenceFilenames:job.input.referenceFilenames,assetType:'recipe',generation:buildGenerationSnapshot({provider:job.result.provider,model:job.result.model,aspectRatio:job.result.aspectRatio,imageSize:job.result.imageSize,quality:job.result.quality,execution:job.result.execution??job.input.execution})})
    setSavedResults(previous => ({...previous,[key]:[...new Set([...(previous[key]||[]),'recipe'])]}))
    toast.success('已存为配方！')
  }
  const showHistoryResult = (job: GenerationTask) => { if (job.result) { setResult({ ...job.result, taskId: job.id, automaticWork: job.workSavePending !== undefined || !!job.workAssetId, referenceFilenames: job.input.referenceFilenames, sourceAssetId: job.input.sourceAssetId }); setActionBanner(null); requestAnimationFrame(() => resultSectionRef.current?.scrollIntoView({block:'start'})) } }
  const draftFromHistory = (job: GenerationTask) => {historyNavigation.current++;return openHistoryDraft({ prompt: job.input.prompt, sourceTaskId: job.input.sourceTaskId, sourceAssetId: job.input.sourceAssetId, refs: job.input.referenceFilenames.map((filename, index) => ({ id: crypto.randomUUID(), serverFilename: filename, note: job.input.referenceNotes?.[index] })), selectedModelKey: `${job.input.provider}:${job.input.model}`, aspectRatio: job.input.aspectRatio, imageSize: job.input.imageSize || '2K', quality: job.input.quality || 'high' })}
  const continueFromHistory = async (job: GenerationTask) => {
    if (!job.result) return
    const navigation=++historyNavigation.current, revision=draftRevision.current
    const {asset} = await createReferenceAsset('images', job.result.filename, job.input.prompt.slice(0, 50) || '生成结果')
    if(navigation!==historyNavigation.current||revision!==draftRevision.current)return
    const version = asset.versions.find(version => version.id === asset.currentVersionId)!
    return openHistoryDraft({prompt:job.input.prompt,sourceAssetId:job.input.sourceAssetId,sourceTaskId:job.id,refs:[{id:crypto.randomUUID(),serverFilename:version.filename}],selectedModelKey:`${job.input.provider}:${job.input.model}`,aspectRatio:job.input.aspectRatio,imageSize:job.input.imageSize||'2K',quality:job.input.quality||'high'})
  }

  const worksById = useMemo(() => new Map(gallery.allImages.filter(image => image.assetType === 'work' && !image.deletedAt).map(image => [image.id, image])), [gallery.allImages])
  const workSync = useRef({
    scope: taskScope,
    initialized: false,
    seen: new Set<string>(),
    inFlight: new Set<string>(),
  })
  useEffect(() => {
    const sync = {scope: taskScope, initialized: false, seen: new Set<string>(), inFlight: new Set<string>()}
    workSync.current = sync
    setRequestFullHistory(false)
    setRecentWorkLimit(30)
    return () => { sync.scope = '' }
  }, [taskScope])

  const syncRecentWorks = (jobs: GenerationTask[]) => {
    const sync = workSync.current
    if (!taskScope || sync.scope !== taskScope) return
    const initial = !sync.initialized
    sync.initialized = true
    for (const job of jobs) {
      const id = job.workAssetId
      if (!id || job.status !== 'completed' || !job.result || sync.seen.has(id)) continue
      if (initial || worksById.has(id)) {
        sync.seen.add(id)
        continue
      }
      if (sync.inFlight.has(id)) continue
      sync.inFlight.add(id)
      void fetchImage(id).then(image => {
        if (sync.scope !== currentTaskScope.current || workSync.current !== sync) return
        sync.seen.add(id)
        if (image.assetType === 'work' && !image.deletedAt) gallery.addImage(image)
      }).catch(() => {
        // The gallery's existing refresh remains available if the targeted read fails.
      }).finally(() => sync.inFlight.delete(id))
    }
  }

  const recentWorks = useMemo(() => {
    const worksByFilename = new Map<string, GalleryImage | null>()
    for (const image of worksById.values()) {
      worksByFilename.set(image.filename, worksByFilename.has(image.filename) ? null : image)
    }
    const seen = new Set<string>()
    return [...recentTasks]
      .filter(job => !job.deletedAt && job.status === 'completed' && job.result)
      .sort((left, right) => (right.completedAt || right.createdAt).localeCompare(left.completedAt || left.createdAt))
      .flatMap(job => {
        const saved = job.workAssetId ? worksById.get(job.workAssetId) : worksByFilename.get(job.result!.filename)
        const image = saved ?? taskAsImage(job)
        const workId = job.workAssetId ?? saved?.id
        const key = workId ? `work:${workId}` : `file:${image.filename}`
        if (seen.has(key)) return []
        seen.add(key)
        return [{ image, job, saved: !!saved }]
      })
  }, [recentTasks, worksById])
  const hasMoreLoadedWorks = recentWorks.length > recentWorkLimit
  const hasMoreRecentWorks = hasMoreLoadedWorks || historyMeta.hasMore
  useEffect(() => {
    const end = recentWorkEndRef.current
    const scroll = mainScrollRef.current
    if (!hasMoreRecentWorks || historyMeta.loadingFull || !!historyMeta.fullError || !end || !scroll || typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return
      if (recentWorks.length > recentWorkLimit) {
        setRecentWorkLimit(limit => Math.max(limit, recentWorkLimit + 30))
      }
      if (historyMeta.hasMore && recentWorks.length <= recentWorkLimit + 30) {
        setRequestFullHistory(true)
      }
    }, {
      root: scroll,
      rootMargin: '0px 0px 240px',
    })
    observer.observe(end)
    return () => observer.disconnect()
  }, [hasMoreRecentWorks, historyMeta.hasMore, historyMeta.loadingFull, historyMeta.fullError, recentWorks.length, recentWorkLimit])
  const previewIndex = recentWorks.findIndex(({ job }) => job.id === previewWorkId)
  const preview = recentWorks[previewIndex]
  const previewWork = preview?.image
  if (previewWorkId && !preview) setPreviewWorkId(null)

  const previousPreviewWork = previewIndex > 0 ? recentWorks[previewIndex - 1].job : undefined
  const nextPreviewWork = previewIndex >= 0 ? recentWorks[previewIndex + 1]?.job : undefined
  const openWorkPreview = (id: string, trigger: HTMLButtonElement) => {
    previewTrigger.current = trigger
    setPreviewWorkId(id)
  }
  const detailIndex = recentWorks.findIndex(({ job }) => job.id === detailWorkId)
  const detail = recentWorks[detailIndex]
  const sourceId = detail?.job.input.sourceTaskId
  const source = sourceId ? recentWorks.find(({ job }) => job.id === sourceId) : undefined
  const recipeSaved = detail && savedResults[historyRecipeKey(detail.job)]?.includes('recipe')
  const favoriteLabel = detail?.image.favorited ? '取消喜欢' : '喜欢'
  const archiveHistoryResult = async (id: string) => {
    await taskRequest(`/${id}/trash`, { confirm: true })
    setRecentTasks(previous => previous.filter(job => job.id !== id))
    setHistoryRevision(revision => revision + 1)
    toast.success('任务记录已移入历史回收站，图库中的作品不受影响')
  }
  const runDetail = async (work: () => Promise<void>) => {
    if (detailFlight.current) return
    detailFlight.current = true
    setDetailBusy(true)
    try { await work() }
    catch (error) { toast.error(error instanceof Error ? error.message : '操作失败') }
    finally { detailFlight.current = false; setDetailBusy(false) }
  }
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0a0a10] text-zinc-200 dark">
      <Sidebar
        currentPage="generate"
        assetType={gallery.assetType}
        filter={gallery.filter}
        onAssetTypeChange={gallery.setAssetType}
        onFilterChange={gallery.setFilter}
        tags={gallery.tags}
        workCount={gallery.workCount}
        recipeCount={gallery.recipeCount}
        favoriteCount={gallery.favoriteCount}
      />

      {/* 主内容区 */}
      <main ref={mainScrollRef} className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="flex min-w-0 flex-none flex-col">
        <header className="flex items-center border-b border-[#1E2336] px-6 py-3 shrink-0">
          <h1 className="flex items-center gap-1.5 text-sm font-medium text-zinc-400">
            <Sparkles size={14} />
            图片生成
          </h1>
        </header>

        {sourceUnavailable && !loadIndependent && <div role="status" className="px-4 pt-4 text-sm text-amber-300">来源条目不存在或已移入回收站，未创建来源草稿。</div>}
        {!drafts.ready && drafts.error && <div role="alert" className="p-4 text-red-300">{drafts.error} <button onClick={drafts.retry}>{loadIndependent ? '重试读取来源' : '重试读取草稿'}</button></div>}
        <div className="flex-1">
          <fieldset disabled={!drafts.ready || drafts.switching} className="mx-auto min-w-0 max-w-5xl px-6 py-6 space-y-6">
            {drafts.ready && drafts.error && <p role="alert" className="text-sm text-red-300">{drafts.error} <button onClick={drafts.retry}>重试保存</button></p>}
            {drafts.pendingIncoming && <div className="space-y-2 text-sm text-amber-200"><p>已有未完成草稿。如何使用刚打开的配方？</p><div className="flex flex-wrap gap-3"><button onClick={() => void drafts.chooseIncoming('new')} className="rounded bg-indigo-700 px-3 py-2">另开草稿</button><button onClick={() => void drafts.chooseIncoming('replace')} className="rounded border border-zinc-700 px-3 py-2">替换当前草稿</button><button onClick={() => void drafts.chooseIncoming('keep')} className="px-3 py-2">继续当前草稿</button></div></div>}
            {submissionNotice && <p role="status" className="text-sm text-amber-200">{submissionNotice}</p>}
            {pendingSubmission && <div role="alert" className="rounded border border-amber-700 p-3 text-sm text-amber-200"><p>上一次提交回执尚未确认：{pendingSubmission.input.prompt.slice(0, 80)}</p><button disabled={generating} onClick={() => { if (missingReceiptKey === pendingKey) void retrySubmission(); else checkPending.current(pendingSubmission) }} className="mt-2 underline">{missingReceiptKey === pendingKey ? '核对／重试原提交（保留相同标识）' : '核对原提交回执'}</button></div>}

            {/* 提示词区域随内容增高，设置面板保持自身高度。 */}
            <div className="flex flex-col lg:flex-row gap-6 items-start">
              {/* 提示词 */}
              <div className="flex w-full min-w-0 flex-1 flex-col space-y-2">
                <section ref={promptToolbarRef} aria-label="生成草稿" className="flex min-h-7 flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                  <label
                    htmlFor="generation-prompt"
                    className="text-xs font-medium text-zinc-400"
                  >
                    提示词
                  </label>
                  <span className="text-[11px] text-zinc-500">{drafts.error ? '草稿尚未保存' : drafts.status}</span>
                  {drafts.conflict && <span role="status" className="text-xs text-amber-200">原草稿已在其他标签页更新，本页修改已另存为新草稿。</span>}
                  </div>
                  <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                    <select aria-label="切换草稿" value={drafts.activeId} disabled={!drafts.ready || drafts.switching || generating || !!uploadProgress} onChange={event => void drafts.switchDraft(event.target.value)} className="min-w-0 max-w-48 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300">
                      {!drafts.drafts.some(draft => draft.id === drafts.activeId) && <option value={drafts.activeId}>当前草稿</option>}
                      {drafts.drafts.map(draft => <option key={draft.id} value={draft.id}>{draft.prompt.trim().slice(0, 36) || '空白草稿'} · {new Date(draft.updatedAt).toLocaleString()}</option>)}
                    </select>
                    <button type="button" disabled={!drafts.ready || drafts.switching || generating || !!uploadProgress} onClick={() => void drafts.newDraft(defaultSettings ? {selectedModelKey:imageGenerationModelKey(defaultSettings.provider,defaultSettings.model),aspectRatio:defaultSettings.aspectRatio,imageSize:defaultSettings.imageSize||'2K',quality:defaultSettings.quality||'high'} : undefined)} className="rounded px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-zinc-800/70 hover:text-zinc-200 active:bg-zinc-800 disabled:opacity-40">新建草稿</button>
                    <button type="button" disabled={!availableDrafts.some(draft => draft.id === activeId) || generating || !!uploadProgress} onClick={() => {
                      if (window.confirm('删除当前草稿？其中未用于生成的参考图也会从此浏览器移除。')) void drafts.deleteDraft()
                    }} className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-red-950 hover:text-red-300 disabled:opacity-40">删除当前草稿</button>
                  {promptToggleEnabled ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-zinc-500 transition-colors hover:bg-zinc-800/70 hover:text-zinc-300"
                      onClick={() => setPromptCollapsed((collapsed) => !collapsed)}
                      aria-expanded={!promptCollapsed}
                      aria-controls="generation-prompt"
                    >
                      {promptCollapsed ? (
                        <>
                          <ChevronDown size={13} />
                          展开
                        </>
                      ) : (
                        <>
                          <ChevronUp size={13} />
                          收起
                        </>
                      )}
                    </button>
                  ) : null}
                  </div>
                </section>
                <textarea
                  id="generation-prompt"
                  ref={promptRef}
                  value={prompt}
                  readOnly={!drafts.ready || drafts.switching}
                  onInput={(event) => setPrompt(event.currentTarget.value)}
                  placeholder="描述你想生成的图片…"
                  className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-200 outline-none focus:border-zinc-500 placeholder:text-zinc-600 leading-relaxed"
                />
              </div>

              {/* 设置面板 */}
              <div ref={generationSettingsRef} className="w-full lg:w-[280px] shrink-0 space-y-4 rounded-lg border border-[#1E2336] bg-[#0d0d14] p-4">
                <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">生成设置</h3>

                {modelStatus === 'error' && <button type="button" className="text-sm text-amber-200 underline" onClick={() => {
                  setModelStatus('loading')
                  setModelReload(n => n + 1)
                }}>模型状态获取失败，点击重试</button>}
                <SelectField
                  label="模型"
                  value={selectedModelKey}
                  onChange={(value) => {
                    setSelectedModelKey(value)
                    const nextModel = effectiveModelOptions.find(
                      (option) =>
                        imageGenerationModelKey(option.provider, option.model) === value,
                    )
                    if (nextModel) {
                      if (nextModel.defaultResolution) setImageSize(nextModel.defaultResolution)
                      setAspectRatio(
                        aspectRatioForModel(
                          nextModel,
                          preferredAspectRatioRef.current,
                        ),
                      )
                    }
                  }}
                  options={modelStatus !== 'ready'
                    ? [{ value: selectedModelKey, label: modelStatus === 'loading' ? '正在获取模型状态…' : '模型状态获取失败', disabled: true }]
                    : [...(!effectiveModelOptions.some(option => imageGenerationModelKey(option.provider, option.model) === selectedModelKey) ? [{ value: selectedModelKey, label: '草稿中的模型已不可用，请重新选择', disabled: true }] : []), ...effectiveModelOptions.map((option) => ({
                    value: imageGenerationModelKey(option.provider, option.model),
                    label: `${option.label}${option.available ? '' : option.unavailableReason ? '（离线）' : '（未配置）'}`,
                    disabled: !option.available,
                  }))]}
                />
                <SelectField
                  label="宽高比"
                  value={aspectRatio}
                  onChange={(value) => {
                    preferredAspectRatioRef.current = value
                    setAspectRatio(value)
                  }}
                  options={supportedAspectRatios.map((value) => ({
                    value,
                    label: value === 'source' ? '跟随第一张参考图' : value === 'auto' ? '自动' : value,
                  }))}
                />
                {selectedModel.parameterMode === 'resolution' ? (
                  <SelectField
                    label="分辨率"
                    value={imageSize}
                    onChange={setImageSize}
                    options={supportedResolutions.map((r) => ({ value: r, label: r }))}
                  />
                ) : (
                  <SelectField
                    label="质量"
                    value={quality}
                    onChange={(value) => setQuality(value as ImageGenerationQuality)}
                    options={selectedModel.supportedQualities.map((value) => ({
                      value,
                      label: value[0].toUpperCase() + value.slice(1),
                    }))}
                  />
                )}

                {(selectedModel.provider==='qwen-local'||selectedModel.provider==='krea-local') && (
                  <p aria-live="polite" className="text-xs tabular-nums text-zinc-400">
                    {expectedLocalOutput?`预计 ${expectedLocalOutput.width} × ${expectedLocalOutput.height}`:aspectRatio==='source'?'跟随第一张参考图':null}
                  </p>
                )}

                <Button
                  onClick={() => void handleGenerate()}
                  disabled={
                    generating || receiptReadFailed || !!pendingSubmission ||
                    !prompt.trim() ||
                    modelStatus !== 'ready' ||
                    !selectedModel.available ||
                    refs.length > maxReferenceImages
                  }
                  className="w-full mt-2 bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
                >
                  {generating ? (
                    <>
                      <Loader2 size={14} className="animate-spin mr-1.5" />
                      提交中…
                    </>
                  ) : (
                    <>
                      <Sparkles size={14} className="mr-1.5" />
                      提交生成
                    </>
                  )}
                </Button>
              </div>
            </div>

            {/* 参考图区域 */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-zinc-400">
                参考图片
                <span className="ml-1.5 text-zinc-600">
                  {maxReferenceImages===0?'（当前模型仅支持文生图）':<>（点击、拖拽或粘贴上传；点缩略图看大图，拖动缩略图可调整顺序，最多 {maxReferenceImages} 张）</>}
                </span>
              </label>
              {refs.length > maxReferenceImages ? (
                <div className="text-xs text-amber-400">
                  {maxReferenceImages===0?'当前模型仅支持文生图；参考图已保留，请移除参考图或切回支持参考图的模型。':<>当前有 {refs.length} 张参考图，{selectedModel.label} 最多支持 {maxReferenceImages} 张；请移除多余图片后再生成。</>}
                </div>
              ) : null}

              <div className="flex flex-wrap items-start gap-3">
                {refs.map((ref, i) => (
                  <div
                    key={ref.id}
                    className={`group relative ${draggingRefId === ref.id ? 'opacity-50' : ''} ${
                      dragOverRefId === ref.id
                        ? `before:absolute ${draggingIndex >= 0 && draggingIndex < i ? 'before:left-full' : 'before:-left-1.5'} before:top-0 before:h-20 before:w-0.5 before:rounded before:bg-indigo-400 before:content-['']`
                        : ''
                    }`}
                    onDragStart={(event) => {
                      // 只有缩略图本身能起拖；删除按钮与编号角标保持纯点击。
                      draggedRefId.current = ref.id
                      setDraggingRefId(ref.id)
                      event.dataTransfer.setData('text/plain', ref.id)
                      event.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={endRefDrag}
                    onDragOver={(event) => {
                      const fromId = draggedRefId.current
                      if (!fromId) return
                      event.preventDefault()
                      event.stopPropagation()
                      event.dataTransfer.dropEffect = 'move'
                      setDragOverRefId((current) => {
                        if (fromId === ref.id) return null
                        return current === ref.id ? current : ref.id
                      })
                    }}
                    onDragLeave={(event) => {
                      if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget as Node)) return
                      setDragOverRefId((current) => (current === ref.id ? null : current))
                    }}
                    onDrop={(event) => {
                      const fromId = draggedRefId.current
                      if (event.dataTransfer.files.length > 0 || !fromId) return
                      event.preventDefault()
                      event.stopPropagation()
                      endRefDrag()
                      moveRef(fromId, ref.id)
                    }}
                  >
                    <div
                      draggable
                      title={`参考图 ${i + 1}：点击看大图，拖动调整顺序`}
                      onClick={() => {
                        // 拖动结束后的这次 click 不当作“看大图”；缺文件或没有预览地址时不弹。
                        if (Date.now() - lastRefDragEndRef.current < 200) return
                        if (!ref.previewUrl) return
                        setLightbox({ src: ref.previewUrl, alt: `参考图 ${i + 1} 大图` })
                      }}
                      className="h-20 w-20 cursor-grab overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 active:cursor-grabbing"
                    >
                      {ref.fileMissing && !ref.serverFilename ? <span role="alert" className="block p-2 text-xs text-amber-300">参考图文件未恢复，请重新添加</span> : <img
                        src={ref.previewUrl}
                        alt={`参考图 ${i + 1}`}
                        draggable={false}
                        className="h-full w-full object-cover"
                      />}
                    </div>
                    <span className="absolute -top-1.5 -left-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-[10px] font-bold text-white">
                      {i + 1}
                    </span>
                    <button
                      aria-label={`移除参考图 ${i + 1}`}
                      onClick={() => removeRef(ref.id)}
                      className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-white md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 transition-opacity"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}

                {refs.length < maxReferenceImages && (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex h-20 w-20 items-center justify-center rounded-lg border border-dashed border-zinc-600 text-zinc-500 hover:border-zinc-400 hover:text-zinc-300 transition-colors"
                  >
                    <Plus size={20} />
                  </button>
                )}
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) addFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </div>

            {/* 生成结果 */}
            {(result || generating || actionBanner) && (
              <div ref={resultSectionRef} role="region" aria-label="生成结果" className="scroll-mt-6 space-y-3">
                <label className="text-xs font-medium text-zinc-400">生成结果</label>
                {actionBanner ? (
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-4 text-sm text-amber-100">
                    <div className="font-medium">{actionBanner.title}</div>
                    {actionBanner.detail ? (
                      <div className="mt-1 text-amber-200/90">
                        {actionBanner.detail}
                      </div>
                    ) : null}
                    {actionBanner.unavailableSource &&
                      actionBanner.unavailableSource.sourceTaskId === sourceTaskId &&
                      actionBanner.unavailableSource.sourceAssetId === sourceAssetId && (
                        <Button type="button" variant="outline" className="mt-3" disabled={generating || !prompt.trim() || refs.some(ref => ref.fileMissing && !ref.serverFilename)} onClick={() => void handleGenerate(true)}>
                          解除来源绑定并提交
                        </Button>
                      )}
                  </div>
                ) : null}
                {(generating || result) ? (
                  <div className="overflow-hidden rounded-lg border border-[#1E2336] bg-[#0d0d14]">
                    {generating ? (
                      <div className="flex h-64 items-center justify-center">
                        <div className="flex flex-col items-center gap-3 text-zinc-500">
                          <Loader2 size={32} className="animate-spin" />
                          <span className="text-sm">
                            {uploadProgress || submissionNotice || '正在提交任务…'}
                          </span>
                        </div>
                      </div>
                    ) : result ? (
                      <div className="flex flex-col items-center gap-4 p-6">
                        <RetryableImage
                          src={imageAssetUrl(result.filename)}
                          alt="生成结果"
                          className="max-h-[500px] max-w-full rounded-lg object-contain shadow-2xl cursor-pointer hover:opacity-90 transition-opacity"
                          onClick={() => setLightbox({ src: imageAssetUrl(result.filename), alt: '生成结果大图', downloadFilename:result.filename })}
                        />
                        <div className="flex gap-3">
                          {!result.automaticWork && <Button
                            onClick={() => handleSaveAsset('work')}
                            disabled={savingAsset || generating || savedAssetTypes.includes('work')}
                            variant="outline"
                            className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                          >
                            <Save size={14} className="mr-1.5" />
                            {savedAssetTypes.includes('work') ? '已保存作品' : '保存作品'}
                          </Button>}
                          <Button
                            onClick={() => handleSaveAsset('recipe')}
                            disabled={savingAsset || generating || savedAssetTypes.includes('recipe')}
                            variant="outline"
                            className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                          >
                            <Sparkles size={14} className="mr-1.5" />
                            {savedAssetTypes.includes('recipe') ? '已存为配方' : '存为配方'}
                          </Button>
                          <Button
                            onClick={handleDownload}
                            variant="outline"
                            className="border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                          >
                            <Download size={14} className="mr-1.5" />
                            下载
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}


          </fieldset>
        </div>
        </div>
        <section aria-label="生成记录" className="flex min-w-0 flex-none flex-col">
          <div className="@container min-h-0 flex-1 px-6 pb-6" tabIndex={0} aria-label="浏览生成记录">
            <div className="mx-auto max-w-5xl">
              <header className="flex flex-wrap items-center gap-x-2 pt-4">
                <h2 className="text-xs font-semibold tracking-wider text-zinc-300">生成记录</h2>
                {typeof historyMeta.total === 'number' && historyMeta.total > 0 && (
                  <span className="text-xs text-zinc-500">共 {historyMeta.total} 条任务</span>
                )}
              </header>
            <GenerationHistory key={taskScope} revision={historyRevision} requestFull={requestFullHistory} fullRetryKey={fullHistoryRetryKey} onHistoryMeta={setHistoryMeta} onTasks={handleHistoryTasks} pendingQueryIds={pendingQueryIds} pendingRetryId={pendingSubmission?.historyTaskId} onRetryGeneration={retryHistoryGeneration} onResumeResult={resumeHistoryResult} onRetrySave={async job=>{if(!job.result)return;await saveGeneratedToGallery({taskId:job.id,filename:job.result.filename,prompt:job.input.prompt,width:job.result.width,height:job.result.height,referenceFilenames:job.input.referenceFilenames,assetType:'work'});toast.success('作品已保存')}} onSaveRecipe={saveHistoryRecipe} onResult={showHistoryResult} onPreview={job => { if (job.result) setLightbox({ src: imageAssetUrl(job.result.filename), alt: '生成历史大图', downloadFilename:job.result.filename }) }} onPreviewReference={(filename, label) => setLightbox({ src: referenceAssetUrl(filename), alt: label, downloadFilename: filename })} onDraft={job => { void draftFromHistory(job) }} onContinue={async job => { await continueFromHistory(job) }} hasWork={job => recentWorks.some(work => work.job.id === job.id && work.saved)} works={<>
            <div className="grid grid-cols-2 gap-3 @min-[520px]:grid-cols-3 @min-[860px]:grid-cols-4 @min-[1100px]:grid-cols-5">
              {recentWorks.slice(0, recentWorkLimit).map(({ image, job }) => {
                const duration = generationTaskDuration(job)
                return (
                  <div key={job.id} className="group/work relative min-w-0 [content-visibility:auto]">
                    <button type="button" aria-label={image.workCode ? `打开作品 ${image.workCode}` : '打开作品大图'}
                      onClick={event => openWorkPreview(job.id, event.currentTarget)}
                      className="block w-full min-w-0 overflow-hidden rounded-lg text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-400">
                      <span className="block aspect-square overflow-hidden rounded-lg bg-zinc-900">
                        <img src={`${imageAssetUrl(image.filename)}?thumbnail=true`} alt="" loading="lazy" decoding="async"
                          className={cn(
                            'work-thumbnail h-full w-full object-contain motion-safe:transition-[filter]',
                            'group-has-[:focus-visible]/work:blur-[2px]',
                            '[@media(hover:hover)_and_(pointer:fine)]:group-has-[.work-thumbnail:hover,.work-actions_button:hover]/work:blur-[2px]',
                          )} />
                      </span>
                      <span className="mt-1.5 block break-words text-xs text-zinc-300">
                        {[formatImageGenerationSource(job.input.provider, job.input.model), generationTaskSettings(job.input)].filter(Boolean).join(' · ')}
                      </span>
                      {duration && <span className="block text-xs tabular-nums text-zinc-500">用时 {duration}</span>}
                    </button>
                    <div className={cn(
                      'work-actions pointer-events-none absolute inset-x-0 top-0 flex aspect-square flex-col items-center justify-center gap-1.5 rounded-lg bg-black/50 p-1 text-xs text-white opacity-0',
                      'group-has-[:focus-visible]/work:opacity-100 group-has-[:focus-visible]/work:[&_button]:pointer-events-auto',
                      '[@media(hover:hover)_and_(pointer:fine)]:group-has-[.work-thumbnail:hover,.work-actions_button:hover]/work:opacity-100',
                      '[@media(hover:hover)_and_(pointer:fine)]:group-has-[.work-thumbnail:hover,.work-actions_button:hover]/work:[&_button]:pointer-events-auto',
                    )}>
                      {image.workCode && <CopyWorkCodeButton code={image.workCode} showIcon={false}
                        className="max-w-full border border-white/25 bg-black/70 px-1.5 py-1.5 hover:bg-zinc-800" />}
                      <div className="flex flex-wrap justify-center gap-1">
                        <button type="button" aria-label="详情"
                          className="rounded border border-white/25 bg-black/70 px-2 py-1.5 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-indigo-300"
                          onClick={() => setDetailWorkId(job.id)}>详情</button>
                        <button type="button" aria-label="另开"
                          className="rounded border border-white/25 bg-black/70 px-2 py-1.5 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-indigo-300"
                          onClick={() => void draftFromHistory(job)}>另开</button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            {historyMeta.loadingFull ? (
              <p role="status" className="px-5 pb-5 text-center text-xs text-zinc-400">正在加载更多历史作品…</p>
            ) : historyMeta.fullError ? (
              <p role="alert" className="px-5 pb-5 text-center text-xs text-amber-300">
                {historyMeta.fullError}{' '}
                <button type="button" className="underline hover:text-amber-200" onClick={() => { setRequestFullHistory(true); setFullHistoryRetryKey(n => n + 1) }}>重试加载</button>
              </p>
            ) : hasMoreRecentWorks ? (
              <button
                ref={recentWorkEndRef}
                type="button"
                onClick={() => {
                  setRecentWorkLimit(limit => limit + 30)
                  if (historyMeta.hasMore) setRequestFullHistory(true)
                }}
                className="mx-auto mb-5 block rounded-lg px-3 py-2 text-sm text-zinc-400 hover:bg-white/5 hover:text-white"
              >
                {hasMoreLoadedWorks
                  ? '显示更多作品'
                  : `加载更多历史作品${typeof historyMeta.total === 'number' ? `（共 ${historyMeta.total} 条记录）` : ''}`}
              </button>
            ) : recentWorks.length > 0 && (
              <p className="px-5 pb-5 text-center text-xs text-zinc-500">{gallery.loadingMore ? '正在加载作品…' : gallery.error ?? '已显示全部生成作品'}</p>
            )}
            {!recentWorks.length && <p className="px-5 text-sm text-zinc-500">{gallery.loading ? '正在加载作品…' : '暂无生成作品'}</p>}
            </>} />
            </div>
          </div>
        </section>
      </main>
      <Dialog open={Boolean(previewWork)} onOpenChange={open => { if (!open) setPreviewWorkId(null) }}>
        {previewWork && <DialogContent
          hideClose
          aria-describedby={undefined}
          className="left-0 top-0 z-[60] block h-full w-full max-w-none translate-x-0 translate-y-0 overflow-hidden rounded-none border-0 bg-black/85 p-0 sm:rounded-none"
          onCloseAutoFocus={event => {
            event.preventDefault()
            previewTrigger.current?.focus({ preventScroll: true })
            previewTrigger.current = null
          }}
          onKeyDown={event => {
            if (event.altKey || event.ctrlKey || event.metaKey) return
            const work = event.key === 'ArrowLeft' ? previousPreviewWork : event.key === 'ArrowRight' ? nextPreviewWork : undefined
            if (work) {
              event.preventDefault()
              setPreviewWorkId(work.id)
            }
          }}
        >
          <DialogTitle className="sr-only">大图预览</DialogTitle>
          <button type="button" aria-label="关闭大图预览" onClick={() => setPreviewWorkId(null)}
            className="absolute right-4 top-4 z-10 grid size-10 place-items-center rounded-full bg-black/70 text-white hover:bg-zinc-800">
            <X size={20} />
          </button>
          <RetryableImage src={imageAssetUrl(previewWork.filename)} alt={previewWork.workCode || '生成作品'}
            className="block size-full cursor-zoom-out object-contain"
            onClick={() => setPreviewWorkId(null)} />
          <div role="group" aria-label="大图操作"
            className={cn(
              'absolute inset-x-2 bottom-[max(0.5rem,env(safe-area-inset-bottom))] mx-auto flex w-fit flex-wrap items-center justify-center gap-1.5 rounded-xl bg-zinc-950/85 p-1.5 text-sm text-white sm:gap-2.5',
              '[@media(hover:hover)_and_(pointer:fine)]:opacity-0',
              '[@media(hover:hover)_and_(pointer:fine)]:hover:opacity-100',
              '[@media(hover:hover)_and_(pointer:fine)]:has-[:focus-visible]:opacity-100',
            )}
            onClick={event => { if (!(event.target as Element).closest('button')) setPreviewWorkId(null) }}>
            <button type="button" aria-label="上一张" disabled={!previousPreviewWork}
              className="grid size-9 place-items-center rounded hover:bg-white/10 disabled:opacity-30"
              onClick={() => { if (previousPreviewWork) setPreviewWorkId(previousPreviewWork.id) }}><ChevronLeft size={20} /></button>
            <span aria-live="polite" className="tabular-nums">{previewIndex + 1} / {recentWorks.length}</span>
            <button type="button" aria-label="下一张" disabled={!nextPreviewWork}
              className="grid size-9 place-items-center rounded hover:bg-white/10 disabled:opacity-30"
              onClick={() => { if (nextPreviewWork) setPreviewWorkId(nextPreviewWork.id) }}><ChevronRight size={20} /></button>
            <button type="button" className="rounded border border-zinc-700 px-2.5 py-2 hover:bg-white/10"
              onClick={() => downloadOriginal(previewWork.filename)}>下载原图</button>
            <button type="button" className="rounded border border-zinc-700 px-2.5 py-2 hover:bg-white/10"
              onClick={() => {
                previewTrigger.current = null
                setPreviewWorkId(null)
                setDetailWorkId(preview.job.id)
              }}>详情</button>
          </div>
        </DialogContent>}
      </Dialog>
      {detail && <DetailModal
        readOnly
        image={{
          ...taskAsImage(detail.job),
          prompt: detail.job.input.prompt,
          createdAt: detail.job.createdAt,
          workCode: detail.saved ? detail.image.workCode : undefined,
        }}
        requestDuration={generationTaskDuration(detail.job)}
        generationContext={source && <button type="button" className={relatedDetailAction} onClick={() => setDetailWorkId(source.job.id)}>来源结果</button>}
        onClose={() => setDetailWorkId(null)}
        onPrevious={detailIndex > 0 ? () => setDetailWorkId(recentWorks[detailIndex - 1].job.id) : undefined}
        onNext={detailIndex + 1 < recentWorks.length ? () => {
          if (detailIndex + 1 >= recentWorkLimit) setRecentWorkLimit(limit => limit + 30)
          setDetailWorkId(recentWorks[detailIndex + 1].job.id)
        } : undefined}
        positionLabel={`${detailIndex + 1} / ${recentWorks.length}`}
        onDelete={archiveHistoryResult}
        deleteConfirmation={{ message: '仅从生成记录隐藏，不影响图库里的作品，可在历史回收站恢复。', label: '移入回收站' }}
        primaryActions={(guard, confirmArchive) => <>
          <div aria-label="常用操作" className="flex items-center gap-1.5">
            <button type="button" className={mainDetailAction} disabled={detailBusy} onClick={() => guard(() => void runDetail(async () => {
              if (await draftFromHistory(detail.job)) setDetailWorkId(current => current === detail.job.id ? null : current)
            }))}><Sparkles size={14} />另开草稿</button>
            <button type="button" className={alternateDetailAction} disabled={detailBusy} onClick={() => guard(() => void runDetail(async () => {
              if (await continueFromHistory(detail.job)) setDetailWorkId(current => current === detail.job.id ? null : current)
            }))}><Pencil size={14} />继续修改</button>
            {detail.saved && <button type="button" aria-label={favoriteLabel} title={favoriteLabel} aria-pressed={detail.image.favorited}
              className={cn(iconAction, 'hover:text-rose-400 disabled:opacity-40')} disabled={detailBusy}
              onClick={() => guard(() => void runDetail(async () => { await gallery.toggleFavorite(detail.image.id) }))}>
              <Heart size={16} className={detail.image.favorited ? 'fill-rose-400 text-rose-400' : ''} />
            </button>}
          </div>
          <div aria-label="其他操作" className="grid grid-cols-2 gap-1 @min-[315px]:grid-cols-[repeat(3,minmax(0,1fr))_auto]">
            <button type="button" className={secondaryAction} onClick={() => downloadOriginal(detail.job.result!.filename)}><Download size={14} />下载原图</button>
            <button type="button" className={secondaryAction} disabled={detailBusy || recipeSaved}
              onClick={() => guard(() => void runDetail(() => saveHistoryRecipe(detail.job)))}>
              {recipeSaved ? <Check size={14} /> : <Save size={14} />}{recipeSaved ? '已存为配方' : '存为配方'}
            </button>
            {detail.saved && <button type="button" className={secondaryAction} onClick={() => guard(() =>
              navigate('/', { state: { openImageId: detail.image.id, assetType: 'work' } })
            )}>去图库查看</button>}
            <button type="button" className={cn(secondaryAction, 'text-red-400 hover:bg-red-950/40 hover:text-red-300')}
              disabled={detailBusy} onClick={confirmArchive}><Trash2 size={14} />移入历史回收站</button>
          </div>
        </>}
      />}

      {dragActive && (
        <div
          className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center bg-[#08080d]/80 p-6 backdrop-blur-sm"
          role="status"
          aria-live="polite"
          data-testid="reference-drop-overlay"
        >
          <div
            className={cn(
              'flex min-h-64 w-full max-w-2xl flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed px-8 text-center shadow-2xl',
              remainingReferenceSlots > 0
                ? 'border-indigo-400/80 bg-indigo-500/10 text-indigo-100'
                : 'border-amber-400/80 bg-amber-500/10 text-amber-100',
            )}
          >
            <ImageIcon size={44} strokeWidth={1.5} />
            <div>
              <div className="text-lg font-semibold">
                {remainingReferenceSlots > 0
                  ? '松开即可添加为参考图'
                  : '参考图数量已达到上限'}
              </div>
              <div className="mt-1.5 text-sm opacity-75">
                {remainingReferenceSlots > 0
                  ? `支持 JPG、PNG、WebP · 还可添加 ${remainingReferenceSlots} 张`
                  : `${selectedModel.label} 最多支持 ${maxReferenceImages} 张`}
              </div>
            </div>
          </div>
        </div>
      )}

      <Dialog open={Boolean(lightbox)} onOpenChange={open => { if (!open) setLightbox(null) }}>
        <DialogContent
          hideClose
          aria-modal="true"
          aria-describedby={undefined}
          className="left-0 top-0 z-[60] flex h-dvh w-full max-w-none translate-x-0 translate-y-0 items-center justify-center border-0 bg-black/25 p-0 sm:rounded-none"
          onOpenAutoFocus={() => {
            lightboxOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          }}
          onCloseAutoFocus={event => {
            event.preventDefault()
            lightboxOpener.current?.focus({ preventScroll: true })
          }}
          onClick={event => { if (event.target === event.currentTarget) setLightbox(null) }}
        >
          <DialogTitle className="sr-only">大图预览</DialogTitle>
          {lightbox && <>
            <RetryableImage src={lightbox.src} alt={lightbox.alt} className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl" />
            {lightbox.downloadFilename && <button
              type="button"
              className="absolute bottom-4 left-4 rounded-md border border-zinc-700 bg-zinc-900/90 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
              onClick={() => { if (lightbox.downloadFilename) downloadOriginal(lightbox.downloadFilename, lightbox.src) }}
            >下载原图</button>}
          </>}
          <DialogClose
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white/70 transition-colors hover:text-white"
            aria-label="关闭大图预览"
          >
            <X size={20} />
          </DialogClose>
        </DialogContent>
      </Dialog>

    </div>
  )
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string; disabled?: boolean }[]
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-zinc-500">{label}</label>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200',
          'outline-none focus:border-zinc-500 appearance-none cursor-pointer',
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

function draftFromPageState(state: GeneratePageState & { resolution?: string }): DraftContent {
  const provider = state.provider ?? 'google'
  const selectedModelKey = imageGenerationModelKey(provider,
    state.model || (isImageGenerationProviderName(provider) ? defaultModelForProvider(provider) : ''),
  )
  return {
    sourceTaskId: state.sourceTaskId, sourceAssetId: state.sourceAssetId,
    prompt: state.prompt || '', selectedModelKey,
    refs: (state.referenceImages || []).map((filename, index) => ({
      id: crypto.randomUUID(), serverFilename: filename, note: state.referenceNotes?.[index],
    })),
    aspectRatio: state.aspectRatio || '1:1', imageSize: state.imageSize || state.resolution || '2K',
    quality: state.quality || 'high',
  }
}

function defaultAspectRatioForModel(
  model: Pick<GenerationModelStatus, 'defaultAspectRatio' | 'supportedAspectRatios'>,
): string {
  return model.defaultAspectRatio ?? model.supportedAspectRatios[0] ?? '1:1'
}

function aspectRatioForModel(
  model: Pick<GenerationModelStatus, 'defaultAspectRatio' | 'supportedAspectRatios'>,
  preferredAspectRatio: string | null,
): string {
  if (
    preferredAspectRatio &&
    model.supportedAspectRatios.includes(preferredAspectRatio)
  ) {
    return preferredAspectRatio
  }
  return defaultAspectRatioForModel(model)
}
