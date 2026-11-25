import { Routes, Route } from 'react-router-dom'
import { Toaster } from '@/components/ui/sonner'
import { lazy, Suspense } from 'react'
import { SessionProvider } from '@/auth/useSession'
import { GalleryProvider } from '@/hooks/GalleryProvider'
import { RequireAuth } from '@/auth/RequireAuth'

const GalleryPage = lazy(() => import('@/pages/GalleryPage'))
const GeneratePage = lazy(() => import('@/pages/GeneratePage'))
const TrashPage = lazy(() => import('@/pages/TrashPage'))
const SettingsPage = lazy(() => import('@/pages/SettingsPage'))

export default function App() {
  return (
    <>
      <SessionProvider>
        <GalleryProvider>
        <Suspense fallback={
          <div className="flex h-screen w-screen items-center justify-center bg-[#0a0a10] text-zinc-500">
            加载中…
          </div>
        }>
          <Routes>
            <Route
              path="/"
              element={(
                <RequireAuth>
                  <GalleryPage />
                </RequireAuth>
              )}
            />
            <Route
              path="/generate"
              element={(
                <RequireAuth>
                  <GeneratePage />
                </RequireAuth>
              )}
            />
            <Route path="/trash" element={<RequireAuth><TrashPage /></RequireAuth>} />
            <Route
              path="/settings"
              element={(
                <RequireAuth>
                  <SettingsPage />
                </RequireAuth>
              )}
            />
          </Routes>
        </Suspense>
        </GalleryProvider>
      </SessionProvider>
      <Toaster position="bottom-right" theme="dark" />
    </>
  )
}
