import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { preferenceRequest } from '@/lib/preferences'
import { IMAGE_GENERATION_PROVIDER_DEFINITIONS } from '@/lib/image-generation-providers'
import type { ProviderConfigStatus } from '@/types'

const endpoint = '/personal/provider-config'
const input = 'w-full min-w-0 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-500'
const action = 'shrink-0 rounded-lg border border-zinc-700 px-3 py-2 text-zinc-300 hover:text-white disabled:opacity-50'
type Draft = { googleKey?: string; openaiKey?: string; location?: string; baseUrl?: string; model?: string }

export function ProviderCredentials({ status, onChange }: {
  status: ProviderConfigStatus
  onChange: (status: ProviderConfigStatus) => void
}) {
  const [draft, setDraft] = useState<Draft>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { google, openaiCompatible: openai } = status
  const setField = (field: keyof Draft, value: string) => setDraft(previous => ({ ...previous, [field]: value }))

  async function apply(write: () => Promise<ProviderConfigStatus>, reset: Partial<Draft> = {}) {
    setBusy(true)
    setError('')
    try {
      onChange(await write())
      setDraft(previous => ({ ...previous, ...reset }))
      toast.success('生图渠道已保存，立即生效')
    } catch (error) {
      setError(error instanceof Error ? error.message : '无法保存生图凭据')
    } finally {
      setBusy(false)
    }
  }

  function update(body: unknown, reset?: Partial<Draft>) {
    return apply(() => preferenceRequest<ProviderConfigStatus>(endpoint, 'PUT', body), reset)
  }

  function save(event: FormEvent) {
    event.preventDefault()
    void update({
      google: { apiKey: draft.googleKey?.trim() || undefined, location: optionalOverride(draft.location) },
      openaiCompatible: {
        apiKey: draft.openaiKey?.trim() || undefined,
        baseUrl: optionalOverride(draft.baseUrl),
        model: optionalOverride(draft.model),
      },
    }, { googleKey: undefined, openaiKey: undefined, location: undefined, baseUrl: undefined, model: undefined })
  }

  async function upload(file: File) {
    if (file.size > 256 * 1024) {
      setError('服务账号 JSON 不得超过 256 KB')
      return
    }
    await apply(async () => {
      const response = await fetch(`/api${endpoint}/service-account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: await file.text(),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || '上传服务账号失败')
      return result
    })
  }

  return (
    <form onSubmit={save} autoComplete="off" className="space-y-3 text-sm">
      {!status.canManage && <p className="text-amber-300">请在本机入口修改凭据</p>}
      <fieldset disabled={busy || !status.canManage} className="grid min-w-0 gap-4 disabled:opacity-60 lg:grid-cols-2">
        <div className="min-w-0 space-y-3 rounded-xl bg-zinc-900/60 p-4">
          <h3 className="font-semibold text-white">Google Gemini</h3>
          <label htmlFor="google-api-key" className="block">Gemini API Key</label>
          <div className="flex flex-wrap items-center gap-2">
            <input id="google-api-key" type="password" autoComplete="new-password" value={draft.googleKey ?? ''}
              onChange={event => setField('googleKey', event.target.value)} className={`${input} flex-1`}
              placeholder={google.apiKeyConfigured ? '已配置，留空保持不变' : '输入 API Key'} />
            {google.apiKeyConfigured && <span className="text-xs text-zinc-400">{google.apiKeyMasked}</span>}
            {google.apiKeyConfigured && <button type="button" disabled={google.apiKeySource !== 'ui'} className={action} aria-label="清除 Gemini API Key"
              onClick={() => void update({ google: { apiKey: null } }, { googleKey: undefined })}>清除</button>}
          </div>
          {google.apiKeySource === 'env' && <p className="text-xs text-zinc-400">API Key 来自环境变量</p>}
          <div className="flex flex-wrap items-center gap-2">
            <label className={`${action} relative cursor-pointer focus-within:outline-2 focus-within:outline-indigo-400`}>
              上传服务账号 JSON
              <input type="file" accept=".json,application/json" className="sr-only" onChange={event => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (file) void upload(file)
              }} />
            </label>
            {google.serviceAccountConfigured && <button type="button" disabled={google.serviceAccountSource !== 'ui'} className={action} aria-label="清除服务账号"
              onClick={() => void update({ google: { clearServiceAccount: true } })}>清除</button>}
          </div>
          {google.serviceAccountConfigured && <div className="space-y-1 break-all text-xs text-zinc-400">
            {google.projectId && <p>项目：{google.projectId}</p>}
            {google.clientEmail && <p>账号：{google.clientEmail}</p>}
            {google.serviceAccountSource === 'env' && <p>服务账号来自环境变量</p>}
          </div>}
          {google.serviceAccountConfigured && <label className="grid gap-1">Vertex 区域
            <input className={input} value={draft.location ?? google.location} placeholder="global"
              onChange={event => setField('location', event.target.value)} />
          </label>}
          {google.serviceAccountConfigured && google.apiKeyConfigured && <p className="text-xs text-indigo-300">当前优先使用服务账号</p>}
        </div>
        <div className="min-w-0 space-y-3 rounded-xl bg-zinc-900/60 p-4">
          <h3 className="font-semibold text-white">OpenAI / 自定义中转站</h3>
          <label className="grid gap-1">Base URL
            <input className={input} value={draft.baseUrl ?? openai.baseUrl} placeholder="https://api.openai.com/v1"
              onChange={event => setField('baseUrl', event.target.value)} />
          </label>
          <label htmlFor="openai-api-key" className="block">OpenAI API Key</label>
          <div className="flex flex-wrap items-center gap-2">
            <input id="openai-api-key" type="password" autoComplete="new-password" value={draft.openaiKey ?? ''}
              onChange={event => setField('openaiKey', event.target.value)} className={`${input} flex-1`}
              placeholder={openai.apiKeyConfigured ? '已配置，留空保持不变' : '输入 API Key'} />
            {openai.apiKeyConfigured && <span className="text-xs text-zinc-400">{openai.apiKeyMasked}</span>}
            {openai.apiKeyConfigured && <button type="button" disabled={openai.source !== 'ui'} className={action} aria-label="清除 OpenAI API Key"
              onClick={() => void update({ openaiCompatible: { apiKey: null } }, { openaiKey: undefined })}>清除</button>}
          </div>
          {openai.source === 'env' && <p className="text-xs text-zinc-400">当前配置来自环境变量</p>}
          <label className="grid gap-1">模型名
            <input className={input} value={draft.model ?? openai.model} onChange={event => setField('model', event.target.value)} />
          </label>
        </div>
      </fieldset>
      {error && <p role="alert" className="text-red-300">{error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy || !status.canManage || !Object.values(draft).some(value => value !== undefined)}
          className="rounded-lg bg-indigo-600 px-3 py-2 text-white disabled:opacity-50">{busy ? '正在保存…' : '保存渠道配置'}</button>
        <span className="text-xs text-zinc-400">
          {status.canManage && '清除网页配置后会回退；网址、模型或区域留空保存即可清除。'}
        </span>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        {[`免费演示：${status.demoEnabled ? '已开启' : '未开启'}`, ...status.envProviders.map(provider => {
          const label = IMAGE_GENERATION_PROVIDER_DEFINITIONS[provider].label
          return `${label}（环境变量）`
        })].map(label => <span key={label} className="rounded-full bg-zinc-800 px-2.5 py-1 text-zinc-300">{label}</span>)}
      </div>
    </form>
  )
}

function optionalOverride(value: string | undefined) {
  return value === undefined ? undefined : value.trim() || null
}
