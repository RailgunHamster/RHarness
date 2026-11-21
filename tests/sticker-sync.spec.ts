import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startStandaloneServer } from '../src/server/standalone.ts'
import { KV } from '../src/kv.ts'
import { DATA_CENTER_TAG, createDeviceGroup, createGroupInvitation, createJoinRequest, ensureDeviceIdentity, redeemGroupInvitation, signOperation } from '../src/app/device-group.ts'
import { saveStickerFromBuffer, deleteStickerFile, readStickerFile } from '../src/app/assistant-persona-and-ambient.ts'
import { publishStickerGallery } from '../src/app/sticker-sync.ts'

it('replicates original IDs and verified bytes to the paired center, repairs missing files, and preserves trash and permanent deletes', async () => {
  const root = mkdtempSync(join(tmpdir(),'sticker-sync-'))
  const oldDir = process.env.RHARNESS_STICKERS_DIR
  process.env.RHARNESS_STICKERS_DIR = join(root,'center-images')
  const center = await startStandaloneServer({ port: 0, stateDir: root, liveAgents: false, host: '127.0.0.1' })
  try {
    const identity = ensureDeviceIdentity(undefined,center.port,[DATA_CENTER_TAG])
    const source = ensureDeviceIdentity(undefined,4319)
    const group = createDeviceGroup(identity)
    const packet = redeemGroupInvitation(identity,group,createGroupInvitation(identity,group,false).token,createJoinRequest(source))
    center.runtime.store.set(KV.deviceGroup.identity,identity)
    center.runtime.store.set(KV.deviceGroup.packet,packet)
    const target = { ...identity, origin: center.url }
    const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64')
    const record = saveStickerFromBuffer([], { data: bytes, name: 'test' }).entry
    deleteStickerFile(record)
    const read = vi.fn(() => bytes)
    const signal = new AbortController().signal
    const gallery = { records: [record], removals: {} }
    const sync = () => publishStickerGallery(source,target,gallery,signal,read)
    const url = center.url + '/orchestrator/standalone/assistant/stickers/' + record.id
    const headers = { 'x-orchestrator-request': '1' }
    await expect(publishStickerGallery(ensureDeviceIdentity(undefined,4320),target,gallery,signal,read)).rejects.toThrow(/403/)
    expect(read).not.toHaveBeenCalled()
    const batch = { items: [record], removed: [] }
    const invalid = await fetch(center.url + '/orchestrator/standalone/assistant/sticker-replica', {
      method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({
        batch, proof: signOperation(source,'test-integrity','sticker-publish',[identity.deviceId,batch]),
        content: Buffer.alloc(bytes.length).toString('base64'),
      }),
    })
    expect(invalid.ok).toBe(false)
    expect(readStickerFile(record)).toBeUndefined()
    await expect(publishStickerGallery(source,target,gallery,signal,() => Buffer.alloc(bytes.length))).rejects.toThrow()
    expect(center.runtime.store.get(KV.persona.stickers) ?? []).toEqual([])
    await sync()
    const res = await fetch(url + '/content',{headers})
    expect(res.headers.get('content-type')).toBe('image/gif')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes)
    expect(center.runtime.store.get(KV.persona.stickers)?.[0]?.id).toBe(record.id)
    await sync()
    expect(read).toHaveBeenCalledTimes(1)
    deleteStickerFile(record)
    await sync()
    expect(read).toHaveBeenCalledTimes(2)
    expect(readStickerFile(record)).toEqual(bytes)
    expect((await fetch(url,{method:'DELETE',headers})).ok).toBe(true)
    await sync()
    expect(center.runtime.store.get(KV.persona.stickers)?.[0]?.deletedAt).toBeTruthy()
    expect((await fetch(url + '/permanent',{method:'DELETE',headers})).ok).toBe(true)
    await sync()
    expect((await fetch(url + '/content',{headers})).status).toBe(404)
    expect(read).toHaveBeenCalledTimes(2)
  } finally {
    await center.stop()
    if (oldDir === undefined) delete process.env.RHARNESS_STICKERS_DIR
    else process.env.RHARNESS_STICKERS_DIR = oldDir
    rmSync(root,{recursive:true,force:true})
  }
})
