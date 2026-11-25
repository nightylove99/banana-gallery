import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { GalleryWriteCoordinator } from '../../server/gallery/write-coordinator'

const coordinatorUrl = pathToFileURL(path.resolve('server/gallery/write-coordinator.ts')).href
it('serializes separate CLI processes and releases after rejection and reentrant operations', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-lock-'))
  try {
    const data = path.join(root, 'counter'); fs.writeFileSync(data, '0')
    const script = path.join(root, 'writer.mts')
    fs.writeFileSync(script, `import fs from 'node:fs'; import { GalleryWriteCoordinator } from ${JSON.stringify(coordinatorUrl)}; const data = process.argv[2]; const lock = new GalleryWriteCoordinator(data, data + '.lock'); for (let i = 0; i < 5; i++) await lock.run(async () => { const n = Number(fs.readFileSync(data)); await new Promise(r => setTimeout(r, 10)); fs.writeFileSync(data, String(n + 1)); });`)
    await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath, ['--import', 'tsx', script, data])))
    expect(fs.readFileSync(data, 'utf8')).toBe('15')
    const lock = new GalleryWriteCoordinator(data, `${data}.lock`)
    await expect(lock.run(() => { throw new Error('failure') })).rejects.toThrow('failure')
    expect(await lock.run(() => lock.run(() => 'okay'))).toBe('okay')
    expect(fs.existsSync(`${data}.lock`)).toBe(false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

it('a detached task and callbacks inherited from an expired lock still wait for active writers',async()=>{
 const lock=new GalleryWriteCoordinator('async-context-test')
 let inherited!:Promise<void>,resume!:()=>void,release!:()=>void
 const events:string[]=[]
 await lock.run(async()=>{inherited=(async()=>{await new Promise<void>(resolve=>{resume=resolve});await lock.run(()=>{events.push('inherited')})})()})
 const writer=lock.run(async()=>{events.push('writer');await new Promise<void>(resolve=>{release=resolve})})
 await new Promise(resolve=>setTimeout(resolve,0))
 resume();const escaped=inherited
 await new Promise(resolve=>setTimeout(resolve,0));expect(events).toEqual(['writer'])
 release();await Promise.all([writer,escaped]);expect(events).toEqual(['writer','inherited'])
 let background!:Promise<void>
 await lock.run(async()=>{background=lock.detached(()=>lock.run(()=>{events.push('background')}));events.push('parent')})
 await background;expect(events.slice(-2)).toEqual(['parent','background'])
})

it.each(['', 'not JSON', 'null'])('recovers an expired malformed lock (%j)', async contents => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-lock-'))
  try {
    const file = path.join(root, 'gallery.lock')
    fs.writeFileSync(file, contents)
    const expired = new Date(Date.now() - 5_000)
    fs.utimesSync(file, expired, expired)
    const script = path.join(root, 'recover.mts')
    fs.writeFileSync(script, `
      import fs from 'node:fs'
      import { GalleryWriteCoordinator } from ${JSON.stringify(coordinatorUrl)}
      const file = process.argv[2]
      const lock = new GalleryWriteCoordinator(file, file)
      await lock.run(() => {
        const owner = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (owner.pid !== process.pid || !owner.token || !Number.isFinite(owner.timestamp)) throw new Error('incomplete lease')
        fs.writeFileSync(file + '.completed', 'yes')
      })
    `)
    await promisify(execFile)(process.execPath, ['--import', 'tsx', script, file], { timeout: 3_000 })
    expect(fs.readFileSync(file + '.completed', 'utf8')).toBe('yes')
    expect(fs.existsSync(file)).toBe(false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

it.each(['pause', 'crash'])('keeps concurrent recovery exclusive when the first reaper hits a %s', async interruption => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-lock-'))
  try {
    const file = path.join(root, 'gallery.lock')
    const { stdout } = await promisify(execFile)(process.execPath, ['-p', 'process.pid'])
    fs.writeFileSync(file, JSON.stringify({ pid: Number(stdout), token: 'dead' }))
    const script = path.join(root, 'race.mts')
    fs.writeFileSync(script, `
      import fs from 'node:fs'
      import { GalleryWriteCoordinator } from ${JSON.stringify(coordinatorUrl)}
      const [file, role, interruption] = process.argv.slice(2)
      const coordinator = new GalleryWriteCoordinator(file, file)
      const pause = () => {
        if (role !== 'first' || fs.existsSync(file + '.paused')) return
        fs.writeFileSync(file + '.paused', '')
        if (interruption === 'crash') process.exit(72)
        const delay = new Int32Array(new SharedArrayBuffer(4))
        const deadline = Date.now() + 2_000
        while (!fs.existsSync(file + '.second-entered') && Date.now() < deadline) {
          Atomics.wait(delay, 0, 0, 10)
        }
      }
      const unlink = fs.unlinkSync
      const rename = fs.renameSync
      fs.unlinkSync = target => { if (target === file) pause(); unlink(target) }
      fs.renameSync = (from, to) => { if (from === file) pause(); rename(from, to) }
      await coordinator.run(async () => {
        fs.writeFileSync(file + '.critical', role, { flag: 'wx' })
        try {
          if (role === 'second') fs.writeFileSync(file + '.second-entered', '')
          await new Promise(resolve => setTimeout(resolve, 150))
          if (JSON.parse(fs.readFileSync(file, 'utf8')).pid !== process.pid) throw new Error('lease replaced in critical section')
          fs.writeFileSync(file + '.' + role + '-completed', '')
        } finally { unlink(file + '.critical') }
      })
    `)
    const run = (role: string) => promisify(execFile)(process.execPath, ['--import', 'tsx', script, file, role, interruption], { timeout: 8_000 })
    const first = interruption === 'crash'
      ? expect(run('first')).rejects.toMatchObject({ code: 72 })
      : run('first')
    const second = (async () => {
      const deadline = Date.now() + 4_000
      while (!fs.existsSync(file + '.paused')) {
        if (Date.now() > deadline) throw new Error('first reaper did not reach the race window')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      await run('second')
    })()
    const results = await Promise.allSettled([first, second])
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason
    }
    expect(fs.existsSync(file + '.first-completed')).toBe(interruption === 'pause')
    expect(fs.existsSync(file + '.second-completed')).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.readdirSync(root).filter(name => /\.recover-|\.retired$|\.tmp$/.test(name))).toEqual([])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

it('leaves no published lock on a partial ENOSPC write and allows retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-lock-'))
  const write = fs.writeFileSync
  try {
    const file = path.join(root, 'gallery.lock')
    const lock = new GalleryWriteCoordinator(file, file)
    fs.writeFileSync = (target, data, options) => {
      write(target, '{', options)
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    }
    await expect(lock.run(() => 'not reached')).rejects.toThrow('disk full')
    fs.writeFileSync = write
    expect(fs.readdirSync(root)).toEqual([])
    await expect(lock.run(() => 'retried')).resolves.toBe('retried')
  } finally {
    fs.writeFileSync = write
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('publishes a complete, exclusive lease even where hard links are unsupported', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-lock-'))
  const link = fs.linkSync
  try {
    const file = path.join(root, 'gallery.lock')
    const first = new GalleryWriteCoordinator('first-fallback', file)
    const second = new GalleryWriteCoordinator('second-fallback', file)
    fs.linkSync = () => { throw Object.assign(new Error('no hard links'), { code: 'ENOTSUP' }) }
    let secondRun!: Promise<void>
    let enteredSecond = false
    await first.run(async () => {
      const owner = fs.readFileSync(path.join(file, 'owner.json'), 'utf8')
      expect(JSON.parse(owner)).toMatchObject({ pid: process.pid, token: expect.any(String), timestamp: expect.any(Number) })
      secondRun = second.run(() => { enteredSecond = true })
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(enteredSecond).toBe(false)
      expect(fs.readFileSync(path.join(file, 'owner.json'), 'utf8')).toBe(owner)
    })
    await secondRun
    expect(enteredSecond).toBe(true)
    expect(fs.readdirSync(root)).toEqual([])
  } finally {
    fs.linkSync = link
    fs.rmSync(root, { recursive: true, force: true })
  }
})
