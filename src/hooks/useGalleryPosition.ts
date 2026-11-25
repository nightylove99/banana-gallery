import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { GalleryAnchor, GalleryGridHandle } from '@/components/GalleryGrid'

function read<T>(key: string | null, fallback: T): T {
  try { return key ? JSON.parse(window.localStorage.getItem(key) || 'null') ?? fallback : fallback } catch { return fallback }
}
function write(key: string | null, value: GalleryAnchor | null) {
  try { if (key && value) window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* Optional position preference. */ }
}
export function useGalleryPosition({ storageKey, query, ready, content, grid, container: containerRef }: {
  storageKey: string | null; query: string; ready: boolean; content: unknown
  grid: RefObject<GalleryGridHandle | null>; container: RefObject<HTMLDivElement | null>
}) {
  const key = storageKey ? `${storageKey}:position:${query}` : null
  const anchor = useRef<GalleryAnchor | null>(null)
  const restored = useRef(false)
  useLayoutEffect(() => {
    restored.current = false
    anchor.current = read<GalleryAnchor | null>(key, null)
    // Adopt an old position only for its original query, never another collection.
    if (!anchor.current && read(storageKey && `${storageKey}:query`, '') === query) anchor.current = read(storageKey && `${storageKey}:anchor`, null)
    const element = containerRef.current
    if (element) element.scrollTop = 0
    return () => { if (restored.current) write(key, anchor.current) }
  }, [key, storageKey, query, containerRef])
  const capture = useCallback(() => {
    if (!restored.current) return
    anchor.current = grid.current?.getAnchor() ?? null
    write(key, anchor.current)
  }, [grid, key])
  useEffect(() => {
    if (!ready || restored.current) return
    const frame = requestAnimationFrame(() => {
      if (anchor.current) grid.current?.restoreAnchor(anchor.current)
      else if (containerRef.current) containerRef.current.scrollTop = 0
      restored.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [ready, key, content, grid, containerRef])
  const requestRestore = () => { restored.current = false }
  return { capture, requestRestore }
}
