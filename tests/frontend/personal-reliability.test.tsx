// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { DetailModal } from '../../src/components/DetailModal'
const entry = { id: 'one', filename: 'main.png', prompt: 'original', referenceImages: [], tags: [], favorited: false, createdAt: '2026-09-11', width: 1, height: 1, assetType: 'work' as const }
afterEach(cleanup)
it('deletion failure leaves the detail open and allows retry', async () => {
  const onClose = vi.fn()
  const onDelete = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined)
  render(<MemoryRouter><DetailModal image={entry} onClose={onClose} onDelete={onDelete} onToggleFavorite={() => {}} onUpdatePrompt={() => {}} onUpdateTags={() => {}} /></MemoryRouter>)
  const user = userEvent.setup()
  expect(screen.queryByRole('button', { name: '作品更多操作' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '移入回收站' }))
  await user.click(screen.getByRole('button', { name: '删除', exact: true }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('disk full'))
  expect(onClose).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '删除', exact: true }))
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
})
it('unsaved prompt has the same leave protection as reference edits', async () => {
  const onClose = vi.fn()
  render(<MemoryRouter><DetailModal image={entry} onClose={onClose} onToggleFavorite={() => {}} onUpdatePrompt={() => {}} onUpdateTags={() => {}} /></MemoryRouter>)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '编辑提示词' }))
  await user.type(screen.getByRole('textbox', { name: '编辑提示词' }), ' changed')
  await user.click(screen.getByRole('button', { name: '关闭详情' }))
  expect(onClose).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '放弃修改' }))
  expect(onClose).toHaveBeenCalledOnce()
})

it('settings offers complete backup creation and verification without exposing raw paths', async () => {
  const { default: SettingsPage } = await import('../../src/pages/SettingsPage')
  const { SessionProvider } = await import('../../src/auth/useSession')
  let made = false
  const manifest = { id: 'backup-fixture', createdAt: '2026-09-11T00:00:00Z', files: [{ bytes: 100 }] }
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/session') return Response.json({ user: { id: 'local', email: 'local@test' }, workspace: { id: 'local', name: 'Local' } })
    if (url.startsWith('/api/images')) return Response.json([])
    if (url === '/api/account/summary') return Response.json({ user: { id: 'local', email: 'local@test' }, workspace: { id: 'local', name: 'Local' }, runtimeMode: 'personal-local', plan: { id: 'personal' } })
    if (url === '/api/settings/runtime') return Response.json({ allowServerSideImport: false, showDeveloperDiagnostics: false })
    if (url === '/api/personal/backups') {
      if (init?.method === 'POST') { made = true; return Response.json(manifest, { status: 201 }) }
      return Response.json({ backups: made ? [manifest] : [], canManage: true })
    }
    if (url.endsWith('/verify')) return Response.json(manifest)
    return Response.json({}, { status: 404 })
  })
  try {
    render(<MemoryRouter><SessionProvider><SettingsPage /></SessionProvider></MemoryRouter>)
    const user = userEvent.setup()
    const details = (await screen.findByText('管理备份与空间明细')).closest('details')!
    expect(details.open).toBe(false)
    await user.click(screen.getByText('管理备份与空间明细'))
    expect(details.open).toBe(true)
    await user.click(screen.getByText('管理备份与空间明细'))
    expect(details.open).toBe(false)
    await user.click(await screen.findByRole('button', { name: '立即备份' }))
    await waitFor(() => expect(details.open).toBe(true))
    expect(screen.getByText('backup-fixture')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '校验备份' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('校验通过'))
  } finally { vi.unstubAllGlobals() }
})

