import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { inspectGalleryDiskAssets } from '../../server/gallery/disk-asset-integrity'
import { GalleryBackups } from '../../server/personal/backups'
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })) })
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-backup-')); roots.push(root)
  const imagesDir = path.join(root, 'public/images'); fs.mkdirSync(imagesDir, { recursive: true })
  const referencesDir = path.join(root, 'public/references'); fs.mkdirSync(referencesDir)
  const dataFile = path.join(root, 'gallery-data.json')
  fs.writeFileSync(path.join(imagesDir, 'a.png'), 'original image')
  fs.writeFileSync(path.join(referencesDir, 'b.png'), 'reference')
  fs.writeFileSync(dataFile, JSON.stringify({ images: [{ id: 'one', filename: 'a.png', prompt: 'keep', referenceImages: ['b.png'], assetType: 'recipe', tags: [], favorited: false, createdAt: '2026-09-11', width: 1, height: 1 }] }))
  return { root, service: new GalleryBackups({ dataFile, imagesDir, referencesDir, backupDir: path.join(root, 'backups') }) }
}
it('restores a verified snapshot into an empty directory without altering the original', async () => {
  const { root, service } = setup()
  const snapshot = await service.create()
  const target = path.join(root, 'restored')
  await service.restoreTo(snapshot.id, target)
  expect(fs.readFileSync(path.join(target, 'public/images/a.png'), 'utf8')).toBe('original image')
  expect(fs.readFileSync(path.join(target, 'public/references/b.png'), 'utf8')).toBe('reference')
  expect(JSON.parse(fs.readFileSync(path.join(target, 'gallery-data.json'), 'utf8')).images[0].prompt).toBe('keep')
  await expect(service.restoreTo(snapshot.id, root)).rejects.toThrow(/空目录/)
})
it('refuses a corrupt snapshot before creating the restore target and preserves previous backups on failure', async () => {
  const { root, service } = setup()
  const snapshot = await service.create()
  fs.unlinkSync(path.join(root, 'public/images/a.png'))
  await expect(service.create()).rejects.toThrow()
  expect(service.list()).toHaveLength(1)
  fs.writeFileSync(path.join(root, 'backups', snapshot.id, 'public/images/a.png'), 'bad')
  const target = path.join(root, 'restored')
  await expect(service.restoreTo(snapshot.id, target)).rejects.toThrow(/校验/)
  expect(fs.existsSync(target)).toBe(false)
})
it('rejects a backup manifest traversal and a symlinked asset', async () => {
  const { root, service } = setup()
  const snapshot = await service.create()
  const manifestPath = path.join(root, 'backups', snapshot.id, 'backup-info.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.files[0].path = '../gallery-data.json'
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  await expect(service.verify(snapshot.id)).rejects.toThrow(/路径/)
  fs.unlinkSync(path.join(root, 'public/images/a.png'))
  fs.symlinkSync(path.join(root, 'gallery-data.json'), path.join(root, 'public/images/a.png'))
  await expect(service.create()).rejects.toThrow(/符号链接/)
})

it('in-place restore keeps the entire old data in a recovery directory, including unindexed files', async () => {
  const { root, service } = setup()
  const snapshot = await service.create()
  fs.writeFileSync(path.join(root, 'public/images/a.png'), 'changed')
  fs.writeFileSync(path.join(root, 'public/images/unindexed.png'), 'unsaved')
  const result = await service.restoreInPlace(snapshot.id)
  expect(fs.readFileSync(path.join(root, 'public/images/a.png'), 'utf8')).toBe('original image')
  expect(fs.readFileSync(path.join(result.recoveryDir, 'public/images/a.png'), 'utf8')).toBe('changed')
  expect(fs.readFileSync(path.join(result.recoveryDir, 'public/images/unindexed.png'), 'utf8')).toBe('unsaved')
})

it('rolls all assets back when installing the restored index fails', async () => {
  const { root, service } = setup()
  const snapshot = await service.create()
  fs.writeFileSync(path.join(root, 'public/images/a.png'), 'new content')
  const rename = fs.renameSync.bind(fs)
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (path.basename(path.dirname(String(from))).startsWith('.restore-') && String(to) === service.paths.dataFile) throw new Error('disk failure')
    return rename(from, to)
  })
  await expect(service.restoreInPlace(snapshot.id)).rejects.toThrow('disk failure')
  expect(fs.readFileSync(path.join(root, 'public/images/a.png'), 'utf8')).toBe('new content')
  expect(JSON.parse(fs.readFileSync(service.paths.dataFile, 'utf8')).images).toHaveLength(1)
})

