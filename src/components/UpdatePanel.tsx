import { useEffect, useState, type ReactNode } from 'react'
import { Check, Copy, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { checkAppUpdate } from '@/api'
import type { UpdateCheckResult } from '@/types'

export function UpdatePanel({ children }: { children?: ReactNode }) {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/health')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { version?: string } | null) => {
        if (!cancelled && typeof data?.version === 'string') {
          setCurrentVersion(data.version)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const handleCheck = async () => {
    setChecking(true)
    setError(null)
    try {
      const next = await checkAppUpdate()
      setResult(next)
      if (next.currentVersion) setCurrentVersion(next.currentVersion)
    } catch (err) {
      setError(err instanceof Error ? err.message : '检查更新失败，请稍后重试')
    } finally {
      setChecking(false)
    }
  }

  const handleCopyCommand = async () => {
    try {
      await navigator.clipboard.writeText('npm run update')
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      // ignore clipboard unavailability
    }
  }

  return (
    <section className="space-y-3 rounded-2xl border border-[#1E2336] bg-[#0d0d14] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-white">版本与更新</h2>
          <p className="text-sm text-zinc-400">
            当前版本：{currentVersion ? `v${currentVersion}` : '读取中…'}
          </p>
        </div>

        <button
          type="button"
          disabled={checking}
          onClick={() => void handleCheck()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 transition hover:border-zinc-500 hover:text-white disabled:opacity-50"
        >
          {checking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {checking ? '正在检查…' : '检查更新'}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}

      {result && (
        <div
          role="status"
          className={`space-y-2 rounded-xl border p-3.5 text-sm ${
            result.status === 'update-available'
              ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-100'
              : result.status === 'up-to-date'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                : 'border-zinc-800 bg-zinc-950/60 text-zinc-300'
          }`}
        >
          <p>{result.message}</p>

          {result.releaseNotes && result.status === 'update-available' && (
            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-zinc-950/70 p-2.5 font-sans text-xs leading-relaxed text-zinc-300">
              {result.releaseNotes}
            </pre>
          )}

          {(result.releaseUrl || result.releasesUrl) && (
            <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
              <a
                href={result.releaseUrl || result.releasesUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-indigo-300 hover:text-indigo-200 hover:underline"
              >
                查看 GitHub Release
                <ExternalLink size={12} />
              </a>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800/80 bg-zinc-950/40 px-3.5 py-2.5 text-xs text-zinc-400">
        <span>
          队列空闲后运行 <code className="text-zinc-200">npm run update</code>，然后重启服务。
        </span>
        <button
          type="button"
          onClick={() => void handleCopyCommand()}
          className="inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:border-zinc-500 hover:text-white"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? '已复制' : '复制命令'}
        </button>
      </div>
      {children}
    </section>
  )
}
