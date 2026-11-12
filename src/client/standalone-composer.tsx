/** Inline local conversation with topic sidebar, per-message ticket receipt cards, persistent drafts, and image input. */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button, Input, Modal, Switch, Tag } from './controls.tsx'
import { MarkdownText as MarkdownLite } from './markdown-view.tsx'
import {
  formatSmartTimestamp,
  standaloneFetch,
  type Lang,
  type PanelMessageReceipt,
  type PanelTopicSummary,
  type PendingUserQuestionInfo,
} from './standalone-api.ts'
import { PendingDecisionsPanel } from './ui-slots.tsx'
import {
  PANEL_IMAGE_MEDIA_TYPES,
  MAX_PANEL_IMAGES,
  MAX_PANEL_IMAGE_BYTES,
  MAX_PANEL_MESSAGE_IMAGE_BYTES,
  isPanelImageMediaType,
  type PanelImageMediaType,
} from './image-composer.tsx'
import {
  readPanelDraft,
  writePanelDraft,
  readPanelPreferences,
  writePanelPreferences,
  readPanelDraftImages,
  writePanelDraftImages,
  type PanelDraft,
  type PanelImageDraft,
  type PanelPreferences,
} from './panel-draft.ts'

export type PanelImage = { type: 'image'; mediaType: PanelImageMediaType; data: string; name: string }
type PanelText = { type: 'text'; text: string }
type PanelContentPart = PanelText | PanelImage
interface PanelMessage { id: string; sender: string; bot?: boolean; text: string; at: string; content?: PanelContentPart[] }
const supported = PANEL_IMAGE_MEDIA_TYPES
const imageSource = (image: PanelImage) => isPanelImageMediaType(image.mediaType) ? `data:${image.mediaType};base64,${image.data}` : undefined

