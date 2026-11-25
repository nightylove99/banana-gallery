import { useCallback, useEffect, useRef, useState } from 'react'
import { deleteGenerationDraft, loadGenerationDraft, readDraftCatalog, saveGenerationDraft, selectGenerationDraft, type DraftContent, type GenerationDraft } from '@/lib/generation-drafts'

interface DraftCursor {
  scope: string
  id: string
  revision: number
  writes: Promise<void>
  restoring: boolean
  isolated: boolean
  savedContent?: DraftContent
}

type IndependentDraftLoader = () => Promise<DraftContent | null>

export function useGenerationDrafts({ scope, content, incoming, onRestore, loadIndependent, historyDraftId }: {
  scope: string | null
  content: DraftContent
  incoming: DraftContent | null
  onRestore: (draft: DraftContent) => void
  loadIndependent?: IndependentDraftLoader
  historyDraftId?: string
}) {
  const [switching, setSwitching] = useState(false)
  const switchingRef = useRef(false)
  const cursor = useRef<DraftCursor | null>(null)
  const [conflict, setConflict] = useState(false)
  const [activeId, setActiveId] = useState('')
  const [ready, setReady] = useState(false)
  const [drafts, setDrafts] = useState<GenerationDraft[]>([])
  const [pendingIncoming, setPendingIncoming] = useState<DraftContent | null>(null)
  const [status, setStatus] = useState('正在读取草稿…')
  const [error, setError] = useState('')
  const [independentResult, setIndependentResult] = useState<{ scope: string; load: IndependentDraftLoader; id: string | null } | null>(null)
  const skipNormalRestore = useRef(false)
  const [readRetry, setReadRetry] = useState(0)
  const [retry, setRetry] = useState(0)
  const pendingWrites = useRef(0)
  const alive = useRef(true)
  const activate = useCallback((scope: string | null, draft?: GenerationDraft, restoring = !!draft, isolated = cursor.current?.isolated ?? false) => {
    if (!scope) return
    const id = draft?.id ?? crypto.randomUUID()
    cursor.current = { scope, id, revision: draft?.revision ?? 0, writes: Promise.resolve(), restoring, isolated }
    setActiveId(id)
    setConflict(false)
    if (restoring) setStatus(draft ? '草稿已保存到此浏览器' : '尚未保存草稿')
  }, [])
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (!scope) return
    // A route replace records a draft already open in this tab; don't reload it.
    if (!loadIndependent && !incoming && cursor.current?.scope === scope &&
        (historyDraftId === cursor.current.id || skipNormalRestore.current)) {
      skipNormalRestore.current = false
      return
    }
    skipNormalRestore.current = false
    let cancelled = false
    setReady(false); setError(''); setPendingIncoming(null)
    void (async () => {
      try {
        if (loadIndependent) {
          const imported = await loadIndependent()
          if (cancelled) return
          if (imported) {
            const saved = await saveGenerationDraft(scope, {
              ...imported, id: crypto.randomUUID(), updatedAt: new Date().toISOString(),
            }, { makeActive: false })
            if (cancelled) return
            const draft = saved.drafts.find(item => item.id === saved.savedId)!
            activate(scope, draft, true, true)
            setDrafts(saved.drafts)
            onRestore(draft)
            setReady(true)
            setIndependentResult({ scope, load: loadIndependent, id: draft.id })
            return
          }
        }
        const catalog = await readDraftCatalog(scope)
        const tabDraft = historyDraftId && !loadIndependent ? await loadGenerationDraft(scope, historyDraftId) : undefined
        const existing = tabDraft ?? await loadGenerationDraft(scope, catalog.activeId)
        if (cancelled) return
        setDrafts(catalog.drafts)
        const carried = loadIndependent ? null : incoming
        const incomingReplacesEmpty = !!carried && !existing?.prompt.trim() && !existing?.refs.length
        const skipEmptySave = !!loadIndependent && !existing
        activate(scope, existing, skipEmptySave || (!!existing && !existing.unsaved && !incomingReplacesEmpty), !!tabDraft)
        if (existing) onRestore(existing)
        if (carried) {
          if (existing && (existing.prompt.trim() || existing.refs.length)) setPendingIncoming(carried)
          else onRestore(carried)
        }
        if (loadIndependent) {
          skipNormalRestore.current = true
          setIndependentResult({ scope, load: loadIndependent, id: null })
        }
        setReady(true)
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : '读取草稿失败') }
    })()
    return () => { cancelled = true }
  }, [scope, incoming, onRestore, readRetry, activate, loadIndependent, historyDraftId])

  const persist = useCallback(async (value: DraftContent, force = true) => {
    const current = cursor.current
    if (!current || current.scope !== scope) return
    pendingWrites.current++
    setStatus('正在保存草稿…')
    const write = current.writes.catch(() => {}).then(async () => {
      if (!force && current.savedContent === value) return
      const originalId = current.id
      const catalog = await saveGenerationDraft(current.scope, {
        ...value, id: originalId, revision: current.revision, updatedAt: new Date().toISOString(),
      }, { makeActive: !current.isolated })
      const saved = catalog.drafts.find(item => item.id === catalog.savedId)!
      current.id = saved.id
      current.revision = saved.revision ?? 0
      current.savedContent = value
      if (alive.current && cursor.current === current) {
        setDrafts(catalog.drafts)
        setError('')
        if (saved.id !== originalId) {
          setConflict(true)
          setActiveId(saved.id)
        }
      }
    })
    current.writes = write
    try { await write }
    catch (cause) {
      if (alive.current && cursor.current === current) setError(cause instanceof Error ? cause.message : '草稿保存失败，请重试')
      throw cause
    } finally {
      pendingWrites.current--
      if (alive.current && cursor.current === current && !pendingWrites.current) setStatus('草稿已保存到此浏览器')
    }
  }, [scope])
  useEffect(() => {
    const current = cursor.current
    if (!ready || current?.scope !== scope || current.id !== activeId) return
    if (current.restoring) {
      current.restoring = false
      current.savedContent = content
    } else if (current.savedContent !== content) {
      void persist(content, false).catch(() => {})
    }
  }, [activeId, content, ready, persist, retry, scope])
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (pendingWrites.current || error) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [error])
  const chooseIncoming = async (choice: 'new' | 'replace' | 'keep') => {
    if (!pendingIncoming || switchingRef.current) return
    if (choice === 'keep') { setPendingIncoming(null); return }
    switchingRef.current = true; setSwitching(true)
    try {
      await persist(content)
      if (choice === 'new') activate(scope)
      onRestore(pendingIncoming); setPendingIncoming(null)
    } catch { /* Keep the decision open when the current draft cannot be saved. */ }
    finally { switchingRef.current = false; setSwitching(false) }
  }
  const switchDraft = async (id: string) => {
    if (!scope || !ready || switchingRef.current) return
    switchingRef.current = true; setSwitching(true)
    try {
      await persist(content, false)
      const selected = await loadGenerationDraft(scope, id)
      if (selected) {
        if (!cursor.current?.isolated) setDrafts((await selectGenerationDraft(scope, id)).drafts)
        activate(scope, selected, !selected.unsaved)
        onRestore(selected)
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '切换草稿失败') }
    finally { switchingRef.current = false; setSwitching(false) }
  }
  const deleteDraft = async () => {
    const current = cursor.current
    if (!scope || !ready || !current || switchingRef.current) return
    switchingRef.current = true; setSwitching(true)
    try {
      await current.writes.catch(() => {})
      const catalog = await deleteGenerationDraft(scope, current.id, current.revision)
      const next = await loadGenerationDraft(scope, catalog.activeId)
      setDrafts(catalog.drafts)
      setError('')
      activate(scope, next, true)
      onRestore(next ?? { ...content, sourceAssetId: undefined, sourceTaskId: undefined, prompt: '', refs: [] })
    } catch (cause) { setError(cause instanceof Error ? cause.message : '删除草稿失败') }
    finally { switchingRef.current = false; setSwitching(false) }
  }
  const newDraft = async (defaults?: Pick<DraftContent, 'selectedModelKey' | 'aspectRatio' | 'imageSize' | 'quality'>) => {
    if (switchingRef.current) return
    switchingRef.current = true; setSwitching(true)
    try {
      await persist(content)
      activate(scope); onRestore({ ...content, ...defaults, sourceAssetId: undefined, sourceTaskId: undefined, prompt: '', refs: [] })
    } catch { /* Preserve current draft on storage failure. */ }
    finally { switchingRef.current = false; setSwitching(false) }
  }
  const openDraft = async (value: DraftContent) => {
    if (!ready || switchingRef.current) return false
    switchingRef.current = true; setSwitching(true)
    try { await persist(content); activate(scope); onRestore(value); return true }
    catch { return false /* Preserve the current draft if saving fails. */ }
    finally { switchingRef.current = false; setSwitching(false) }
  }
  const resolvedIndependent = independentResult?.scope === scope && independentResult?.load === loadIndependent
    ? independentResult : null
  return { openDraft, persist, deleteDraft, ready, resolvedIndependent, switching, drafts, activeId, status, conflict, error, pendingIncoming, chooseIncoming, switchDraft, newDraft, retry: () => ready ? setRetry(value => value + 1) : setReadRetry(value => value + 1) }
}
