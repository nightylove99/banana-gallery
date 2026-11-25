import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

const queues = new Map<string, Promise<void>>()
const held = new AsyncLocalStorage<Map<string, { active: boolean }>>()
const malformedLockGraceMs = 2_000
const ownerFilename = 'owner.json'

type LockOwner = { pid: number; token: string }
type LockSnapshot = { identity: string; mtime: number; owner?: LockOwner }

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException).code
}

function readLock(file: string): LockSnapshot | undefined {
  try {
    const stat = fs.statSync(file, { bigint: true })
    const identity = `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.size}`
    let owner: LockOwner | undefined
    try {
      const value = JSON.parse(fs.readFileSync(stat.isDirectory() ? path.join(file, ownerFilename) : file, 'utf8'))
      // Older legitimate leases have no timestamp.
      if (Number.isInteger(value?.pid) && value.pid > 0 && value.pid <= 0x7fffffff &&
        typeof value.token === 'string' && value.token) owner = value
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(stat.isDirectory() && errorCode(error) === 'ENOENT')) throw error
    }
    return { identity: `${identity}:${owner?.token ?? ''}`, mtime: Number(stat.mtimeMs), owner }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(errorCode(error) ?? '')) return undefined
    throw error
  }
}

function processExited(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    // EPERM means the process may still be alive.
    return errorCode(error) === 'ESRCH'
  }
  return false
}

function removeLockArtifact(file: string): void {
  try {
    fs.rmSync(file, { recursive: true, force: true })
  } catch {
    // A private staging file or a retired lease cannot block acquisition.
    console.warn('[gallery-lock] 未能清理写入锁临时文件')
  }
}

function publishLock(file: string, owner: LockOwner): boolean {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify({ ...owner, timestamp: Date.now() }), { flag: 'wx', mode: 0o600 })
    try {
      fs.linkSync(temporary, file)
      return true
    } catch (error) {
      const code = errorCode(error)
      if (code === 'EEXIST') return false
      if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EACCES', 'EXDEV'].includes(code ?? '')) throw error
    }

    // APFS supports hard links. On volumes without them, rename a complete non-empty
    // directory instead: it cannot replace another published directory or regular file.
    const directory = `${temporary}.dir`
    try {
      fs.mkdirSync(directory, { mode: 0o700 })
      fs.renameSync(temporary, path.join(directory, ownerFilename))
      try {
        fs.renameSync(directory, file)
        return true
      } catch (error) {
        if (['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(errorCode(error) ?? '') || fs.existsSync(file)) return false
        throw error
      }
    } finally {
      removeLockArtifact(directory)
    }
  } finally {
    removeLockArtifact(temporary)
  }
}

function retireLock(file: string) {
  const tombstone = `${file}.${randomUUID()}.retired`
  try {
    fs.renameSync(file, tombstone)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
  removeLockArtifact(tombstone)
}

function recoverLock(file: string, stale: LockSnapshot, owner: LockOwner): void {
  const generation = createHash('sha256').update(stale.identity).digest('hex').slice(0, 24)
  const claimPrefix = `${file}.recover-${generation}`
  const abandonedClaims: string[] = []
  let claim = claimPrefix
  while (!publishLock(claim, owner)) {
    const previous = readLock(claim)?.owner
    if (!previous || !processExited(previous.pid)) return
    // A dead reaper's immutable claim selects one exclusive successor; nobody has
    // to remove that claim and race against a live successor to take over.
    abandonedClaims.push(claim)
    claim = `${claimPrefix}-${previous.token}`
  }

  try {
    // Only the live claimant for this generation may attempt the rename. A
    // delayed contender for a retired generation cannot rename a newer lease.
    if (readLock(file)?.identity === stale.identity) retireLock(file)
  } finally {
    // Keep the chain intact if rename failed and the old lease still exists.
    if (readLock(file)?.identity !== stale.identity) {
      for (const abandoned of abandonedClaims.reverse()) retireLock(abandoned)
    }
    retireLock(claim)
  }
}

/** Shares one read/modify/write boundary across requests, app instances and backup CLI. */
export class GalleryWriteCoordinator {
  private readonly key: string
  private readonly lockFile?: string
  constructor(key: string, lockFile?: string) { this.key = key; this.lockFile = lockFile }

  detached<T>(operation: () => T): T { return held.run(new Map(), operation) }

  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    if (held.getStore()?.get(this.key)?.active) return operation()
    const previous = queues.get(this.key) ?? Promise.resolve()
    let release!: () => void
    const finished = new Promise<void>(resolve => { release = resolve })
    queues.set(this.key, finished)
    await previous
    let unlock: (() => void) | undefined
    const lease = { active: true }
    try {
      unlock = await this.acquireFileLock()
      return await held.run(new Map([...(held.getStore() ?? []), [this.key, lease]]), operation)
    } finally {
      lease.active = false
      unlock?.()
      release()
      if (queues.get(this.key) === finished) queues.delete(this.key)
    }
  }

  private async acquireFileLock(): Promise<() => void> {
    const file = this.lockFile
    if (!file) return () => {}
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const owner = { pid: process.pid, token: randomUUID() }
    const deadline = Date.now() + 30_000
    while (true) {
      const lock = readLock(file)
      if (!lock && publishLock(file, owner)) {
        return () => {
          try {
            if (readLock(file)?.owner?.token === owner.token) retireLock(file)
          } catch { /* Do not remove a different owner's lock. */ }
        }
      }
      if (lock && (lock.owner ? processExited(lock.owner.pid) : Date.now() - lock.mtime >= malformedLockGraceMs)) {
        recoverLock(file, lock, owner)
      }
      if (Date.now() > deadline) throw new Error('图库正被其他操作占用，请稍后重试')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}
