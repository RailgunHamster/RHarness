import { randomUUID } from 'node:crypto'
import { lstatSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import {
  detectStickerMediaType, readStickerFile, resolveStickerFilePath, STICKER_MAX_BYTES, STICKER_MEDIA_EXT, type StickerRecord,
} from './assistant-persona-and-ambient.ts'
import { sha256Hex, signOperation, validOperation, type DeviceIdentityRecord, type PeerOperation } from './device-group.ts'

const id = z.string().regex(/^stk-[a-zA-Z0-9-]{1,96}$/)
const stamp = z.iso.datetime()
const meta = z.object({
  id, name: z.string().max(240), tags: z.array(z.string().max(60)).max(32), emotion: z.string().max(80).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/), sizeBytes: z.number().int().min(1).max(STICKER_MAX_BYTES),
  mediaType: z.enum(['image/png','image/jpeg','image/gif','image/webp']), source: z.enum(['upload','chat','feishu']),
  createdAt: stamp, updatedAt: stamp, lastUsedAt: stamp.optional(), useCount: z.number().int().nonnegative(), deletedAt: stamp.optional(),
})
const batchSchema = z.object({ items: z.array(meta).max(64), removed: z.array(z.object({ id, at: stamp })).max(64) })
type Batch = z.infer<typeof batchSchema>
interface Gallery {
  records: StickerRecord[]
  removals: Record<string,string>
}

function hasFile(record: StickerRecord) {
  try {
    const info = lstatSync(resolveStickerFilePath(record))
    return info.isFile() && info.size === record.sizeBytes
  } catch { return false }
}

/** Merge authenticated changes into the data center. Keep original IDs for chat and publish only verified files. */
export function receiveStickerBatch(gallery: Gallery, input: unknown, content?: unknown) {
  const batch = batchSchema.parse(input)
  const records = new Map(gallery.records.map(item => [item.id,item]))
  const removals = { ...gallery.removals }
  const need: string[] = []
  const discarded: StickerRecord[] = []
  let changed = false
  if (content !== undefined && (typeof content !== 'string' || batch.items.length !== 1 || batch.removed.length)) throw new Error('Invalid sticker transfer')
  for (const { id, at } of batch.removed) {
    if (removals[id] && removals[id]! >= at) continue
    removals[id] = at
    changed = true
    const previous = records.get(id)
    if (previous && previous.updatedAt <= at) { records.delete(id); discarded.push(previous) }
  }
  for (const item of batch.items) {
    if (removals[item.id] && removals[item.id]! >= item.updatedAt) continue
    const previous = records.get(item.id)
    if (previous && previous.sha256 !== item.sha256) throw new Error('Conflicting sticker identity')
    const incoming: StickerRecord = { ...item, fileName: item.id + STICKER_MEDIA_EXT[item.mediaType] }
    const file = previous ?? incoming
    if (!previous || !hasFile(file)) {
      if (typeof content !== 'string') { need.push(item.id); continue }
      const bytes = Buffer.from(content, 'base64')
      if (bytes.length !== item.sizeBytes || detectStickerMediaType(bytes) !== item.mediaType || sha256Hex(bytes) !== item.sha256) throw new Error('Sticker integrity check failed')
      const path = resolveStickerFilePath(file)
      const temp = path + '.' + randomUUID() + '.tmp'
      try { writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 }); renameSync(temp,path) }
      finally { rmSync(temp,{ force: true }) }
    }
    if (previous && previous.updatedAt >= item.updatedAt) continue
    if (previous?.feishuImageKey) incoming.feishuImageKey = previous.feishuImageKey
    incoming.useCount = Math.max(previous?.useCount ?? 0, item.useCount)
    records.set(item.id, incoming)
    changed = true
  }
  return { records: [...records.values()], removals, need, changed, discarded: discarded.filter(item => !records.has(item.id)) }
}

export interface StickerCenter { origin: string; deviceId: string; publicKeyB64: string }
export async function publishStickerGallery(identity: DeviceIdentityRecord, center: StickerCenter, gallery: Gallery, signal: AbortSignal, readOriginal = readStickerFile) {
  const endpoint = new URL('/orchestrator/standalone/assistant/sticker-replica', center.origin)
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))) throw new Error('Sticker replication requires a secure origin')
  async function post(batch: Batch, bytes?: Buffer) {
    const proof = signOperation(identity,randomUUID(),'sticker-publish',[center.deviceId,batch])
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type':'application/json' },
      body: JSON.stringify({ batch, proof, ...(bytes ? { content: bytes.toString('base64') } : {}) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]) })
    if (!response.ok) throw new Error('Data center sticker sync failed (' + response.status + ')')
    const result = await response.json() as { need: string[]; proof: PeerOperation }
    if (!Array.isArray(result.need) || result.proof?.key !== proof.key || !validOperation(result.proof,'sticker-receipt',result.need,[center.publicKeyB64])) throw new Error('Invalid sticker receipt')
    return new Set(result.need)
  }

  let unavailable = 0
  const removed = Object.entries(gallery.removals).map(([id,at]) => ({ id,at }))
  for (let offset = 0; offset < Math.max(gallery.records.length,removed.length); offset += 64) {
    const source = gallery.records.slice(offset,offset + 64)
    const batch = { items: source.map(record => meta.parse(record)), removed: removed.slice(offset,offset + 64) }
    const need = await post(batch)
    const missing = source.filter(item => need.has(item.id))
    for (let i = 0; i < missing.length; i += 3) {
      await Promise.all(missing.slice(i, i + 3).map(async item => {
        const bytes = readOriginal(item)
        if (!bytes || bytes.length !== item.sizeBytes || sha256Hex(bytes) !== item.sha256) { unavailable++; return }
        await post({ items: [meta.parse(item)], removed: [] }, bytes)
      }))
    }
  }
  if (unavailable) throw new Error(unavailable + ' sticker originals are missing or corrupt on the publishing node')
}
