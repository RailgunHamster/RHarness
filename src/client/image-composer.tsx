import { useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from 'react'
import { Button, Icon, Input, Modal, Switch } from './controls.tsx'

export const PANEL_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type PanelImageMediaType = typeof PANEL_IMAGE_MEDIA_TYPES[number]
export const MAX_PANEL_IMAGES = 8
export const MAX_PANEL_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_PANEL_MESSAGE_IMAGE_BYTES = 12 * 1024 * 1024

type PanelTextPart = { type: 'text'; text: string }
export type PanelImagePart = { type: 'image'; mediaType: PanelImageMediaType; data: string; name?: string }
export type PanelContentPart = PanelTextPart | PanelImagePart
export interface PanelMessagePayload {
  conversation: string
  sender: string
  text: string
  content: PanelContentPart[]
  addressed: 'direct'
  autoAccept: boolean
}
export interface PanelMessageResponse {
  id: string
  threadKey: string
  result: string
  ticketId?: string
}
export interface PanelComposerModalProps {
  open: boolean
  lang: 'zh' | 'en'
  onClose: () => void
  sendMessage: (payload: PanelMessagePayload) => Promise<PanelMessageResponse>
}

export function isPanelImageMediaType(value: string): value is PanelImageMediaType {
  return (PANEL_IMAGE_MEDIA_TYPES as readonly string[]).includes(value)
}

export function panelImageValidationError(file: Pick<File, 'name' | 'size' | 'type'>, imageCount = 0, imageBytes = 0): string | undefined {
  if (!isPanelImageMediaType(file.type)) return 'unsupported image type'
  if (file.size <= 0 || file.size > MAX_PANEL_IMAGE_BYTES) return 'image is larger than 8 MiB or empty'
  if (imageCount >= MAX_PANEL_IMAGES) return 'up to 8 images are allowed'
  if (imageBytes + file.size > MAX_PANEL_MESSAGE_IMAGE_BYTES) return 'images exceed the 12 MiB total limit'
  return undefined
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Could not read the image'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image'))
    reader.readAsDataURL(file)
  })
}

interface ImageDraft extends PanelImagePart {
  id: string
  preview: string
  size: number
}

