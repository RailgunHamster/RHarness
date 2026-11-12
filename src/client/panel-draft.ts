/** Browser-local text/preferences and ordered, separately stored image drafts for each conversation. */
import { PANEL_IMAGE_MEDIA_TYPES, MAX_PANEL_IMAGES, MAX_PANEL_IMAGE_BYTES, MAX_PANEL_MESSAGE_IMAGE_BYTES, type PanelImageMediaType } from './image-composer.tsx'

export interface PanelImageDraft {
  type: 'image'
  mediaType: PanelImageMediaType
  data: string
  name: string
  size: number
}

export interface PanelDraft {
  text: string
  replyTo: string
}

export interface PanelPreferences {
  conversation: string
  sender: string
  autoAccept: boolean
}

const DEFAULT_PANEL_DRAFT: PanelDraft = { text: '', replyTo: '' }
const DEFAULT_PANEL_PREFERENCES: PanelPreferences = { conversation: 'main', sender: 'operator', autoAccept: false }
const PANEL_STORAGE_PREFIX = 'dsh-panel-draft-v1'
const IMAGE_DATABASE_NAME = 'dsh-panel-drafts-v1'
const IMAGE_STORE_NAME = 'images'
const IMAGE_DATABASE_VERSION = 1

type StorageGlobal = typeof globalThis & { localStorage?: Storage }

function pathname(): string {
  try {
    const value = (globalThis as typeof globalThis & { location?: Location }).location?.pathname
    return typeof value === 'string' && value ? value : '/'
  } catch {
    return '/'
  }
}

function storageKey(kind: 'draft' | 'preferences', conversation?: string): string {
  const path = encodeURIComponent(pathname())
  const suffix = conversation === undefined ? '' : `:${encodeURIComponent(conversation)}`
  return `${PANEL_STORAGE_PREFIX}:${path}:${kind}${suffix}`
}

function getStorage(): Storage | undefined {
  try {
    const storage = (globalThis as StorageGlobal).localStorage
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return undefined
    return storage
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type ParsedStorageValue = { value: unknown; failed: boolean }

function parseStorageValue(key: string): ParsedStorageValue {
  try {
    const storage = (globalThis as StorageGlobal).localStorage
    if (!storage || typeof storage.getItem !== 'function') return { value: undefined, failed: true }
    const value = storage.getItem(key)
    if (value === null) return { value: undefined, failed: false }
    try {
      return { value: JSON.parse(value) as unknown, failed: false }
    } catch {
      return { value: undefined, failed: false }
    }
  } catch {
    return { value: undefined, failed: true }
  }
}

function isPanelDraft(value: unknown): value is PanelDraft {
  return isRecord(value) && typeof value.text === 'string' && typeof value.replyTo === 'string'
}

function isPanelPreferences(value: unknown): value is PanelPreferences & { bypassEval?: boolean } {
  return isRecord(value) && typeof value.conversation === 'string' && typeof value.sender === 'string' && typeof value.autoAccept === 'boolean'
}

export function readPanelDraft(conversation: string): PanelDraft & { restoreFailed?: true } {
  const parsed = parseStorageValue(storageKey('draft', conversation))
  if (isPanelDraft(parsed.value)) return { text: parsed.value.text, replyTo: parsed.value.replyTo }
  return parsed.failed ? { ...DEFAULT_PANEL_DRAFT, restoreFailed: true } : { ...DEFAULT_PANEL_DRAFT }
}

export function writePanelDraft(conversation: string, draft: PanelDraft): boolean {
  if (typeof conversation !== 'string' || !isPanelDraft(draft)) return false
  const storage = getStorage()
  if (!storage) return false
  try {
    storage.setItem(storageKey('draft', conversation), JSON.stringify({ text: draft.text, replyTo: draft.replyTo }))
    return true
  } catch {
    return false
  }
}

export function readPanelPreferences(): PanelPreferences & { restoreFailed?: true } {
  const parsed = parseStorageValue(storageKey('preferences'))
  if (isPanelPreferences(parsed.value)) {
    const autoAccept = typeof parsed.value.bypassEval === 'boolean' ? parsed.value.bypassEval : false
    return { conversation: parsed.value.conversation, sender: parsed.value.sender, autoAccept }
  }
  return parsed.failed ? { ...DEFAULT_PANEL_PREFERENCES, restoreFailed: true } : { ...DEFAULT_PANEL_PREFERENCES }
}

export function writePanelPreferences(preferences: PanelPreferences): boolean {
  if (!isPanelPreferences(preferences)) return false
  const storage = getStorage()
  if (!storage) return false
  try {
    storage.setItem(storageKey('preferences'), JSON.stringify({
      conversation: preferences.conversation,
      sender: preferences.sender,
      autoAccept: preferences.autoAccept,
      bypassEval: preferences.autoAccept,
    }))
    return true
  } catch {
    return false
  }
}

function isPanelImageMediaType(value: unknown): value is PanelImageMediaType {
  return typeof value === 'string' && (PANEL_IMAGE_MEDIA_TYPES as readonly string[]).includes(value)
}

function isPanelImageDraft(value: unknown): value is PanelImageDraft {
  return isRecord(value)
    && value.type === 'image'
    && isPanelImageMediaType(value.mediaType)
    && typeof value.data === 'string'
    && value.data.length > 0
    && value.data.length % 4 === 0
    && /^[A-Za-z0-9+/]*={0,2}$/.test(value.data)
    && typeof value.name === 'string'
    && typeof value.size === 'number'
    && Number.isSafeInteger(value.size)
    && value.size > 0
    && value.size <= MAX_PANEL_IMAGE_BYTES
}

function validateImages(value: unknown): value is PanelImageDraft[] {
  if (!Array.isArray(value) || value.length > MAX_PANEL_IMAGES || !value.every(isPanelImageDraft)) return false
  return value.reduce((total, image) => total + image.size, 0) <= MAX_PANEL_MESSAGE_IMAGE_BYTES
}

function copyImages(images: readonly PanelImageDraft[]): PanelImageDraft[] {
  return images.map(image => ({ ...image }))
}

function getIndexedDb(): IDBFactory | undefined {
  try {
    const value = (globalThis as typeof globalThis & { indexedDB?: IDBFactory }).indexedDB
    return value && typeof value.open === 'function' ? value : undefined
  } catch {
    return undefined
  }
}

let databasePromise: Promise<IDBDatabase> | undefined

function openImageDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise
  const factory = getIndexedDb()
  if (!factory) return Promise.reject(new Error('IndexedDB is unavailable'))
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      request = factory.open(IMAGE_DATABASE_NAME, IMAGE_DATABASE_VERSION)
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    request.onupgradeneeded = () => {
      try {
        const names = request.result.objectStoreNames
        const hasStore = typeof names.contains === 'function'
          ? names.contains(IMAGE_STORE_NAME)
          : Array.from(names).includes(IMAGE_STORE_NAME)
        if (!hasStore) request.result.createObjectStore(IMAGE_STORE_NAME)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => {
        database.close()
        databasePromise = undefined
      }
      resolve(database)
    }
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'))
    request.onblocked = () => reject(new Error('IndexedDB open was blocked'))
  })
  const retryablePromise = promise.catch(error => {
    if (databasePromise === retryablePromise) databasePromise = undefined
    throw error
  })
  databasePromise = retryablePromise
  return retryablePromise
}

