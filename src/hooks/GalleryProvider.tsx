/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, type ReactNode } from 'react'
import { useSession } from '@/auth/useSession'
import { GalleryStore } from '@/lib/gallery-store'
const GalleryContext = createContext<GalleryStore | null>(null)
export function GalleryProvider({ children }: { children: ReactNode }) {
  const { session, authMode } = useSession()
  const scope = session ? JSON.stringify([authMode, session.user.id, session.user.email, session.workspace.id]) : 'signed-out'
  return <ScopedGallery key={scope}>{children}</ScopedGallery>
}
function ScopedGallery({ children }: { children: ReactNode }) {
  const [store] = useState(() => new GalleryStore())
  return <GalleryContext.Provider value={store}>{children}</GalleryContext.Provider>
}
export function useGalleryStore() {
  const shared = useContext(GalleryContext)
  const [fallback] = useState(() => shared ?? new GalleryStore())
  return shared || fallback
}
