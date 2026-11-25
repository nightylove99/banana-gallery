import type { ImageGenerationQuality } from './image-generation-providers'
export interface DraftReference {
  note?: string
  id: string
  serverFilename?: string
  uploadKey?: string
  file?: File
  fileInfo?: { key: string; name: string; type: string; lastModified: number }
  fileMissing?: boolean
}
export interface DraftContent {
  sourceTaskId?: string
  sourceAssetId?: string
  prompt: string
  refs: DraftReference[]
  selectedModelKey: string
  aspectRatio: string
  imageSize: string
  quality: ImageGenerationQuality
}
export interface GenerationDraft extends DraftContent { id: string; updatedAt: string; revision?: number }
export interface DraftCatalog { version: 1; activeId: string; drafts: GenerationDraft[] }
const keyFor = (scope: string) => `banana-generation-drafts:v1:${scope}`
const unsavedDrafts = new Map<string, GenerationDraft>()
const writtenFiles = new WeakMap<File, string>()

function readLegacyCatalog(scope: string): DraftCatalog {
  const raw = window.localStorage.getItem(keyFor(scope))
  const catalog: DraftCatalog = raw ? JSON.parse(raw) : { version: 1, activeId: '', drafts: [] }
  if (catalog.version !== 1 || !Array.isArray(catalog.drafts) ||
      catalog.drafts.some(draft => typeof draft.id !== 'string' || typeof draft.prompt !== 'string' || !Array.isArray(draft.refs))) {
    throw new Error('已有草稿格式无法读取，已停止覆盖；请保留此浏览器的数据')
  }
  return catalog
}

async function openDraftDatabase(): Promise<IDBDatabase> {
  if (!window.indexedDB) throw new Error('此浏览器无法保存草稿，请使用支持 IndexedDB 的浏览器')
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open('banana-generation-draft-files', 2)
    let blocked = false
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files')
      db.createObjectStore('catalogs')
    }
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return }
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => {
      blocked = true
      reject(new Error('草稿库被其他窗口占用，请关闭旧页面后重试'))
    }
  })
}

function referencedKeys(scope: string, catalog: DraftCatalog) {
  return new Set(catalog.drafts.flatMap(draft => draft.refs.flatMap(ref => {
    const key = `${scope}:${draft.id}:${ref.id}`
    return ref.fileInfo?.key === key ? [key] : []
  })))
}

/** Catalog and Blob updates share a transaction, including cross-tab revision checks. */
async function updateCatalog<T extends DraftCatalog>(
  scope: string, update?: (catalog: DraftCatalog, files: IDBObjectStore) => T,
): Promise<T> {
  const db = await openDraftDatabase()
  try {
    const next = await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(['catalogs', 'files'], 'readwrite')
      const catalogs = transaction.objectStore('catalogs')
      const files = transaction.objectStore('files')
      let result: T
      const request = catalogs.get(scope)
      request.onsuccess = () => {
        try {
          const migrated = !request.result
          const catalog: DraftCatalog = request.result ?? readLegacyCatalog(scope)
          result = update ? update(catalog, files) : catalog as T
          if (!migrated && !update) return
          catalogs.put({ version: result.version, activeId: result.activeId, drafts: result.drafts }, scope)
          const keys = referencedKeys(scope, result)
          for (const key of referencedKeys(scope, catalog)) {
            if (!keys.has(key)) files.delete(key)
          }
          if (migrated) {
            // Clean up Blob writes abandoned by the old, non-atomic storage path.
            const prefix = scope + ':'
            const cursor = files.openKeyCursor(IDBKeyRange.bound(prefix, scope + ';', false, true))
            cursor.onsuccess = () => {
              const entry = cursor.result
              if (!entry) return
              if (typeof entry.key === 'string' && !keys.has(entry.key)) files.delete(entry.key)
              entry.continue()
            }
          }
        } catch (error) {
          reject(error)
          transaction.abort()
        }
      }
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(transaction.error ?? new Error('草稿保存中断，请重试'))
    })
    // Only remove the legacy copy after the IndexedDB transaction commits.
    try { window.localStorage.removeItem(keyFor(scope)) } catch { /* IndexedDB remains authoritative. */ }
    return next
  } finally { db.close() }
}

