import { beforeEach, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
})