function readImage(file: File): Promise<PanelImageDraft> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Cannot read ${file.name}`))
    reader.onload = () => {
      const encoded = String(reader.result).split(',')[1]
      if (!encoded) { reject(new Error(`Cannot read ${file.name}`)); return }
      resolve({ type: 'image', mediaType: file.type as PanelImageMediaType, data: encoded, name: file.name || 'image.png', size: file.size })
    }
    reader.readAsDataURL(file)
  })
}

function MessageReceiptCard({
  receipt,
  lang,
  inspectedSessionId,
  onInspectSession,
  onAnswered,
}: {
  receipt: PanelMessageReceipt
  lang: Lang
  inspectedSessionId?: string | undefined
  onInspectSession?: ((sessionId: string, ticketId?: string) => void) | undefined
  onAnswered?: (() => void) | undefined
}) {
  const [answerDraft, setAnswerDraft] = useState('')
  const [sendingAnswer, setSendingAnswer] = useState(false)
  const shortId = receipt.ticketId ? `#${receipt.ticketId.slice(0, 6)}` : ''
  const isSelected = !!receipt.sessionId && inspectedSessionId === receipt.sessionId
  const kindBadge = receipt.kind === 'created'
    ? { tone: 'success' as const, text: lang === 'zh' ? `新建工单 ${shortId}` : `New Ticket ${shortId}` }
    : receipt.kind === 'followup'
      ? { tone: 'info' as const, text: lang === 'zh' ? `并入工单 ${shortId}` : `Follow-up ${shortId}` }
      : receipt.kind === 'evaluating'
        ? { tone: 'info' as const, text: lang === 'zh' ? '正在评估' : 'Evaluating' }
        : receipt.kind === 'queued'
          ? { tone: 'neutral' as const, text: lang === 'zh' ? '排队待评估' : 'Queued' }
          : { tone: 'warning' as const, text: lang === 'zh' ? '来源已过滤' : 'Filtered' }

  const stateLabel = receipt.attentionQuestion
    ? (lang === 'zh' ? '⚠️ 待人工拍板' : '⚠️ Awaiting Decision')
    : receipt.ticketState === 'running'
      ? (lang === 'zh' ? '正在执行' : 'Running')
      : receipt.ticketState === 'completed'
        ? (lang === 'zh' ? '已完成并合入 main' : 'Completed & merged')
        : receipt.ticketState === 'waiting'
          ? (lang === 'zh' ? '等待输入' : 'Waiting')
          : receipt.ticketState === 'stopped'
            ? (lang === 'zh' ? '已停止' : 'Stopped')
            : receipt.ticketState === 'failed'
              ? (lang === 'zh' ? '执行失败' : 'Failed')
              : ''

  const submitInlineAnswer = async () => {
    const val = answerDraft.trim()
    if (!val || !receipt.ticketId || sendingAnswer) return
    setSendingAnswer(true)
    try {
      await standaloneFetch('questions/answer', 'POST', {
        role: 'worker',
        ticketId: receipt.ticketId,
        answer: val,
      })
      setAnswerDraft('')
      onAnswered?.()
    } catch {} finally {
      setSendingAnswer(false)
    }
  }

  return <div className="dt-msg-receipt" data-active={isSelected}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      <div className="dt-live-head">
        <div className="dt-msg-receipt-main">
          <Tag tone={kindBadge.tone}>{kindBadge.text}</Tag>
          {receipt.ticketTitle && <strong className="dt-msg-receipt-title">{receipt.ticketTitle}</strong>}
          {stateLabel && <span className="dt-msg-receipt-state">· {stateLabel}</span>}
          {receipt.kind === 'followup' && receipt.acked && <span className="dt-msg-receipt-ack">
            · {lang === 'zh' ? '执行器已确认接手' : 'Acknowledged by Executor'}
          </span>}
          {receipt.nodeName && <span className="dt-mono dt-msg-receipt-branch">🖥 {receipt.nodeName}</span>}
          {receipt.branch && <span className="dt-mono dt-msg-receipt-branch">{receipt.branch}</span>}
        </div>
        {receipt.sessionId && onInspectSession && <button
          type="button"
          className="dt-receipt-inspect-btn"
          onClick={() => onInspectSession(receipt.sessionId!, receipt.ticketId)}
        >
          {isSelected
            ? (lang === 'zh' ? '正在右侧检视' : 'Inspecting')
            : (lang === 'zh' ? '在右侧检视执行流' : 'Inspect execution')}
        </button>}
      </div>

      {receipt.attentionQuestion && receipt.ticketId && (
        <div className="dt-banner" style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid={`receipt-attention-${receipt.ticketId}`}>
          <div className="dt-msg-receipt-main">
            <Tag tone="warning">{lang === 'zh' ? '⚠️ 执行器请求您拍板 (Attention)' : '⚠️ Attention Required'}</Tag>
          </div>
          <MarkdownLite text={receipt.attentionQuestion} />
          <div className="dt-topic-switch">
            <Input
              value={answerDraft}
              disabled={sendingAnswer}
              onChange={e => setAnswerDraft(e.target.value)}
              placeholder={lang === 'zh' ? '直接在此输入您的决定（按 Enter 发送并唤醒此工单继续执行）…' : 'Enter your decision to resume this ticket…'}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && answerDraft.trim()) {
                  e.preventDefault()
                  void submitInlineAnswer()
                }
              }}
            />
            <Button
              size="sm"
              variant="primary"
              disabled={sendingAnswer || !answerDraft.trim()}
              onClick={() => { void submitInlineAnswer() }}
            >
              {lang === 'zh' ? '发送决定' : 'Send'}
            </Button>
          </div>
        </div>
      )}
    </div>
  </div>
}

