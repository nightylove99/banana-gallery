import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { importMarkdown } from '@/api'
import { FolderOpen, CheckCircle, AlertCircle, Loader2 } from 'lucide-react'

interface ImportModalProps {
  open: boolean
  onClose: () => void
  onImported: () => void
}

const DEFAULT_MD_PATH = ''
const DEFAULT_VAULT_PATH = ''

export function ImportModal({ open, onClose, onImported }: ImportModalProps) {
  const [mdPath, setMdPath] = useState(DEFAULT_MD_PATH)
  const [vaultPath, setVaultPath] = useState(DEFAULT_VAULT_PATH)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ imported: number; skipped: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleImport = async () => {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await importMarkdown(mdPath.trim(), vaultPath.trim())
      setResult(res)
      onImported()
    } catch (e) {
      setError(e instanceof Error ? e.message : '导入失败，请检查路径是否正确')
    } finally {
      setLoading(false)
    }
  }

  const handleClose = () => {
    setResult(null)
    setError(null)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="w-[560px] bg-[#0d0d14] border-[#1E2336] text-zinc-200">
        <DialogTitle className="flex items-center gap-2 text-base font-semibold">
          <FolderOpen size={18} />
          导入 Obsidian Markdown
        </DialogTitle>
        <DialogDescription className="text-xs text-zinc-500">
          从 Obsidian Markdown 文件批量导入历史提示词和图片
        </DialogDescription>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">Markdown 文件路径</label>
            <input
              value={mdPath}
              onChange={(e) => setMdPath(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-200 outline-none focus:border-zinc-500 font-mono"
              placeholder="/path/to/your/file.md"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-400">Obsidian 图片文件夹路径（vault 内图片所在目录）</label>
            <input
              value={vaultPath}
              onChange={(e) => setVaultPath(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-200 outline-none focus:border-zinc-500 font-mono"
              placeholder="/path/to/obsidian/attachments"
            />
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs text-zinc-500 space-y-1">
            <p>格式说明：每段 <code className="text-zinc-400">```提示词```</code> 后紧跟 <code className="text-zinc-400">![[图片名.jpg]]</code> 的条目将被导入。</p>
            <p>已导入过的条目（相同提示词开头）会自动跳过，不会重复导入。</p>
          </div>

          {result && (
            <div className="flex items-start gap-2 rounded-lg bg-emerald-900/20 border border-emerald-800/40 px-3 py-2.5">
              <CheckCircle size={16} className="shrink-0 text-emerald-400 mt-0.5" />
              <div className="text-xs text-emerald-300">
                <p className="font-medium">导入完成！</p>
                <p>成功导入 <strong>{result.imported}</strong> 张 · 跳过 <strong>{result.skipped}</strong> 条 · 共解析 <strong>{result.total}</strong> 条</p>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-red-900/20 border border-red-800/40 px-3 py-2.5">
              <AlertCircle size={16} className="shrink-0 text-red-400 mt-0.5" />
              <p className="text-xs text-red-300">{error}</p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={handleClose} className="text-zinc-400">
            关闭
          </Button>
          <Button
            size="sm"
            onClick={handleImport}
            disabled={loading || !mdPath.trim() || !vaultPath.trim()}
            className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200"
          >
            {loading ? (
              <>
                <Loader2 size={14} className="animate-spin mr-1.5" />
                导入中…
              </>
            ) : (
              '开始导入'
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
