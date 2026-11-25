import { IMAGE_INPUT_LIMIT_MESSAGE, imageInputMaxBytes } from './image-intake-policy'

export const SUPPORTED_REFERENCE_IMAGE_TYPES = ['image/jpeg', 'image/png'] as const
export const SUPPORTED_UPLOAD_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

type SupportedImageTypes = readonly string[]

interface EditableTargetLike {
  tagName?: string | null
  isContentEditable?: boolean
  parentElement?: EditableTargetLike | null
}

interface ClipboardItemLike {
  kind: string
  type: string
  getAsFile: () => File | null
}

interface ClipboardDataLike {
  items?: ArrayLike<ClipboardItemLike>
  files?: ArrayLike<File>
}

interface DragDataLike {
  types?: ArrayLike<string>
}

export function hasDraggedFiles(dataTransfer: DragDataLike | null) {
  return Array.from(dataTransfer?.types ?? []).includes('Files')
}

export function isSupportedReferenceImage(
  file: Pick<File, 'type'>,
  supportedTypes: SupportedImageTypes = SUPPORTED_REFERENCE_IMAGE_TYPES,
) {
  return supportedTypes.includes(file.type)
}

export function referenceUploadError(file: File) {
  if (!isSupportedReferenceImage(file, SUPPORTED_UPLOAD_IMAGE_TYPES)) return '参考图仅支持 JPG、PNG 或 WebP'
  if (file.size === 0) return '参考图文件为空'
  if (file.size > imageInputMaxBytes(file.type)) return IMAGE_INPUT_LIMIT_MESSAGE
  return null
}

// 统一约束参考图来源，避免拖拽或粘贴绕过文件选择器的类型限制。
export function splitReferenceImageFiles(
  files: Iterable<File>,
  supportedTypes: SupportedImageTypes = SUPPORTED_REFERENCE_IMAGE_TYPES,
) {
  const accepted: File[] = []
  const rejected: File[] = []

  for (const file of files) {
    if (isSupportedReferenceImage(file, supportedTypes)) {
      accepted.push(file)
    } else {
      rejected.push(file)
    }
  }

  return { accepted, rejected }
}

// 优先读取剪贴板里的图片项，兼容“复制图片”与“截图后直接粘贴”两种场景。
export function extractReferenceImagesFromClipboard(
  clipboardData: ClipboardDataLike | null,
  supportedTypes: SupportedImageTypes = SUPPORTED_REFERENCE_IMAGE_TYPES,
) {
  if (!clipboardData) return []

  const itemFiles: File[] = []
  const items = clipboardData.items ?? []
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    if (item.kind !== 'file') continue
    if (!supportedTypes.includes(item.type)) {
      continue
    }

    const file = item.getAsFile()
    if (file) itemFiles.push(file)
  }

  if (itemFiles.length > 0) return itemFiles

  return splitReferenceImageFiles(Array.from(clipboardData.files ?? []), supportedTypes).accepted
}

export function isEditablePasteTarget(target: EventTarget | null) {
  let current = target as EditableTargetLike | null

  while (current) {
    const tagName = current.tagName?.toUpperCase()
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || current.isContentEditable) {
      return true
    }
    current = current.parentElement ?? null
  }

  return false
}