function imagePart(image: ImageDraft): PanelImagePart {
  return { type: 'image', mediaType: image.mediaType, data: image.data, ...(image.name ? { name: image.name } : {}) }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`
}

function imageFiles(event: ClipboardEvent): File[] {
  const files = [...event.clipboardData.files].filter(file => file.type.startsWith('image/'))
  if (files.length) return files
  return [...event.clipboardData.items]
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter((file): file is File => !!file)
}

export function PanelComposerModal({ open, lang, onClose, sendMessage }: PanelComposerModalProps) {
  const [conversation, setConversation] = useState('main')
  const [sender, setSender] = useState('operator')
  const [text, setText] = useState('')
  const [autoAccept, setAutoAccept] = useState(true)
  const [images, setImages] = useState<ImageDraft[]>([])
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [status, setStatus] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const imageBytes = images.reduce((total, image) => total + image.size, 0)
  const disabled = busy || reading
  const canSubmit = !disabled && (!!text.trim() || images.length > 0)

  const addFiles = async (files: readonly File[]) => {
    if (disabled || !files.length) return
    setReading(true)
    setStatus('')
    const accepted: ImageDraft[] = []
    const errors: string[] = []
    let count = images.length
    let bytes = imageBytes
    for (const file of files) {
      const error = panelImageValidationError(file, count, bytes)
      if (error) {
        errors.push(`${file.name || 'image'}: ${error}`)
        continue
      }
      try {
        const preview = await readDataUrl(file)
        const comma = preview.indexOf(',')
        if (comma < 0) throw new Error('Invalid image data')
        accepted.push({
          id: `${file.name}-${file.lastModified}-${accepted.length}`,
          preview,
          mediaType: file.type as PanelImageMediaType,
          data: preview.slice(comma + 1),
          name: file.name || undefined,
          size: file.size,
          type: 'image',
        })
        count += 1
        bytes += file.size
      } catch (error) {
        errors.push(`${file.name || 'image'}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (accepted.length) setImages(previous => [...previous, ...accepted])
    if (errors.length) setStatus(errors.join('; '))
    setReading(false)
  }

  const onFileChange = (event: { currentTarget: HTMLInputElement }) => {
    const files = event.currentTarget.files ? [...event.currentTarget.files] : []
    event.currentTarget.value = ''
    void addFiles(files)
  }

  const onPaste = (event: ClipboardEvent) => {
    const files = imageFiles(event)
    if (!files.length) return
    event.preventDefault()
    void addFiles(files)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    void addFiles([...event.dataTransfer.files])
  }

  const removeImage = (id: string) => {
    if (disabled) return
    setImages(previous => previous.filter(image => image.id !== id))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setStatus('')
    const trimmedText = text.trim()
    const content: PanelContentPart[] = [
      ...(trimmedText ? [{ type: 'text' as const, text: trimmedText }] : []),
      ...images.map(imagePart),
    ]
    try {
      const result = await sendMessage({
        conversation: conversation.trim() || 'main',
        sender: sender.trim() || 'operator',
        text: trimmedText,
        content,
        addressed: 'direct',
        autoAccept,
      })
      setText('')
      setImages([])
      setStatus(lang === 'zh'
        ? `已发送触发 ${result.id.slice(0, 12)}（状态：${result.result}，线程：${result.threadKey}${result.ticketId ? `，已建工单：${result.ticketId.slice(0, 8)}` : ''}）`
        : `Sent Trigger ${result.id.slice(0, 12)} (${result.result} on ${result.threadKey}${result.ticketId ? `, Ticket: ${result.ticketId.slice(0, 8)}` : ''})`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      className="dt-glossary-modal"
      open={open}
      onClose={() => { if (!busy) onClose() }}
      title={lang === 'zh' ? '本地面板消息 (Panel Source)' : 'Local Panel Message (Panel Source)'}
      closeLabel={lang === 'zh' ? '关闭' : 'Close'}
      description={lang === 'zh'
        ? '直接向 dsh-superagent 发起请求或在已有线程追加跟进。'
        : 'Send a direct request or follow-up message through the built-in Local Panel Source.'}
      footer={<Button variant="outline" disabled={busy} onClick={onClose}>{lang === 'zh' ? '关闭' : 'Close'}</Button>}
    >
      <form className="dt-form" onSubmit={event => { void submit(event) }} onPaste={onPaste}>
        <div className="dt-grid3">
          <div className="dt-field">
            <label className="dt-field-head">{lang === 'zh' ? '对话线程 ID' : 'Conversation Thread ID'}</label>
            <Input value={conversation} onChange={event => setConversation(event.target.value)} placeholder="main" disabled={disabled} />
          </div>
          <div className="dt-field">
            <label className="dt-field-head">{lang === 'zh' ? '发送者 ID' : 'Sender ID'}</label>
            <Input value={sender} onChange={event => setSender(event.target.value)} placeholder="operator" disabled={disabled} />
          </div>
          <div className="dt-field">
            <span className="dt-field-head">{lang === 'zh' ? '自动接单建工单' : 'Auto-accept as Ticket'}</span>
            <Switch checked={autoAccept} onChange={setAutoAccept} label={lang === 'zh' ? '自动接单建工单' : 'Auto-accept as Ticket'} />
          </div>
        </div>
        <div className="dt-field">
          <label className="dt-field-head" htmlFor="panel-message-text">{lang === 'zh' ? '消息内容' : 'Message'}</label>
          <textarea id="panel-message-text" className="dt-textarea" rows={4} value={text} disabled={disabled}
            onChange={event => setText(event.target.value)}
            placeholder={lang === 'zh' ? '输入工作请求或对工单的回复，也可以仅发送图片…' : 'Describe the work request or follow-up, or send images only…'} />
        </div>
        <div className={`dt-image-drop${dragActive ? ' dt-image-drop-active' : ''}`} role="region"
          aria-label={lang === 'zh' ? '图片附件' : 'Image attachments'}
          aria-disabled={disabled}
          onDragEnter={event => { event.preventDefault(); if (!disabled) setDragActive(true) }}
          onDragOver={event => { event.preventDefault(); if (!disabled) setDragActive(true) }}
          onDragLeave={event => { event.preventDefault(); setDragActive(false) }}
          onDrop={onDrop}>
          <div className="dt-image-drop-copy">
            <strong>{lang === 'zh' ? '添加图片' : 'Add images'}</strong>
            <span>{lang === 'zh' ? '选择、粘贴或拖拽 PNG/JPEG/WebP/GIF（最多 8 张，总计 12 MiB）' : 'Choose, paste, or drop PNG/JPEG/WebP/GIF (up to 8 images, 12 MiB total)'}</span>
          </div>
          <input ref={fileInput} className="dt-image-input" type="file" accept={PANEL_IMAGE_MEDIA_TYPES.join(',')} multiple
            disabled={disabled} aria-label={lang === 'zh' ? '选择图片文件' : 'Choose image files'} onChange={onFileChange} />
          <Button type="button" variant="outline" icon={<Icon name="plus" />} disabled={disabled}
            onClick={() => fileInput.current?.click()}>{lang === 'zh' ? '选择文件' : 'Choose files'}</Button>
        </div>
        {images.length > 0 && (
          <div className="dt-image-previews" aria-label={lang === 'zh' ? '图片预览' : 'Image previews'}>
            {images.map(image => (
              <figure className="dt-image-preview" key={image.id}>
                <img src={image.preview} alt={image.name ?? 'image'} />
                <figcaption title={image.name}>{image.name} · {formatBytes(image.size)}</figcaption>
                <Button type="button" variant="ghost" size="sm" icon={<Icon name="close" />} aria-label={lang === 'zh' ? `移除 ${image.name}` : `Remove ${image.name}`}
                  disabled={disabled} onClick={() => removeImage(image.id)} />
              </figure>
            ))}
            <p className="dt-image-count">{images.length}/{MAX_PANEL_IMAGES} · {formatBytes(imageBytes)}/{formatBytes(MAX_PANEL_MESSAGE_IMAGE_BYTES)}</p>
          </div>
        )}
        {status && <p className="dt-hint" role="status" aria-live="polite">{status}</p>}
        <div className="dt-row-buttons">
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            {busy ? (lang === 'zh' ? '正在发送…' : 'Sending…') : (lang === 'zh' ? '发送消息' : 'Send message')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
