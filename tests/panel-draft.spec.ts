// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readPanelDraft,
  readPanelDraftImages,
  readPanelPreferences,
  writePanelDraft,
  writePanelDraftImages,
  writePanelPreferences,
  type PanelImageDraft,
} from '../src/client/panel-draft.ts'

class MemoryStorage {
  readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

class FailingStorage extends MemoryStorage {
  override getItem(_key: string): string | null { throw new Error('storage blocked') }
  override setItem(_key: string, _value: string): void { throw new Error('storage blocked') }
}

type FakeRequest = {
  result?: unknown
  error: Error | null
  onsuccess: (() => void) | null
  onerror: (() => void) | null
}

function createIndexedDbMock() {
  const values = new Map<string, unknown>()
  const events: string[] = []
  const state = { failReads: 0, failWrites: 0 }
  const database = {
    objectStoreNames: { contains: (name: string) => name === 'images' },
    createObjectStore: () => ({}),
    close: () => undefined,
    transaction: (_name: string, _mode: IDBTransactionMode) => {
      const transaction = {
        error: null as Error | null,
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
        objectStore: () => ({
          get: (key: string) => {
            const request: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null }
            queueMicrotask(() => {
              if (state.failReads) {
                state.failReads -= 1
                request.error = new Error('read failed')
                request.onerror?.()
                transaction.onerror?.()
                return
              }
              request.result = values.get(key)
              request.onsuccess?.()
            })
            return request as unknown as IDBRequest
          },
          put: (value: unknown, key: string) => {
            const request: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null }
            queueMicrotask(() => {
              if (state.failWrites) {
                state.failWrites -= 1
                request.error = new Error('write failed')
                request.onerror?.()
                transaction.onerror?.()
                return
              }
              values.set(key, value)
              events.push(`put:${key}`)
              request.onsuccess?.()
              queueMicrotask(() => transaction.oncomplete?.())
            })
            return request as unknown as IDBRequest
          },
          delete: (key: string) => {
            const request: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null }
            queueMicrotask(() => {
              if (state.failWrites) {
                state.failWrites -= 1
                request.error = new Error('delete failed')
                request.onerror?.()
                transaction.onerror?.()
                return
              }
              values.delete(key)
              events.push(`delete:${key}`)
              request.onsuccess?.()
              queueMicrotask(() => transaction.oncomplete?.())
            })
            return request as unknown as IDBRequest
          },
        }),
      }
      return transaction as unknown as IDBTransaction
    },
  } as unknown as IDBDatabase
  const factory = {
    open: () => {
      const request: FakeRequest & { onupgradeneeded: (() => void) | null } = {
        result: database,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      }
      queueMicrotask(() => {
        request.onupgradeneeded?.()
        request.onsuccess?.()
      })
      return request as unknown as IDBOpenDBRequest
    },
  } as unknown as IDBFactory
  return {
    factory,
    values,
    events,
    state,
    reset() { values.clear(); events.length = 0; state.failReads = 0; state.failWrites = 0 },
  }
}

