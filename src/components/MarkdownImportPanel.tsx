import { useMemo, useState } from 'react'
import { FolderOpen, CheckCircle, AlertCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { importMarkdown } from '@/api'

interface MarkdownImportPanelProps {
  onImported?: () => void
}

const STORAGE_KEYS = {
  markdownPath: 'banana-gallery.settings.markdownPath',
  vaultPath: 'banana-gallery.settings.vaultPath',
}

function readStoredValue(key: string) {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(key) ?? ''
}

function persistValue(key: string, value: string) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, value)
}

export function MarkdownImportPanel({ onImported }: MarkdownImportPanelProps) {
  const [mdPath, setMdPath] = useState(() => readStoredValue(STORAGE_KEYS.markdownPath))
  const [vaultPath, setVaultPath] = useState(() => readStoredValue(STORAGE_KEYS.vaultPath))
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ imported: number; skipped: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const canImport = useMemo(
    () => mdPath.trim().length > 0 && vaultPath.trim().length > 0 && !loading,
    [loading, mdPath, vaultPath],
  )

  const handleImport = async () => {
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const response = await importMarkdown(mdPath.trim(), vaultPath.trim())
      setResult(response)
      onImported?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败，请检查路径是否正确')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="rounded-2xl border border-[#1E2336] bg-[#0d0d14] p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-zinc-900 p-2.5 text-zinc-300">
          <FolderOpen size={18} />
        </div>
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-white">导入配方</h2>
          <p className="text-sm text-zinc-500">
            将 Obsidian Markdown 中“提示词 + 对应图片”的条目批量导入为配方，并记住最近使用的路径，方便重复导入。
          </p>
        </div>
      </div>

      <div className="mt-5 space-y-4">
        <div className="space-y-1.5">
          <label className="text-xs text-zinc-400">Markdown 文件路径</label>
          <input
            value={mdPath}
            onChange={(e) => {
              setMdPath(e.target.value)
              persistValue(STORAGE_KEYS.markdownPath, e.target.value)
            }}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-500 font-mono"
            placeholder="/path/to/your/file.md"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-zinc-400">Obsidian 图片目录路径</label>
          <input
            value={vaultPath}
            onChange={(e) => {
              setVaultPath(e.target.value)
              persistValue(STORAGE_KEYS.vaultPath, e.target.value)
            }}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-zinc-500 font-mono"
            placeholder="/path/to/obsidian/attachments"
          />
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-3 text-xs text-zinc-500 space-y-1">
          <p>
            格式说明：每段 <code className="text-zinc-300">```提示词```</code> 后紧跟{' '}
            <code className="text-zinc-300">![[图片名.jpg]]</code> 的条目会被导入到配方库。
          </p>
          <p>已导入过的条目会自动跳过，不会重复写入配方库。</p>
          <p>这适合导入“可复用的提示词 + 示例图”，不适合批量导入纯作品图片。</p>
        </div>

        {result && (
          <div className="flex items-start gap-2 rounded-xl border border-emerald-800/40 bg-emerald-900/20 px-3 py-2.5">
            <CheckCircle size={16} className="mt-0.5 shrink-0 text-emerald-400" />
            <div className="text-sm text-emerald-300">
              <p className="font-medium">配方导入完成</p>
              <p>
                成功导入 <strong>{result.imported}</strong> 个配方，跳过 <strong>{result.skipped}</strong>{' '}
                条，共解析 <strong>{result.total}</strong> 条。
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-red-800/40 bg-red-900/20 px-3 py-2.5">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        <div className="flex justify-end">
          <Button
            onClick={handleImport}
            disabled={!canImport}
            className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200"
          >
            {loading ? (
              <>
                <Loader2 size={14} className="mr-1.5 animate-spin" />
                导入中…
              </>
            ) : (
              '开始导入配方'
            )}
          </Button>
        </div>
      </div>
    </section>
  )
}