/** The settings stay mounted while each topic owns its own composer, draft, and message polling. */
export function PanelConversation({
  lang,
  active = true,
  visible = true,
  pendingQuestions,
  onQuestionsUpdated,
  inspectedSessionId,
  onInspectSession,
}: {
  lang: Lang
  active?: boolean
  visible?: boolean
  pendingQuestions?: PendingUserQuestionInfo[] | undefined
  onQuestionsUpdated?: ((next: PendingUserQuestionInfo[]) => void) | undefined
  inspectedSessionId?: string | undefined
  onInspectSession?: ((sessionId: string, ticketId?: string) => void) | undefined
}) {
  const [preferences, setPreferences] = useState(readPanelPreferences)
  const preferencesRef = useRef(preferences)
  const [conversationInput, setConversationInput] = useState(preferences.conversation)
  const [preferenceError, setPreferenceError] = useState(() => 'restoreFailed' in preferences && !!preferences.restoreFailed)
  const [busy, setBusy] = useState(false)
  const [topics, setTopics] = useState<PanelTopicSummary[]>([])
  const [hasCurrentDraft, setHasCurrentDraft] = useState(false)

  const updatePreferences = (change: Partial<PanelPreferences>) => {
    const next = { ...preferencesRef.current, ...change }
    preferencesRef.current = next
    setPreferences(next)
    setPreferenceError(!writePanelPreferences(next))
  }
  const selectConversation = (value: string) => {
    const next = value.trim() || 'main'
    setConversationInput(next)
    updatePreferences({ conversation: next })
  }
  const conversation = preferences.conversation.trim() || 'main'
  const mergedTopics: PanelTopicSummary[] = topics.some(t => t.conversation === conversation)
    ? topics
    : [
        {
          conversation,
          title: conversation === 'main' ? (lang === 'zh' ? '主工作台对话' : 'Main workspace') : conversation,
          messageCount: 0,
          ticketCount: 0,
          status: 'idle',
          updatedAt: '',
        },
        ...topics,
      ]

  return <section id="local-chat" className="dt-panel-conversation" aria-labelledby="local-chat-title" hidden={!visible} style={!visible ? { display: 'none' } : undefined}>
    <div className="dt-chat-top">
      <div className="dt-live-head">
        <div className="dt-chat-head-title">
          <h2 id="local-chat-title">{lang === 'zh' ? '工程对话' : 'Local chat'}</h2>
          <span className="dt-chip-topic dt-mono">#{conversation}</span>
        </div>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => selectConversation(`topic-${Date.now().toString(36)}`)}>
          {lang === 'zh' ? '+ 新建话题' : '+ New topic'}
        </Button>
      </div>
    </div>

    {pendingQuestions && pendingQuestions.length > 0 && (
      <PendingDecisionsPanel
        questions={pendingQuestions}
        lang={lang}
        onAnswered={onQuestionsUpdated}
        onInspectTicket={tid => onInspectSession?.(`worker-${tid}`, tid)}
      />
    )}

    <details className="dt-conversation-settings">
      <summary>{lang === 'zh' ? '对话设置' : 'Conversation settings'} · {conversation}</summary>
      <div className="dt-grid3">
        <div className="dt-field">
          <label className="dt-field-head" htmlFor="local-chat-topic">{lang === 'zh' ? '对话线程 ID' : 'Conversation ID'}</label>
          <div className="dt-topic-switch">
            <Input
              id="local-chat-topic"
              value={conversationInput}
              disabled={busy}
              onChange={event => setConversationInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  selectConversation(conversationInput)
                }
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy || (conversationInput.trim() || 'main') === conversation}
              onClick={() => selectConversation(conversationInput)}
            >
              {lang === 'zh' ? '切换' : 'Switch'}
            </Button>
          </div>
        </div>
        <label className="dt-field">
          <span className="dt-field-head">{lang === 'zh' ? '发送者 ID' : 'Sender ID'}</span>
          <Input value={preferences.sender} disabled={busy} onChange={event => updatePreferences({ sender: event.target.value })} />
        </label>
        <div className="dt-field">
          <span className="dt-field-head">{lang === 'zh' ? '跳过评估直接建单' : 'Bypass Eval (direct Ticket)'}</span>
          <Switch
            checked={preferences.autoAccept}
            disabled={busy}
            onChange={autoAccept => updatePreferences({ autoAccept })}
            label={lang === 'zh' ? '跳过评估直接建单（关闭时由 Eval 模型判断接单或续接）' : 'Bypass Eval (when off, Eval model decides)'}
          />
        </div>
      </div>
    </details>

    {preferenceError && <p className="dt-error" role="status">{lang === 'zh' ? '浏览器未能恢复或保存对话设置，重开后可能无法恢复当前话题。' : 'Conversation settings could not be restored or saved. This topic may not reopen automatically.'}</p>}

    <div className="dt-workbench-chat-grid">
      <aside className="dt-topic-sidebar" aria-label={lang === 'zh' ? '话题与工单列表' : 'Topics and tickets'}>
        <div className="dt-topic-sidebar-head">
          <span>{lang === 'zh' ? '话题列表' : 'Topics'}</span>
          <span className="dt-mono">{mergedTopics.length}</span>
        </div>
        <div className="dt-topic-list">
          {mergedTopics.map(item => {
            const isCurrent = item.conversation === conversation
            const showDraftBadge = isCurrent && hasCurrentDraft
            return <button
              key={item.conversation}
              type="button"
              className="dt-topic-card"
              aria-current={isCurrent ? 'true' : undefined}
              disabled={busy}
              onClick={() => selectConversation(item.conversation)}
            >
              <div className="dt-topic-card-top">
                <span className="dt-topic-card-title">{item.title}</span>
                {showDraftBadge ? (
                  <Tag tone="warning">{lang === 'zh' ? '有草稿' : 'Draft'}</Tag>
                ) : item.status === 'running' ? (
                  <Tag tone="info">{lang === 'zh' ? '执行中' : 'Running'}</Tag>
                ) : item.status === 'completed' ? (
                  <Tag tone="success">{lang === 'zh' ? '已合入' : 'Merged'}</Tag>
                ) : null}
              </div>
              <div className="dt-topic-card-meta">
                <span className="dt-mono">#{item.conversation}</span>
                {item.ticketCount > 0 && <span>· {lang === 'zh' ? `${item.ticketCount} 个工单` : `${item.ticketCount} tickets`}</span>}
              </div>
            </button>
          })}
        </div>
      </aside>

      <div className="dt-chat-stage">
        <ConversationForm
          key={conversation}
          conversation={conversation}
          sender={preferences.sender}
          autoAccept={preferences.autoAccept}
          active={active}
          visible={visible}
          lang={lang}
          onBusy={setBusy}
          onTopics={setTopics}
          onDraftPresence={setHasCurrentDraft}
          inspectedSessionId={inspectedSessionId}
          onInspectSession={onInspectSession}
        />
      </div>
    </div>
  </section>
}