const image: PanelImageDraft = { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=', name: 'hello.png', size: 5 }
const pathKey = (kind: string, conversation?: string) => `dsh-panel-draft-v1:${encodeURIComponent('/panel-draft-test')}:${kind}${conversation === undefined ? '' : `:${encodeURIComponent(conversation)}`}`
const imageKey = (conversation: string) => `${encodeURIComponent('/panel-draft-test')}:${encodeURIComponent(conversation)}`

const storage = new MemoryStorage()
const indexedDb = createIndexedDbMock()

beforeEach(() => {
  storage.clear()
  indexedDb.reset()
  window.history.replaceState({}, '', '/panel-draft-test')
  vi.stubGlobal('localStorage', storage as unknown as Storage)
  vi.stubGlobal('indexedDB', indexedDb.factory)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('panel draft localStorage persistence', () => {
  it('round trips text, reply target, preferences, and isolates conversations', () => {
    expect(writePanelDraft('alpha', { text: 'draft alpha', replyTo: 'm1' })).toBe(true)
    expect(writePanelDraft('beta', { text: 'draft beta', replyTo: '' })).toBe(true)
    expect(readPanelDraft('alpha')).toEqual({ text: 'draft alpha', replyTo: 'm1' })
    expect(readPanelDraft('beta')).toEqual({ text: 'draft beta', replyTo: '' })
    expect(readPanelDraft('missing')).toEqual({ text: '', replyTo: '' })

    expect(writePanelPreferences({ conversation: 'beta', sender: 'reviewer', autoAccept: false })).toBe(true)
    expect(readPanelPreferences()).toEqual({ conversation: 'beta', sender: 'reviewer', autoAccept: false })
  })

  it('ignores corrupt JSON but marks unavailable storage as a restore failure', () => {
    storage.setItem(pathKey('draft', 'broken'), '{not json')
    storage.setItem(pathKey('preferences'), '{not json')
    expect(readPanelDraft('broken')).toEqual({ text: '', replyTo: '' })
    expect(readPanelPreferences()).toEqual({ conversation: 'main', sender: 'operator', autoAccept: false })

    vi.stubGlobal('localStorage', new FailingStorage() as unknown as Storage)
    expect(readPanelDraft('broken')).toMatchObject({ text: '', replyTo: '', restoreFailed: true })
    expect(readPanelPreferences()).toMatchObject({ conversation: 'main', sender: 'operator', autoAccept: false, restoreFailed: true })
    expect(writePanelDraft('broken', { text: 'new', replyTo: '' })).toBe(false)
    expect(writePanelPreferences({ conversation: 'main', sender: 'operator', autoAccept: false })).toBe(false)
  })

  it('keeps storage isolated by pathname', () => {
    expect(writePanelDraft('same', { text: 'first path', replyTo: '' })).toBe(true)
    window.history.replaceState({}, '', '/another-panel')
    expect(readPanelDraft('same')).toEqual({ text: '', replyTo: '' })
    expect(writePanelDraft('same', { text: 'second path', replyTo: '' })).toBe(true)
    window.history.replaceState({}, '', '/panel-draft-test')
    expect(readPanelDraft('same')).toEqual({ text: 'first path', replyTo: '' })
  })
})

describe('panel image IndexedDB persistence', () => {
  it('round trips images, isolates conversations and deletes in call order', async () => {
    await writePanelDraftImages('alpha', [image])
    expect(await readPanelDraftImages('alpha')).toEqual([image])
    expect(await readPanelDraftImages('beta')).toEqual([])

    const save = writePanelDraftImages('alpha', [{ ...image, name: 'new.png' }])
    const remove = writePanelDraftImages('alpha', [])
    // A read issued before either write settles must still observe the later deletion.
    expect(await readPanelDraftImages('alpha')).toEqual([])
    await Promise.all([save, remove])
    expect(indexedDb.events.at(-2)).toContain('put:')
    expect(indexedDb.events.at(-1)).toContain('delete:')
  })

  it('captures the page path before an asynchronous image write and isolates it from other pages', async () => {
    const save = writePanelDraftImages('alpha', [image])
    window.history.replaceState({}, '', '/another-panel')
    await save
    expect(await readPanelDraftImages('alpha')).toEqual([])
    window.history.replaceState({}, '', '/panel-draft-test')
    expect(await readPanelDraftImages('alpha')).toEqual([image])
  })

  it('retries opening the image database after an unavailable database rejects a read', async () => {
    vi.resetModules()
    const unavailable = { open: vi.fn(() => { throw new Error('database unavailable') }) }
    vi.stubGlobal('indexedDB', unavailable)
    const fresh = await import('../src/client/panel-draft.ts')
    await expect(fresh.readPanelDraftImages('alpha')).rejects.toThrow('database unavailable')
    await expect(fresh.readPanelDraftImages('alpha')).rejects.toThrow('database unavailable')
    expect(unavailable.open).toHaveBeenCalledTimes(2)
  })

  it('rejects read failures and preserves old data after write failure', async () => {
    await writePanelDraftImages('alpha', [image])
    indexedDb.state.failWrites = 1
    await expect(writePanelDraftImages('alpha', [{ ...image, name: 'replacement.png' }])).rejects.toThrow('write failed')
    expect(await readPanelDraftImages('alpha')).toEqual([image])

    indexedDb.state.failReads = 1
    await expect(readPanelDraftImages('alpha')).rejects.toThrow('read failed')
  })

  it('safely ignores malformed stored image records', async () => {
    indexedDb.values.set(imageKey('broken'), [{ ...image, mediaType: 'image/svg+xml' }])
    expect(await readPanelDraftImages('broken')).toEqual([])
    await expect(writePanelDraftImages('broken', [{ ...image, data: 'bad' }])).rejects.toThrow('Invalid image draft')
  })
})
