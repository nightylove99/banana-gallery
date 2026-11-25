// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'

const sessionState = {
  session: null as null | {
    user: { id: string; email: string }
    workspace: { id: string; name: string }
  },
  loading: false,
  authMode: 'local' as 'local' | 'cloudflare_access' | null,
  error: null as string | null,
}

vi.mock('@/components/ui/sonner', () => ({
  Toaster: () => <div data-testid="app-toaster" />,
}))

vi.mock('@/pages/GalleryPage', () => ({
  default: () => <div>画廊页壳子</div>,
}))

vi.mock('@/pages/GeneratePage', () => ({
  default: () => <div>生成页壳子</div>,
}))

vi.mock('@/pages/TrashPage', () => ({
  default: () => <div>回收站页壳子</div>,
}))

vi.mock('@/pages/SettingsPage', () => ({
  default: () => <div>设置页壳子</div>,
}))

vi.mock('@/auth/useSession', () => ({
  SessionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useSession: () => ({
    session: sessionState.session,
    loading: sessionState.loading,
    authMode: sessionState.authMode,
    error: sessionState.error,
    refresh: async () => {},
    signOut: async () => {},
  }),
}))

import App from '../../src/App'

afterEach(() => {
  cleanup()
  sessionState.session = null
  sessionState.loading = false
  sessionState.authMode = 'local'
  sessionState.error = null
})

describe('App 认证路由', () => {
  it.each([
    '/', '/generate', '/settings', '/trash',
  ])('本机连接异常时在 %s 显示恢复提示', async (route) => {
    render(
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>,
    )

    expect(await screen.findByText('暂时无法确认登录状态')).toBeTruthy()
    expect(screen.queryByPlaceholderText('you@example.com')).toBeNull()
  })

  it.each([['/generate', '生成页壳子'], ['/trash', '回收站页壳子']])('已登录时允许访问 %s', async (route, title) => {
    sessionState.session = {
      user: { id: 'user-1', email: 'user@example.com' },
      workspace: { id: 'workspace-1', name: 'Workspace' },
    }

    render(
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>,
    )

    expect(await screen.findByText(title)).toBeTruthy()
  })

  it('Cloudflare Access 会话失效时提示重新验证', async () => {
    sessionState.authMode = 'cloudflare_access'

    render(
      <MemoryRouter initialEntries={['/generate']}>
        <App />
      </MemoryRouter>,
    )

    expect(await screen.findByText('需要重新验证 Cloudflare Access')).toBeTruthy()
    expect(screen.queryByText('邮箱登录')).toBeNull()
    expect(screen.queryByPlaceholderText('you@example.com')).toBeNull()
  })

  it('未取得认证模式时可重新连接', async () => {
    sessionState.authMode = null
    sessionState.error = '获取登录状态失败'

    render(
      <MemoryRouter initialEntries={['/generate']}>
        <App />
      </MemoryRouter>,
    )

    expect(await screen.findByText('暂时无法确认登录状态')).toBeTruthy()
    expect(screen.queryByText('邮箱登录')).toBeNull()
  })
})