function ConversationForm({
  conversation,
  sender,
  autoAccept,
  active,
  visible,
  lang,
  onBusy,
  onTopics,
  onDraftPresence,
  inspectedSessionId,
  onInspectSession,
}: {
  conversation: string
  sender: string
  autoAccept: boolean
  active: boolean
  visible: boolean
  lang: Lang
  onBusy: (busy: boolean) => void
  onTopics: (topics: PanelTopicSummary[]) => void
  onDraftPresence: (hasDraft: boolean) => void
  inspectedSessionId?: string | undefined
  onInspectSession?: ((sessionId: string, ticketId?: string) => void) | undefined
}) {
  const [draft, setDraft] = useState(() => readPanelDraft(conversation))
  const draftRef = useRef(draft)
  const [textSaveError, setTextSaveError] = useState(() => 'restoreFailed' in draft && !!draft.restoreFailed)
  const [images, setImages] = useState<PanelImageDraft[]>([])
  const imagesRef = useRef(images)
  const [imageState, setImageState] = useState<'loading' | 'saving' | 'saved' | 'error'>('loading')
  const imageRevision = useRef(0)
  const mounted = useRef(true)
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [messages, setMessages] = useState<PanelMessage[]>([])
  const [receipts, setReceipts] = useState<Record<string, PanelMessageReceipt>>({})
  const [loaded, setLoaded] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [follow, setFollow] = useState(true)
  const [fullscreenMsgId, setFullscreenMsgId] = useState<string | null>(null)
  const history = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const adding = useRef(false)
  const sending = useRef(false)
  const { text, replyTo } = draft

  useEffect(() => {
    onDraftPresence(Boolean(text.trim() || images.length))
  }, [text, images.length, onDraftPresence])

  const updateDraft = (change: Partial<PanelDraft>) => {
    const next = { ...draftRef.current, ...change }
    draftRef.current = next
    setDraft(next)
    // Write in the input handler: an immediate refresh must not outrun an effect or debounce.
    setTextSaveError(!writePanelDraft(conversation, next))
  }
  const updateImages = async (next: PanelImageDraft[]) => {
    imagesRef.current = next
    setImages(next)
    const revision = ++imageRevision.current
    setImageState('saving')
    try {
      await writePanelDraftImages(conversation, next)
      if (mounted.current && revision === imageRevision.current) setImageState('saved')
    } catch {
      if (mounted.current && revision === imageRevision.current) setImageState('error')
    }
  }
  useEffect(() => {
    mounted.current = true
    let cancelled = false
    void readPanelDraftImages(conversation).then(saved => {
      if (cancelled) return
      imagesRef.current = saved
      setImages(saved)
      setImageState('saved')
    }, () => { if (!cancelled) setImageState('error') })
    return () => { cancelled = true; mounted.current = false }
  }, [conversation])
  useEffect(() => { onBusy(busy || reading); return () => onBusy(false) }, [busy, reading, onBusy])
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let cursor: number | undefined
    const poll = async () => {
      try {
        const previous = cursor
        const result = await standaloneFetch<{
          messages: PanelMessage[]
          next?: number
          receipts?: Record<string, PanelMessageReceipt>
          topics?: PanelTopicSummary[]
        }>(`panel/messages?conversation=${encodeURIComponent(conversation)}${cursor === undefined ? '' : `&after=${cursor}`}`, 'GET', undefined, controller.signal)
        if (controller.signal.aborted) return
        if (previous !== undefined && result.next !== undefined && result.next < previous) { cursor = undefined; return }
        cursor = result.next
        setMessages(current => previous === undefined ? result.messages : [...current, ...result.messages])
        if (result.receipts) setReceipts(result.receipts)
        if (result.topics) onTopics(result.topics)
        setLoaded(true)
        setError('')
      } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)) }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => { void poll() }, 2000) }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [active, conversation, refresh, onTopics])
  useEffect(() => {
    if (visible) setFollow(true)
  }, [visible, conversation])
  const latestPanelKey = `${messages.length}:${messages.at(-1)?.id ?? ''}:${messages.at(-1)?.text.length ?? 0}`
  useEffect(() => {
    if (!follow || !history.current) return
    history.current.scrollTop = history.current.scrollHeight
    const raf = requestAnimationFrame(() => {
      if (history.current) history.current.scrollTop = history.current.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [visible, latestPanelKey, follow])
  const addImages = async (files: File[]) => {
    if (adding.current || sending.current || imageState === 'loading' || !files.length) return
    adding.current = true
    setReading(true)
    setStatus('')
    try {
      if (files.some(file => !isPanelImageMediaType(file.type))) throw new Error(lang === 'zh' ? '请选择 PNG、JPEG、WebP 或 GIF 图片。' : 'Choose PNG, JPEG, WebP, or GIF images.')
      if (imagesRef.current.length + files.length > MAX_PANEL_IMAGES) throw new Error(lang === 'zh' ? `每条消息最多 ${MAX_PANEL_IMAGES} 张图片。` : `Up to ${MAX_PANEL_IMAGES} images per message.`)
      if (files.some(file => file.size <= 0 || file.size > MAX_PANEL_IMAGE_BYTES)) throw new Error(lang === 'zh' ? '单张图片大小需在 1 字节到 8 MiB 之间。' : 'Each image must be between 1 byte and 8 MiB.')
      const existingBytes = imagesRef.current.reduce((sum, image) => sum + image.size, 0)
      if (existingBytes + files.reduce((sum, file) => sum + file.size, 0) > MAX_PANEL_MESSAGE_IMAGE_BYTES) throw new Error(lang === 'zh' ? '每条消息的图片总大小不能超过 12 MiB。' : 'Images must total at most 12 MiB per message.')
      const added = await Promise.all(files.map(readImage))
      if (mounted.current) await updateImages([...imagesRef.current, ...added])
    } catch (err) { if (mounted.current) setStatus(err instanceof Error ? err.message : String(err)) }
    finally { if (mounted.current) setReading(false); adding.current = false }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if ((!text.trim() && !images.length) || sending.current || reading || imageState === 'loading') return
    sending.current = true
    setBusy(true)
    setStatus('')
    try {
      const textValue = text.trim()
      const content: PanelContentPart[] = [
        ...(textValue ? [{ type: 'text' as const, text: textValue }] : []),
        ...images.map(({ size: _size, ...image }) => image),
      ]
      const res = await standaloneFetch<{ ticketId?: string }>('panel/messages', 'POST', {
        conversation, sender: sender.trim() || 'operator', text: textValue,
        content, addressed: 'direct', autoAccept, ...(replyTo ? { replyTo } : {}),
      })
      if (res.ticketId && onInspectSession) {
        onInspectSession(`worker-${res.ticketId}`, res.ticketId)
      }
      if (!mounted.current) {
        writePanelDraft(conversation, { text: '', replyTo: '' })
        await writePanelDraftImages(conversation, [])
        return
      }
      updateDraft({ text: '', replyTo: '' })
      await updateImages([])
      if (!mounted.current) return
      setFollow(true)
      setRefresh(value => value + 1)
      setStatus(lang === 'zh' ? '已发送。下方回执卡与右侧面板会实时同步执行进展。' : 'Sent. Receipt card and right-hand inspector will update live.')
    } catch (err) { if (mounted.current) setStatus(err instanceof Error ? err.message : String(err)) }
    finally { sending.current = false; if (mounted.current) setBusy(false) }
  }
  const locked = busy || reading || imageState === 'loading'
  return <form className="dt-form" onSubmit={event => { void submit(event) }}>
    {error && <p className="dt-error" role="status">{error}</p>}
    {replyTo && <div className="dt-row-buttons"><span className="dt-hint">{lang === 'zh' ? '回复：' : 'Replying to: '}{messages.find(message => message.id === replyTo)?.text.slice(0, 60) || replyTo}</span>
      <Button size="sm" disabled={busy} onClick={() => updateDraft({ replyTo: '' })}>{lang === 'zh' ? '取消回复' : 'Cancel reply'}</Button></div>}
    <div className="dt-image-drop" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
      onDrop={event => { event.preventDefault(); void addImages(Array.from(event.dataTransfer.files)) }}>
      <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '消息内容' : 'Message'}</span>
        <textarea ref={textarea} className="dt-textarea" rows={3} value={text} disabled={busy} onChange={event => updateDraft({ text: event.target.value })}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
              event.preventDefault(); void submit(event)
            }
          }}
          onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length) { if (!event.clipboardData.getData('text/plain')) event.preventDefault(); void addImages(files) } }}
          placeholder={lang === 'zh' ? '输入消息，也可粘贴截图或拖入图片…' : 'Write a message, paste a screenshot, or drop images…'} /></label>
      <div className="dt-image-previews">{images.map((image, index) => <figure key={index}><img src={imageSource(image)} alt={image.name} />
        <figcaption>{image.name}</figcaption><Button size="sm" disabled={locked} aria-label={`${lang === 'zh' ? '移除' : 'Remove'} ${image.name}`}
          onClick={() => { void updateImages(imagesRef.current.filter((_, i) => i !== index)) }}>{lang === 'zh' ? '移除' : 'Remove'}</Button></figure>)}</div>
      <input ref={fileInput} type="file" accept={supported.join(',')} multiple hidden aria-label={lang === 'zh' ? '添加图片' : 'Add images'}
        onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void addImages(files) }} />
      <div className="dt-composer-actions">
        <div className="dt-row-buttons"><Button variant="outline" size="sm" disabled={locked} onClick={() => fileInput.current?.click()}>
          {lang === 'zh' ? (reading ? '读取图片…' : '添加图片') : (reading ? 'Reading images…' : 'Add images')}</Button>
          <span className="dt-hint">{lang === 'zh' ? '最多 8 张 · 单张 8 MiB · 合计 12 MiB' : 'Up to 8 images · 8 MiB each · 12 MiB total'}</span></div>
        <div className="dt-row-buttons"><span className="dt-hint">{lang === 'zh' ? 'Ctrl / ⌘ + Enter 发送' : 'Ctrl / ⌘ + Enter to send'}</span>
          <Button type="submit" variant="primary" disabled={locked || (!text.trim() && !images.length)}>
            {lang === 'zh' ? (busy ? '发送中…' : '发送消息') : (busy ? 'Sending…' : 'Send message')}</Button></div>
      </div>
    </div>
    <p className={textSaveError || imageState === 'error' ? 'dt-error' : 'dt-hint'} role="status">
      {textSaveError ? (lang === 'zh' ? '文字草稿读取或保存失败，刷新前请复制消息内容。' : 'Text draft could not be restored or saved. Copy it before refreshing.')
        : imageState === 'error' ? (lang === 'zh' ? '文字已自动保存；图片草稿无法访问，刷新前请保留原图。' : 'Text is saved; image draft storage is unavailable. Keep the originals before refreshing.')
          : imageState === 'loading' ? (lang === 'zh' ? '正在恢复图片草稿…' : 'Restoring image draft…')
            : imageState === 'saving' ? (lang === 'zh' ? '文字已保存，正在保存图片…' : 'Text saved. Saving images…')
              : (lang === 'zh' ? '草稿自动保存 · 刷新或重开后恢复 · 发送成功后清空' : 'Drafts save automatically, survive refresh and reopening, and clear after a successful send.')}
    </p>
    {status && <p className="dt-hint" role="status">{status}</p>}
    <div className="dt-activity-toolbar">
      <span className="dt-hint">
        {lang === 'zh' ? `共 ${messages.length} 条对话记录（默认定位到最新消息）` : `${messages.length} messages (auto-following latest)`}
      </span>
      <Button size="sm" variant="ghost" aria-pressed={follow} onClick={() => setFollow(value => !value)}>
        {lang === 'zh' ? (follow ? '自动跟随：开' : '自动跟随：关') : (follow ? 'Follow: on' : 'Follow: off')}
      </Button>
    </div>
    <div className="dt-panel-history" ref={history} tabIndex={0} aria-label={lang === 'zh' ? '面板对话记录' : 'Panel conversation history'}
      onScroll={() => { const node = history.current; if (node) setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 60) }}>
      {!messages.length && <p className="dt-hint">{!loaded ? (lang === 'zh' ? '正在加载对话…' : 'Loading conversation…')
        : (lang === 'zh' ? '发送文字或图片开始对话。' : 'Send text or images to start a conversation.')}</p>}
      {messages.map(message => {
        const receipt = !message.bot ? receipts[message.id] : undefined
        return <article className="dt-panel-message" data-bot={!!message.bot} key={message.id}>
          <div className="dt-session-reply-head">
            <strong>{message.bot ? (lang === 'zh' ? '助手' : 'Assistant') : message.sender}</strong>
            <div className="dt-msg-head-actions">
              <time dateTime={message.at}>{formatSmartTimestamp(message.at, lang)}</time>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setFullscreenMsgId(message.id)}
                data-testid={`panel-fullscreen-${message.id}`}
              >
                {lang === 'zh' ? '放大查看' : 'Expand'}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { updateDraft({ replyTo: message.id }); textarea.current?.focus() }}>
                {lang === 'zh' ? '回复此消息' : 'Reply'}
              </Button>
            </div>
          </div>
          <MarkdownLite text={message.text} />
          <div className="dt-image-previews">{message.content?.filter(part => part.type === 'image').map((image, index) => <a key={index}
            href={imageSource(image)} download={image.name || 'image'} title={lang === 'zh' ? '下载原图' : 'Download original'}>
            <img src={imageSource(image)} alt={image.name || (lang === 'zh' ? '图片' : 'Image')} loading="lazy" /></a>)}</div>
          {receipt && <MessageReceiptCard
            receipt={receipt}
            lang={lang}
            inspectedSessionId={inspectedSessionId}
            onInspectSession={onInspectSession}
            onAnswered={() => setRefresh(v => v + 1)}
          />}
        </article>
      })}
    </div>
    {!follow && <Button size="sm" variant="ghost" onClick={() => setFollow(true)}>{lang === 'zh' ? '回到最新消息' : 'Jump to latest'}</Button>}

    {(() => {
      const fullMsg = fullscreenMsgId ? messages.find(m => m.id === fullscreenMsgId) : undefined
      const fullReceipt = fullMsg && !fullMsg.bot ? receipts[fullMsg.id] : undefined
      return (
        <Modal
          className="dt-fullscreen-modal"
          open={Boolean(fullMsg)}
          onClose={() => setFullscreenMsgId(null)}
          title={
            fullMsg
              ? `${fullMsg.bot ? (lang === 'zh' ? '助手回复' : 'Assistant Reply') : fullMsg.sender} · ${formatSmartTimestamp(fullMsg.at, lang)}`
              : ''
          }
          closeLabel={lang === 'zh' ? '关闭 (ESC)' : 'Close (ESC)'}
          description={lang === 'zh' ? `话题 #${conversation} · 点击左右暗色背景、按 ESC 或点击关闭按钮即可退出` : `Topic #${conversation} · Click backdrop or press ESC to close`}
          footer={
            <div className="dt-row-buttons">
              {fullMsg && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    updateDraft({ replyTo: fullMsg.id })
                    setFullscreenMsgId(null)
                    textarea.current?.focus()
                  }}
                >
                  {lang === 'zh' ? '回复此消息' : 'Reply'}
                </Button>
              )}
              <Button size="sm" variant="primary" onClick={() => setFullscreenMsgId(null)}>
                {lang === 'zh' ? '关闭 (ESC)' : 'Close (ESC)'}
              </Button>
            </div>
          }
        >
          {fullMsg && (
            <div className="dt-form">
              {fullReceipt && (
                <MessageReceiptCard
                  receipt={fullReceipt}
                  lang={lang}
                  inspectedSessionId={inspectedSessionId}
                  onInspectSession={(sid, tid) => {
                    setFullscreenMsgId(null)
                    onInspectSession?.(sid, tid)
                  }}
                />
              )}
              <div className="dt-panel-message" data-bot={!!fullMsg.bot}>
                <MarkdownLite text={fullMsg.text} />
                <div className="dt-image-previews">
                  {fullMsg.content?.filter(part => part.type === 'image').map((image, index) => (
                    <a key={index} href={imageSource(image)} download={image.name || 'image'} title={lang === 'zh' ? '下载原图' : 'Download original'}>
                      <img src={imageSource(image)} alt={image.name || (lang === 'zh' ? '图片' : 'Image')} style={{ maxHeight: '70vh', height: 'auto' }} />
                    </a>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Modal>
      )
    })()}
  </form>
}

/** Kept for hosts that explicitly need a dialog; the standalone workspace uses the inline conversation. */
export function PanelComposerModal({ open, lang, onClose }: { open: boolean; lang: Lang; onClose: () => void }) {
  return <Modal className="dt-conversation-modal" open={open} onClose={onClose}
    title={lang === 'zh' ? '本地面板对话' : 'Local panel conversation'} closeLabel={lang === 'zh' ? '关闭' : 'Close'}>
    <PanelConversation lang={lang} active={open} />
  </Modal>
}
