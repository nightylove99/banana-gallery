import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'

test('external personal data paths preserve the old default and isolate new installs', async () => {
  const module = await import('../server/config/runtime-paths.ts').catch(() => null)
  assert.ok(module, 'runtime paths must support an explicit external data directory')
  const root = path.resolve('/app')
  const data = path.resolve('/user/data')
  const legacy = module.resolveRuntimePaths(root, {})
  assert.equal(legacy.dataFile, path.join(root, 'gallery-data.json'))
  assert.equal(legacy.imagesDir, path.join(root, 'public', 'images'))
  const external = module.resolveRuntimePaths(root, { BANANA_GALLERY_DATA_DIR: data })
  assert.equal(external.dataFile, path.join(data, 'gallery-data.json'))
  assert.equal(external.referencesDir, path.join(data, 'public', 'references'))
  assert.equal(external.distDir, path.join(root, 'dist'))
  assert.throws(() => module.resolveRuntimePaths(root, { BANANA_GALLERY_DATA_DIR: '../data' }), /绝对/)
})

test('personal backup destination is explicit and shared with the data path resolver', async () => {
  const { resolveRuntimePaths } = await import('../server/config/runtime-paths.ts')
  const root = path.resolve('/app')
  const data = path.resolve('/data')
  const snapshots = path.resolve('/snapshots')
  assert.equal(resolveRuntimePaths(root, {}).backupDir, path.join(root, 'backups'))
  assert.equal(resolveRuntimePaths(root, { BANANA_GALLERY_DATA_DIR: data, BANANA_GALLERY_BACKUP_DIR: snapshots }).backupDir, snapshots)
  assert.throws(() => resolveRuntimePaths(root, { BANANA_GALLERY_BACKUP_DIR: '../snapshots' }), /绝对/)
})

test('rejects private data directories under publicly served app folders', async () => {
  const { resolveRuntimePaths } = await import('../server/config/runtime-paths.ts')
  const root = path.resolve('/app')
  for (const directory of ['public', 'dist']) {
    assert.throws(() => resolveRuntimePaths(root, { BANANA_GALLERY_DATA_DIR: path.join(root, directory, 'data') }), /不能位于/)
  }
  assert.doesNotThrow(() => resolveRuntimePaths(root, { BANANA_GALLERY_DATA_DIR: path.join(root, 'public-data') }))
})
