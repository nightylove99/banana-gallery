import { useCallback, useEffect, useRef, useState } from 'react'
import { preferenceRequest } from '@/lib/preferences'

type Files = { files: number; bytes: number }
interface StorageSummary {
  originals: Files
  references: Files
  cache: Files
  backups: Files
  physicalBytes: number
  history: Files & { entries: number }
  trash: Files & { entries: number }
  materials: Files & { entries: number }
  workEntries: number
  unreferenced: { images: Files; references: Files }
  missingImages: number
  missingReferences: number
  skipped: number
}
interface BackupPolicy { enabled: boolean; intervalHours: number; maxCount: number; maxBytes: number }
interface Snapshot { id: string; createdAt: string; files: Array<{ bytes: number }> }
interface BackupStatus {
  backups: Snapshot[]
  canManage: boolean
  policy?: BackupPolicy
  automaticBackupError?: string
}

const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB`
  : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${(value / 1024).toFixed(1)} KB`
const action = 'shrink-0 rounded-lg border border-zinc-700 px-3 py-2 text-zinc-200 hover:border-zinc-500 disabled:opacity-50'

export function StoragePanel() {
  const [summary, setSummary] = useState<StorageSummary | null>(null)
  const [backup, setBackup] = useState<BackupStatus | null>(null)
  const [policy, setPolicy] = useState<BackupPolicy | undefined>()
  const [storageError, setStorageError] = useState('')
  const [backupError, setBackupError] = useState('')
  const [message, setMessage] = useState('')
  const [clearing, setClearing] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  const details = useRef<HTMLDetailsElement>(null)

  const loadStorage = useCallback(async () => {
    try {
      setSummary(await preferenceRequest<StorageSummary>('/personal/storage'))
      setStorageError('')
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : '无法统计磁盘空间')
    }
  }, [])

  const loadBackup = useCallback(async () => {
    try {
      const status = await preferenceRequest<BackupStatus>('/personal/backups')
      setBackup(status)
      setPolicy(status.policy)
      setBackupError('')
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : '无法读取备份状态')
    }
  }, [])

  useEffect(() => {
    void loadStorage()
    void loadBackup()
  }, [loadStorage, loadBackup])

  async function clearCache() {
    if (!window.confirm('清理可重建的缩略图缓存？原图和参考图不受影响。')) return
    setClearing(true)
    try {
      await preferenceRequest('/personal/storage/clear-cache', 'POST', { confirm: true })
      await loadStorage()
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : '清理缓存失败')
    } finally {
      setClearing(false)
    }
  }

  async function runBackup(id?: string) {
    setBackingUp(true)
    setBackupError('')
    setMessage('')
    try {
      await preferenceRequest(`/personal/backups${id ? `/${encodeURIComponent(id)}/verify` : ''}`, 'POST')
      if (id) {
        setMessage('校验通过：索引和所有图片完整')
      } else {
        await loadBackup()
        if (details.current) details.current.open = true
        setMessage('完整备份已创建')
        void loadStorage()
      }
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : '备份操作失败')
    } finally {
      setBackingUp(false)
    }
  }

  async function savePolicy() {
    setBackingUp(true)
    setBackupError('')
    setMessage('')
    try {
      await preferenceRequest('/personal/backups/policy', 'PATCH', policy)
      await loadBackup()
      setMessage('自动备份设置已保存')
      void loadStorage()
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : '保存自动备份设置失败')
    } finally {
      setBackingUp(false)
    }
  }

  const latest = backup?.backups[0]
  return (
    <section className="space-y-3 rounded-2xl border border-[#1E2336] bg-[#0d0d14] p-5 text-sm">
      <h2 className="font-semibold text-white">存储与备份</h2>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>存储空间 <span className="text-zinc-400">
          {summary ? `${summary.workEntries} 件作品 · 总占用 ${bytes(summary.physicalBytes)} · 缩略图缓存 ${bytes(summary.cache.bytes)}`
            : storageError ? '暂不可用' : '统计中…'}
        </span></p>
        <button type="button" className={action} disabled={!summary || clearing} onClick={() => void clearCache()}>
          {clearing ? '清理中…' : '清理缓存'}
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 pt-3">
        <p>数据备份 <span className="text-zinc-400">
          {backup ? `自动备份${backup.policy?.enabled ? '已开启' : '未开启'} · ${latest
            ? `最近备份 ${new Date(latest.createdAt).toLocaleString()}` : '尚未备份'}`
            : backupError ? '暂不可用' : '读取中…'}
        </span></p>
        <button type="button" className={action} disabled={!backup?.canManage || backingUp} onClick={() => void runBackup()}>
          立即备份
        </button>
      </div>
      {storageError && <p role="alert" className="text-red-300">{storageError} <button className="underline" onClick={() => void loadStorage()}>重试</button></p>}
      {backupError && <p role="alert" className="text-red-300">{backupError} <button className="underline" onClick={() => void loadBackup()}>重试</button></p>}
      {summary && summary.missingImages + summary.missingReferences + summary.skipped > 0 && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-amber-300">
          文件异常：缺失原图 {summary.missingImages}、参考图 {summary.missingReferences}，另有 {summary.skipped} 项因不可读或链接未统计。
        </p>
      )}
      <details ref={details} className="border-t border-zinc-800 pt-3">
        <summary className="cursor-pointer text-zinc-300">管理备份与空间明细</summary>
        <div className="mt-3 space-y-4">
          {summary && <>
            <dl className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {([['原图', summary.originals], ['参考图', summary.references], ['缩略图缓存', summary.cache], ['备份', summary.backups]] as const)
                .map(([label, files]) => <div key={label} className="rounded-lg bg-zinc-900 p-3">
                  <dt>{label}</dt><dd className="text-xs text-zinc-400">{files.files} 个文件 · {bytes(files.bytes)}</dd>
                </div>)}
            </dl>
            <p className="text-xs text-zinc-400">
              历史 {summary.history.entries} 项 / {bytes(summary.history.bytes)}；回收站 {summary.trash.entries} 项 / {bytes(summary.trash.bytes)}；素材 {summary.materials.entries} 项 / {bytes(summary.materials.bytes)}。分类间可能共享文件。
            </p>
            <p className="text-xs text-zinc-400">待检查文件：原图 {summary.unreferenced.images.files}、参考图 {summary.unreferenced.references.files}；可能是未入库或暂存上传，不会自动删除。</p>
            <button type="button" onClick={() => void loadStorage()} className="text-xs text-indigo-300">刷新统计</button>
          </>}
          {backup && !backup.canManage && <p className="text-zinc-400">请在本机入口管理备份。</p>}
          {backup?.canManage && policy && <fieldset disabled={backingUp} className="space-y-3 rounded-lg border border-zinc-800 p-3">
            <legend className="px-1">自动备份策略</legend>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={policy.enabled} onChange={event => setPolicy({ ...policy, enabled: event.target.checked })} />启用自动备份
            </label>
            <div className="flex flex-wrap gap-3">
              {([
                { key: 'intervalHours', label: '间隔（小时）', unit: 1, min: 1, max: 168 },
                { key: 'maxCount', label: '最多自动快照数', unit: 1, min: 1, max: 100 },
                { key: 'maxBytes', label: '自动备份容量（GB）', unit: 1024 ** 3, min: 1 / 1024, max: 1024 },
              ] as const).map(({ key, label, unit, min, max }) => (
                <label key={key} className="grid gap-1">{label}
                  <input type="number" min={min} max={max} step={key === 'maxBytes' ? 'any' : 1} value={policy[key] / unit}
                    onChange={event => setPolicy({ ...policy, [key]: key === 'maxBytes' ? Math.round(Number(event.target.value) * unit) : Number(event.target.value) })}
                    className="w-32 rounded bg-zinc-900 px-2 py-1" />
                </label>
              ))}
            </div>
            <p className="text-xs text-zinc-400">超过保留上限只清理自动快照，手动备份不受影响。</p>
            <button type="button" onClick={() => void savePolicy()} className={action}>保存自动备份设置</button>
          </fieldset>}
          {backup?.automaticBackupError && <p role="alert" className="text-amber-300">自动备份未完成：{backup.automaticBackupError}</p>}
          {message && <p role="status" className="text-emerald-300">{message}</p>}
          {backup && backup.backups.length > 0 && <ul className="max-h-64 space-y-2 overflow-y-auto">
            {backup.backups.map(snapshot => <li key={snapshot.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-zinc-900 p-3 text-xs">
              <div className="min-w-0 break-all">{snapshot.id}<p className="text-zinc-400">
                {new Date(snapshot.createdAt).toLocaleString()} · {bytes(snapshot.files.reduce((sum, file) => sum + file.bytes, 0))}
              </p></div>
              {backup.canManage && <button type="button" disabled={backingUp} className={action} onClick={() => void runBackup(snapshot.id)}>校验备份</button>}
            </li>)}
          </ul>}
          <p className="text-xs text-zinc-400">在本机用 <code>./gallery.sh restore 备份编号 --to 空目录</code> 恢复并核验；如需恢复原位置，先停止服务，再用 <code>./gallery.sh restore 备份编号 --in-place</code>。</p>
        </div>
      </details>
    </section>
  )
}
