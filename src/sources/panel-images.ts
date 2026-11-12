/** Panel image admission and immutable local storage. No uploaded bytes enter a Trigger or prompt. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { Trigger } from '../core/index.ts'

export const PANEL_IMAGE_LIMITS = { count: 8, imageBytes: 8 * 1024 * 1024, messageBytes: 12 * 1024 * 1024 } as const
// 12 MiB of binary becomes 16 MiB of base64; leave bounded room for text and JSON metadata.
export const PANEL_MESSAGE_BODY_BYTES = 17 * 1024 * 1024
export type PanelContentPart = { type: 'text'; text: string } | { type: 'image'; mediaType: ImageMediaType; data: string; name?: string }
export interface PanelImage {
  id: string
  path: string
  mediaType: ImageMediaType
  bytes: number
  name?: string
}
export type StoredPanelContent = { type: 'text'; text: string } | { type: 'image'; image: PanelImage }
const extensions: Record<ImageMediaType, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

/** Validate the wire shape, canonical base64, byte budgets, and declared raster format before writing anything. */
export function panelContent(body: Record<string, unknown>): { text: string; content: PanelContentPart[] } {
  if (body.content !== undefined && !Array.isArray(body.content)) throw new Error('Panel content must be an array')
  if (body.text !== undefined && typeof body.text !== 'string') throw new Error('Message text must be a string')
  const content: PanelContentPart[] = []
  const texts: string[] = []
  let count = 0, bytes = 0
  for (const part of (body.content ?? []) as unknown[]) {
    if (!part || typeof part !== 'object') throw new Error('Invalid panel content part')
    const value = part as Record<string, unknown>
    if (value.type === 'text' && typeof value.text === 'string') {
      const text = value.text.trim()
      if (text) { content.push({ type: 'text', text }); texts.push(text) }
      continue
    }
    if (value.type !== 'image' || typeof value.data !== 'string' || typeof value.mediaType !== 'string'
      || !Object.hasOwn(extensions, value.mediaType)) throw new Error('Panel images must be PNG, JPEG, WebP, or GIF')
    if (++count > PANEL_IMAGE_LIMITS.count) throw new Error('A panel message supports at most 8 images')
    const mediaType = value.mediaType as ImageMediaType
    const prefix = /^data:([^;,]+);base64,/.exec(value.data)
    if (prefix && prefix[1] !== mediaType) throw new Error('Panel image data URL media type does not match')
    const data = prefix ? value.data.slice(prefix[0].length) : value.data
    if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Panel image data is not valid base64')
    const size = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
    if (size <= 0 || size > PANEL_IMAGE_LIMITS.imageBytes) throw new Error('Each panel image must be between 1 byte and 8 MiB')
    bytes += size
    if (bytes > PANEL_IMAGE_LIMITS.messageBytes) throw new Error('Panel images exceed the 12 MiB message limit')
    const decoded = Buffer.from(data, 'base64')
    if (decoded.toString('base64') !== data) throw new Error('Panel image data is not canonical base64')
    verifyImageType(decoded, mediaType)
    const name = typeof value.name === 'string' ? value.name.replace(/[\\/\x00-\x1f\x7f]/g, '').trim().slice(0, 120) : undefined
    content.push({ type: 'image', mediaType, data, ...(name ? { name } : {}) })
  }
  const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim() : texts.join('\n')
  if (text && !texts.includes(text)) content.unshift({ type: 'text', text })
  if (!text && count) content.unshift({ type: 'text', text: '[image]' })
  if (!text && !count) throw new Error('Message text or image is required')
  return { text: text || (count ? '[image]' : ''), content }
}

function verifyImageType(data: Buffer, mediaType: ImageMediaType): void {
  const matches = mediaType === 'image/png' ? data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && data.toString('ascii', 12, 16) === 'IHDR' && data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0
    : mediaType === 'image/jpeg' ? data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    : mediaType === 'image/gif' ? data.length >= 13 && ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6)) && data.readUInt16LE(6) > 0 && data.readUInt16LE(8) > 0
    : data.length >= 20 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
  if (!matches) throw new Error('Panel image bytes do not match the declared media type')
}

export async function storePanelContent(stateDir: string, content: readonly PanelContentPart[]): Promise<StoredPanelContent[]> {
  const directory = resolve(stateDir, 'panel-images')
  if (content.some(part => part.type === 'image')) await mkdir(directory, { recursive: true, mode: 0o700 })
  const result: StoredPanelContent[] = []
  for (const part of content) {
    if (part.type === 'text') { result.push(part); continue }
    const data = Buffer.from(part.data, 'base64')
    const id = digest(data)
    const path = join(directory, `${id}${extensions[part.mediaType]}`)
    await writeFile(path, data, { flag: 'wx', mode: 0o600 }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
      if (digest(await readFile(path)) !== id) throw new Error('Stored panel image failed its integrity check')
    })
    result.push({ type: 'image', image: { id, path, mediaType: part.mediaType, bytes: data.length, ...(part.name ? { name: part.name } : {}) } })
  }
  return result
}

/** All filesystem reads are confined to our content-addressed image directory and verify the immutable bytes. */
export async function readPanelImage(image: PanelImage, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted()
  if (!/^[a-f0-9]{64}$/.test(image.id) || !Object.hasOwn(extensions, image.mediaType)
    || image.bytes < 1 || image.bytes > PANEL_IMAGE_LIMITS.imageBytes) throw new Error('Invalid panel image reference')
  const expected = `${image.id}${extensions[image.mediaType]}`
  const directory = dirname(image.path)
  if (join(directory, expected) !== image.path || !directory.endsWith(`${process.platform === 'win32' ? '\\' : '/'}panel-images`)) throw new Error('Invalid panel image path')
  if (dirname(await realpath(image.path)) !== await realpath(directory)) throw new Error('Panel image path escapes its storage directory')
  const data = await readFile(image.path, { signal })
  if (data.length !== image.bytes || digest(data) !== image.id) throw new Error('Stored panel image failed its integrity check')
  return data
}

export async function panelWireContent(content: readonly (StoredPanelContent | PanelContentPart)[]): Promise<PanelContentPart[]> {
  return Promise.all(content.map(async part => part.type === 'image' && 'image' in part
    ? { type: 'image' as const, mediaType: part.image.mediaType, data: (await readPanelImage(part.image)).toString('base64'), ...(part.image.name ? { name: part.image.name } : {}) }
    : part))
}

/** Only panel-produced compact references travel across the existing Trigger boundary. */
export function panelImages(triggers: readonly Trigger[]): PanelImage[] {
  const images = triggers.flatMap(trigger => trigger.source === 'panel' && Array.isArray(trigger.meta.images) ? trigger.meta.images as PanelImage[] : [])
  return [...new Map(images.map(image => [image.id, image])).values()]
}