function imageKey(conversation: string, path = pathname()): string {
  return `${encodeURIComponent(path)}:${encodeURIComponent(conversation)}`
}

function readImagesFromDatabase(database: IDBDatabase, key: string): Promise<PanelImageDraft[]> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction
    try {
      transaction = database.transaction(IMAGE_STORE_NAME, 'readonly')
      const request = transaction.objectStore(IMAGE_STORE_NAME).get(key)
      request.onsuccess = () => {
        const value: unknown = request.result
        resolve(validateImages(value) ? copyImages(value) : [])
      }
      request.onerror = () => reject(request.error ?? new Error('Could not read image draft'))
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function writeImagesToDatabase(database: IDBDatabase, key: string, images: readonly PanelImageDraft[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction
    try {
      transaction = database.transaction(IMAGE_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(IMAGE_STORE_NAME)
      const request = images.length
        ? store.put(copyImages(images), key)
        : store.delete(key)
      let requestFailed = false
      request.onerror = () => {
        requestFailed = true
        reject(request.error ?? new Error('Could not write image draft'))
      }
      transaction.oncomplete = () => {
        if (!requestFailed) resolve()
      }
      transaction.onerror = () => {
        if (!requestFailed) reject(transaction.error ?? new Error('Could not write image draft'))
      }
      transaction.onabort = () => {
        if (!requestFailed) reject(transaction.error ?? new Error('Could not write image draft'))
      }
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

let imageWriteQueue: Promise<void> = Promise.resolve()

export async function readPanelDraftImages(conversation: string): Promise<PanelImageDraft[]> {
  if (typeof conversation !== 'string') throw new Error('Invalid conversation')
  const key = imageKey(conversation)
  const pendingWrites = imageWriteQueue
  await pendingWrites
  return readImagesFromDatabase(await openImageDatabase(), key)
}

export function writePanelDraftImages(conversation: string, images: readonly PanelImageDraft[]): Promise<void> {
  if (typeof conversation !== 'string' || !Array.isArray(images)) return Promise.reject(new Error('Invalid image draft'))
  const snapshot = copyImages(images)
  if (!validateImages(snapshot)) return Promise.reject(new Error('Invalid image draft'))
  const key = imageKey(conversation)
  const operation = imageWriteQueue.then(async () => writeImagesToDatabase(await openImageDatabase(), key, snapshot), async () => writeImagesToDatabase(await openImageDatabase(), key, snapshot))
  imageWriteQueue = operation.catch(() => undefined)
  return operation
}
