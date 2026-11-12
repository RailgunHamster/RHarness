import { describe, expect, it, vi } from 'vitest'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { panelContent, readPanelImage, storePanelContent, type PanelImage } from '../src/sources/panel-images.ts'
import { codexTurnContent, dshTurnContent } from '../src/app/local-images.ts'
import type { SessionTurnMessage } from '../src/app/standalone-host.ts'
import { startStandaloneServer } from '../src/server/standalone.ts'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+9f8AAAAASUVORK5CYII='
const upload = { type: 'image' as const, mediaType: 'image/png' as const, data: png, name: 'one.png' }

describe('panel image backend', () => {
  it('accepts pure image messages and enforces count, canonical encoding, MIME, and byte limits', () => {
    const parsed = panelContent({ text: '', content: [upload] })
    expect(parsed.text).toBe('[image]')
    expect(parsed.content).toContainEqual(upload)
    expect(panelContent({ content: Array.from({ length: 8 }, () => upload) }).content.filter(part => part.type === 'image')).toHaveLength(8)
    expect(() => panelContent({ content: Array.from({ length: 9 }, () => upload) })).toThrow(/8 images/)
    expect(() => panelContent({ content: [{ ...upload, data: 'AB==' }] })).toThrow(/canonical/)
    expect(() => panelContent({ content: [{ ...upload, mediaType: 'image/jpeg' }] })).toThrow(/match/)
    expect(() => panelContent({ content: [{ ...upload, data: 'data:image/jpeg;base64,' + png }] })).toThrow(/does not match/)
    expect(() => panelContent({ content: [{ ...upload, data: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') }] })).toThrow(/8 MiB/)
    const large = Buffer.alloc(6 * 1024 * 1024 + 1)
    Buffer.from(png, 'base64').copy(large)
    expect(() => panelContent({ content: [{ ...upload, data: large.toString('base64') }, { ...upload, data: large.toString('base64') }] })).toThrow(/12 MiB/)
    expect(() => panelContent({ content: {}, text: 'hello' })).toThrow(/array/)
  })

  it('stores immutable references, strips display paths and detects replacement or path escape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'panel-images-'))
    try {
      const parts = await storePanelContent(dir, panelContent({ content: [{ ...upload, name: '../one.png' }] }).content)
      const image = parts.find(part => part.type === 'image')?.image
      expect(image?.name).not.toMatch(/[\\/]/)
      expect(image && (await readPanelImage(image)).toString('base64')).toBe(png)
      expect(await readFile(image!.path)).toHaveLength(image!.bytes)
      await expect(readPanelImage({ ...image!, path: join(dir, 'outside.png') })).rejects.toThrow(/path/)
      await writeFile(image!.path, 'replaced')
      await expect(readPanelImage(image!)).rejects.toThrow(/integrity/)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('projects actual image input into Codex and DSH provider APIs without embedding base64 in text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'panel-image-model-'))
    try {
      const parts = await storePanelContent(dir, panelContent({ content: [upload] }).content)
      const image = parts.find(part => part.type === 'image')?.image
      const messages: SessionTurnMessage[] = [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'Inspect this' }, { type: 'image', path: image!.path, mediaType: image!.mediaType }] }]
      expect(codexTurnContent(messages)).toEqual([{ type: 'text', text: 'Inspect this', text_elements: [] }, { type: 'localImage', path: image!.path }])
      const ref: ImageAttachmentRef = { attachmentId: AttachmentId(image!.id), mediaType: 'image/png', width: 1, height: 1, bytes: image!.bytes }
      const saveImage = vi.fn(async () => ref)
      const content = await dshTurnContent(messages, { saveImage }, new AbortController().signal)
      expect(saveImage.mock.calls).toHaveLength(1)
      expect(saveImage.mock.calls[0]).toEqual([{ data: Buffer.from(png, 'base64'), mediaType: 'image/png', name: undefined }])
      expect(content).toEqual([{ type: 'text', text: 'Inspect this' }, { type: 'image', attachment: ref }])
      expect(JSON.stringify(content)).not.toContain(png)
      await expect(dshTurnContent(messages, undefined, new AbortController().signal)).rejects.toThrow(/attachment service/)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('round-trips HTTP images and delivers them to assessment, initial executor, and follow-up inputs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'panel-image-http-'))
    const srv = await startStandaloneServer({ port: 0, stateDir: dir, liveAgents: false })
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${srv.url}/orchestrator/standalone/${path}`, { method,
        headers: { 'x-orchestrator-request': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      return { status: response.status, body: await response.json() as Record<string, any> }
    }
    try {
      const settings = srv.runtime.store.settings()
      srv.runtime.store.saveSettings({ ...settings, eval: { ...settings.eval, model: { provider: 'human', model: 'human-operator' } },
        executor: { ...settings.executor, model: { provider: 'human', model: 'human-operator' } } })
      const posted = await api('POST', 'panel/messages', { conversation: 'pictures', text: '', content: [upload], autoAccept: true })
      expect(posted.status, JSON.stringify(posted.body)).toBe(200)
      expect(posted.body.ticketId).toBeTruthy()
      await srv.runtime.idle()
      const trigger = srv.runtime.store.triggers.get(posted.body.id)!
      expect(trigger.meta.images).toHaveLength(1)
      expect(JSON.stringify(trigger)).not.toContain(png)
      const imagesIn = (id: string) => {
        const detail = srv.host.getSessionDetail(id)!
        return (detail.events as { type: string; data: any }[]).filter(event => event.type === 'user/message')
          .flatMap(event => event.data.content.filter((part: { type: string }) => part.type === 'image'))
      }
      expect(imagesIn(srv.runtime.masterId)).toHaveLength(1)
      const worker = `worker-${posted.body.ticketId}`
      expect(imagesIn(worker)).toHaveLength(1)
      expect(codexTurnContent([{ id: 'worker', role: 'user', content: imagesIn(worker) }])).toContainEqual({ type: 'localImage', path: imagesIn(worker)[0].path })
      const follow = await api('POST', 'panel/messages', { conversation: 'pictures', text: '', replyTo: posted.body.messageId, content: [upload] })
      expect(follow.status).toBe(200)
      await srv.runtime.idle()
      expect(imagesIn(worker)).toHaveLength(2)
      const beforeConcurrent = imagesIn(srv.runtime.masterId).length
      await Promise.all([1, 2].map(() => srv.runtime.sessions.prompt(srv.runtime.masterId, 'concurrent-image-delivery', 'Inspect again', 'steer', undefined, undefined, trigger.meta.images as PanelImage[])))
      expect(imagesIn(srv.runtime.masterId)).toHaveLength(beforeConcurrent + 1)
      const history = await api('GET', 'panel/messages?conversation=pictures')
      expect(history.status).toBe(200)
      const first = history.body.messages.find((message: { id: string }) => message.id === posted.body.messageId)
      expect(first).toMatchObject({ text: '[image]', content: expect.arrayContaining([upload]) })
      const followMessage = history.body.messages.find((message: { id: string }) => message.id === follow.body.messageId)
      expect(followMessage.replyTo).toBe(posted.body.messageId)
      const incremental = await api('GET', `panel/messages?conversation=pictures&after=${history.body.next}`)
      expect(incremental.body).toMatchObject({ messages: [], next: history.body.next })
      const events = await api('GET', `sessions/${encodeURIComponent(worker)}/events?after=0`)
      expect(events.status).toBe(200)
      // Two 6 MiB rasters are 16 MiB of base64, above the old 14 MiB request cap.
      const padded = Buffer.alloc(6 * 1024 * 1024)
      Buffer.from(png, 'base64').copy(padded)
      const large = await api('POST', 'panel/messages', { conversation: 'large', text: 'large images', content: [{ ...upload, data: padded.toString('base64') }, { ...upload, data: padded.toString('base64') }] })
      expect(large.status, JSON.stringify(large.body)).toBe(200)
      const invalid = await api('POST', 'panel/messages', { conversation: 'invalid', content: [{ ...upload, data: 'bad' }] })
      expect(invalid.status).toBe(400)
      expect((await api('GET', 'panel/messages?conversation=invalid')).body.messages).toEqual([])
    } finally {
      await srv.stop()
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
