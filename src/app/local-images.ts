/** Translate the standalone host's local image parts into native provider image input. */
import { readFile } from 'node:fs/promises'
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { SessionTurnMessage } from './standalone-host.ts'

export function localMessageImages(messages: readonly SessionTurnMessage[]): { path: string; mediaType: ImageMediaType; name?: string }[] {
  return messages.flatMap(message => message.content.flatMap(part => part.type === 'image' && typeof part.path === 'string'
    ? [{ path: part.path, mediaType: part.mediaType as ImageMediaType, ...(typeof part.name === 'string' ? { name: part.name } : {}) }] : []))
}

export function messageText(messages: readonly SessionTurnMessage[]): string {
  const multiTurn = messages.length > 1
  return messages.map((message, idx) => {
    const body = message.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n')
    if (!body) return ''
    if (message.role === 'assistant') return `[Previous assistant turn]\n${body}`
    if (multiTurn && idx < messages.length - 1) return `[Previous user turn]\n${body}`
    if (multiTurn && idx === messages.length - 1) return `[Current user turn]\n${body}`
    return body
  }).filter(Boolean).join('\n\n')
}

/** The App Server consumes local images as image items, never as text paths or base64 prompt text. */
export function codexTurnContent(messages: readonly SessionTurnMessage[]) {
  return [
    { type: 'text', text: messageText(messages), text_elements: [] },
    ...localMessageImages(messages).map(image => ({ type: 'localImage', path: image.path })),
  ]
}

/** DSH's own attachment service verifies/normalizes bytes and owns provider request projection. */
export async function dshTurnContent(messages: readonly SessionTurnMessage[], attachments: { saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> } | undefined,
  signal: AbortSignal) {
  const content: ({ type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef })[] = [{ type: 'text', text: messageText(messages) }]
  const images = localMessageImages(messages)
  if (images.length && !attachments) throw new Error('Image input is unavailable: this DSH installation has no attachment service')
  for (const image of images) {
    const data = await readFile(image.path, { signal })
    const attachment = await attachments!.saveImage({ data, mediaType: image.mediaType, name: image.name })
    signal.throwIfAborted()
    content.push({ type: 'image', attachment })
  }
  return content
}
