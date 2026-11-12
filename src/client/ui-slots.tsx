import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Input, Modal, StateDot, Tag } from './controls.tsx'
import {
  MAX_PANEL_IMAGES,
  MAX_PANEL_IMAGE_BYTES,
  MAX_PANEL_MESSAGE_IMAGE_BYTES,
  PANEL_IMAGE_MEDIA_TYPES,
  isPanelImageMediaType,
  type PanelImageMediaType,
} from './image-composer.tsx'
import { MarkdownText as MarkdownLite } from './markdown-view.tsx'
import {
  formatSmartTimestamp,
  standaloneFetch,
  type AssistantChatBackupInfo,
  type AssistantContextConfigInfo,
  type AssistantMessageInfo,
  type ClawFeedItemInfo,
  type Lang,
  type LiveSessionRunInfo,
  type MemoryEntryInfo,
  type PendingUserQuestionInfo,
  type PluginDescriptorInfo,
  type SessionProgressCardInfo,
} from './standalone-api.ts'

export type MainViewSlotId = 'workbench' | 'assistant' | 'clawfeed' | 'rhtoolkit' | 'memory' | 'pipeline' | 'management'

export interface UIViewSlotPlugin {
  id: MainViewSlotId
  pluginId?: string
  order: number
  label: (
    lang: Lang,
    counts: {
      assistantCount: number
      clawfeedCount: number
      memoryCount: number
      enabledPlugins: number
      totalPlugins: number
      pipelineCount: number
    },
  ) => string
}

/**
 * First-class UI Slot Registry (`ctx.slots` pattern for the Web Panel).
 * Each top-level window is registered as a modular slot plugin and dynamically hidden if its backing plugin is disabled.
 */
export const BUILTIN_UI_VIEW_SLOTS: UIViewSlotPlugin[] = [
  {
    id: 'assistant',
    pluginId: 'dsh-claw-assistant',
    order: 10,
    label: (lang, c) =>
      lang === 'zh'
        ? `个人助理 (${c.assistantCount})`
        : `Personal Assistant (${c.assistantCount})`,
  },
  {
    id: 'workbench',
    pluginId: 'ui-workbench',
    order: 20,
    label: lang => (lang === 'zh' ? '工程对话' : 'Engineering Chat'),
  },
  {
    id: 'clawfeed',
    pluginId: 'dsh-clawfeed',
    order: 25,
    label: (lang, c) =>
      lang === 'zh'
        ? `📱 手机通知 (${c.clawfeedCount})`
        : `📱 Notifications (${c.clawfeedCount})`,
  },
  {
    id: 'rhtoolkit',
    pluginId: 'dsh-rhtoolkit',
    order: 28,
    label: lang => (lang === 'zh' ? '🧰 云端工具箱' : '🧰 Cloud Toolkit'),
  },
  {
    id: 'memory',
    order: 30,
    label: (lang, c) =>
      lang === 'zh'
        ? `记忆与插件 (${c.memoryCount} · ${c.enabledPlugins}/${c.totalPlugins})`
        : `Memory & Plugins (${c.memoryCount} · ${c.enabledPlugins}/${c.totalPlugins})`,
  },
  {
    id: 'pipeline',
    pluginId: 'ui-pipeline',
    order: 40,
    label: (lang, c) =>
      lang === 'zh'
        ? `管线追踪 (${c.pipelineCount})`
        : `Pipeline (${c.pipelineCount})`,
  },
  {
    id: 'management',
    pluginId: 'ui-management',
    order: 50,
    label: lang => (lang === 'zh' ? '系统管理' : 'Management'),
  },
]

export function getEnabledUIViewSlots(plugins: PluginDescriptorInfo[]): UIViewSlotPlugin[] {
  const disabledSet = new Set(plugins.filter(p => !p.enabled).map(p => p.id))
  const registeredIds = new Set(plugins.map(p => p.id))
  const privatePackSlotIds = new Set(['dsh-rhtoolkit', 'dsh-clawfeed'])
  return BUILTIN_UI_VIEW_SLOTS
    .filter(slot => {
      if (!slot.pluginId) return true
      if (disabledSet.has(slot.pluginId)) return false
      if (privatePackSlotIds.has(slot.pluginId) && plugins.length > 0 && !registeredIds.has(slot.pluginId)) {
        return false
      }
      return true
    })
    .sort((a, b) => a.order - b.order)
}

interface AssistantImageDraft {
  type: 'image'
  mediaType: PanelImageMediaType
  data: string
  name: string
  size: number
}