it('automatic backups run only when enabled, due and changed, and bound only their own retention', async () => {
  const { root, service } = setup()
  const policy = { enabled: true, intervalHours: 24, maxCount: 2, maxBytes: 1024 * 1024 }
  const manual = await service.create()
  expect(await service.runAutomatic({ ...policy, enabled: false })).toBeNull()
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-11'))
  try {
    const first = await service.runAutomatic(policy)
    expect(first?.automatic).toBe(true)
    const change = () => { const file = service.paths.dataFile; const data = JSON.parse(fs.readFileSync(file, 'utf8')); data.images[0].prompt += '!'; fs.writeFileSync(file, JSON.stringify(data)) }
    change()
    expect(await service.runAutomatic(policy)).toBeNull()
    for (let day = 12; day <= 14; day++) { vi.setSystemTime(new Date(`2026-09-${day}`)); change(); await service.runAutomatic(policy) }
    expect(service.list().filter(snapshot => snapshot.automatic)).toHaveLength(2)
    expect(service.list().some(snapshot => snapshot.id === manual.id)).toBe(true)
    vi.setSystemTime(new Date('2026-09-16'))
    expect(await service.runAutomatic(policy)).toBeNull()
    change()
    await expect(service.runAutomatic({ ...policy, maxBytes: 1 })).rejects.toThrow(/容量/)
    expect(service.list().filter(snapshot => snapshot.automatic)).toHaveLength(2)
    expect(fs.existsSync(path.join(root, 'backups', manual.id))).toBe(true)
  } finally { vi.useRealTimers() }
})

it('in-place restore stages on the data disk when the backup destination is a different volume', async () => {
  const { root, service } = setup()
  service.paths.backupDir = path.join(root, 'external-volume')
  const snapshot = await service.create()
  const rename = fs.renameSync.bind(fs)
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).startsWith(service.paths.backupDir) && !String(from).startsWith(service.paths.backupDir)) {
      throw Object.assign(new Error('cross-device rename'), { code: 'EXDEV' })
    }
    return rename(from, to)
  })
  const result = await service.restoreInPlace(snapshot.id)
  expect(result.recoveryDir.startsWith(path.join(root, 'recovery'))).toBe(true)
  expect(fs.readFileSync(path.join(root, 'public/images/a.png'), 'utf8')).toBe('original image')
})

it('does not deduplicate against a pre-existing corrupt automatic snapshot', async () => {
  const { service } = setup()
  const snapshot = await service.create(true)
  fs.writeFileSync(path.join(service.paths.backupDir, snapshot.id, 'public/images/a.png'), 'bad')
  const restarted = new GalleryBackups(service.paths)
  const result = await restarted.runAutomatic({ enabled: true, intervalHours: 24, maxCount: 2, maxBytes: 1024 ** 2 })
  expect(result?.id).not.toBe(snapshot.id)
  expect(result).not.toBeNull()
  await expect(restarted.verify(result!.id)).resolves.toEqual(result)
})

it('backs up queue-only changes and restores the task index without leaving a stale sidecar', async () => {
  const { root, service } = setup()
  const legacy = await service.create()
  const taskFile = path.join(root, 'generation-tasks.json')
  const taskPath = path.join(root, 'public/references/only-task.png')
  fs.writeFileSync(taskPath, 'task reference')
  const tasks = JSON.stringify({ generationTasks: [{ id: 'task', input: { referenceFilenames: ['only-task.png'] } }] })
  fs.writeFileSync(taskFile, tasks)
  const index = JSON.parse(fs.readFileSync(service.paths.dataFile, 'utf8'))
  expect(inspectGalleryDiskAssets(index, service.paths.imagesDir, service.paths.referencesDir, Buffer.from(tasks)).missing).toEqual([])
  fs.unlinkSync(taskPath)
  expect(inspectGalleryDiskAssets(index, service.paths.imagesDir, service.paths.referencesDir, Buffer.from(tasks)).missing)
    .toMatchObject([{ kind: 'references', filename: 'only-task.png' }])
  await expect(service.create()).rejects.toThrow(/only-task.png/)
  fs.writeFileSync(taskPath, 'task reference')
  const snapshot = await service.create()
  expect(snapshot.files.map(file => file.path)).toEqual(expect.arrayContaining(['generation-tasks.json', 'public/references/only-task.png']))
  await service.restoreInPlace(legacy.id)
  expect(fs.existsSync(taskFile)).toBe(false)
  await service.restoreInPlace(snapshot.id)
  expect(fs.readFileSync(taskFile, 'utf8')).toBe(tasks)
  expect(fs.readFileSync(taskPath, 'utf8')).toBe('task reference')
})