export async function readDraftCatalog(scope: string): Promise<DraftCatalog> {
  const catalog = await updateCatalog(scope)
  const pending = unsavedDrafts.get(scope)
  return pending ? { ...catalog, activeId: pending.id, drafts: [pending, ...catalog.drafts.filter(draft => draft.id !== pending.id)] } : catalog
}

export async function loadGenerationDraft(scope: string, id: string): Promise<(GenerationDraft & { unsaved: boolean }) | undefined> {
  const draft = (await readDraftCatalog(scope)).drafts.find(item => item.id === id)
  if (!draft) return undefined
  const db = await openDraftDatabase()
  try {
    const store = db.transaction('files').objectStore('files')
    const refs = await Promise.all(draft.refs.map(async ref => {
      if (ref.file || !ref.fileInfo) return { ...ref }
      const { key, name, type, lastModified } = ref.fileInfo
      if (key !== `${scope}:${draft.id}:${ref.id}`) return { ...ref, fileMissing: true }
      const blob = await new Promise<Blob | undefined>((resolve, reject) => {
        const request = store.get(key)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      }).catch(() => undefined)
      if (!blob) return { ...ref, fileMissing: true }
      const file = new File([blob], name, { type, lastModified })
      writtenFiles.set(file, key)
      return { ...ref, fileMissing: false, file }
    }))
    return { ...draft, revision: draft.revision ?? 0, unsaved: unsavedDrafts.get(scope) === draft, refs }
  } finally { db.close() }
}

export async function saveGenerationDraft(scope: string, draft: GenerationDraft, { makeActive = true } = {}) {
  if (makeActive) unsavedDrafts.set(scope, draft)
  const written: [File, string][] = []
  const result = await updateCatalog(scope, (catalog, files) => {
    const expectedRevision = draft.revision ?? 0
    const current = catalog.drafts.find(item => item.id === draft.id)
    const conflicted = (current?.revision ?? 0) !== expectedRevision
    const id = conflicted ? crypto.randomUUID() : draft.id
    const previousKeys = referencedKeys(scope, catalog)
    const refs = draft.refs.map(ref => {
      const key = `${scope}:${id}:${ref.id}`
      let fileInfo = ref.fileInfo?.key === key ? ref.fileInfo : undefined
      if (ref.file) {
        if (writtenFiles.get(ref.file) !== key || !previousKeys.has(key)) {
          files.put(ref.file, key)
          written.push([ref.file, key])
        }
        fileInfo = { key, name: ref.file.name, type: ref.file.type, lastModified: ref.file.lastModified }
      }
      return { id: ref.id, note: ref.note, serverFilename: ref.serverFilename, uploadKey: ref.uploadKey, fileInfo, fileMissing: !ref.file && ref.fileMissing }
    })
    const stored: GenerationDraft = {
      id, revision: conflicted ? 1 : expectedRevision + 1, updatedAt: draft.updatedAt, prompt: draft.prompt, refs,
      sourceTaskId: draft.sourceTaskId, sourceAssetId: draft.sourceAssetId,
      selectedModelKey: draft.selectedModelKey, aspectRatio: draft.aspectRatio,
      imageSize: draft.imageSize, quality: draft.quality,
    }
    return {
      version: 1 as const, activeId: makeActive ? id : catalog.activeId,
      drafts: [stored, ...catalog.drafts.filter(item => item.id !== id)], savedId: id,
    }
  })
  for (const [file, key] of written) writtenFiles.set(file, key)
  if (unsavedDrafts.get(scope) === draft) unsavedDrafts.delete(scope)
  return result
}

export function selectGenerationDraft(scope: string, id: string) {
  return updateCatalog(scope, catalog => ({
    ...catalog, activeId: catalog.drafts.some(draft => draft.id === id) ? id : catalog.activeId,
  }))
}

export async function deleteGenerationDraft(scope: string, id: string, revision: number) {
  const result = await updateCatalog(scope, catalog => {
    const current = catalog.drafts.find(draft => draft.id === id)
    if (current && (current.revision ?? 0) !== revision) throw new Error('草稿已在其他标签页更新，请重新打开后再删除')
    const drafts = catalog.drafts.filter(draft => draft.id !== id)
    return { ...catalog, drafts, activeId: drafts[0]?.id ?? '' }
  })
  if (unsavedDrafts.get(scope)?.id === id) unsavedDrafts.delete(scope)
  return result
}
