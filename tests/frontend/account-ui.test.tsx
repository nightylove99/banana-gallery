// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const sessionState = {
  authMode: null as null | 'local' | 'cloudflare_access',
  session: null as null | {
    user: { id: string; email: string }
    workspace: { id: string; name: string }
  },
}

const fetchAccountSummaryMock = vi.fn()
const fetchRuntimeSettingsMock = vi.fn()
const signOutMock = vi.fn()

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/api', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/api')>(),
  fetchAccountSummary: (...args: unknown[]) => fetchAccountSummaryMock(...args),
  fetchRuntimeSettings: (...args: unknown[]) => fetchRuntimeSettingsMock(...args),
}))

vi.mock('@/auth/useSession', () => ({
  useSession: () => ({
    session: sessionState.session,
    loading: false,
    authMode: sessionState.authMode,
    refresh: async () => {},
    signOut: signOutMock,
  }),
}))

vi.mock('@/hooks/useGallery', () => ({
  useGallery: () => ({
    groups: [],
    groupsLoading: false,
    groupsError: '',
    allImages: [],
    reloadGroups: vi.fn(),
    images: [],
    tags: [],
    filter: 'all',
    setFilter: vi.fn(),
    loading: false,
    authMode: sessionState.authMode,
    reload: vi.fn(),
    toggleFavorite: vi.fn(),
    updateImage: vi.fn(),
    removeImage: vi.fn(),
    addImage: vi.fn(),
  }),
}))

vi.mock('@/components/MarkdownImportPanel', () => ({
  MarkdownImportPanel: () => <div>MarkdownImportPanel</div>,
}))

vi.mock('@/components/UploadModal', () => ({
  UploadModal: () => null,
}))

import { Sidebar } from '../../src/components/Sidebar'
import SettingsPage from '../../src/pages/SettingsPage'

afterEach(() => {
  cleanup()
  sessionState.session = null
  sessionState.authMode = null
  fetchAccountSummaryMock.mockReset()
  fetchRuntimeSettingsMock.mockReset()
  signOutMock.mockReset()
})

describe('账户 UI', () => {
  it('SettingsPage 为 Windows 用户提供 py -3 自检命令', async () => {
    const agent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    fetchAccountSummaryMock.mockResolvedValue(null)
    fetchRuntimeSettingsMock.mockResolvedValue(null)
    try {
      render(<MemoryRouter><SettingsPage /></MemoryRouter>)
      expect(await screen.findByText('py -3 scripts/banana-gallery.py models --available-only')).toBeTruthy()
    } finally {
      agent.mockRestore()
    }
  })

  it('SettingsPage 在个人自用模式隐藏套餐、邀请码和额度卡片', async () => {
    sessionState.session = {
      user: { id: 'local-user', email: 'owner@example.com' },
      workspace: { id: 'local-workspace', name: 'Local Workspace' },
    }
    fetchAccountSummaryMock.mockResolvedValue({
      runtimeMode: 'personal-local',
      user: sessionState.session.user,
      workspace: sessionState.session.workspace,
      plan: { id: 'personal' },
    })
    fetchRuntimeSettingsMock.mockResolvedValue({
      showDeveloperDiagnostics: false,
      allowServerSideImport: true,
    })

    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    )

    for (const name of ['生图渠道与默认参数', '外部 Agent 接入', '存储与备份', '版本与更新']) {
      expect(await screen.findByRole('heading', { name })).toBeTruthy()
    }
    expect(screen.queryByLabelText('图库默认密度')).toBeNull()
    expect(screen.queryByLabelText('图库默认构图')).toBeNull()
    const sidebar = within(screen.getByRole('complementary'))
    expect(sidebar.getByText('Banana Gallery')).toBeTruthy()
    expect(screen.queryByText('个人自用', { exact: false })).toBeNull()
    expect(screen.queryByRole('button', { name: '管理参考图库与组合' })).toBeNull()
    expect(screen.queryByText('常用模型顺序')).toBeNull()
    expect(sidebar.queryByRole('button', { name: '上传图片' })).toBeNull()
    expect(screen.queryByText('owner@example.com')).toBeNull()
    expect(screen.queryByRole('button', { name: '退出登录' })).toBeNull()
    expect(screen.queryByText('使用量概览')).toBeNull()
    expect(screen.queryByText('输入邀请码升级')).toBeNull()
  })
  it('启用 Cloudflare Access 时，本机监听器仍不显示退出入口', async () => {
    sessionState.authMode = 'cloudflare_access'
    sessionState.session = { user: { id: 'local', email: 'local@fixture.invalid' }, workspace: { id: 'local', name: 'Local' } }
    fetchAccountSummaryMock.mockResolvedValue({ runtimeMode: 'personal-local' })
    render(<MemoryRouter><Sidebar currentPage="gallery" assetType="recipe" filter="all" onAssetTypeChange={() => {}} onFilterChange={() => {}} tags={[]} workCount={0} recipeCount={0} favoriteCount={0} /></MemoryRouter>)
    expect(screen.queryByRole('button', { name: '退出登录' })).toBeNull()
  })

  it('远程访问只在侧边栏显示退出入口', async () => {
    sessionState.authMode = 'cloudflare_access'
    sessionState.session = { user: { id: 'local', email: 'remote@fixture.invalid' }, workspace: { id: 'local', name: 'Local' } }
    fetchAccountSummaryMock.mockResolvedValue({ runtimeMode: 'personal-remote', user: sessionState.session.user, workspace: sessionState.session.workspace, plan: { id: 'personal' } })
    render(<MemoryRouter><Sidebar currentPage="gallery" assetType="recipe" filter="all" onAssetTypeChange={() => {}} onFilterChange={() => {}} tags={[]} workCount={0} recipeCount={0} favoriteCount={0} /></MemoryRouter>)
    const signOut = await screen.findByRole('button', { name: '退出登录' })
    expect(screen.queryByText('remote@fixture.invalid')).toBeNull()
    expect(screen.queryByText('Access 私有远程访问')).toBeNull()
    signOut.click()
    expect(signOutMock).toHaveBeenCalledOnce()
  })

})