it('shows the full position and upper parameters and guards edits after folding more info', async () => {
  const onClose = vi.fn()
  const image = { ...entry, title: '旧标题', generation: { aspectRatio: 'auto', imageSize: '2K' } }
  render(<MemoryRouter><DetailModal image={image} onClose={onClose} positionLabel="12345 / 44446"
    onUpdateMetadata={async () => image} onToggleFavorite={() => {}} onUpdatePrompt={() => {}} onUpdateTags={() => {}} /></MemoryRouter>)
  const position = screen.getByText('12345 / 44446')
  expect(position.classList.contains('whitespace-nowrap')).toBe(true)
  const dimensions = screen.getByText('2K')
  expect(dimensions.compareDocumentPosition(screen.getByRole('heading', { name: '提示词' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const user = userEvent.setup()
  const more = screen.getByRole('button', { name: /更多信息/ })
  expect(more.getAttribute('aria-expanded')).toBe('false')
  await user.click(more)
  await user.type(screen.getByRole('textbox', { name: '标题' }), ' 新内容')
  await user.click(more)
  expect(more.textContent).toContain('有未保存修改')
  await user.click(screen.getByRole('button', { name: '关闭详情' }))
  expect(onClose).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '放弃修改' }))
  expect(onClose).toHaveBeenCalledOnce()
})

it('saves write-only credentials, refreshes the model select, and disables writes on the remote page', async () => {
  const { default: SettingsPage } = await import('../../src/pages/SettingsPage')
  const { SessionProvider } = await import('../../src/auth/useSession')
  const account = { user: { id: 'local', email: 'owner@test' }, workspace: { id: 'local', name: 'Local' } }
  const secret = 'fixture-openai-secret-abcd'
  const received: unknown[] = []
  const readModel = vi.fn()
  let remote = false
  let saved = false
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/session') return Response.json(account)
    if (url === '/api/account/summary') return Response.json({ ...account, runtimeMode: remote ? 'personal-remote' : 'personal-local' })
    if (url === '/api/settings/runtime') return Response.json({ showDeveloperDiagnostics: false, allowServerSideImport: false })
    if (url.startsWith('/api/images')) return Response.json([])
    if (url === '/api/personal/provider-config') {
      if (init?.method === 'PUT') {
        received.push(JSON.parse(String(init.body)))
        saved = true
      }
      return Response.json({
        google: { apiKeyConfigured: false, apiKeySource: 'none', serviceAccountConfigured: false, serviceAccountSource: 'none', location: 'global', activeMode: 'none' },
        openaiCompatible: { configured: saved, source: saved ? 'ui' : 'none', apiKeyConfigured: saved, apiKeyMasked: saved ? '...abcd' : undefined, baseUrl: 'https://relay.example.test/v1', model: saved ? 'relay-image' : 'old-model' },
        canManage: !remote, agentTokenConfigured: true, apiBaseUrl: 'http://127.0.0.1:3333/api/v1', skillPath: 'skills/banana-gallery',
        demoEnabled: true, envProviders: [],
      })
    }
    if (url === '/api/generation/models') {
      readModel()
      const model = { provider: 'openai-compatible', model: saved ? 'relay-image' : 'old-model', label: saved ? 'Relay image' : 'Old model', available: saved, parameterMode: 'quality', defaultAspectRatio: '1:1', supportedAspectRatios: ['1:1'], supportedResolutions: [], supportedQualities: ['high'] }
      return Response.json({ defaultModel: model, models: [model] })
    }
    return Response.json({}, { status: 404 })
  })
  try {
    const mount = () => render(<MemoryRouter><SessionProvider><SettingsPage /></SessionProvider></MemoryRouter>)
    const first = mount()
    const user = userEvent.setup()
    await screen.findByRole('option', { name: 'Old model（未配置）' })
    const password = await screen.findByLabelText<HTMLInputElement>('OpenAI API Key')
    expect(password.type).toBe('password')
    expect(password.value).toBe('')
    await user.type(password, secret)
    const model = screen.getByLabelText('模型名')
    await user.clear(model)
    await user.type(model, 'relay-image')
    await user.click(screen.getByRole('button', { name: '保存渠道配置' }))
    await screen.findByRole('option', { name: 'Relay image' })
    expect(readModel.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(received).toEqual([{ google: {}, openaiCompatible: { apiKey: secret, model: 'relay-image' } }])
    expect(password.value).toBe('')
    expect(screen.getByText('...abcd')).toBeTruthy()
    expect(screen.queryByText(secret)).toBeNull()
    first.unmount()

    remote = true
    mount()
    expect(await screen.findByText('请在本机入口修改凭据')).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>('OpenAI API Key').matches(':disabled')).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>('上传服务账号 JSON').matches(':disabled')).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存渠道配置' }).disabled).toBe(true)
    expect(await screen.findByText('远程访问 · owner@test')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '退出登录' })).toHaveLength(1)
  } finally { vi.unstubAllGlobals() }
})
