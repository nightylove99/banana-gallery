import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchTrash, purgeTrashItem, restoreImage } from '@/api'
import type { TrashItem } from '@/types'
import { useGalleryStore } from './GalleryProvider'

export type TrashTarget = Pick<TrashItem, 'id' | 'version'>
type TrashAction = 'restore' | 'purge'

export function useTrash() {
  const store = useGalleryStore()
  const [items, setItems] = useState<TrashItem[]>([])
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const read = useRef<AbortController | null>(null)
  const running = useRef(false)

  const reload = useCallback(async () => {
    read.current?.abort()
    const controller = new AbortController()
    read.current = controller
    const { signal } = controller
    setLoading(true)
    setReadError('')
    try {
      const list = await fetchTrash(signal)
      if (!signal.aborted) setItems(list)
    } catch (error) {
      if (!signal.aborted) setReadError(error instanceof Error ? error.message : '无法读取回收站，请重试')
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
    return () => read.current?.abort()
  }, [reload])

  const run = async (action: TrashAction, targets: readonly TrashTarget[], onSuccess?: (id: string) => void) => {
    if (running.current || !targets.length) return
    running.current = true
    setBusy(true)
    setActionError('')
    const label = action === 'restore' ? '恢复' : '清理'
    const errors = new Set<string>()
    let failed = 0
    setStatus(`正在${label} 0 / ${targets.length} 项…`)
    try {
      for (const [index, { id, version }] of targets.entries()) {
        try {
          if (action === 'restore') store.add(await restoreImage(id, version))
          else await purgeTrashItem(id, version)
          setItems(previous => previous.filter(item => item.id !== id))
          onSuccess?.(id)
        } catch (error) {
          failed++
          errors.add(error instanceof Error ? error.message : '操作失败')
        }
        setStatus(`正在${label} ${index + 1} / ${targets.length} 项…`)
      }
      const completed = `已${label} ${targets.length - failed} 项`
      setStatus(failed ? '' : completed)
      if (failed) {
        setActionError(`${completed}，失败 ${failed} 项。${[...errors].join('；')}`)
        // Conflicts and interrupted file deletions can both change the server
        // entry. Refresh for the next explicit action; never replay this batch.
        await reload()
      }
    } finally {
      void store.refreshTrashCount()
      running.current = false
      setBusy(false)
    }
  }

  return { items, loading, readError, actionError, status, busy, reload, run }
}
