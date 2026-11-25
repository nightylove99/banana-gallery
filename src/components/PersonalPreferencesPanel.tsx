import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { fetchGenerationModels } from '@/api'
import { fetchPreferences, preferenceRequest } from '@/lib/preferences'
import { imageGenerationModelKey } from '@/lib/image-generation-providers'
import type { GenerationModelStatus, PersonalPreferences } from '@/types'

const keyFor = (model: { provider: string; model: string }) => imageGenerationModelKey(model.provider, model.model)
const preferredSize = (model: GenerationModelStatus | undefined) =>
  model?.supportedResolutions.includes('2K') ? '2K' : model?.supportedResolutions[0] ?? '2K'
const control = 'min-w-0 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2'

export function PersonalPreferencesPanel({ modelRevision }: { modelRevision: number }) {
  const [models, setModels] = useState<GenerationModelStatus[]>([])
  const [modelKey, setModelKey] = useState('')
  const [aspect, setAspect] = useState('1:1')
  const [size, setSize] = useState('2K')
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>('high')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let active = true
    fetchGenerationModels().then(catalog => {
      if (!active) return
      const defaults = catalog.defaultSettings
      const key = keyFor(defaults ?? catalog.defaultModel)
      const model = catalog.models.find(model => keyFor(model) === key)
      setModels(catalog.models)
      setModelKey(key)
      setAspect(defaults?.aspectRatio ?? model?.defaultAspectRatio ?? '1:1')
      setSize(defaults?.imageSize ?? preferredSize(model))
      setQuality(defaults?.quality ?? 'high')
      setError('')
    }).catch(error => { if (active) setError(error instanceof Error ? error.message : '读取默认设置失败') })
    return () => { active = false }
  }, [modelRevision, retry])

  const selected = models.find(model => keyFor(model) === modelKey)
  function choose(key: string) {
    const model = models.find(model => keyFor(model) === key)
    setModelKey(key)
    setAspect(model?.defaultAspectRatio ?? '1:1')
    setSize(preferredSize(model))
    setQuality('high')
  }

  async function save() {
    if (!selected) return
    setBusy(true)
    try {
      const preferences = await fetchPreferences()
      await preferenceRequest<PersonalPreferences>('/preferences', 'PATCH', {
        expectedVersion: preferences.version,
        defaultGeneration: {
          provider: selected.provider, model: selected.model, aspectRatio: aspect,
          ...(selected.parameterMode === 'resolution' ? { imageSize: size } : { quality }),
        },
      })
      toast.success('默认设置已保存')
      setError('')
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存默认设置失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 border-t border-zinc-800 pt-4 text-sm">
      <h3 className="font-semibold text-white">新建生图默认参数</h3>
      {error && <p role="alert" className="text-amber-300">{error} <button className="underline" onClick={() => setRetry(n => n + 1)}>重试读取</button></p>}
      <fieldset disabled={busy || !models.length} className="min-w-0 space-y-3 disabled:opacity-60">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="grid min-w-0 gap-1">默认模型
            <select className={control} value={modelKey} onChange={event => choose(event.target.value)}>
              {!selected && <option value={modelKey}>{models.length ? '原模型不可用，请重新选择' : '尚无模型'}</option>}
              {models.map(model => <option key={keyFor(model)} value={keyFor(model)}>{model.label}{model.available ? '' : '（未配置）'}</option>)}
            </select>
          </label>
          <label className="grid gap-1">默认比例
            <select className={control} value={aspect} onChange={event => setAspect(event.target.value)}>
              {selected?.supportedAspectRatios.map(value => <option key={value}>{value}</option>)}
            </select>
          </label>
          {selected?.parameterMode === 'resolution' ? <label className="grid gap-1">默认分辨率
            <select className={control} value={size} onChange={event => setSize(event.target.value)}>
              {selected.supportedResolutions.map(value => <option key={value}>{value}</option>)}
            </select>
          </label> : <label className="grid gap-1">默认质量
            <select className={control} value={quality} onChange={event => setQuality(event.target.value as typeof quality)}>
              {selected?.supportedQualities.map(value => <option key={value}>{value}</option>)}
            </select>
          </label>}
        </div>
        <button type="button" disabled={!selected || busy} onClick={() => void save()}
          className="rounded-lg border border-zinc-700 px-3 py-2 disabled:opacity-50">{busy ? '保存中…' : '保存默认设置'}</button>
      </fieldset>
    </div>
  )
}