function readAssistantImageFile(file: File): Promise<AssistantImageDraft> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Cannot read ${file.name}`))
    reader.onload = () => {
      const encoded = String(reader.result).split(',')[1]
      if (!encoded) {
        reject(new Error(`Cannot read ${file.name}`))
        return
      }
      resolve({
        type: 'image',
        mediaType: file.type as PanelImageMediaType,
        data: encoded,
        name: file.name || 'image.png',
        size: file.size,
      })
    }
    reader.readAsDataURL(file)
  })
}

export function PendingDecisionsPanel({
  questions,
  lang,
  onAnswered,
  onInspectTicket,
}: {
  questions: readonly PendingUserQuestionInfo[]
  lang: Lang
  onAnswered?: ((next: PendingUserQuestionInfo[]) => void) | undefined
  onInspectTicket?: ((ticketId: string) => void) | undefined
}): ReactNode {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [submittingId, setSubmittingId] = useState<string | null>(null)
  const [err, setErr] = useState('')

  if (!questions.length) return null

  const submitAnswer = async (q: PendingUserQuestionInfo, explicitText?: string) => {
    const answerText = (explicitText ?? drafts[q.id] ?? '').trim()
    if (!answerText || submittingId) return
    setSubmittingId(q.id)
    setErr('')
    try {
      const res = await standaloneFetch<{
        answered: boolean
        pendingQuestions: PendingUserQuestionInfo[]
      }>('questions/answer', 'POST', {
        id: q.id,
        role: q.role,
        ...(q.ticketId ? { ticketId: q.ticketId } : {}),
        ...(q.conversation ? { conversation: q.conversation } : {}),
        answer: answerText,
      })
      setDrafts(curr => {
        const next = { ...curr }
        delete next[q.id]
        return next
      })
      onAnswered?.(res.pendingQuestions)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmittingId(null)
    }
  }

  return (
    <div className="dt-pipeline-list" data-testid="pending-decisions-panel">
      {err && <p className="dt-error" role="status">{err}</p>}
      {questions.map(q => {
        const roleLabel =
          q.role === 'claw'
            ? (lang === 'zh' ? '🤖 个人助理 (Claw) 征求意见' : '🤖 Personal Assistant (Claw)')
            : q.role === 'eval'
              ? (lang === 'zh' ? '⚖️ 工程主控 (Eval) 征求意见' : '⚖️ Engineering Eval')
              : (lang === 'zh' ? '🛠 工单执行器 (Worker) 待您拍板' : '🛠 Worker Attention')
        const val = drafts[q.id] ?? ''
        const isBusy = submittingId === q.id
        return (
          <div
            key={q.id}
            className="dt-banner"
            style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 16px' }}
            data-testid={`pending-question-${q.id}`}
          >
            <div className="dt-live-head">
              <div className="dt-msg-receipt-main">
                <Tag tone="warning">{roleLabel}</Tag>
                <strong>{q.title}</strong>
                <span className="dt-mono dt-hint">{formatSmartTimestamp(q.createdAt, lang)}</span>
              </div>
              {q.ticketId && onInspectTicket && (
                <button
                  type="button"
                  className="dt-receipt-inspect-btn"
                  onClick={() => onInspectTicket(q.ticketId!)}
                >
                  {lang === 'zh' ? '检视工单执行流 →' : 'Inspect Ticket →'}
                </button>
              )}
            </div>

            <div className="dt-panel-message" data-bot="true">
              <MarkdownLite text={q.question} />
              {q.context && (
                <div className="dt-hint" style={{ marginTop: 4 }}>
                  <MarkdownLite text={q.context} />
                </div>
              )}
            </div>

            {q.options && q.options.length > 0 && (
              <div className="dt-row-buttons">
                <span className="dt-hint">{lang === 'zh' ? '快捷拍板选项（点击直接提交或填入）：' : 'Quick options:'}</span>
                {q.options.map((opt, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className={val === opt ? 'dt-pill dt-pill-active' : 'dt-pill'}
                    disabled={isBusy}
                    onClick={() => { void submitAnswer(q, opt) }}
                    data-testid={`question-opt-${q.id}-${idx}`}
                  >
                    ✓ {opt}
                  </button>
                ))}
              </div>
            )}

            <div className="dt-topic-switch">
              <Input
                value={val}
                disabled={isBusy}
                onChange={e => setDrafts(curr => ({ ...curr, [q.id]: e.target.value }))}
                placeholder={
                  lang === 'zh'
                    ? '输入您的决定或补充指示（按 Enter 直接发送并唤醒智能体继续执行）…'
                    : 'Type your decision or instructions (press Enter to send and resume agent)…'
                }
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && val.trim()) {
                    e.preventDefault()
                    void submitAnswer(q)
                  }
                }}
                data-testid={`question-input-${q.id}`}
              />
              <Button
                size="sm"
                variant="primary"
                disabled={isBusy || !val.trim()}
                onClick={() => { void submitAnswer(q) }}
                data-testid={`question-submit-${q.id}`}
              >
                {isBusy
                  ? (lang === 'zh' ? '发送中…' : 'Sending…')
                  : (lang === 'zh' ? '发送决定并继续' : 'Send & Continue')}
              </Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Reusable inline ephemeral live chat bubble displayed directly inside the conversation stream
 * for `Personal Assistant (Claw)`, `Engineering Eval`, and `Worker` while a turn is in progress.
 * Automatically disappears as soon as the final durable reply settles into the message list.
 */
export function InlineLiveAgentBubble({
  run,
  fallbackRole = 'assistant',
  fallbackModel,
  startedAtFallback,
  lang,
  testId,
  bubbleStyle = false,
}: {
  run?: LiveSessionRunInfo | null | undefined
  fallbackRole?: 'assistant' | 'eval' | 'worker'
  fallbackModel?: { provider: string; model: string; reasoningEffort?: string } | null | undefined
  startedAtFallback?: number | undefined
  lang: Lang
  testId?: string | undefined
  bubbleStyle?: boolean | undefined
}) {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 300)
    return () => clearInterval(timer)
  }, [])

  const role = run?.role ?? fallbackRole
  const model = run?.model ?? fallbackModel
  const parsedStart = run?.startedAt ? Date.parse(run.startedAt) : NaN
  const baseStart = Number.isFinite(parsedStart) ? parsedStart : (startedAtFallback ?? nowMs)
  const elapsedSec = Math.max(0, (nowMs - baseStart) / 1000).toFixed(1)

  const authorTitle =
    role === 'eval'
      ? (lang === 'zh' ? '⚖️ Eval 主控评估' : '⚖️ Eval')
      : role === 'worker'
        ? (lang === 'zh'
            ? `🛠️ Worker ${run?.ticketId ? `#${run.ticketId.slice(0, 6)}` : ''}${run?.ticketTitle ? ` · ${run.ticketTitle}` : ''}`
            : `🛠️ Worker ${run?.ticketId ? `#${run.ticketId.slice(0, 6)}` : ''}`)
        : (lang === 'zh' ? '个人助理' : 'Assistant')

  const phaseText = run
    ? run.phaseLabel[lang]
    : role === 'eval'
      ? (lang === 'zh' ? '⚖️ Eval 正在评估请求与准入规则…' : '⚖️ Eval is assessing request…')
      : role === 'worker'
        ? (lang === 'zh' ? '🛠️ Worker 正在准备并执行工单…' : '🛠️ Worker is executing ticket…')
        : (lang === 'zh' ? '⏳ 正在思考…' : '⏳ Thinking…')

  return (
    <article
      className={bubbleStyle ? 'dt-panel-message dt-chat-bubble dt-live-ephemeral-bubble' : 'dt-panel-message dt-live-ephemeral-bubble'}
      data-bot="true"
      data-sender={bubbleStyle ? 'bot' : undefined}
      data-testid={testId}
      aria-live="polite"
    >
      <div className="dt-session-reply-head">
        <div className="dt-msg-receipt-main">
          <strong>{authorTitle}</strong>
          {model && (
            <Tag tone="info">
              {model.provider} / {model.model}
              {model.reasoningEffort ? ` · ${model.reasoningEffort}` : ''}
            </Tag>
          )}
          {run && run.stepCount > 1 && (
            <Tag tone="neutral">
              {lang === 'zh' ? `第 ${run.stepCount} 步` : `Step ${run.stepCount}`}
            </Tag>
          )}
        </div>
        <div className="dt-msg-head-actions">
          <span className="dt-mono dt-hint">{elapsedSec}s</span>
        </div>
      </div>

      <div className="dt-live-status-bar">
        <StateDot state="ongoing" />
        <span>{phaseText}</span>
      </div>

      {run?.streamingText && <MarkdownLite text={run.streamingText} />}
    </article>
  )
}

export function PersonalAssistantSlotView(props: {
  lang: Lang
  messages: AssistantMessageInfo[]
  liveRun?: LiveSessionRunInfo | null | undefined
  chatBackups?: AssistantChatBackupInfo[] | undefined
  memories: MemoryEntryInfo[]
  pendingQuestions?: PendingUserQuestionInfo[] | undefined
  progressCard?: SessionProgressCardInfo | undefined
  contextConfig?: AssistantContextConfigInfo | undefined
  activeAssistantModel?: { provider: string; model: string; reasoningEffort?: string } | null | undefined
  matchedAssistantSlot?: { label: string; startTime: string; endTime: string } | undefined
  onRefresh: () => Promise<void>
  onQuestionsUpdated?: ((next: PendingUserQuestionInfo[]) => void) | undefined
  onChatBackupsUpdated?: ((next: AssistantChatBackupInfo[]) => void) | undefined
  onMemoriesUpdated?: ((next: MemoryEntryInfo[]) => void) | undefined
  onContextConfigUpdated?: ((next: AssistantContextConfigInfo) => void) | undefined
  onJumpToEngineeringTicket: (ticketId?: string) => void
  onSwitchToMemoryTab: () => void
  onOpenAssistantSession?: (() => void) | undefined
}): ReactNode {
  const {
    lang,
    messages,
    liveRun,
    chatBackups = [],
    memories,
    pendingQuestions = [],
    progressCard,
    contextConfig,
    activeAssistantModel,
    matchedAssistantSlot,
    onRefresh,
    onQuestionsUpdated,
    onChatBackupsUpdated,
    onContextConfigUpdated,
    onJumpToEngineeringTicket,
    onSwitchToMemoryTab,
    onOpenAssistantSession,
  } = props
  const [draft, setDraft] = useState('')
  const [handoffAnswerDrafts, setHandoffAnswerDrafts] = useState<Record<string, string>>({})
  const [images, setImages] = useState<AssistantImageDraft[]>([])
  const [readingImages, setReadingImages] = useState(false)
  const [busy, setBusy] = useState(false)
  const [clearChatConfirm, setClearChatConfirm] = useState(false)
  const [forwardingId, setForwardingId] = useState<string | null>(null)
  const [fullscreenMsgId, setFullscreenMsgId] = useState<string | null>(null)
  const [chatFullscreen, setChatFullscreen] = useState(false)
  const [follow, setFollow] = useState(true)
  const [expandedDetailIds, setExpandedDetailIds] = useState<Record<string, boolean>>({})
  const [refusalInputFor, setRefusalInputFor] = useState<string | null>(null)
  const [refusalReasonDraft, setRefusalReasonDraft] = useState('该内容属于日常问答或备忘，无需创建代码工单。')
  const [ephemeralBtwCard, setEphemeralBtwCard] = useState<{ question: string; answer: string; at: string } | null>(null)
  const [optimisticUserMsg, setOptimisticUserMsg] = useState<AssistantMessageInfo | null>(null)
  const [pendingTurnSinceMs, setPendingTurnSinceMs] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  const composerInputRef = useRef<HTMLTextAreaElement>(null)

  // Clear optimistic user bubble and pending turn tracker once the server message / bot reply arrives
  useEffect(() => {
    if (optimisticUserMsg) {
      const matchedInServer = messages.some(
        m => !m.bot && (m.id === optimisticUserMsg.id || (m.text === optimisticUserMsg.text && Date.parse(m.at) >= Date.parse(optimisticUserMsg.at) - 5000)),
      )
      if (matchedInServer) setOptimisticUserMsg(null)
    }
    if (pendingTurnSinceMs !== null) {
      const botArrived = messages.some(m => m.bot && Date.parse(m.at) >= pendingTurnSinceMs - 1000)
      if (botArrived) {
        setPendingTurnSinceMs(null)
      }
    }
  }, [messages, optimisticUserMsg, pendingTurnSinceMs])

  // Fast poll while waiting for turn startup before `liveRun` is observed on parent state
  useEffect(() => {
    if (pendingTurnSinceMs === null) return
    const timer = setInterval(() => {
      void onRefresh()
    }, 550)
    const safety = setTimeout(() => {
      setPendingTurnSinceMs(curr => (curr === pendingTurnSinceMs ? null : curr))
    }, 90_000)
    return () => {
      clearInterval(timer)
      clearTimeout(safety)
    }
  }, [pendingTurnSinceMs, onRefresh])

  useEffect(() => {
    if (!chatFullscreen) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) {
        e.preventDefault()
        setChatFullscreen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [chatFullscreen])

  const showAssistantLiveBubble = Boolean(liveRun || pendingTurnSinceMs !== null)
  const latestMsgKey = `${messages.length}:${messages.at(-1)?.id ?? ''}:${messages.at(-1)?.text.length ?? 0}:${showAssistantLiveBubble}:${liveRun?.phaseLabel.zh ?? ''}:${liveRun?.streamingText?.length ?? 0}`
  useEffect(() => {
    if (!follow || !historyRef.current) return
    const el = historyRef.current
    el.scrollTop = el.scrollHeight
    const raf = requestAnimationFrame(() => {
      if (historyRef.current) historyRef.current.scrollTop = historyRef.current.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [follow, latestMsgKey, chatFullscreen])

  const toggleDetail = (msgId: string) => {
    setExpandedDetailIds(curr => ({ ...curr, [msgId]: !curr[msgId] }))
  }

  const startNewContextWindow = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await standaloneFetch<{ contextConfig: AssistantContextConfigInfo }>('assistant/context', 'POST', {
        action: 'reset-window',
      })
      onContextConfigUpdated?.(res.contextConfig)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const clearAssistantChatHistory = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await standaloneFetch<{
        messages: AssistantMessageInfo[]
        chatBackups?: AssistantChatBackupInfo[]
        contextConfig: AssistantContextConfigInfo
      }>('assistant/clear', 'POST', {})
      onContextConfigUpdated?.(res.contextConfig)
      if (res.chatBackups) onChatBackupsUpdated?.(res.chatBackups)
      setClearChatConfirm(false)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const deleteSingleMessage = async (msgId: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await standaloneFetch<{
        deleted: boolean
        messages: AssistantMessageInfo[]
        chatBackups?: AssistantChatBackupInfo[]
      }>(`assistant/messages/${encodeURIComponent(msgId)}`, 'DELETE')
      if (res.chatBackups) onChatBackupsUpdated?.(res.chatBackups)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const restoreChatBackup = async (backupId: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await standaloneFetch<{
        restoredCount: number
        messages: AssistantMessageInfo[]
        chatBackups: AssistantChatBackupInfo[]
      }>(`assistant/backups/${encodeURIComponent(backupId)}/restore`, 'POST', {})
      onChatBackupsUpdated?.(res.chatBackups)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const addImages = async (files: File[]) => {
    if (!files.length) return
    setError(null)
    if (images.length + files.length > MAX_PANEL_IMAGES) {
      setError(lang === 'zh' ? '单条消息最多添加 8 张图片' : 'Attach at most 8 images per message')
      return
    }
    for (const file of files) {
      if (!isPanelImageMediaType(file.type)) {
        setError(lang === 'zh' ? '仅支持 PNG、JPEG、WebP 或 GIF 图片' : 'Images must be PNG, JPEG, WebP, or GIF')
        return
      }
      if (file.size <= 0 || file.size > MAX_PANEL_IMAGE_BYTES) {
        setError(lang === 'zh' ? '单张图片不能超过 8 MiB' : 'Each image must be at most 8 MiB')
        return
      }
    }
    const totalBytes = images.reduce((s, img) => s + img.size, 0) + files.reduce((s, f) => s + f.size, 0)
    if (totalBytes > MAX_PANEL_MESSAGE_IMAGE_BYTES) {
      setError(lang === 'zh' ? '图片总大小不能超过 12 MiB' : 'Images exceed the 12 MiB message limit')
      return
    }
    setReadingImages(true)
    try {
      const loaded = await Promise.all(files.map(readAssistantImageFile))
      setImages(curr => [...curr, ...loaded])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setReadingImages(false)
    }
  }

  const submitMessage = async (event?: FormEvent) => {
    event?.preventDefault()
    const text = draft.trim()
    if ((!text && !images.length) || busy || readingImages) return
    const isBtw = /^\/btw(?:\s+|$)/i.test(text)
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const content = [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...images.map(({ type, mediaType, data, name }) => ({ type, mediaType, data, name })),
    ]
    const prevDraft = draft
    const prevImages = images

    // 0ms optimistic UI: clear composer & show user bubble + live thinking indicator immediately
    setDraft('')
    setImages([])
    setFollow(true)
    if (!isBtw) {
      setOptimisticUserMsg({
        id: `optimistic-${nowMs}`,
        sender: 'operator',
        text,
        content,
        at: nowIso,
      })
    }
    setPendingTurnSinceMs(nowMs)
    setBusy(true)
    setError(null)
    try {
      const res = await standaloneFetch<{
        message?: AssistantMessageInfo
        ephemeralBtw?: boolean
        question?: string
        answer?: string
        at?: string
      }>('assistant/messages', 'POST', {
        text,
        content,
      })
      if (res.message?.id && !isBtw) {
        setOptimisticUserMsg(curr => (curr ? { ...curr, id: res.message!.id } : null))
      }
      if (res.ephemeralBtw && res.answer) {
        setPendingTurnSinceMs(null)
        setEphemeralBtwCard({
          question: res.question ?? text,
          answer: res.answer,
          at: res.at ?? new Date().toISOString(),
        })
      } else {
        await onRefresh()
      }
    } catch (err) {
      setOptimisticUserMsg(null)
      setPendingTurnSinceMs(null)
      setDraft(prevDraft)
      setImages(prevImages)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const forwardMessageToEngineering = async (msg: AssistantMessageInfo) => {
    if (forwardingId) return
    setForwardingId(msg.id)
    setError(null)
    try {
      await standaloneFetch('assistant/forward', 'POST', {
        originalMessageId: msg.id,
        originalText: msg.text,
      })
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setForwardingId(null)
    }
  }

  const runEvalDecision = async (triggerId: string, decision: 'accept' | 'ignore', title?: string, reason?: string) => {
    setBusy(true)
    setError(null)
    try {
      await standaloneFetch('assistant/eval-decision', 'POST', {
        triggerId,
        decision,
        ...(title ? { title } : {}),
        ...(reason ? { reason } : {}),
      })
      setRefusalInputFor(null)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const submitHandoffTicketAnswer = async (ticketId: string) => {
    const answerText = (handoffAnswerDrafts[ticketId] ?? '').trim()
    if (!answerText || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await standaloneFetch<{
        answered: boolean
        pendingQuestions: PendingUserQuestionInfo[]
      }>('questions/answer', 'POST', {
        role: 'worker',
        ticketId,
        answer: answerText,
      })
      setHandoffAnswerDrafts(curr => {
        const next = { ...curr }
        delete next[ticketId]
        return next
      })
      onQuestionsUpdated?.(res.pendingQuestions)
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const pinnedMemories = memories.filter(m => m.pinned)
  const locked = busy || readingImages
  const displayMessages =
    optimisticUserMsg && !messages.some(m => m.id === optimisticUserMsg.id)
      ? [...messages, optimisticUserMsg]
      : messages

  return (
    <div className="dt-form" data-testid="personal-assistant-view">
      <section
        className="dt-pipeline-card dt-assistant-shell"
        data-fullscreen={chatFullscreen ? 'true' : undefined}
        aria-label={lang === 'zh' ? '个人助理' : 'Personal Assistant'}
      >
        <div className="dt-live-head dt-assistant-header">
          <div className="dt-msg-receipt-main">
            <h2>{lang === 'zh' ? '个人助理' : 'Personal Assistant'}</h2>
            <span className="dt-chip-topic dt-mono">Claw</span>
            {activeAssistantModel && (
              <Tag tone="info">
                {activeAssistantModel.provider} / {activeAssistantModel.model}
                {activeAssistantModel.reasoningEffort ? ` · ${activeAssistantModel.reasoningEffort}` : ''}
              </Tag>
            )}
            {matchedAssistantSlot && (
              <Tag tone="success">
                {matchedAssistantSlot.label} ({matchedAssistantSlot.startTime}→{matchedAssistantSlot.endTime})
              </Tag>
            )}
          </div>
          <div className="dt-row-buttons">
            <Button
              size="sm"
              variant={chatFullscreen ? 'primary' : 'outline'}
              onClick={() => setChatFullscreen(v => !v)}
              data-testid="assistant-chat-fullscreen-btn"
              title={
                lang === 'zh'
                  ? (chatFullscreen ? '退出沉浸式全屏聊天 (按 ESC 亦可退出)' : '将个人助理放大为全屏聊天窗口')
                  : (chatFullscreen ? 'Exit full-screen chat (or press ESC)' : 'Expand Personal Assistant to full-screen chat')
              }
            >
              {lang === 'zh'
                ? (chatFullscreen ? '↙ 退出全屏 (ESC)' : '⛶ 全屏对话')
                : (chatFullscreen ? '↙ Exit Fullscreen' : '⛶ Fullscreen Chat')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => { void startNewContextWindow() }}
              title={lang === 'zh' ? '从当前位置切分新窗口：之前的聊天自动归入无损 DAG 摘要树 (lcm_grep / lcm_expand)，新对话零历史包袱' : 'Start a fresh context window; earlier messages stay searchable via Lossless DAG (lcm_grep / lcm_expand)'}
            >
              {lang === 'zh' ? '+ 开启新窗口' : '+ New Window'}
            </Button>
            {!clearChatConfirm ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || messages.length === 0}
                onClick={() => setClearChatConfirm(true)}
                title={lang === 'zh' ? '清空个人助理对话记录（移入30天保护备份箱，随时可恢复）' : 'Clear assistant chat history (moved to 30-day protected backup)'}
                data-testid="assistant-clear-chat-btn"
              >
                {lang === 'zh' ? '清空对话记录' : 'Clear Chat History'}
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => { void clearAssistantChatHistory() }}
                  data-testid="assistant-clear-chat-confirm-btn"
                >
                  {lang === 'zh'
                    ? `⚠️ 确认清空 (${messages.length} 条移入30天备份)`
                    : `Confirm Clear (${messages.length} to 30d backup)`}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setClearChatConfirm(false)}>
                  {lang === 'zh' ? '取消' : 'Cancel'}
                </Button>
              </>
            )}
            {onOpenAssistantSession && (
              <Button size="sm" variant="ghost" onClick={onOpenAssistantSession}>
                {lang === 'zh' ? '调试控制台' : 'Console'}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => { setChatFullscreen(false); onSwitchToMemoryTab() }}>
              {lang === 'zh' ? `记忆与插件 (${memories.length} 条 · ${pinnedMemories.length} 常驻)` : `Memory & Plugins (${memories.length})`}
            </Button>
          </div>
        </div>

        {error && <p className="dt-error" role="status">{error}</p>}

        {/* Prominent Pending Decisions Banner (Claw / Eval / Worker questions) */}
        <PendingDecisionsPanel
          questions={pendingQuestions}
          lang={lang}
          onAnswered={next => {
            onQuestionsUpdated?.(next)
            void onRefresh()
          }}
          onInspectTicket={tid => onJumpToEngineeringTicket(tid)}
        />

        {/* Durable In-Place Session Progress Card (`@rharness/plugin-progress-card`) */}
        {progressCard && (
          <div className="dt-form dt-block" data-testid="assistant-progress-card">
            <div className="dt-live-head">
              <div className="dt-msg-receipt-main">
                <Tag tone="info">📊 {lang === 'zh' ? '原地任务进度卡' : 'Progress Card'}</Tag>
                <strong>{progressCard.title}</strong>
                <span className="dt-mono dt-hint">
                  {progressCard.completedCount}/{progressCard.totalCount} ({progressCard.percent}%)
                </span>
              </div>
              <span className="dt-mono dt-hint">{formatSmartTimestamp(progressCard.updatedAt, lang)}</span>
            </div>
            {progressCard.markdown && <div className="dt-hint">{progressCard.markdown}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {progressCard.steps.map((st, idx) => (
                <div key={idx} className="dt-msg-receipt-main">
                  <span>
                    {st.status === 'completed' ? '✅' : st.status === 'in_progress' ? '⏳' : '⬜'} {st.step}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Ephemeral `/btw` Side Question Result Card (never saved to chat history) */}
        {ephemeralBtwCard && (
          <div className="dt-form dt-block" data-testid="ephemeral-btw-card">
            <div className="dt-live-head">
              <div className="dt-msg-receipt-main">
                <Tag tone="warning">💡 {lang === 'zh' ? '/btw 旁路快问 · 不计入正式上下文历史' : '/btw Ephemeral Side Answer'}</Tag>
                <strong>{ephemeralBtwCard.question}</strong>
                <span className="dt-mono dt-hint">{formatSmartTimestamp(ephemeralBtwCard.at, lang)}</span>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setEphemeralBtwCard(null)}>
                {lang === 'zh' ? '收起关闭' : 'Dismiss'}
              </Button>
            </div>
            <div className="dt-panel-message" data-bot="true">
              <MarkdownLite text={ephemeralBtwCard.answer} />
            </div>
          </div>
        )}

        {/* Message & Image Composer (docked at the bottom in Chat App style via `.dt-assistant-composer`) */}
        <form className="dt-form dt-assistant-composer" onSubmit={event => { void submitMessage(event) }}>
          <div
            className="dt-image-drop"
            onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
            onDrop={event => { event.preventDefault(); void addImages(Array.from(event.dataTransfer.files)) }}
          >
            <label className="dt-field">
              <span className="dt-field-head">{lang === 'zh' ? '消息内容' : 'Message'}</span>
              <textarea
                ref={composerInputRef}
                className="dt-textarea"
                rows={chatFullscreen ? 2 : 3}
                value={draft}
                disabled={busy}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    void submitMessage()
                  }
                }}
                onPaste={event => {
                  const files = Array.from(event.clipboardData.files)
                  if (files.length) {
                    if (!event.clipboardData.getData('text/plain')) event.preventDefault()
                    void addImages(files)
                  }
                }}
                placeholder={
                  lang === 'zh'
                    ? '输入消息、粘贴截图或拖入图片…（若助理判断属于工程需求，将在总结后连同您的原话与原图一并递交工程对话）'
                    : 'Write a message, paste a screenshot, or drop images…'
                }
              />
            </label>
            <div className="dt-image-previews">
              {images.map((img, idx) => (
                <figure key={idx}>
                  <img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name} />
                  <figcaption>{img.name}</figcaption>
                  <Button
                    size="sm"
                    disabled={locked}
                    onClick={() => setImages(curr => curr.filter((_, i) => i !== idx))}
                  >
                    {lang === 'zh' ? '移除' : 'Remove'}
                  </Button>
                </figure>
              ))}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept={PANEL_IMAGE_MEDIA_TYPES.join(',')}
              multiple
              hidden
              onChange={event => {
                const files = Array.from(event.target.files ?? [])
                event.target.value = ''
                void addImages(files)
              }}
            />
            <div className="dt-composer-actions">
              <div className="dt-row-buttons">
                <Button variant="outline" size="sm" disabled={locked} onClick={() => fileInputRef.current?.click()}>
                  {lang === 'zh' ? (readingImages ? '读取图片…' : '添加图片') : (readingImages ? 'Reading…' : 'Add images')}
                </Button>
                <span className="dt-hint">
                  {lang === 'zh' ? '支持粘贴截图 / 拖拽图片 · 最多 8 张' : 'Paste or drop up to 8 images'}
                </span>
              </div>
              <div className="dt-row-buttons">
                <span className="dt-hint">{lang === 'zh' ? 'Ctrl / ⌘ + Enter 发送' : 'Ctrl / ⌘ + Enter to send'}</span>
                <Button type="submit" variant="primary" disabled={locked || (!draft.trim() && !images.length)}>
                  {lang === 'zh' ? (busy ? '发送中…' : '发送消息') : (busy ? 'Sending…' : 'Send message')}
                </Button>
              </div>
            </div>
          </div>
        </form>

        {/* Assistant Conversation Stream */}
        <div className="dt-activity-toolbar dt-assistant-toolbar">
          <span className="dt-hint">
            {lang === 'zh' ? `共 ${messages.length} 条对话记录（默认定位到最新消息）` : `${messages.length} messages (auto-following latest)`}
          </span>
          <div className="dt-row-buttons">
            {!follow && (
              <Button size="sm" variant="outline" onClick={() => setFollow(true)}>
                {lang === 'zh' ? '⬇ 回到最新消息' : '⬇ Jump to latest'}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={follow}
              onClick={() => setFollow(v => !v)}
            >
              {lang === 'zh' ? (follow ? '自动跟随：开' : '自动跟随：关') : (follow ? 'Follow: on' : 'Follow: off')}
            </Button>
          </div>
        </div>
        <div
          ref={historyRef}
          className="dt-panel-history dt-assistant-stream"
          data-testid="assistant-message-stream"
          onScroll={() => {
            const node = historyRef.current
            if (node) setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 60)
          }}
        >
          {displayMessages.length === 0 && !showAssistantLiveBubble ? (
            <p className="dt-hint">
              {lang === 'zh' ? '发送文字或图片开始与个人助理对话。' : 'Send text or images to chat with Personal Assistant.'}
            </p>
          ) : (
            displayMessages.map((msg, idx) => {
              const isBot = Boolean(msg.bot)
              const handoff = msg.handoff
              const replyMeta = msg.replyMeta
              const replyModel = replyMeta?.model ?? (isBot ? activeAssistantModel : undefined)
              const isDetailOpen = Boolean(expandedDetailIds[msg.id])
              const resetAt = contextConfig?.contextResetAt
              const prevMsg = idx > 0 ? displayMessages[idx - 1] : undefined
              const showResetDividerBefore = Boolean(
                resetAt && msg.at >= resetAt && (!prevMsg || prevMsg.at < resetAt),
              )
              const showResetDividerAfterLast = Boolean(
                resetAt && idx === displayMessages.length - 1 && msg.at < resetAt,
              )
              const msgImages = (msg.content ?? []).filter(
                (part): part is { type: 'image'; mediaType: string; data: string; name?: string } => part.type === 'image',
              )
              const handoffTone = handoff?.state === 'accepted'
                ? 'success'
                : handoff?.state === 'rejected'
                  ? 'warning'
                  : 'info'
              return (
                <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {showResetDividerBefore && (
                    <div className="dt-msg-receipt" data-active="true">
                      <span className="dt-hint">
                        {lang === 'zh'
                          ? '── ✂ 已开启新对话窗口：上方历史已归档（不占用当前上下文，助理可随时通过 memory_chat_search 检索） ──'
                          : '── ✂ New Context Window Started: Earlier messages archived (searchable via memory_chat_search) ──'}
                      </span>
                    </div>
                  )}
                  <article
                    className="dt-panel-message dt-chat-bubble"
                    data-bot={isBot}
                    data-sender={isBot ? 'bot' : 'self'}
                    data-testid={`assistant-msg-${msg.id}`}
                  >
                  <div className="dt-session-reply-head">
                    <div className="dt-msg-receipt-main">
                      <strong>{isBot ? (lang === 'zh' ? '个人助理' : 'Assistant') : msg.sender}</strong>
                      {isBot && replyModel && (
                        <Tag tone="info">
                          {replyModel.provider} / {replyModel.model}
                          {replyModel.reasoningEffort ? ` · ${replyModel.reasoningEffort}` : ''}
                        </Tag>
                      )}
                      {isBot && replyMeta?.matchedSlot && (
                        <Tag tone="success">
                          {replyMeta.matchedSlot.label} ({replyMeta.matchedSlot.startTime}→{replyMeta.matchedSlot.endTime})
                        </Tag>
                      )}
                      {isBot && replyMeta?.durationMs !== undefined && (
                        <span className="dt-mono dt-hint">{(replyMeta.durationMs / 1000).toFixed(1)}s</span>
                      )}
                    </div>
                    <div className="dt-msg-head-actions">
                      <time dateTime={msg.at}>{formatSmartTimestamp(msg.at, lang)}</time>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setFullscreenMsgId(msg.id)}
                        data-testid={`assistant-fullscreen-${msg.id}`}
                      >
                        {lang === 'zh' ? '放大查看' : 'Expand'}
                      </Button>
                      {isBot && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => toggleDetail(msg.id)}
                          data-testid={`assistant-detail-btn-${msg.id}`}
                        >
                          {isDetailOpen
                            ? (lang === 'zh' ? '收起原始回复与细节' : 'Hide raw details')
                            : (lang === 'zh' ? '查看原始回复与细节' : 'Raw reply & details')}
                        </Button>
                      )}
                      {!isBot && !handoff && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={forwardingId === msg.id || busy}
                          onClick={() => { void forwardMessageToEngineering(msg) }}
                        >
                          {forwardingId === msg.id
                            ? (lang === 'zh' ? '转交中…' : 'Forwarding…')
                            : (lang === 'zh' ? '转交工程对话 →' : 'Forward to Engineering →')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => { void deleteSingleMessage(msg.id) }}
                        title={lang === 'zh' ? '删除此条对话并移入 30 天反悔恢复箱（30 天内随时可恢复）' : 'Delete message and move to 30-day recovery vault'}
                        data-testid={`assistant-delete-msg-${msg.id}`}
                      >
                        {lang === 'zh' ? '删除' : 'Delete'}
                      </Button>
                    </div>
                  </div>

                  <MarkdownLite text={msg.text} />

                  {isBot && isDetailOpen && (
                    <div className="dt-msg-receipt" data-testid={`assistant-detail-panel-${msg.id}`}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
                        <div className="dt-msg-receipt-main">
                          <strong>{lang === 'zh' ? '原始回复与执行细节' : 'Raw Reply & Execution Details'}</strong>
                          {replyModel && (
                            <span className="dt-mono dt-msg-receipt-branch">
                              {lang === 'zh' ? '模型：' : 'Model: '}
                              {replyModel.provider} / {replyModel.model}
                              {replyModel.reasoningEffort ? ` (${replyModel.reasoningEffort})` : ''}
                            </span>
                          )}
                          {replyMeta?.turn !== undefined && (
                            <span className="dt-mono dt-msg-receipt-branch">Turn #{replyMeta.turn}</span>
                          )}
                          {replyMeta?.durationMs !== undefined && (
                            <span className="dt-mono dt-msg-receipt-branch">
                              {lang === 'zh' ? `耗时 ${(replyMeta.durationMs / 1000).toFixed(2)}s` : `${(replyMeta.durationMs / 1000).toFixed(2)}s`}
                            </span>
                          )}
                        </div>

                        {replyMeta?.toolCalls && replyMeta.toolCalls.length > 0 && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <span className="dt-hint">
                              {lang === 'zh' ? `本回合工具调用 (${replyMeta.toolCalls.length})：` : `Tool calls (${replyMeta.toolCalls.length}):`}
                            </span>
                            {replyMeta.toolCalls.map((tc, idx) => (
                              <pre key={idx} className="dt-raw-events">
                                {`[${tc.name}] args=${JSON.stringify(tc.args ?? {})}\nresult=${JSON.stringify(tc.output ?? null, null, 2)}`}
                              </pre>
                            ))}
                          </div>
                        )}

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span className="dt-hint">{lang === 'zh' ? '原始回复文本 (Raw Markdown)：' : 'Raw Markdown Text:'}</span>
                          <pre className="dt-raw-events">{msg.text}</pre>
                        </div>

                        {replyMeta?.events && replyMeta.events.length > 0 && (
                          <details>
                            <summary className="dt-hint" style={{ cursor: 'pointer' }}>
                              {lang === 'zh' ? `展开本回合原始会话事件 (${replyMeta.events.length} 条)` : `Raw turn events (${replyMeta.events.length})`}
                            </summary>
                            <pre className="dt-raw-events">{JSON.stringify(replyMeta.events, null, 2)}</pre>
                          </details>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="dt-image-previews">
                    {msgImages.map((image, index) => {
                      const src = `data:${image.mediaType};base64,${image.data}`
                      return (
                        <a key={index} href={src} download={image.name || 'image'} title={lang === 'zh' ? '下载原图' : 'Download original'}>
                          <img src={src} alt={image.name || (lang === 'zh' ? '图片' : 'Image')} loading="lazy" />
                        </a>
                      )
                    })}
                  </div>

                  {handoff && (
                    <div
                      className="dt-msg-receipt"
                      data-active={handoff.state === 'accepted'}
                      data-testid={`handoff-card-${msg.id}`}
                      data-handoff-state={handoff.state}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
                        <div className="dt-live-head">
                          <div className="dt-msg-receipt-main">
                            <Tag tone={handoffTone}>
                              {handoff.state === 'accepted'
                                ? (lang === 'zh' ? `✓ 工程已接单 #${handoff.ticketId?.slice(0, 6)}` : `✓ Accepted #${handoff.ticketId?.slice(0, 6)}`)
                                : handoff.state === 'rejected'
                                  ? (lang === 'zh' ? '✕ 工程评估已拒收' : '✕ Refused by Engineering Eval')
                                  : (lang === 'zh' ? '⏳ 已转交工程对话 · 待评估' : '⏳ Forwarded to Engineering Chat')}
                            </Tag>
                            {handoff.summary && (
                              <strong className="dt-msg-receipt-title">{handoff.summary}</strong>
                            )}
                            <span className="dt-mono dt-msg-receipt-branch">
                              {lang === 'zh'
                                ? `已附原话${handoff.imageCount ? `及 ${handoff.imageCount} 张原图` : ''}`
                                : `Verbatim text${handoff.imageCount ? ` + ${handoff.imageCount} image(s)` : ''} attached`}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="dt-receipt-inspect-btn"
                            onClick={() => onJumpToEngineeringTicket(handoff.ticketId)}
                          >
                            {lang === 'zh' ? '在工程对话中查看 →' : 'Open in Engineering Chat →'}
                          </button>
                        </div>

                        {handoff.state === 'rejected' && (
                          <div className="dt-error" data-testid={`handoff-refusal-${msg.id}`}>
                            <strong>{lang === 'zh' ? '拒收原因：' : 'Refusal reason: '}</strong>
                            {handoff.refusalReason}
                          </div>
                        )}

                        {handoff.attentionQuestion && handoff.ticketId && (
                          <div className="dt-banner" style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid={`handoff-attention-${msg.id}`}>
                            <div className="dt-msg-receipt-main">
                              <Tag tone="warning">{lang === 'zh' ? '⚠️ 工单待您拍板 (Attention)' : '⚠️ Awaiting Your Decision'}</Tag>
                              <strong>{handoff.ticketTitle}</strong>
                            </div>
                            <MarkdownLite text={handoff.attentionQuestion} />
                            <div className="dt-topic-switch">
                              <Input
                                value={handoffAnswerDrafts[handoff.ticketId] ?? ''}
                                disabled={busy}
                                onChange={e => setHandoffAnswerDrafts(curr => ({ ...curr, [handoff.ticketId!]: e.target.value }))}
                                placeholder={lang === 'zh' ? '直接在此回复工程执行器的问题（按 Enter 发送并唤醒工单继续）…' : 'Reply directly to wake the worker…'}
                                onKeyDown={e => {
                                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && (handoffAnswerDrafts[handoff.ticketId!] ?? '').trim()) {
                                    e.preventDefault()
                                    void submitHandoffTicketAnswer(handoff.ticketId!)
                                  }
                                }}
                              />
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={busy || !(handoffAnswerDrafts[handoff.ticketId] ?? '').trim()}
                                onClick={() => { void submitHandoffTicketAnswer(handoff.ticketId!) }}
                              >
                                {lang === 'zh' ? '发送决定' : 'Send'}
                              </Button>
                            </div>
                          </div>
                        )}

                        {handoff.liveRun && (
                          <div className="dt-live-status-bar" data-testid={`handoff-live-status-${msg.id}`}>
                            <StateDot state="ongoing" />
                            <span>
                              {handoff.liveRun.phaseLabel[lang]}
                              {handoff.liveRun.stepCount > 1
                                ? (lang === 'zh' ? ` · 第 ${handoff.liveRun.stepCount} 步` : ` · Step ${handoff.liveRun.stepCount}`)
                                : ''}
                            </span>
                          </div>
                        )}

                        {handoff.liveRun?.streamingText && (
                          <div className="dt-hint" style={{ fontSize: 12.5 }}>
                            <MarkdownLite text={handoff.liveRun.streamingText} />
                          </div>
                        )}

                        {handoff.reportSummary && !handoff.attentionQuestion && (
                          <div className="dt-hint" style={{ fontSize: 12 }}>
                            <MarkdownLite text={handoff.reportSummary} />
                          </div>
                        )}

                        {handoff.state === 'evaluating' && (
                          <div className="dt-row-buttons">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => { void runEvalDecision(handoff.triggerId, 'accept', (handoff.summary || handoff.originalText).slice(0, 80)) }}
                            >
                              {lang === 'zh' ? '工程确认接单 (Accept)' : 'Accept'}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => setRefusalInputFor(refusalInputFor === handoff.triggerId ? null : handoff.triggerId)}
                            >
                              {lang === 'zh' ? '工程拒收 (Refuse)' : 'Refuse'}
                            </Button>
                          </div>
                        )}

                        {handoff.state === 'evaluating' && refusalInputFor === handoff.triggerId && (
                          <div className="dt-topic-switch">
                            <Input
                              value={refusalReasonDraft}
                              onChange={e => setRefusalReasonDraft(e.target.value)}
                              placeholder={lang === 'zh' ? '输入拒收理由…' : 'Refusal reason…'}
                            />
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={busy}
                              onClick={() => { void runEvalDecision(handoff.triggerId, 'ignore', undefined, refusalReasonDraft) }}
                            >
                              {lang === 'zh' ? '确认拒收' : 'Confirm refusal'}
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  </article>
                  {showResetDividerAfterLast && (
                    <div className="dt-msg-receipt" data-active="true">
                      <span className="dt-hint">
                        {lang === 'zh'
                          ? '── ✂ 已开启新对话窗口：上方历史已归档（不占用当前上下文，助理可随时通过 memory_chat_search 检索） ──'
                          : '── ✂ New Context Window Started: Earlier messages archived (searchable via memory_chat_search) ──'}
                      </span>
                    </div>
                  )}
                </div>
              )
            })
          )}
          {showAssistantLiveBubble && (
            <InlineLiveAgentBubble
              run={liveRun}
              fallbackRole="assistant"
              fallbackModel={activeAssistantModel}
              startedAtFallback={pendingTurnSinceMs ?? undefined}
              lang={lang}
              testId="assistant-live-bubble"
              bubbleStyle
            />
          )}
        </div>
        {/* 30-Day Protected Chat Backup & Recovery Vault (`assistant-chat-backups/`) */}
        <details className="dt-conversation-settings dt-assistant-vault" open={chatBackups.length > 0} data-testid="assistant-chat-backup-vault">
          <summary>
            {lang === 'zh'
              ? `🛡 对话记录 30 天反悔恢复箱 (assistant-chat-backups/ · 共 ${chatBackups.length} 份备份 · 30天内不可手动删除、随时可恢复)`
              : `🛡 30-Day Chat History Backup & Recovery Vault (${chatBackups.length} backups)`}
          </summary>
          {chatBackups.length === 0 ? (
            <p className="dt-hint">
              {lang === 'zh'
                ? '当前暂无已删除的对话备份。单条删除或清空的对话记录均会锁定保存在此 30 天，期间可随时一键恢复。'
                : 'No deleted chat backups currently.'}
            </p>
          ) : (
            <div className="dt-pipeline-list">
              {chatBackups.map(bak => {
                const remainingDays = Math.max(
                  1,
                  Math.ceil((Date.parse(bak.expiresAt) - Date.now()) / (24 * 60 * 60 * 1000)),
                )
                return (
                  <div key={bak.id} className="dt-msg-receipt" data-active="true" data-testid={`chat-backup-${bak.id}`}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
                      <div className="dt-msg-receipt-main">
                        <Tag tone="warning">
                          {lang === 'zh' ? `🔒 30天保护期 · 剩余 ${remainingDays} 天自动清理` : `🔒 Protected · ${remainingDays}d left`}
                        </Tag>
                        <Tag tone="info">
                          {bak.reason === 'clear-all'
                            ? (lang === 'zh' ? `清空对话备份 (${bak.count} 条)` : `Cleared Chat (${bak.count})`)
                            : (lang === 'zh' ? `单条删除备份 (${bak.count} 条)` : `Single Message (${bak.count})`)}
                        </Tag>
                        <span className="dt-mono dt-hint">
                          {formatSmartTimestamp(bak.deletedAt, lang)} · {bak.id}
                        </span>
                      </div>
                      <div style={{ fontSize: 12 }}>
                        {bak.messages
                          .slice(0, 4)
                          .map(m => `${m.bot ? '助理' : '我'}: ${m.text.slice(0, 60)}${m.text.length > 60 ? '…' : ''}`)
                          .join(' ｜ ')}
                      </div>
                    </div>
                    <div className="dt-row-buttons">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy}
                        onClick={() => { void restoreChatBackup(bak.id) }}
                        data-testid={`restore-chat-backup-${bak.id}`}
                      >
                        {lang === 'zh' ? '↩ 一键恢复对话' : '↩ Restore Chat'}
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </details>
      </section>

      {(() => {
        const fullMsg = fullscreenMsgId ? messages.find(m => m.id === fullscreenMsgId) : undefined
        const fullBot = Boolean(fullMsg?.bot)
        const fullModel = fullMsg?.replyMeta?.model ?? (fullBot ? activeAssistantModel : undefined)
        const fullImages = (fullMsg?.content ?? []).filter(
          (part): part is { type: 'image'; mediaType: string; data: string; name?: string } => part.type === 'image',
        )
        return (
          <Modal
            className="dt-fullscreen-modal"
            open={Boolean(fullMsg)}
            onClose={() => setFullscreenMsgId(null)}
            title={
              fullMsg
                ? `${fullBot ? (lang === 'zh' ? '个人助理' : 'Assistant') : fullMsg.sender}${fullBot && fullModel ? ` (${fullModel.provider} / ${fullModel.model}${fullModel.reasoningEffort ? ` · ${fullModel.reasoningEffort}` : ''})` : ''} · ${formatSmartTimestamp(fullMsg.at, lang)}`
                : ''
            }
            closeLabel={lang === 'zh' ? '关闭 (ESC)' : 'Close (ESC)'}
            description={lang === 'zh' ? '点击左右半透明暗色背景、按 ESC 键或点击关闭按钮即可退出' : 'Click the dark backdrop, press ESC, or click close to exit'}
            footer={
              <div className="dt-row-buttons">
                {fullMsg && !fullBot && !fullMsg.handoff && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={forwardingId === fullMsg.id || busy}
                    onClick={() => { void forwardMessageToEngineering(fullMsg) }}
                  >
                    {lang === 'zh' ? '转交工程对话 →' : 'Forward to Engineering →'}
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
                <div className="dt-panel-message" data-bot={fullBot}>
                  <MarkdownLite text={fullMsg.text} />
                  <div className="dt-image-previews">
                    {fullImages.map((image, index) => {
                      const src = `data:${image.mediaType};base64,${image.data}`
                      return (
                        <a key={index} href={src} download={image.name || 'image'} title={lang === 'zh' ? '下载原图' : 'Download original'}>
                          <img src={src} alt={image.name || (lang === 'zh' ? '图片' : 'Image')} style={{ maxHeight: '70vh', height: 'auto' }} />
                        </a>
                      )
                    })}
                  </div>
                </div>

                {fullBot && fullMsg.replyMeta && (
                  <details className="dt-conversation-settings" open>
                    <summary>
                      {lang === 'zh' ? '原始回复与执行细节 (Raw Reply & Tool Calls)' : 'Raw Reply & Execution Details'}
                    </summary>
                    <div className="dt-form" style={{ marginTop: 8 }}>
                      {fullMsg.replyMeta.toolCalls && fullMsg.replyMeta.toolCalls.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span className="dt-hint">
                            {lang === 'zh' ? `本回合工具调用 (${fullMsg.replyMeta.toolCalls.length})：` : `Tool calls (${fullMsg.replyMeta.toolCalls.length}):`}
                          </span>
                          {fullMsg.replyMeta.toolCalls.map((tc, idx) => (
                            <pre key={idx} className="dt-raw-events">
                              {`[${tc.name}] args=${JSON.stringify(tc.args ?? {})}\nresult=${JSON.stringify(tc.output ?? null, null, 2)}`}
                            </pre>
                          ))}
                        </div>
                      )}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span className="dt-hint">{lang === 'zh' ? '原始回复文本 (Raw Markdown)：' : 'Raw Markdown Text:'}</span>
                        <pre className="dt-raw-events">{fullMsg.text}</pre>
                      </div>
                    </div>
                  </details>
                )}
              </div>
            )}
            </Modal>
          )
        })()}
    </div>
  )
}

export function ClawFeedNotificationsSlotView({
  lang,
  items,
  onItemsUpdated,
}: {
  lang: Lang
  items: ClawFeedItemInfo[]
  onItemsUpdated: (next: ClawFeedItemInfo[]) => void
}) {
  const [tagFilter, setTagFilter] = useState<'all' | '验证码' | '重要' | '普通'>('all')
  const [searchQ, setSearchQ] = useState('')
  const [clearConfirm, setClearConfirm] = useState(false)
  const [copiedId, setCopiedId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refreshItems = async () => {
    setBusy(true); setError('')
    try {
      const res = await standaloneFetch<{ items: ClawFeedItemInfo[] }>('clawfeed', 'GET')
      onItemsUpdated(res.items ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const removeOne = async (id: string) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const res = await standaloneFetch<{ items: ClawFeedItemInfo[] }>(`clawfeed/${encodeURIComponent(id)}`, 'DELETE')
      onItemsUpdated(res.items ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const clearAll = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const res = await standaloneFetch<{ items: ClawFeedItemInfo[] }>('clawfeed/clear', 'POST', {})
      onItemsUpdated(res.items ?? [])
      setClearConfirm(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const extractOtpCode = (text: string): string | undefined => {
    const m = /(?<!\d)(\d{4,8})(?!\d)/.exec(text.replace(/\[\d{4}-\d{2}-\d{2}[^\]]*\]/g, ''))
    return m?.[1]
  }

  const copyText = async (id: string, val: string) => {
    try {
      await navigator.clipboard.writeText(val)
      setCopiedId(id)
      setTimeout(() => setCopiedId(''), 1800)
    } catch {}
  }

  const otpCount = items.filter(i => i.tag === '验证码').length
  const impCount = items.filter(i => i.tag === '重要').length
  const normCount = items.filter(i => i.tag === '普通').length

  const filtered = items.filter(item => {
    if (tagFilter !== 'all' && item.tag !== tagFilter) return false
    if (!searchQ.trim()) return true
    return `${item.message} ${item.user} ${item.tag}`.toLowerCase().includes(searchQ.trim().toLowerCase())
  })

  return (
    <div className="dt-form" data-testid="clawfeed-slot-view">
      {error && <p className="dt-error" role="status">{error}</p>}
      <section className="dt-pipeline-card" aria-label={lang === 'zh' ? '手机通知中心' : 'Mobile Notifications Center'}>
        <div className="dt-live-head">
          <div>
            <h2>
              {lang === 'zh'
                ? `📱 手机通知与验证码中心 (ClawFeed · 共 ${items.length} 条)`
                : `📱 Mobile Notifications & OTP Center (${items.length})`}
            </h2>
            <span className="dt-hint">
              {lang === 'zh'
                ? '独立展示手机 Message Mirror 转发来的短信与应用通知（验证码 / 重要 / 普通），不再混入「个人助理」对话记录；个人助理仍可通过 clawfeed_recent 工具按需检索'
                : 'Dedicated view for phone SMS & app notifications (OTP / Important / Normal), completely separated from Personal Assistant chat history'}
            </span>
          </div>
          <div className="dt-row-buttons">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => { void refreshItems() }}>
              {lang === 'zh' ? '↻ 刷新通知' : '↻ Refresh'}
            </Button>
            {items.length > 0 && !clearConfirm && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setClearConfirm(true)}>
                {lang === 'zh' ? `清空通知 (${items.length})` : `Clear All (${items.length})`}
              </Button>
            )}
            {items.length > 0 && clearConfirm && (
              <>
                <Button size="sm" variant="primary" disabled={busy} onClick={() => { void clearAll() }}>
                  {lang === 'zh' ? `⚠️ 确认清空全部 ${items.length} 条通知` : `Confirm Clear (${items.length})`}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setClearConfirm(false)}>
                  {lang === 'zh' ? '取消' : 'Cancel'}
                </Button>
              </>
            )}
          </div>
        </div>

        <div className="dt-topic-switch">
          <div className="dt-row-buttons">
            {([
              ['all', lang === 'zh' ? `全部 (${items.length})` : `All (${items.length})`],
              ['验证码', lang === 'zh' ? `🔑 验证码 (${otpCount})` : `🔑 OTP (${otpCount})`],
              ['重要', lang === 'zh' ? `📌 重要通知 (${impCount})` : `📌 Important (${impCount})`],
              ['普通', lang === 'zh' ? `💬 普通通知 (${normCount})` : `💬 Normal (${normCount})`],
            ] as const).map(([key, label]) => (
              <Button
                key={key}
                size="sm"
                variant={tagFilter === key ? 'primary' : 'outline'}
                onClick={() => setTagFilter(key)}
              >
                {label}
              </Button>
            ))}
          </div>
          <Input
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
            placeholder={lang === 'zh' ? '搜索短信/通知内容、验证码、快递、银行或应用名…' : 'Search notifications…'}
          />
        </div>

        <div className="dt-pipeline-list">
          {filtered.length === 0 && (
            <p className="dt-hint">
              {lang === 'zh' ? '当前暂无匹配的手机通知。' : 'No matching mobile notifications.'}
            </p>
          )}
          {filtered.map(item => {
            const otpCode = item.tag === '验证码' ? extractOtpCode(item.message) : undefined
            return (
              <div key={item.id} className="dt-msg-receipt" data-active={item.tag === '验证码' || item.tag === '重要'}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
                  <div className="dt-msg-receipt-main">
                    <Tag tone={item.tag === '验证码' ? 'warning' : item.tag === '重要' ? 'success' : 'neutral'}>
                      {item.tag === '验证码' ? '🔑 验证码' : item.tag === '重要' ? '📌 重要' : '💬 普通'}
                    </Tag>
                    <span className="dt-mono dt-msg-receipt-branch">user: {item.user}</span>
                    {otpCode && (
                      <Tag tone="info">
                        {lang === 'zh' ? `验证码：${otpCode}` : `Code: ${otpCode}`}
                      </Tag>
                    )}
                    <span className="dt-mono dt-hint">{formatSmartTimestamp(item.at, lang)}</span>
                  </div>
                  <div style={{ fontSize: 13.5, lineHeight: '21px', whiteSpace: 'pre-wrap' }}>{item.message}</div>
                </div>
                <div className="dt-row-buttons">
                  {otpCode && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => { void copyText(`otp-${item.id}`, otpCode) }}
                    >
                      {copiedId === `otp-${item.id}`
                        ? (lang === 'zh' ? `✓ 已复制 ${otpCode}` : `✓ Copied ${otpCode}`)
                        : (lang === 'zh' ? `📋 复制验证码 (${otpCode})` : `📋 Copy ${otpCode}`)}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { void copyText(`full-${item.id}`, item.message) }}
                  >
                    {copiedId === `full-${item.id}` ? (lang === 'zh' ? '✓ 已复制' : '✓ Copied') : (lang === 'zh' ? '复制全文' : 'Copy')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => { void removeOne(item.id) }}
                  >
                    {lang === 'zh' ? '删除' : 'Delete'}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

interface ToolkitFileEntryUI {
  name: string
  relativePath: string
  sizeBytes: number
  sizeMb: number
  modifiedAt: string
  isMedia: boolean
  folder: string
}

interface ToolkitOverviewUI {
  hostedLocally: boolean
  nodeHost: string
  rootDir: string
  diskFreeGb: number | null
  diskTotalGb: number | null
  memFreeMb: number
  memTotalMb: number
  toolsAvailable: { bbdown: boolean; ytdlp: boolean; sevenZip: boolean }
  downloadTask: {
    running: boolean
    progress: number
    command: string
    error: string | null
    outputTail: string
    recentFiles: { filename: string; relativePath: string; sizeMb: number }[]
  }
  backupTask: {
    running: boolean
    progress: number
    currentFolder: string | null
    filename: string | null
    sizeMb: number | null
    error: string | null
  }
  folders: {
    folder: string
    fileCount: number
    totalSizeMb: number
    files: ToolkitFileEntryUI[]
  }[]
  totalDownloadFiles: number
  totalDownloadSizeMb: number
  backups: {
    filename: string
    sizeBytes: number
    sizeMb: number
    createdAt: string
  }[]
  recentHistory: { timestamp: string; command: string; success: boolean; fileCount: number }[]
  activeZipJob: {
    jobId: string
    status: 'queued' | 'running' | 'ready' | 'error'
    progress: number
    filename: string
    fileCount: number
    sizeMb: number
    error: string | null
    updatedAt: string
  } | null
}

/**
 * Optional Private-Pack Top-Bar View Slot (`🧰 云端工具箱`).
 * Provides Bilibili/UP-space/Twitter/yt-dlp downloads, inline HTML5 Range video player,
 * background ZIP packaging, and 7z directory backups when mounted via `~/.rharness/private-pack`.
 */
export function RHToolkitSlotView({ lang }: { lang: Lang }) {
  const [subTab, setSubTab] = useState<'download' | 'library' | 'backup'>('download')
  const [state, setState] = useState<ToolkitOverviewUI | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')

  // Download form
  const [targetUrl, setTargetUrl] = useState('')
  const [subfolder, setSubfolder] = useState('')
  const [spaceUrl, setSpaceUrl] = useState('')
  const [spaceResult, setSpaceResult] = useState<{ uid: string; username: string; folderName: string; total: number; bvIds: string[] } | null>(null)
  const [spaceBusy, setSpaceBusy] = useState(false)

  // Library filter & inline player
  const [selectedFolder, setSelectedFolder] = useState<string>('ALL')
  const [searchQ, setSearchQ] = useState('')
  const [playingFile, setPlayingFile] = useState<ToolkitFileEntryUI | null>(null)
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [newFolderName, setNewFolderName] = useState('')

  // Backup form
  const [backupSource, setBackupSource] = useState('')
  const [backupName, setBackupName] = useState('')

  const refreshState = async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await standaloneFetch<ToolkitOverviewUI>('rhtoolkit/state', 'GET')
      setState(res)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    void refreshState(false)
  }, [])

  useEffect(() => {
    const isBusy = Boolean(
      state?.downloadTask.running ||
        state?.backupTask.running ||
        state?.activeZipJob?.status === 'running' ||
        state?.activeZipJob?.status === 'queued',
    )
    const intervalMs = isBusy ? 2500 : 12000
    const timer = setInterval(() => {
      void refreshState(true)
    }, intervalMs)
    return () => clearInterval(timer)
  }, [state?.downloadTask.running, state?.backupTask.running, state?.activeZipJob?.status])

  const submitDownload = async (e: FormEvent) => {
    e.preventDefault()
    if (!targetUrl.trim()) return
    setLoading(true)
    setFeedback('')
    try {
      const res = await standaloneFetch<{ ok: boolean; message: string }>('rhtoolkit/download', 'POST', {
        target: targetUrl.trim(),
        ...(subfolder.trim() ? { subfolder: subfolder.trim() } : {}),
      })
      setFeedback(res.message)
      if (res.ok) setTargetUrl('')
      await refreshState(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const cancelDownload = async () => {
    setLoading(true)
    try {
      const res = await standaloneFetch<{ ok: boolean; message: string }>('rhtoolkit/cancel', 'POST', {})
      setFeedback(res.message)
      await refreshState(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const fetchSpace = async () => {
    if (!spaceUrl.trim()) return
    setSpaceBusy(true)
    setFeedback('')
    try {
      const res = await standaloneFetch<{
        ok: boolean
        uid?: string
        username?: string
        folderName?: string
        total?: number
        bvIds?: string[]
        error?: string
      }>('rhtoolkit/space-fetch', 'POST', { spaceUrl: spaceUrl.trim() })
      if (!res.ok || !res.uid || !res.bvIds) {
        setError(res.error || '拉取 UP 主空间失败')
      } else {
        setSpaceResult({
          uid: res.uid,
          username: res.username || 'up',
          folderName: res.folderName || `${res.username}_${res.uid}`,
          total: res.total ?? res.bvIds.length,
          bvIds: res.bvIds,
        })
        setFeedback(`成功获取 UP 主「${res.username}」共 ${res.bvIds.length} 个视频 BV 号`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSpaceBusy(false)
    }
  }

  const startSpaceBatch = async () => {
    if (!spaceResult) return
    setSpaceBusy(true)
    try {
      const res = await standaloneFetch<{ ok: boolean; message: string }>('rhtoolkit/space-download', 'POST', {
        uid: spaceResult.uid,
        username: spaceResult.username,
        bvIds: spaceResult.bvIds,
      })
      setFeedback(res.message)
      await refreshState(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSpaceBusy(false)
    }
  }

  const triggerZipJob = async (folder?: string, videosOnly = false) => {
    setLoading(true)
    try {
      const res = await standaloneFetch<{ ok: boolean; job?: { filename: string }; error?: string }>('rhtoolkit/zip', 'POST', {
        ...(folder ? { folder } : {}),
        videosOnly,
      })
      if (res.ok) {
        setFeedback(`已启动后台 ZIP 打包：${res.job?.filename ?? ''}`)
        await refreshState(true)
      } else {
        setError(res.error || '启动打包失败')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const submitBackup = async (e: FormEvent) => {
    e.preventDefault()
    if (!backupSource.trim()) return
    setLoading(true)
    try {
      const res = await standaloneFetch<{ ok: boolean; message: string }>('rhtoolkit/backup', 'POST', {
        sourceFolder: backupSource.trim(),
        ...(backupName.trim() ? { backupName: backupName.trim() } : {}),
      })
      setFeedback(res.message)
      await refreshState(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const deleteItem = async (kind: 'download' | 'backup', relativePath: string) => {
    setLoading(true)
    try {
      const res = await standaloneFetch<{ ok: boolean; message: string }>('rhtoolkit/delete', 'POST', {
        kind,
        relativePath,
      })
      setFeedback(res.message)
      if (playingFile?.relativePath === relativePath) setPlayingFile(null)
      await refreshState(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const confirmRenameFolder = async (oldFolder: string) => {
    if (!newFolderName.trim()) return
    setLoading(true)
    try {
      const res = await standaloneFetch<{ ok: boolean; message: string }>('rhtoolkit/rename-folder', 'POST', {
        oldFolder,
        newFolder: newFolderName.trim(),
      })
      setFeedback(res.message)
      setRenamingFolder(null)
      setNewFolderName('')
      await refreshState(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const streamUrl = (kind: 'download' | 'backup' | 'zip', path: string, dl = false) =>
    `/orchestrator/standalone/rhtoolkit/stream?kind=${kind}&path=${encodeURIComponent(path)}${dl ? '&dl=1' : ''}`

  const visibleFolders = (state?.folders ?? []).filter(
    g => selectedFolder === 'ALL' || g.folder === selectedFolder,
  )

  return (
    <div className="dt-form">
      <section className="dt-pipeline-card" aria-label={lang === 'zh' ? '云端工具箱' : 'Cloud Toolkit'}>
        <div className="dt-live-head">
          <div>
            <h2>{lang === 'zh' ? '🧰 云端工具箱 (媒体下载与归档中心)' : '🧰 Cloud Media Downloader & Vault'}</h2>
            <span className="dt-hint">
              {state
                ? `节点 ${state.nodeHost} · 磁盘剩余 ${state.diskFreeGb ?? '?'} / ${state.diskTotalGb ?? '?'} GB · 内存可用 ${state.memFreeMb} MB · 媒体库 ${state.totalDownloadFiles} 个文件 (${(state.totalDownloadSizeMb / 1024).toFixed(2)} GB)`
                : lang === 'zh'
                  ? '正在连接远端工具箱节点…'
                  : 'Connecting to remote toolkit node…'}
            </span>
          </div>
          <div className="dt-row-buttons">
            <Button
              size="sm"
              variant={subTab === 'download' ? 'primary' : 'outline'}
              onClick={() => setSubTab('download')}
            >
              {lang === 'zh' ? '⬇ 视频下载任务' : '⬇ Downloader'}
            </Button>
            <Button
              size="sm"
              variant={subTab === 'library' ? 'primary' : 'outline'}
              onClick={() => setSubTab('library')}
            >
              {lang === 'zh'
                ? `🎬 媒体库点播 (${state?.totalDownloadFiles ?? 0})`
                : `🎬 Library (${state?.totalDownloadFiles ?? 0})`}
            </Button>
            <Button
              size="sm"
              variant={subTab === 'backup' ? 'primary' : 'outline'}
              onClick={() => setSubTab('backup')}
            >
              {lang === 'zh'
                ? `📦 7z 目录备份 (${state?.backups.length ?? 0})`
                : `📦 Backups (${state?.backups.length ?? 0})`}
            </Button>
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => { void refreshState(false) }}>
              {lang === 'zh' ? '↻ 刷新' : '↻ Refresh'}
            </Button>
          </div>
        </div>

        {error && <p className="dt-error">{error}</p>}
        {feedback && <p className="dt-banner">{feedback}</p>}

        {state?.activeZipJob && (
          <div className="dt-msg-receipt" data-active={state.activeZipJob.status === 'ready'}>
            <div className="dt-msg-receipt-main">
              <Tag tone={state.activeZipJob.status === 'ready' ? 'success' : state.activeZipJob.status === 'error' ? 'danger' : 'info'}>
                ZIP {state.activeZipJob.status.toUpperCase()} ({state.activeZipJob.progress}%)
              </Tag>
              <strong>{state.activeZipJob.filename}</strong>
              {state.activeZipJob.sizeMb > 0 && <span className="dt-hint">{state.activeZipJob.sizeMb} MB</span>}
              {state.activeZipJob.error && <span className="dt-error">{state.activeZipJob.error}</span>}
            </div>
            {state.activeZipJob.status === 'ready' && (
              <a
                className="dt-btn dt-btn-primary dt-btn-sm"
                href={streamUrl('zip', state.activeZipJob.jobId, true)}
              >
                {lang === 'zh' ? '⬇ 下载打包好的 ZIP' : '⬇ Download ZIP'}
              </a>
            )}
          </div>
        )}

        {subTab === 'download' && (
          <div className="dt-form">
            <form className="dt-form dt-block" onSubmit={e => { void submitDownload(e) }}>
              <h3 className="dt-block-title">
                {lang === 'zh' ? '🚀 B 站 / Twitter(X) / YouTube 云端高速下载' : '🚀 Cloud Video Download (BBDown & yt-dlp)'}
              </h3>
              <span className="dt-hint">
                {lang === 'zh'
                  ? '直接粘贴 B 站视频链接、b23.tv 短链、BV 号（自动调用 bbdown），或 X/Twitter、YouTube 链接（自动调用 yt-dlp）。也可以直接在个人助理中发链接触发下载。'
                  : 'Paste a Bilibili URL/BV ID (uses bbdown) or X/Twitter/YouTube URL (uses yt-dlp).'}
              </span>
              <div className="dt-grid3">
                <label className="dt-field" style={{ gridColumn: 'span 2' }}>
                  <span>{lang === 'zh' ? '视频链接或 BV 号' : 'Video URL or BV ID'}</span>
                  <Input
                    value={targetUrl}
                    onChange={e => setTargetUrl(e.target.value)}
                    placeholder="https://www.bilibili.com/video/BV... 或 https://x.com/.../status/..."
                  />
                </label>
                <label className="dt-field">
                  <span>{lang === 'zh' ? '保存子目录（可选）' : 'Subfolder (optional)'}</span>
                  <Input
                    value={subfolder}
                    onChange={e => setSubfolder(e.target.value)}
                    placeholder={lang === 'zh' ? '留空存根目录；推文默认存 twitter/' : 'Optional subfolder'}
                  />
                </label>
              </div>
              <div className="dt-row-buttons">
                <Button type="submit" variant="primary" disabled={loading || Boolean(state?.downloadTask.running)}>
                  {state?.downloadTask.running
                    ? (lang === 'zh' ? `下载进行中 (${state.downloadTask.progress}%)…` : `Downloading (${state.downloadTask.progress}%)…`)
                    : (lang === 'zh' ? '⬇ 立即开始云端下载' : '⬇ Start Cloud Download')}
                </Button>
                {state?.downloadTask.running && (
                  <Button type="button" variant="outline" onClick={() => { void cancelDownload() }}>
                    {lang === 'zh' ? '⏹ 取消当前下载' : '⏹ Cancel'}
                  </Button>
                )}
              </div>
            </form>

            <div className="dt-form dt-block">
              <h3 className="dt-block-title">
                {lang === 'zh' ? '📺 B 站 UP 主空间全量抓取与断点续传下载' : '📺 Bilibili UP Space Batch Downloader'}
              </h3>
              <div className="dt-live-head">
                <div style={{ flex: 1, minWidth: 220 }}>
                  <Input
                    value={spaceUrl}
                    onChange={e => setSpaceUrl(e.target.value)}
                    placeholder="https://space.bilibili.com/UID 或纯数字 UID"
                  />
                </div>
                <div className="dt-row-buttons">
                  <Button size="sm" variant="outline" disabled={spaceBusy} onClick={() => { void fetchSpace() }}>
                    {spaceBusy ? (lang === 'zh' ? '解析中…' : 'Fetching…') : (lang === 'zh' ? '🔍 解析空间视频列表' : '🔍 Fetch Space Videos')}
                  </Button>
                  {spaceResult && (
                    <Button size="sm" variant="primary" disabled={spaceBusy || Boolean(state?.downloadTask.running)} onClick={() => { void startSpaceBatch() }}>
                      {lang === 'zh' ? `⬇ 一键批量下载全部 (${spaceResult.total} 个)` : `⬇ Download All (${spaceResult.total})`}
                    </Button>
                  )}
                </div>
              </div>
              {spaceResult && (
                <p className="dt-hint">
                  UP 主：<strong>{spaceResult.username}</strong> (UID: {spaceResult.uid}) · 目标目录：<code className="dt-code">{spaceResult.folderName}</code> · 前 8 个 BV：{spaceResult.bvIds.slice(0, 8).join(', ')}
                </p>
              )}
            </div>

            {state && (
              <div className="dt-form dt-block">
                <div className="dt-live-head">
                  <h3 className="dt-block-title">
                    {lang === 'zh' ? '📟 实时下载终端输出与最近记录' : '📟 Live Download Console & History'}
                  </h3>
                  <Tag tone={state.downloadTask.running ? 'info' : state.downloadTask.error ? 'danger' : 'success'}>
                    {state.downloadTask.running
                      ? `运行中 ${state.downloadTask.progress}%`
                      : state.downloadTask.error
                        ? `异常: ${state.downloadTask.error}`
                        : '空闲就绪'}
                  </Tag>
                </div>
                {state.downloadTask.outputTail && (
                  <pre className="dt-pre">{state.downloadTask.outputTail}</pre>
                )}
              </div>
            )}
          </div>
        )}

        {subTab === 'library' && (
          <div className="dt-form">
            {playingFile && (
              <div className="dt-form dt-block">
                <div className="dt-live-head">
                  <div>
                    <h3 className="dt-block-title">▶ {playingFile.name}</h3>
                    <span className="dt-hint">{playingFile.relativePath} · {playingFile.sizeMb} MB（支持 HTTP Range 拖动进度条）</span>
                  </div>
                  <div className="dt-row-buttons">
                    <a className="dt-btn dt-btn-outline dt-btn-sm" href={streamUrl('download', playingFile.relativePath, true)}>
                      {lang === 'zh' ? '⬇ 保存原文件到手机/电脑' : '⬇ Save File'}
                    </a>
                    <Button size="sm" variant="ghost" onClick={() => setPlayingFile(null)}>
                      {lang === 'zh' ? '✕ 关闭播放器' : '✕ Close Player'}
                    </Button>
                  </div>
                </div>
                <video
                  key={playingFile.relativePath}
                  controls
                  autoPlay
                  playsInline
                  style={{ width: '100%', maxHeight: '62dvh', borderRadius: 12, background: '#000' }}
                  src={streamUrl('download', playingFile.relativePath, false)}
                />
              </div>
            )}

            <div className="dt-live-head">
              <div className="dt-row-buttons">
                <Button
                  size="sm"
                  variant={selectedFolder === 'ALL' ? 'primary' : 'outline'}
                  onClick={() => setSelectedFolder('ALL')}
                >
                  {lang === 'zh' ? `全部目录 (${state?.folders.length ?? 0})` : `All (${state?.folders.length ?? 0})`}
                </Button>
                {(state?.folders ?? []).slice(0, 10).map(g => (
                  <Button
                    key={g.folder}
                    size="sm"
                    variant={selectedFolder === g.folder ? 'primary' : 'outline'}
                    onClick={() => setSelectedFolder(g.folder)}
                  >
                    {g.folder} ({g.fileCount})
                  </Button>
                ))}
              </div>
              <div className="dt-row-buttons">
                <Input
                  value={searchQ}
                  onChange={e => setSearchQ(e.target.value)}
                  placeholder={lang === 'zh' ? '搜索视频或文件名…' : 'Filter files…'}
                />
                <Button size="sm" variant="outline" disabled={loading} onClick={() => { void triggerZipJob(undefined, true) }}>
                  {lang === 'zh' ? '📦 打包全部视频 ZIP' : '📦 ZIP All Videos'}
                </Button>
              </div>
            </div>

            {visibleFolders.map(group => {
              const matchedFiles = group.files.filter(
                f => !searchQ.trim() || f.name.toLowerCase().includes(searchQ.trim().toLowerCase()),
              )
              if (matchedFiles.length === 0) return null
              return (
                <div key={group.folder} className="dt-form dt-block">
                  <div className="dt-live-head">
                    <div>
                      <h3 className="dt-block-title">📁 {group.folder}</h3>
                      <span className="dt-hint">{group.fileCount} 个文件 · {group.totalSizeMb} MB</span>
                    </div>
                    {group.folder !== '(根目录 Root)' && (
                      <div className="dt-row-buttons">
                        {renamingFolder === group.folder ? (
                          <>
                            <Input
                              value={newFolderName}
                              onChange={e => setNewFolderName(e.target.value)}
                              placeholder={lang === 'zh' ? '输入新目录名' : 'New folder name'}
                            />
                            <Button size="sm" variant="primary" onClick={() => { void confirmRenameFolder(group.folder) }}>
                              {lang === 'zh' ? '保存' : 'Save'}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setRenamingFolder(null)}>
                              {lang === 'zh' ? '取消' : 'Cancel'}
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setRenamingFolder(group.folder)
                                setNewFolderName(group.folder)
                              }}
                            >
                              {lang === 'zh' ? '重命名目录' : 'Rename'}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => { void triggerZipJob(group.folder, false) }}>
                              {lang === 'zh' ? '📦 打包此目录 ZIP' : '📦 ZIP Folder'}
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="dt-pipeline-list">
                    {matchedFiles.slice(0, 50).map(file => (
                      <div key={file.relativePath} className="dt-msg-receipt">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                          <strong style={{ wordBreak: 'break-word' }}>{file.name}</strong>
                          <span className="dt-hint">
                            {file.sizeMb} MB · {formatSmartTimestamp(file.modifiedAt, lang)}
                          </span>
                        </div>
                        <div className="dt-row-buttons">
                          {file.isMedia && (
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={() => setPlayingFile(file)}
                            >
                              {lang === 'zh' ? '▶ 在线播放' : '▶ Play'}
                            </Button>
                          )}
                          <a
                            className="dt-btn dt-btn-outline dt-btn-sm"
                            href={streamUrl('download', file.relativePath, true)}
                          >
                            {lang === 'zh' ? '⬇ 下载' : '⬇ Download'}
                          </a>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={loading}
                            onClick={() => { void deleteItem('download', file.relativePath) }}
                          >
                            {lang === 'zh' ? '删除' : 'Delete'}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {subTab === 'backup' && (
          <div className="dt-form">
            <form className="dt-form dt-block" onSubmit={e => { void submitBackup(e) }}>
              <h3 className="dt-block-title">
                {lang === 'zh' ? '🗄 创建服务器目录 7z 压缩备份' : '🗄 Create Server Directory 7z Backup'}
              </h3>
              <div className="dt-grid3">
                <label className="dt-field" style={{ gridColumn: 'span 2' }}>
                  <span>{lang === 'zh' ? '服务器源目录路径' : 'Source Folder Path'}</span>
                  <Input
                    value={backupSource}
                    onChange={e => setBackupSource(e.target.value)}
                    placeholder="/srv/data"
                  />
                </label>
                <label className="dt-field">
                  <span>{lang === 'zh' ? '备份文件名前缀（可选）' : 'Archive Name Prefix'}</span>
                  <Input
                    value={backupName}
                    onChange={e => setBackupName(e.target.value)}
                    placeholder="backup"
                  />
                </label>
              </div>
              <div>
                <Button type="submit" variant="primary" disabled={loading || Boolean(state?.backupTask.running)}>
                  {state?.backupTask.running
                    ? (lang === 'zh' ? '正在执行 7z 压缩…' : 'Compressing…')
                    : (lang === 'zh' ? '📦 开始 7z 备份归档' : '📦 Start 7z Backup')}
                </Button>
              </div>
            </form>

            <div className="dt-form dt-block">
              <h3 className="dt-block-title">
                {lang === 'zh' ? `历史备份归档 (${state?.backups.length ?? 0})` : `Existing Backups (${state?.backups.length ?? 0})`}
              </h3>
              <div className="dt-pipeline-list">
                {(state?.backups ?? []).map(bk => (
                  <div key={bk.filename} className="dt-msg-receipt">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <strong>{bk.filename}</strong>
                      <span className="dt-hint">{bk.sizeMb} MB · {formatSmartTimestamp(bk.createdAt, lang)}</span>
                    </div>
                    <div className="dt-row-buttons">
                      <a
                        className="dt-btn dt-btn-primary dt-btn-sm"
                        href={streamUrl('backup', bk.filename, true)}
                      >
                        {lang === 'zh' ? '⬇ 下载 .7z' : '⬇ Download'}
                      </a>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={loading}
                        onClick={() => { void deleteItem('backup', bk.filename) }}
                      >
                        {lang === 'zh' ? '删除' : 'Delete'}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

