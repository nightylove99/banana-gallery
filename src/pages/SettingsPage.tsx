import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Settings } from 'lucide-react'
import { toast } from 'sonner'
import { Sidebar } from '@/components/Sidebar'
import { ProviderCredentials } from '@/components/ProviderCredentials'
import { PersonalPreferencesPanel } from '@/components/PersonalPreferencesPanel'
import { StoragePanel } from '@/components/StoragePanel'
import { UpdatePanel } from '@/components/UpdatePanel'
import { MarkdownImportPanel } from '@/components/MarkdownImportPanel'
import { fetchAccountSummary, fetchRuntimeSettings } from '@/api'
import { useSession } from '@/auth/useSession'
import { useGallery } from '@/hooks/useGallery'
import { preferenceRequest } from '@/lib/preferences'
import type { AccountSummary, GalleryAssetType, ProviderConfigStatus, RuntimeSettings } from '@/types'

const card = 'space-y-4 rounded-2xl border border-[#1E2336] bg-[#0d0d14] p-5'
export default function SettingsPage() {
  const python = /\bWindows\b/i.test(navigator.userAgent) ? 'py -3' : 'python3'
  const command = `${python} scripts/banana-gallery.py models --available-only`
  const gallery = useGallery()
  const location = useLocation()
  const { signOut, session } = useSession()
  const { setAssetType } = gallery
  const [runtime, setRuntime] = useState<RuntimeSettings | null>(null)
  const [account, setAccount] = useState<AccountSummary | null>(null)
  const [providerConfig, setProviderConfig] = useState<ProviderConfigStatus | null>(null)
  const [providerError, setProviderError] = useState('')
  const [modelRevision, setModelRevision] = useState(0)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const state = location.state as { assetType?: GalleryAssetType } | null
    if (!state?.assetType) return
    setAssetType(state.assetType)
    window.history.replaceState({}, '', window.location.pathname)
  }, [location.state, setAssetType])

  useEffect(() => {
    let active = true
    fetchAccountSummary().then(next => { if (active) setAccount(next) }).catch(() => {})
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    fetchRuntimeSettings().then(next => { if (active) setRuntime(next) }).catch(() => {})
    return () => { active = false }
  }, [modelRevision])

  useEffect(() => {
    let active = true
    preferenceRequest<ProviderConfigStatus>('/personal/provider-config').then(next => {
      if (!active) return
      setProviderConfig(next)
      setProviderError('')
    }).catch(error => { if (active) setProviderError(error instanceof Error ? error.message : '无法读取生图渠道') })
    return () => { active = false }
  }, [retry])

  async function copyAgentCommand() {
    try {
      await navigator.clipboard.writeText(command)
      toast.success('已复制 CLI 自检命令')
    } catch {
      toast.error('无法访问剪贴板，请手动复制命令')
    }
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0a0a10] text-zinc-200 dark">
      <Sidebar currentPage="settings" assetType={gallery.assetType} filter={gallery.filter} onAssetTypeChange={setAssetType}
        onFilterChange={gallery.setFilter} tags={gallery.tags} workCount={gallery.workCount} recipeCount={gallery.recipeCount}
        favoriteCount={gallery.favoriteCount} accountSummary={account} />

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="shrink-0 border-b border-[#1E2336] px-6 py-3">
          <h1 className="flex items-center gap-1.5 text-sm font-medium text-zinc-400"><Settings size={14} />设置</h1>
        </header>
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-5xl flex-col gap-4 px-3 py-4 sm:px-6 sm:py-6">
            <section className={card}>
              <h2 className="text-sm font-semibold text-white">生图渠道与默认参数</h2>
              {providerConfig ? <ProviderCredentials status={providerConfig} onChange={next => {
                setProviderConfig(next)
                setModelRevision(previous => previous + 1)
              }} /> : providerError ? <p role="alert" className="text-sm text-red-300">
                {providerError} <button className="underline" onClick={() => setRetry(n => n + 1)}>重试</button>
              </p> : <p className="text-sm text-zinc-400">正在读取生图渠道…</p>}
              {session && <PersonalPreferencesPanel modelRevision={modelRevision} />}
            </section>

            <section className={card}>
              <h2 className="text-sm font-semibold text-white">外部 Agent 接入</h2>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 break-all text-sm">
                <dt className="text-zinc-400">本机接口</dt><dd><code>{providerConfig?.apiBaseUrl ?? '—'}</code></dd>
                <dt className="text-zinc-400">访问令牌</dt><dd>{providerConfig ? providerConfig.agentTokenConfigured ? '已开启' : '未开启' : '—'}</dd>
                <dt className="text-zinc-400">Skill 路径</dt><dd><code>{providerConfig?.skillPath ?? 'skills/banana-gallery'}</code></dd>
              </dl>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <code className="rounded bg-zinc-900 px-2 py-1 break-all">{command}</code>
                <button type="button" className="rounded border border-zinc-700 px-2 py-1" onClick={() => void copyAgentCommand()}>复制自检命令</button>
              </div>
            </section>

            <StoragePanel />

            <UpdatePanel>
              {account?.runtimeMode === 'personal-remote' && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 pt-3 text-sm">
                  <span className="min-w-0 break-all text-zinc-400">远程访问 · {account.user.email}</span>
                  <button type="button" className="text-indigo-300 hover:underline" onClick={async () => {
                    try { await signOut() }
                    catch (error) { toast.error(error instanceof Error ? error.message : '退出登录失败') }
                  }}>退出登录</button>
                </div>
              )}
              {runtime?.showDeveloperDiagnostics && (
                <details className="border-t border-zinc-800 pt-3 text-sm">
                  <summary className="cursor-pointer">开发者诊断</summary>
                  <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 break-all text-zinc-400">
                    <dt>用户模式</dt><dd>{runtime.userAuthLabel}</dd>
                    <dt>生图认证</dt><dd>{runtime.aiAuthLabel}</dd>
                    <dt>数据驱动</dt><dd>{runtime.dataDriver}</dd>
                    <dt>资源存储</dt><dd>{runtime.assetStorageDriver}</dd>
                    <dt>服务器导入</dt><dd>{runtime.allowServerSideImport ? '已启用' : '已禁用'}</dd>
                    {runtime.project && <><dt>GCP 项目</dt><dd>{runtime.project}</dd></>}
                    {runtime.location && <><dt>区域</dt><dd>{runtime.location}</dd></>}
                  </dl>
                </details>
              )}
              {runtime?.allowServerSideImport && <MarkdownImportPanel onImported={() => {
                gallery.reload()
                toast.success('配方导入成功！')
              }} />}
            </UpdatePanel>
          </div>
        </div>
      </main>
    </div>
  )
}
