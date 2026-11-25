// @vitest-environment jsdom
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'

vi.mock('@/components/ui/sonner', () => ({
  Toaster: () => <div data-testid="app-toaster" />,
}))

vi.mock('@/auth/useSession', () => ({
  SessionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useSession: () => ({
    session: {
      user: { id: 'user-1', email: 'user@example.com' },
      workspace: { id: 'workspace-1', name: 'Workspace' },
    },
    loading: false,
    refresh: async () => {},
    signOut: async () => {},
  }),
}))

vi.mock('@/pages/GalleryPage', () => ({
  default: () => <div>画廊页壳子</div>,
}))

vi.mock('@/pages/GeneratePage', () => ({
  default: () => <div>生成页壳子</div>,
}))

vi.mock('@/pages/SettingsPage', () => ({
  default: () => <div>设置页壳子</div>,
}))

import App from '../src/App'

afterEach(() => {
  cleanup()
})

describe('App 路由壳子冒烟测试', () => {
  it.each([
    ['/', '画廊页壳子'],
    ['/generate', '生成页壳子'],
    ['/settings', '设置页壳子'],
  ])('在 %s 路由能渲染当前页面壳子', async (route, expectedText) => {
    render(
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>,
    )

    expect(await screen.findByText(expectedText)).toBeTruthy()
    expect(screen.getByTestId('app-toaster')).toBeTruthy()
  })
})
