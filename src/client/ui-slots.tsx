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
import { readPanelDraftImages, readTextDraft, useTextDraft, writePanelDraftImages, writeTextDraft } from './panel-draft.ts'
import { MarkdownText as MarkdownLite } from './markdown-view.tsx'
import {
  formatSmartTimestamp,
  standaloneFetch,
  type AmbientSnapshotInfo,
  type AssistantChatBackupInfo,
  type AssistantContextConfigInfo,
  type AssistantMessageInfo,
  type AssistantPersonaConfigInfo,
  type CityCandidateInfo,
  type ClawFeedItemInfo,
  type Lang,
  type NavigationResultInfo,
  type LiveSessionRunInfo,
  type MemoryEntryInfo,
  type PendingUserQuestionInfo,
  type PersonaAmbientStateInfo,
  type PersonaLearningInfo,
  type PluginDescriptorInfo,
  type ResidentAddressInfo,
  type SessionProgressCardInfo,
  type StickerInfo,
} from './standalone-api.ts'

export type MainViewSlotId = 'workbench' | 'assistant' | 'clawfeed' | 'rhtoolkit' | 'memory-library' | 'siyuan-kb' | 'persona-ambient' | 'plugin-center' | 'live-inspector' | 'pipeline' | 'management'

export interface UIViewSlotCounts {
  assistantCount: number
  clawfeedCount: number
  memoryCount: number
  enabledPlugins: number
  totalPlugins: number
  pipelineCount: number
}

export interface UIViewSlotPlugin {
  id: MainViewSlotId
  pluginId?: string
  /** Position of this view inside its tab bar (ascending). */
  order: number
  /**
   * Tab bar (top-level tab) this view belongs to. Views that register the SAME `tabBarId`
   * share ONE top-level tab; inside that tab they arrange themselves as sub-tabs by `order`.
   * Omit to give the view its own dedicated top-level tab (tab bar id defaults to the view id).
   */
  tabBarId?: string
  /** Top-level tab label when this view's tab bar is shown (first member with a `tabBarLabel` wins). */
  tabBarLabel?: ((lang: Lang, counts: UIViewSlotCounts) => string) | undefined
  /** Position of the shared tab bar among top-level tabs. Defaults to the smallest member `order`. */
  tabBarOrder?: number | undefined
  label: (lang: Lang, counts: UIViewSlotCounts) => string
}

/** A resolved top-level tab: one or more views sharing the same registered tab-bar name. */
export interface UIViewTabBarGroup {
  id: string
  order: number
  members: UIViewSlotPlugin[]
  label: (lang: Lang, counts: UIViewSlotCounts) => string
}

/** Groups visible views by their registered tab-bar name (`tabBarId`, defaulting to the view id). */
export function groupUIViewSlotsIntoTabBars(slots: readonly UIViewSlotPlugin[]): UIViewTabBarGroup[] {
  const byId = new Map<string, UIViewSlotPlugin[]>()
  for (const slot of slots) {
    const barId = slot.tabBarId ?? slot.id
    byId.set(barId, [...(byId.get(barId) ?? []), slot])
  }
  return [...byId.entries()]
    .map(([id, members]) => {
      const sorted = [...members].sort((a, b) => a.order - b.order)
      const labelMember = sorted.find(m => m.tabBarLabel) ?? sorted[0]!
      return {
        id,
        order: sorted.find(m => m.tabBarOrder !== undefined)?.tabBarOrder ?? Math.min(...sorted.map(m => m.order)),
        members: sorted,
        label: labelMember.tabBarLabel ?? labelMember.label,
      }
    })
    .sort((a, b) => a.order - b.order)
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
    // Long-Term Memory Library and SiYuan Knowledge Base register the SAME tab bar (`knowledge`):
    // the top bar shows one 「记忆与知识库」 tab and the two views arrange themselves inside it.
    id: 'memory-library',
    pluginId: 'dsh-memory',
    order: 30,
    tabBarId: 'knowledge',
    tabBarOrder: 30,
    tabBarLabel: (lang, c) =>
      lang === 'zh'
        ? `记忆与知识库 (${c.memoryCount})`
        : `Memory & Knowledge (${c.memoryCount})`,
    label: (lang, c) =>
      lang === 'zh'
        ? `🧠 长期记忆库 (${c.memoryCount})`
        : `🧠 Memory Library (${c.memoryCount})`,
  },
  {
    id: 'siyuan-kb',
    pluginId: 'dsh-personal-skills',
    order: 32,
    tabBarId: 'knowledge',
    tabBarLabel: (lang, c) =>
      lang === 'zh'
        ? `记忆与知识库 (${c.memoryCount})`
        : `Memory & Knowledge (${c.memoryCount})`,
    label: lang => (lang === 'zh' ? '📚 思源知识库' : '📚 SiYuan KB'),
  },
  {
    id: 'persona-ambient',
    pluginId: 'dsh-assistant-persona',
    order: 34,
    tabBarId: 'knowledge',
    tabBarLabel: lang => (lang === 'zh' ? '🧠 记忆与知识库' : '🧠 Memory & Knowledge'),
    tabBarOrder: 30,
    label: lang => (lang === 'zh' ? '🎭 人设·表情·城市' : '🎭 Persona · Stickers · City'),
  },
  {
    id: 'plugin-center',
    order: 35,
    label: (lang, c) =>
      lang === 'zh'
        ? `🧩 插件中心 (${c.enabledPlugins}/${c.totalPlugins})`
        : `🧩 Plugin Center (${c.enabledPlugins}/${c.totalPlugins})`,
  },
  {
    id: 'live-inspector',
    pluginId: 'ui-workbench',
    order: 38,
    label: lang => (lang === 'zh' ? '🔍 实时执行检视器' : '🔍 Live Inspector'),
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
  const privatePackSlotIds = new Set(['dsh-rhtoolkit', 'dsh-clawfeed', 'dsh-personal-skills'])
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
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    try { return JSON.parse(readTextDraft('pending-decision-answers') ?? '{}') as Record<string, string> } catch { return {} }
  })
  useEffect(() => {
    writeTextDraft('pending-decision-answers', Object.keys(drafts).length ? JSON.stringify(drafts) : '')
  }, [drafts])
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

const stickerObjectUrlCache = new Map<string, string>()

/** Renders a sticker image below a bot bubble, fetched through the authenticated standalone API and cached as an object URL. */
export function StickerImage({ sticker, lang }: { sticker: { id: string; name: string }; lang: Lang }): ReactNode {
  const [src, setSrc] = useState(() => stickerObjectUrlCache.get(sticker.id) ?? '')
  useEffect(() => {
    const cached = stickerObjectUrlCache.get(sticker.id)
    if (cached) { setSrc(cached); return }
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/orchestrator/standalone/assistant/stickers/${encodeURIComponent(sticker.id)}/content`, { headers: { 'x-orchestrator-request': '1' } })
        if (!res.ok) return
        const url = URL.createObjectURL(await res.blob())
        stickerObjectUrlCache.set(sticker.id, url)
        if (!cancelled) setSrc(url)
      } catch {}
    })()
    return () => { cancelled = true }
  }, [sticker.id])
  if (!src) return <span className="dt-hint">😀 {sticker.name}</span>
  return <img className="dt-chat-sticker" src={src} alt={sticker.name} title={sticker.name} loading="lazy" />
  void lang
}

/** 🎭 人设·表情·感知 workbench: Persona knobs, Sticker Gallery, Learned Knowledge, Home City / Weather / News.
 *  Rendered as a modal from the Personal Assistant header, or embedded as a full page under the
 *  「记忆与知识库」 tab bar's 🎭 人设·表情·城市 sub-tab (`embedded`). */
export function PersonaAmbientWorkbench({ lang, open, onClose, onAmbientChanged, embedded = false }: {
  lang: Lang
  open: boolean
  onClose: () => void
  onAmbientChanged?: ((ambient: AmbientSnapshotInfo) => void) | undefined
  embedded?: boolean
}): ReactNode {
  const [tab, setTab] = useState<'persona' | 'stickers' | 'learnings' | 'ambient'>('persona')
  const [state, setState] = useState<PersonaAmbientStateInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')
  const [draftConfig, setDraftConfig] = useState<AssistantPersonaConfigInfo | null>(null)
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null)
  /** The address text the currently selected city was resolved for (to detect stale reuse). */
  const [selectedCityFor, setSelectedCityFor] = useState('')
  const [addressLabel, setAddressLabel] = useTextDraft('persona:address-label')
  const [addressDraft, setAddressDraft] = useTextDraft('persona:address')
  const [addressPrimary, setAddressPrimary] = useState(false)
  const [cityCandidates, setCityCandidates] = useState<CityCandidateInfo[]>([])
  const [selectedCity, setSelectedCity] = useState<CityCandidateInfo | null>(null)
  const [searchingCity, setSearchingCity] = useState(false)
  const [amapKeyDraft, setAmapKeyDraft] = useState('')
  const [navFrom, setNavFrom] = useTextDraft('persona:nav-from')
  const [navTo, setNavTo] = useTextDraft('persona:nav-to')
  const [navMode, setNavMode] = useState<'driving' | 'transit' | 'bicycling' | 'walking'>('driving')
  const [navResult, setNavResult] = useState<NavigationResultInfo | null>(null)
  const [navBusy, setNavBusy] = useState(false)
  const [newLearning, setNewLearning] = useTextDraft('persona:new-learning')
  const [newLearningKind, setNewLearningKind] = useState<PersonaLearningInfo['kind']>('preference')
  const [stickerName, setStickerName] = useTextDraft('persona:sticker-name')
  const [stickerTags, setStickerTags] = useTextDraft('persona:sticker-tags')
  const stickerFileRef = useRef<HTMLInputElement>(null)
  const [stickerFolderInput, setStickerFolderInput] = useState<HTMLInputElement | null>(null)

  const load = async () => {
    setBusy(true); setErr('')
    try {
      const res = await standaloneFetch<PersonaAmbientStateInfo>('assistant/persona-state', 'GET')
      setState({ ...res, stickerTrash: res.stickerTrash ?? [], ambientConfig: { ...res.ambientConfig, residentAddresses: res.ambientConfig.residentAddresses ?? [] } })
      setDraftConfig(res.config)
      setSelectedCity(null)
      setSelectedCityFor('')
      setCityCandidates([])
      onAmbientChanged?.(res.ambient)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  useEffect(() => { if (open) void load() }, [open ])

  if (!open) return null
  const cfg = draftConfig ?? state?.config
  const savePersona = async () => {
    if (!cfg) return
    setBusy(true); setErr(''); setNotice('')
    try {
      const res = await standaloneFetch<{ config: AssistantPersonaConfigInfo }>('assistant/persona/config', 'PUT', { config: cfg })
      setDraftConfig(res.config)
      setState(curr => (curr ? { ...curr, config: res.config } : curr))
      setNotice(lang === 'zh' ? '✅ 人设已保存，下一回合生效' : '✅ Persona saved')
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const STICKER_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
  const isStickerImageFile = (file: File): boolean => {
    if (file.name.startsWith('.')) return false
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    return STICKER_IMAGE_EXTS.has(ext) || file.type.startsWith('image/')
  }
  /**
   * Batch upload used by both the multi-file picker and the whole-folder picker.
   * In folder mode it scans recursively (the browser flattens the tree into `files` with
   * `webkitRelativePath`), names each sticker after its file, tags it with its parent folder,
   * and skips non-image / >8MiB / duplicate files instead of aborting the whole batch.
   */
  const uploadStickers = async (files: File[], opts?: { fromFolder?: boolean }) => {
    if (!files.length) return
    const fromFolder = Boolean(opts?.fromFolder)
    const skippedNonImage = fromFolder ? files.filter(f => !isStickerImageFile(f)).length : 0
    const candidates = fromFolder ? files.filter(isStickerImageFile) : files
    if (!candidates.length) {
      setNotice(lang === 'zh' ? '这个文件夹里没扫到图片文件（支持 PNG / JPG / WebP / GIF）' : 'No image files found in that folder')
      return
    }
    setBusy(true); setErr(''); setNotice('')
    let added = 0
    let duplicated = 0
    let oversized = 0
    let failed = 0
    const seenIds = new Set((state?.stickers ?? []).map(s => s.id))
    const baseTags = stickerTags.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean)
    try {
      for (const file of candidates) {
        if (file.size > 8 * 1024 * 1024) { oversized++; continue }
        try {
          const loaded = await readAssistantImageFile(file)
          const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
          const parts = rel.split('/').filter(Boolean)
          const fileBase = (parts[parts.length - 1] ?? file.name).replace(/\.[^.]+$/, '') || '未命名表情'
          const parentFolder = fromFolder && parts.length > 1 ? parts[parts.length - 2]! : ''
          const res = await standaloneFetch<{ sticker: StickerInfo; stickers: StickerInfo[]; stickerTrash: StickerInfo[] }>('assistant/stickers', 'POST', {
            dataBase64: loaded.data,
            name: fromFolder ? fileBase.slice(0, 40) : (stickerName.trim() || fileBase),
            tags: [...new Set([...baseTags, ...(parentFolder ? [parentFolder.slice(0, 20)] : [])])],
          })
          if (seenIds.has(res.sticker.id)) duplicated++
          else { added++; seenIds.add(res.sticker.id) }
          setState(curr => (curr ? { ...curr, stickers: res.stickers, stickerTrash: res.stickerTrash ?? curr.stickerTrash } : curr))
        } catch { failed++ }
      }
    } finally { setBusy(false) }
    if (!fromFolder) { setStickerName(''); setStickerTags('') }
    const summary = [
      lang === 'zh' ? `✅ 成功加入 ${added} 张` : `✅ Added ${added}`,
      duplicated ? (lang === 'zh' ? `重复跳过 ${duplicated} 张` : `${duplicated} duplicates skipped`) : '',
      oversized ? (lang === 'zh' ? `超过 8MiB 跳过 ${oversized} 张` : `${oversized} over 8MiB skipped`) : '',
      skippedNonImage ? (lang === 'zh' ? `非图片跳过 ${skippedNonImage} 个` : `${skippedNonImage} non-images skipped`) : '',
      failed ? (lang === 'zh' ? `失败 ${failed} 张` : `${failed} failed`) : '',
    ].filter(Boolean).join(' · ')
    setNotice(added > 0 ? `${summary}${lang === 'zh' ? '，助理闲聊时就能发啦（GIF 动图原样保留）' : ''}` : summary)
  }
  /** Soft-delete into the 1-day trash (restorable); the file is only removed after 24h or via permanent delete. */
  const deleteSticker = async (s: StickerInfo) => {
    setBusy(true); setErr(''); setNotice('')
    try {
      const res = await standaloneFetch<{ stickers: StickerInfo[]; stickerTrash: StickerInfo[] }>(`assistant/stickers/${encodeURIComponent(s.id)}`, 'DELETE')
      setState(curr => (curr ? { ...curr, stickers: res.stickers, stickerTrash: res.stickerTrash ?? curr.stickerTrash } : curr))
      setNotice(lang === 'zh' ? `🗑 「${s.name}」已移入回收站，1 天内可恢复，过期自动彻底删除` : 'Moved to the 1-day trash')
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const restoreSticker = async (s: StickerInfo) => {
    setBusy(true); setErr('')
    try {
      const res = await standaloneFetch<{ stickers: StickerInfo[]; stickerTrash: StickerInfo[] }>(`assistant/stickers/${encodeURIComponent(s.id)}/restore`, 'POST', {})
      setState(curr => (curr ? { ...curr, stickers: res.stickers, stickerTrash: res.stickerTrash ?? curr.stickerTrash } : curr))
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const permanentlyDeleteSticker = async (s: StickerInfo) => {
    setBusy(true); setErr('')
    try {
      const res = await standaloneFetch<{ stickers: StickerInfo[]; stickerTrash: StickerInfo[] }>(`assistant/stickers/${encodeURIComponent(s.id)}/permanent`, 'DELETE')
      stickerObjectUrlCache.delete(s.id)
      setState(curr => (curr ? { ...curr, stickers: res.stickers, stickerTrash: res.stickerTrash ?? curr.stickerTrash } : curr))
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const saveStickerMeta = async (s: StickerInfo, patch: Partial<StickerInfo>) => {
    setBusy(true); setErr('')
    try {
      const res = await standaloneFetch<{ stickers: StickerInfo[] }>(`assistant/stickers/${encodeURIComponent(s.id)}`, 'PUT', patch)
      setState(curr => (curr ? { ...curr, stickers: res.stickers } : curr))
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const addLearning = async () => {
    if (!newLearning.trim()) return
    setBusy(true); setErr('')
    try {
      const res = await standaloneFetch<{ learnings: PersonaLearningInfo[] }>('assistant/persona/learnings', 'POST', { content: newLearning.trim(), kind: newLearningKind })
      setState(curr => (curr ? { ...curr, learnings: res.learnings } : curr))
      setNewLearning('')
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const updateLearning = async (entry: PersonaLearningInfo, patch: Partial<PersonaLearningInfo>) => {
    setBusy(true); setErr('')
    try {
      const res = await standaloneFetch<{ learnings: PersonaLearningInfo[] }>(`assistant/persona/learnings/${encodeURIComponent(entry.id)}`, 'PUT', patch)
      setState(curr => (curr ? { ...curr, learnings: res.learnings } : curr))
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const deleteLearning = async (entry: PersonaLearningInfo) => {
    setBusy(true); setErr('')
    try {
      const res = await standaloneFetch<{ learnings: PersonaLearningInfo[] }>(`assistant/persona/learnings/${encodeURIComponent(entry.id)}`, 'DELETE')
      setState(curr => (curr ? { ...curr, learnings: res.learnings } : curr))
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  /** Searches candidate cities for the address being added (detailed addresses degrade server-side to district/city). */
  const searchCities = async (): Promise<CityCandidateInfo[]> => {
    const q = addressDraft.trim()
    if (!q) return []
    setSearchingCity(true); setErr('')
    try {
      const res = await standaloneFetch<{ candidates: CityCandidateInfo[] }>(`assistant/ambient/geocode?q=${encodeURIComponent(q)}`, 'GET')
      setCityCandidates(res.candidates)
      if (res.candidates.length === 0) setErr(lang === 'zh' ? `没有从「${q}」解析出城市，试试在地址里带上城市名（如「上海市…」），或直接填城市名搜索。` : 'No city could be resolved from that address.')
      return res.candidates
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return [] } finally { setSearchingCity(false) }
  }
  const pickCity = (candidate: CityCandidateInfo) => {
    setSelectedCity(candidate)
    setSelectedCityFor(addressDraft.trim())
  }
  /** Persists the whole resident-address list (add/remove/set-primary/label edit all go through here). */
  const persistAddresses = async (list: ResidentAddressInfo[], noticeText?: string) => {
    if (!state) return
    setBusy(true); setErr('')
    try {
      const res = await standaloneFetch<{ config: PersonaAmbientStateInfo['ambientConfig']; ambient: AmbientSnapshotInfo }>('assistant/ambient/config', 'PUT', { residentAddresses: list })
      setState(curr => (curr ? { ...curr, ambientConfig: { ...res.config, residentAddresses: res.config.residentAddresses ?? [] }, ambient: res.ambient } : curr))
      onAmbientChanged?.(res.ambient)
      if (noticeText) setNotice(noticeText)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  /** Loads an existing address back into the form for editing (address text, label, city). */
  const startEditAddress = (addr: ResidentAddressInfo) => {
    setEditingAddressId(addr.id)
    setAddressLabel(addr.label)
    setAddressDraft(addr.address)
    setAddressPrimary(addr.isPrimary)
    // The stored city is reused as-is: editing the address text never forces a re-resolve.
    setSelectedCity({ name: addr.city.name, latitude: addr.city.latitude, longitude: addr.city.longitude, timezone: addr.city.timezone })
    setSelectedCityFor(addr.address)
    setCityCandidates([])
    setNotice(lang === 'zh' ? `✏️ 正在修改「${addr.label}」：直接改完点「保存修改」即可，不需要重新解析城市（除非地址换到了另一个城市）。` : `Editing ${addr.label}`)
  }
  const cancelEditAddress = () => {
    setEditingAddressId(null)
    setAddressLabel('')
    setAddressDraft('')
    setAddressPrimary(false)
    setSelectedCity(null)
    setSelectedCityFor('')
    setCityCandidates([])
  }
  const addAddress = async () => {
    if (!state || !addressDraft.trim()) return
    // City resolution is automatic, never a gate: a previously resolved/stored city is
    // reused as-is; only a brand-new address with several plausible candidates asks for a pick.
    let chosen = selectedCity
    if (!chosen) {
      const found = await searchCities()
      if (found.length === 1) chosen = found[0]!
      else if (found.length > 1) {
        setNotice(lang === 'zh' ? '🔎 这条地址能解析到不止一个地方，在下面列表里点选它所在的那一个就能保存（只在这一次需要）。' : 'Pick which candidate this address belongs to.')
        return
      } else {
        setErr(lang === 'zh' ? `没能从「${addressDraft.trim()}」解析出城市，检查一下地址是否完整（带上城市名）。` : 'Could not resolve a city from that address.')
        return
      }
    }
    const nowIso = new Date().toISOString()
    const current = state.ambientConfig.residentAddresses ?? []
    const city = { name: chosen.cityName ?? chosen.name, latitude: chosen.latitude, longitude: chosen.longitude, timezone: chosen.timezone }
    if (editingAddressId) {
      const original = current.find(a => a.id === editingAddressId)
      if (original) {
        const updated: ResidentAddressInfo = {
          ...original,
          label: addressLabel.trim() || original.label,
          address: addressDraft.trim(),
          city,
          isPrimary: addressPrimary || original.isPrimary,
          updatedAt: nowIso,
        }
        const list = current.map(a => (a.id === editingAddressId ? updated : updated.isPrimary ? { ...a, isPrimary: false } : a))
        await persistAddresses(list, lang === 'zh' ? `✅ 已修改常驻地址「${updated.label}」（城市：${updated.city.name}）` : '✅ Address updated')
        cancelEditAddress()
        return
      }
      setEditingAddressId(null)
    }
    const entry: ResidentAddressInfo = {
      id: `addr-new-${Date.now()}`,
      label: addressLabel.trim() || (lang === 'zh' ? '常驻地址' : 'Address'),
      address: addressDraft.trim(),
      city,
      isPrimary: addressPrimary || current.length === 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    }
    const list = current.map(a => (entry.isPrimary ? { ...a, isPrimary: false } : a))
    await persistAddresses([...list, entry], lang === 'zh' ? `✅ 已保存常驻地址「${entry.label}」（城市：${entry.city.name}${entry.isPrimary ? '，已设为主要地址，天气按此城市' : ''}）` : '✅ Address saved')
    setAddressDraft('')
    setSelectedCity(null)
    setSelectedCityFor('')
    setCityCandidates([])
  }
  const saveAmbientToggles = async () => {
    if (!state) return
    setBusy(true); setErr(''); setNotice('')
    try {
      const res = await standaloneFetch<{ config: PersonaAmbientStateInfo['ambientConfig']; ambient: AmbientSnapshotInfo }>('assistant/ambient/config', 'PUT', {
        weatherEnabled: state.ambientConfig.weatherEnabled,
        newsEnabled: state.ambientConfig.newsEnabled,
      })
      setState(curr => (curr ? { ...curr, ambientConfig: { ...res.config, residentAddresses: res.config.residentAddresses ?? curr.ambientConfig.residentAddresses ?? [] }, ambient: res.ambient } : curr))
      onAmbientChanged?.(res.ambient)
      setNotice(lang === 'zh' ? '✅ 感知开关已保存' : '✅ Settings saved')
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const saveAmapKey = async () => {
    if (!amapKeyDraft.trim()) return
    setBusy(true); setErr(''); setNotice('')
    try {
      const res = await standaloneFetch<{ amapConfigured: boolean }>('assistant/ambient/amap-key', 'PUT', { apiKey: amapKeyDraft.trim() })
      setState(curr => (curr ? { ...curr, amapConfigured: res.amapConfigured } : curr))
      setAmapKeyDraft('')
      setNotice(lang === 'zh' ? '✅ 高德 Key 已保存，导航可直接报时长/路况了' : '✅ Amap key saved')
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const clearAmapKey = async () => {
    setBusy(true); setErr('')
    try {
      const res = await standaloneFetch<{ amapConfigured: boolean }>('assistant/ambient/amap-key', 'DELETE')
      setState(curr => (curr ? { ...curr, amapConfigured: res.amapConfigured } : curr))
      setNotice(lang === 'zh' ? '已清除保存的高德 Key（若设了环境变量 RHARNESS_AMAP_KEY 则仍以它为准）' : 'Amap key cleared')
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const queryNavigation = async (override?: { to: string; toLabel?: string }) => {
    const to = (override?.to ?? navTo).trim()
    if (!to) return
    setNavBusy(true); setErr('')
    try {
      const params = new URLSearchParams({ to, mode: navMode, ...(navFrom.trim() ? { from: navFrom.trim() } : {}), ...(override?.toLabel ? { toLabel: override.toLabel } : {}) })
      const res = await standaloneFetch<NavigationResultInfo>(`assistant/navigation/route?${params.toString()}`, 'GET')
      setNavResult(res)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setNavBusy(false) }
  }
  const refreshAmbient = async () => {
    setBusy(true); setErr('')
    try {
      const res = await standaloneFetch<PersonaAmbientStateInfo>('assistant/ambient/refresh', 'POST', {})
      setState(curr => (curr ? { ...curr, ambient: res.ambient, news: res.news, ambientConfig: res.ambientConfig ?? curr.ambientConfig } : curr))
      onAmbientChanged?.(res.ambient)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const body = (
      <div className="dt-form">
        <div className="dt-persona-tabs" role="tablist">
          {([['persona', '🎭 人设风格'], ['stickers', `😀 表情包图库 (${state?.stickers.length ?? 0})`], ['learnings', `🧠 已学默契 (${state?.learnings.length ?? 0})`], ['ambient', '🌦 感知与城市']] as const).map(([id, label]) => (
            <Button key={id} size="sm" variant={tab === id ? 'primary' : 'outline'} onClick={() => setTab(id)} data-testid={`persona-tab-${id}`}>{label}</Button>
          ))}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void load() }}>{lang === 'zh' ? '↻ 刷新' : 'Refresh'}</Button>
        </div>
        {err && <p className="dt-error" role="status">{err}</p>}
        {notice && <p className="dt-hint" role="status">{notice}</p>}
        {!state || !cfg ? <p className="dt-hint">{lang === 'zh' ? '加载中…' : 'Loading…'}</p> : tab === 'persona' ? (
          <div className="dt-form" data-testid="persona-panel">
            <div className="dt-persona-presets">
              {state.presets.map(p => (
                <button key={p.id} type="button" className="dt-persona-preset" data-active={cfg.presetId === p.id} onClick={() => setDraftConfig({ ...cfg, presetId: p.id })}>
                  <strong>{p.label[lang]}</strong><span>{p.description[lang]}</span>
                </button>
              ))}
            </div>
            <div className="dt-persona-grid">
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '助理名字/自称' : 'Assistant name'}</span><Input value={cfg.assistantName} onChange={e => setDraftConfig({ ...cfg, assistantName: e.target.value })} /></label>
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '如何称呼你' : 'Calls you'}</span><Input value={cfg.userAddress} onChange={e => setDraftConfig({ ...cfg, userAddress: e.target.value })} /></label>
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '回复长度' : 'Verbosity'}</span><select className="dt-select" value={cfg.verbosity} onChange={e => setDraftConfig({ ...cfg, verbosity: e.target.value as AssistantPersonaConfigInfo['verbosity'] })}><option value="brief">简短</option><option value="balanced">适中</option><option value="detailed">详细</option></select></label>
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '颜文字密度' : 'Kaomoji'}</span><select className="dt-select" value={cfg.kaomojiDensity} onChange={e => setDraftConfig({ ...cfg, kaomojiDensity: e.target.value as AssistantPersonaConfigInfo['kaomojiDensity'] })}><option value="off">关闭</option><option value="light">适度 (｡•̀ᴗ-)✧</option><option value="rich">丰富 Σ(っ °Д °;)っ</option></select></label>
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '玩梗程度' : 'Humor'}</span><select className="dt-select" value={cfg.humorLevel} onChange={e => setDraftConfig({ ...cfg, humorLevel: e.target.value as AssistantPersonaConfigInfo['humorLevel'] })}><option value="off">不玩梗</option><option value="light">轻度接梗</option><option value="lively">活泼玩梗</option></select></label>
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '表情包频率' : 'Stickers'}</span><select className="dt-select" value={cfg.stickerFrequency} onChange={e => setDraftConfig({ ...cfg, stickerFrequency: e.target.value as AssistantPersonaConfigInfo['stickerFrequency'] })}><option value="off">不发表情包</option><option value="occasional">偶尔发</option><option value="lively">经常发</option></select></label>
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '表情冷却（回合）' : 'Sticker cooldown (turns)'}</span><Input type="number" min={0} max={10} value={String(cfg.stickerCooldownTurns)} onChange={e => setDraftConfig({ ...cfg, stickerCooldownTurns: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })} /></label>
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '自动学习相处默契' : 'Auto-learning'}</span><select className="dt-select" value={cfg.learningEnabled ? 'on' : 'off'} onChange={e => setDraftConfig({ ...cfg, learningEnabled: e.target.value === 'on' })}><option value="on">开启（自动生效，可在「已学默契」增删）</option><option value="off">关闭</option></select></label>
            </div>
            <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '自定义风格要求（可选）' : 'Custom style instructions'}</span><textarea className="dt-textarea" rows={3} value={cfg.customInstructions} onChange={e => setDraftConfig({ ...cfg, customInstructions: e.target.value })} placeholder={lang === 'zh' ? '例如：闲聊别列 1/2/3 点；报数据时必须带来源' : ''} /></label>
            <div className="dt-row-buttons"><Button variant="primary" disabled={busy} onClick={() => { void savePersona() }}>{lang === 'zh' ? '💾 保存人设' : 'Save persona'}</Button></div>
          </div>
        ) : tab === 'stickers' ? (
          <div className="dt-form" data-testid="sticker-gallery-panel">
            <p className="dt-hint">{lang === 'zh' ? '你上传的表情包保存在 ~/.rharness/stickers/，支持 PNG / JPG / WebP / GIF（动图原样保留）。点「📁 上传整个文件夹」会递归扫描文件夹里所有图片：每张以文件名命名、自动带上所在子文件夹名作标签，重复图自动跳过；上传完在这儿删多余的就行——删除先进回收站保留 1 天可恢复，过期自动彻底清除。也可以在对话里给助理发图说「存为表情包」，或让它恢复/删除。' : 'Upload single images or a whole folder (recursive scan). Deletes go to a 1-day trash first.'}</p>
            <div className="dt-persona-grid">
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '新表情名字（上传时使用）' : 'Name for uploads'}</span><Input value={stickerName} onChange={e => setStickerName(e.target.value)} placeholder="摸鱼" /></label>
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '标签（逗号分隔，助理按标签选图）' : 'Tags'}</span><Input value={stickerTags} onChange={e => setStickerTags(e.target.value)} placeholder="开心, 日常" /></label>
            </div>
            <input ref={stickerFileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={e => { const f = Array.from(e.target.files ?? []); e.target.value = ''; void uploadStickers(f) }} />
            <input type="file" multiple hidden data-testid="sticker-folder-input" ref={el => { setStickerFolderInput(el); if (el) { el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', '') } }} onChange={e => { const f = Array.from(e.target.files ?? []); e.target.value = ''; void uploadStickers(f, { fromFolder: true }) }} />
            <div className="dt-row-buttons">
              <Button variant="primary" disabled={busy} onClick={() => stickerFileRef.current?.click()} data-testid="sticker-upload-btn">{lang === 'zh' ? '⬆ 上传表情包图片（可多选）' : 'Upload stickers'}</Button>
              <Button variant="outline" disabled={busy} onClick={() => stickerFolderInput?.click()} data-testid="sticker-folder-upload-btn">{lang === 'zh' ? '📁 上传整个文件夹（自动扫描）' : '📁 Upload a whole folder'}</Button>
            </div>
            {state.stickers.length === 0 ? <p className="dt-hint">{lang === 'zh' ? '图库还是空的，上传第一张表情包吧~' : 'No stickers yet.'}</p> : (
              <div className="dt-sticker-grid">
                {state.stickers.map(s => (
                  <div key={s.id} className="dt-sticker-card" data-testid={`sticker-card-${s.id}`}>
                    <StickerImage sticker={s} lang={lang} />
                    <Input value={s.name} disabled={busy} onChange={e => setState(curr => (curr ? { ...curr, stickers: curr.stickers.map(x => x.id === s.id ? { ...x, name: e.target.value } : x) } : curr))} onBlur={e => { void saveStickerMeta(s, { name: e.target.value }) }} />
                    <Input value={s.tags.join(', ')} disabled={busy} placeholder={lang === 'zh' ? '标签' : 'Tags'} onChange={e => setState(curr => (curr ? { ...curr, stickers: curr.stickers.map(x => x.id === s.id ? { ...x, tags: e.target.value.split(/[,，]/).map(t => t.trim()).filter(Boolean) } : x) } : curr))} onBlur={e => { void saveStickerMeta(s, { tags: e.target.value.split(/[,，]/).map(t => t.trim()).filter(Boolean) }) }} />
                    <span className="dt-hint">{s.emotion ? `${s.emotion} · ` : ''}{(s.sizeBytes / 1024).toFixed(0)} KB · {lang === 'zh' ? '已发' : 'used'} {s.useCount} {lang === 'zh' ? '次' : 'x'}</span>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void deleteSticker(s) }} data-testid={`sticker-delete-${s.id}`} title={lang === 'zh' ? '移入回收站：1 天内可恢复，过期自动彻底删除' : 'Move to 1-day trash'}>{lang === 'zh' ? '🗑 移入回收站' : 'Trash'}</Button>
                  </div>
                ))}
              </div>
            )}
            {(state.stickerTrash?.length ?? 0) > 0 && (
              <div className="dt-form" data-testid="sticker-trash-panel">
                <strong>{lang === 'zh' ? `🗑 回收站（${state.stickerTrash.length} 张 · 删除后保留 1 天，过期自动彻底清除）` : `🗑 Trash (${state.stickerTrash.length} · auto-purged after 1 day)`}</strong>
                <div className="dt-sticker-grid">
                  {state.stickerTrash.map(s => {
                    const purgeMs = s.purgeAt ? Date.parse(s.purgeAt) : NaN
                    const remainHours = Number.isFinite(purgeMs) ? Math.max(0, (purgeMs - Date.now()) / 3600000) : 24
                    const remainLabel = remainHours >= 1 ? `${remainHours.toFixed(remainHours >= 10 ? 0 : 1)} ${lang === 'zh' ? '小时' : 'h'}` : `${Math.max(1, Math.round(remainHours * 60))} ${lang === 'zh' ? '分钟' : 'min'}`
                    return (
                      <div key={s.id} className="dt-sticker-card" data-testid={`sticker-trash-card-${s.id}`}>
                        <StickerImage sticker={s} lang={lang} />
                        <strong>{s.name}</strong>
                        <span className="dt-hint">{lang === 'zh' ? `还剩 ${remainLabel} 后彻底删除` : `Permanently deleted in ${remainLabel}`}</span>
                        <div className="dt-row-buttons">
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => { void restoreSticker(s) }} data-testid={`sticker-restore-${s.id}`}>{lang === 'zh' ? '♻️ 恢复' : 'Restore'}</Button>
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void permanentlyDeleteSticker(s) }} data-testid={`sticker-permanent-${s.id}`}>{lang === 'zh' ? '❌ 彻底删除' : 'Delete forever'}</Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        ) : tab === 'learnings' ? (
          <div className="dt-form" data-testid="persona-learnings-panel">
            <p className="dt-hint">{lang === 'zh' ? '助理从对话里自动学到的说话风格/称呼/偏好会立刻生效并记录在这里，随时可改、可删、可停用。你也可以直接新增，或在聊天里说「记住：…」「忘掉你学的…那条」。' : 'Auto-applied learnings. Edit, disable, or delete anytime.'}</p>
            <div className="dt-persona-grid">
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '新增一条默契' : 'New learning'}</span><Input value={newLearning} onChange={e => setNewLearning(e.target.value)} placeholder={lang === 'zh' ? '例如：闲聊时简短一点，多用颜文字' : ''} /></label>
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '类型' : 'Kind'}</span><select className="dt-select" value={newLearningKind} onChange={e => setNewLearningKind(e.target.value as PersonaLearningInfo['kind'])}><option value="style">说话风格</option><option value="address">称呼</option><option value="preference">偏好</option><option value="rapport">相处默契</option><option value="boundary">雷区/边界</option></select></label>
            </div>
            <div className="dt-row-buttons"><Button variant="primary" disabled={busy || !newLearning.trim()} onClick={() => { void addLearning() }}>{lang === 'zh' ? '➕ 添加并生效' : 'Add'}</Button></div>
            {state.learnings.length === 0 ? <p className="dt-hint">{lang === 'zh' ? '还没有学到任何默契。' : 'No learnings yet.'}</p> : (
              <div className="dt-learning-list">
                {state.learnings.map(entry => (
                  <div key={entry.id} className="dt-learning-row" data-testid={`learning-row-${entry.id}`}>
                    <Tag tone={entry.enabled ? 'success' : 'neutral'}>{entry.kind}</Tag>
                    <Input value={entry.content} disabled={busy} onChange={e => setState(curr => (curr ? { ...curr, learnings: curr.learnings.map(x => x.id === entry.id ? { ...x, content: e.target.value } : x) } : curr))} onBlur={e => { void updateLearning(entry, { content: e.target.value }) }} />
                    <span className="dt-hint">{entry.source === 'auto' ? '自动学习' : entry.source === 'agent' ? '助理记录' : '手动添加'} · {formatSmartTimestamp(entry.createdAt, lang)}</span>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => { void updateLearning(entry, { enabled: !entry.enabled }) }}>{entry.enabled ? '停用' : '启用'}</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void deleteLearning(entry) }} data-testid={`learning-delete-${entry.id}`}>🗑 删除</Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="dt-form" data-testid="ambient-panel">
            <div className="dt-ambient-card">
              <strong>{state.ambient.oneLiner}</strong>
              <span className="dt-hint">{state.ambient.beijingTime} · {state.ambient.period} · 农历{state.ambient.lunarDate} · {state.ambient.solarTerm.current}（距{state.ambient.solarTerm.next} {state.ambient.solarTerm.daysToNext} 天）· {state.ambient.dayType === 'workday' ? '工作日' : '休息日'}（{state.ambient.dayReason}）</span>
              {state.ambient.weather && <span>{state.ambient.weather.oneLiner}{state.ambient.weatherStale ? '（缓存稍旧，点刷新更新）' : ''}</span>}
            </div>
            <strong>{lang === 'zh' ? `🏠 常驻地址（可存多个 · 天气基准城市：${state.ambientConfig.homeCity.name}）` : '🏠 Resident addresses'}</strong>
            {(state.ambientConfig.residentAddresses ?? []).length === 0 ? (
              <p className="dt-hint">{lang === 'zh' ? '还没有常驻地址。在下面填详细地址（如「上海市徐汇区梅陇十一村46号401」）、解析出所在城市后保存；可以存多个（家、公司、老家…），主要地址的城市用作天气基准。助理也会知道这些地址（通勤/外卖/附近生活场景），但不会主动复述门牌号。' : 'No resident addresses yet. Add detailed addresses below; the primary one sets the weather city.'}</p>
            ) : (
              <div className="dt-learning-list">
                {(state.ambientConfig.residentAddresses ?? []).map(addr => (
                  <div key={addr.id} className="dt-learning-row" data-testid={`ambient-address-row-${addr.id}`}>
                    <Tag tone={addr.isPrimary ? 'success' : 'neutral'}>{addr.isPrimary ? (lang === 'zh' ? '主要 · 天气基准' : 'Primary') : (lang === 'zh' ? '常驻' : 'Saved')}</Tag>
                    <Input value={addr.label} disabled={busy} onChange={e => setState(curr => (curr ? { ...curr, ambientConfig: { ...curr.ambientConfig, residentAddresses: (curr.ambientConfig.residentAddresses ?? []).map(x => x.id === addr.id ? { ...x, label: e.target.value } : x) } } : curr))} onBlur={e => { void persistAddresses((state.ambientConfig.residentAddresses ?? []).map(x => x.id === addr.id ? { ...x, label: e.target.value } : x)) }} />
                    <span>{addr.address}</span>
                    <span className="dt-hint">📍 {addr.city.name}</span>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => startEditAddress(addr)} data-testid={`ambient-address-edit-${addr.id}`}>{lang === 'zh' ? '✏️ 修改' : 'Edit'}</Button>
                    {!addr.isPrimary && <Button size="sm" variant="outline" disabled={busy} onClick={() => { void persistAddresses((state.ambientConfig.residentAddresses ?? []).map(x => ({ ...x, isPrimary: x.id === addr.id })), lang === 'zh' ? `✅ 主要地址已切换为「${addr.label}」，天气城市：${addr.city.name}` : 'Primary switched') }} data-testid={`ambient-address-primary-${addr.id}`}>{lang === 'zh' ? '设为主要' : 'Make primary'}</Button>}
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void persistAddresses((state.ambientConfig.residentAddresses ?? []).filter(x => x.id !== addr.id), lang === 'zh' ? `已删除常驻地址「${addr.label}」` : 'Address deleted') }} data-testid={`ambient-address-delete-${addr.id}`}>🗑 删除</Button>
                  </div>
                ))}
              </div>
            )}
            {editingAddressId && <p className="dt-hint" data-testid="ambient-editing-hint">{lang === 'zh' ? '✏️ 正在修改一条已有地址（改完点「保存修改」原地替换，不会新增一条）。只改称呼也可以直接在上面列表里改。' : 'Editing an existing address.'}</p>}
            <div className="dt-persona-grid">
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '地址称呼' : 'Label'}</span><Input value={addressLabel} onChange={e => setAddressLabel(e.target.value)} data-testid="ambient-address-label-input" placeholder={lang === 'zh' ? '家 / 公司 / 老家…' : 'Home / Office…'} /></label>
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '详细地址（可写到门牌号）' : 'Detailed address'}</span><Input value={addressDraft} onChange={e => setAddressDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void searchCities() } }} data-testid="ambient-address-input" placeholder={lang === 'zh' ? '上海市徐汇区梅陇十一村46号401' : 'Street address…'} /></label>
            </div>
            <div className="dt-row-buttons">
              <Button variant="outline" disabled={busy || searchingCity || !addressDraft.trim()} onClick={() => { void searchCities() }} data-testid="ambient-search-city-btn">{searchingCity ? (lang === 'zh' ? '解析中…' : 'Resolving…') : (lang === 'zh' ? '🔍 解析所在城市' : '🔍 Resolve city')}</Button>
              {selectedCity && <Tag tone="success">{lang === 'zh' ? `所在城市：${selectedCity.cityName ?? selectedCity.name}${selectedCityFor && addressDraft.trim() !== selectedCityFor ? '（沿用已解析的，保存直接生效）' : ''}` : `City: ${selectedCity.cityName ?? selectedCity.name}`}</Tag>}
              <label className="dt-hint"><input type="checkbox" checked={addressPrimary} onChange={e => setAddressPrimary(e.target.checked)} /> {lang === 'zh' ? '设为主要地址（天气按它的城市）' : 'Make primary (weather city)'}</label>
              <Button variant="primary" disabled={busy || !addressDraft.trim()} onClick={() => { void addAddress() }} data-testid="ambient-add-address-btn">{editingAddressId ? (lang === 'zh' ? '💾 保存修改' : '💾 Save changes') : (lang === 'zh' ? '➕ 保存这个地址' : '➕ Save address')}</Button>
              {editingAddressId && <Button variant="ghost" disabled={busy} onClick={cancelEditAddress} data-testid="ambient-cancel-edit-btn">{lang === 'zh' ? '取消修改' : 'Cancel'}</Button>}
            </div>
            {cityCandidates.length > 0 && (
              <div className="dt-form" data-testid="ambient-city-candidates">
                <strong>{lang === 'zh' ? '解析到以下位置，点选这条地址所在的那一个（选中后保存才生效）：' : 'Pick the matching place:'}</strong>
                <div className="dt-row-buttons">
                  {cityCandidates.map((c, idx) => (
                    <Button key={`${c.name}-${c.latitude}-${c.longitude}`} size="sm" variant={selectedCity === c ? 'primary' : 'outline'} onClick={() => pickCity(c)} data-testid={`ambient-city-candidate-${idx}`}>
                      📍 {c.name}{c.address ? ` · ${c.address}` : ''}{c.admin1 && c.admin1 !== c.name ? ` · ${c.admin1}` : ''}{!c.address && c.country ? ` · ${c.country}` : ''}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <div className="dt-persona-grid">
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '天气感知' : 'Weather'}</span><select className="dt-select" value={state.ambientConfig.weatherEnabled ? 'on' : 'off'} onChange={e => setState(curr => (curr ? { ...curr, ambientConfig: { ...curr.ambientConfig, weatherEnabled: e.target.value === 'on' } } : curr))}><option value="on">开启（每45分钟刷新）</option><option value="off">关闭</option></select></label>
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '新闻感知' : 'News'}</span><select className="dt-select" value={state.ambientConfig.newsEnabled ? 'on' : 'off'} onChange={e => setState(curr => (curr ? { ...curr, ambientConfig: { ...curr.ambientConfig, newsEnabled: e.target.value === 'on' } } : curr))}><option value="on">开启（问新闻时用 news_brief）</option><option value="off">关闭</option></select></label>
            </div>
            <p className="dt-hint">{lang === 'zh' ? '💡 也可以直接在聊天里对助理说「记住我家在上海市徐汇区…」「把常驻城市改成上海」，和这里完全同步。' : 'Tip: tell the Assistant your address in chat — same store.'}</p>
            <div className="dt-row-buttons">
              <Button variant="primary" disabled={busy} onClick={() => { void saveAmbientToggles() }} data-testid="ambient-save-settings-btn">{lang === 'zh' ? '💾 保存感知开关' : 'Save toggles'}</Button>
              <Button variant="outline" disabled={busy} onClick={() => { void refreshAmbient() }}>{lang === 'zh' ? '↻ 立即刷新天气与新闻' : 'Refresh now'}</Button>
            </div>
            <strong>{lang === 'zh' ? '🧭 导航与路线（高德）' : '🧭 Navigation (Amap)'}</strong>
            <div className="dt-persona-grid">
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '高德地图 Key（Web 服务）' : 'Amap API key'}</span><Input type="password" value={amapKeyDraft} onChange={e => setAmapKeyDraft(e.target.value)} data-testid="amap-key-input" placeholder={state.amapConfigured ? (lang === 'zh' ? '已配置（输入可覆盖）' : 'Configured') : (lang === 'zh' ? '未配置：填入后助理能直接报时长/路况' : 'Not configured')} /></label>
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '状态' : 'Status'}</span><span>{state.amapConfigured ? <Tag tone="success">{lang === 'zh' ? '已配置 · 路线数据可用' : 'Configured'}</Tag> : <Tag tone="neutral">{lang === 'zh' ? '未配置 · 仅导航链接' : 'Links only'}</Tag>}</span></label>
            </div>
            <p className="dt-hint">{lang === 'zh' ? '在 lbs.amap.com 免费申请「Web 服务」Key 后填入（个人额度足够）。配置后：助理可直接回答「我回家要多久」并给实时路况时长；地址解析也升级为高德门牌级定位。未配置时导航自动降级为高德/百度跳转链接。Key 只保存在本机、不会回显；查询路线时会把起终点地址发给高德。' : 'Get a free Amap Web-Service key at lbs.amap.com. Without one, navigation falls back to map links.'}</p>
            <div className="dt-row-buttons">
              <Button variant="primary" disabled={busy || !amapKeyDraft.trim()} onClick={() => { void saveAmapKey() }} data-testid="amap-key-save-btn">{lang === 'zh' ? '💾 保存 Key' : 'Save key'}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => { void clearAmapKey() }} data-testid="amap-key-clear-btn">{lang === 'zh' ? '清除' : 'Clear'}</Button>
            </div>
            <div className="dt-persona-grid">
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '起点（默认主要地址）' : 'From'}</span><Input value={navFrom} onChange={e => setNavFrom(e.target.value)} data-testid="nav-from-input" placeholder={(state.ambientConfig.residentAddresses ?? []).map(a => a.label).join(' / ') || (lang === 'zh' ? '家 / 公司 / 任意地址' : 'Home / Office / address')} /></label>
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '终点' : 'To'}</span><Input value={navTo} onChange={e => setNavTo(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void queryNavigation() } }} data-testid="nav-to-input" placeholder={lang === 'zh' ? '目的地：地址、地点名或 家/公司' : 'Destination'} /></label>
              <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '出行方式' : 'Mode'}</span><select className="dt-select" value={navMode} onChange={e => setNavMode(e.target.value as 'driving' | 'transit' | 'bicycling' | 'walking')} data-testid="nav-mode-select"><option value="driving">🚗 驾车（含实时路况）</option><option value="transit">🚇 公交/地铁</option><option value="bicycling">🚴 骑行</option><option value="walking">🚶 步行</option></select></label>
            </div>
            <div className="dt-row-buttons">
              <Button variant="primary" disabled={navBusy || !navTo.trim()} onClick={() => { void queryNavigation() }} data-testid="nav-query-btn">{navBusy ? (lang === 'zh' ? '规划中…' : 'Planning…') : (lang === 'zh' ? '🧭 查询路线' : '🧭 Plan route')}</Button>
            </div>
            {navResult && (
              <div className="dt-ambient-card" data-testid="nav-result">
                <strong>{navResult.origin.label} → {navResult.destination.label}{navResult.distanceKm !== undefined ? ` · ${navResult.distanceKm} km` : ''}{navResult.durationText ? ` · ${navResult.durationText}` : ''}</strong>
                {navResult.note && <span className="dt-hint">{navResult.note}</span>}
                {navResult.needsConfirmation && (navResult.candidates?.length ?? 0) > 0 && (
                  <div className="dt-row-buttons" data-testid="nav-candidates">
                    {navResult.candidates!.map((c, idx) => (
                      <Button key={`${c.name}-${c.longitude}-${c.latitude}`} size="sm" variant="outline" disabled={navBusy} onClick={() => { void queryNavigation({ to: `${c.longitude},${c.latitude}`, toLabel: c.name }) }} data-testid={`nav-candidate-${idx}`}>
                        📍 {c.name}{c.address ? ` · ${c.address}` : ''}{c.district ? ` · ${c.district}` : ''}
                      </Button>
                    ))}
                  </div>
                )}
                {navResult.steps.length > 0 && (
                  <ol className="dt-news-list">
                    {navResult.steps.map((s, i) => <li key={i} className="dt-news-item"><span>{s}</span></li>)}
                  </ol>
                )}
                <div className="dt-row-buttons">
                  {navResult.links.amap && <a className="dt-pill" href={navResult.links.amap} target="_blank" rel="noreferrer" data-testid="nav-link-amap">{lang === 'zh' ? '📍 高德地图导航' : 'Amap'}</a>}
                  <a className="dt-pill" href={navResult.links.baidu} target="_blank" rel="noreferrer" data-testid="nav-link-baidu">{lang === 'zh' ? '📍 百度地图导航' : 'Baidu'}</a>
                </div>
              </div>
            )}
            <strong>{lang === 'zh' ? '📰 最近新闻缓存（问助理「最近有什么新闻」也会用这份）' : '📰 Cached headlines'}</strong>
            {state.news.items.length === 0 ? <p className="dt-hint">{lang === 'zh' ? '暂无缓存，点击「立即刷新」拉取。' : 'No cached news yet.'}</p> : (
              <div className="dt-news-list">
                {state.news.items.slice(0, 10).map((n, i) => (
                  <a key={i} className="dt-news-item" href={n.url} target="_blank" rel="noreferrer"><Tag tone="info">{n.topic}</Tag><span>{n.title}</span><span className="dt-hint">{n.source}</span></a>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
  )
  if (embedded) {
    return (
      <section id="persona-ambient-page" className="dt-live-workspace" aria-label={lang === 'zh' ? '人设、表情包与常驻城市维护' : 'Persona, stickers and home city maintenance'}>
        <div className="dt-live-head">
          <div>
            <h2>{lang === 'zh' ? '🎭 人设 · 表情包 · 已学默契 · 环境感知' : '🎭 Persona · Stickers · Learnings · Ambient'}</h2>
            <span className="dt-hint">{lang === 'zh' ? '维护个人助理的人设风格、表情包图库、已学默契与常驻地址（可多个，主要地址的城市作天气基准）。与个人助理完全同步，改完即生效；助理自己也能通过工具修改同样的内容。' : 'Maintain the Personal Assistant persona, sticker gallery, learnings and resident addresses. Fully in sync with the Assistant.'}</span>
          </div>
        </div>
        {body}
      </section>
    )
  }
  return (
    <Modal className="dt-fullscreen-modal" open={open} onClose={onClose} title={lang === 'zh' ? '🎭 人设 · 表情包 · 已学默契 · 环境感知' : '🎭 Persona · Stickers · Learnings · Ambient'} closeLabel={lang === 'zh' ? '关闭 (ESC)' : 'Close (ESC)'} description={lang === 'zh' ? '仅作用于个人助理（不影响工程 Eval / Worker）。这里能改的，助理自己也能通过工具改。' : 'Personal Assistant only. Everything here is also editable by the Assistant via tools.'} footer={<Button size="sm" variant="primary" onClick={onClose}>{lang === 'zh' ? '完成' : 'Done'}</Button>}>
      {body}
    </Modal>
  )
}

export function PersonalAssistantSlotView(props: {
  lang: Lang
  messages: AssistantMessageInfo[]
  liveRun?: LiveSessionRunInfo | null | undefined
  ambient?: AmbientSnapshotInfo | undefined
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
    ambient,
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
  // Composer draft (text + images) persists locally like the Engineering Chat panel drafts: refresh-safe.
  const [draft, setDraft] = useTextDraft('assistant:main')
  const [handoffAnswerDrafts, setHandoffAnswerDrafts] = useState<Record<string, string>>(() => {
    try { return JSON.parse(readTextDraft('assistant:handoff-answers') ?? '{}') as Record<string, string> } catch { return {} }
  })
  useEffect(() => {
    writeTextDraft('assistant:handoff-answers', Object.keys(handoffAnswerDrafts).length ? JSON.stringify(handoffAnswerDrafts) : '')
  }, [handoffAnswerDrafts])
  const [images, setImages] = useState<AssistantImageDraft[]>([])
  const assistantImagesLoaded = useRef(false)
  useEffect(() => {
    readPanelDraftImages('claw-assistant-main')
      .then(restored => { setImages(restored); assistantImagesLoaded.current = true })
      .catch(() => { assistantImagesLoaded.current = true })
  }, [])
  useEffect(() => {
    if (assistantImagesLoaded.current) void writePanelDraftImages('claw-assistant-main', images).catch(() => {})
  }, [images])
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
  const [personaWorkbenchOpen, setPersonaWorkbenchOpen] = useState(false)
  const [ambientOverride, setAmbientOverride] = useState<AmbientSnapshotInfo | undefined>()
  const [stickerSaveFor, setStickerSaveFor] = useState<{ messageId: string; imageIndex: number } | null>(null)
  const [stickerSaveName, setStickerSaveName] = useTextDraft('assistant:sticker-save-name')
  const [stickerSaveTags, setStickerSaveTags] = useTextDraft('assistant:sticker-save-tags')
  const [actingChangeId, setActingChangeId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const displayAmbient = ambientOverride ?? ambient

  const actOnPersistenceChange = async (changeId: string, action: 'approve' | 'reject' | 'undo') => {
    setActingChangeId(changeId)
    setError(null)
    try {
      await standaloneFetch(`assistant/persistence-changes/${encodeURIComponent(changeId)}/${action}`, 'POST', {})
      await onRefresh()
      try {
        const amb = await standaloneFetch<{ ambient: AmbientSnapshotInfo }>('assistant/ambient', 'GET')
        setAmbientOverride(amb.ambient)
      } catch {}
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setActingChangeId(null)
    }
  }

  const saveImageAsSticker = async () => {
    if (!stickerSaveFor || !stickerSaveName.trim()) return
    setBusy(true); setError(null)
    try {
      await standaloneFetch('assistant/stickers/from-message', 'POST', {
        messageId: stickerSaveFor.messageId,
        imageIndex: stickerSaveFor.imageIndex,
        name: stickerSaveName.trim(),
        tags: stickerSaveTags.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean),
      })
      setStickerSaveFor(null); setStickerSaveName(''); setStickerSaveTags('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }
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
            {displayAmbient && (
              <button type="button" className="dt-ambient-pill" data-testid="assistant-ambient-pill" onClick={() => setPersonaWorkbenchOpen(true)} title={lang === 'zh' ? '常驻城市 / 天气 / 农历节气（点击打开「感知与城市」设置，助理也能自己改）' : 'Home city / weather / lunar (click to open Ambient settings)'}>
                {displayAmbient.oneLiner}
              </button>
            )}
          </div>
          <div className="dt-row-buttons">
            <Button size="sm" variant="outline" onClick={() => setPersonaWorkbenchOpen(true)} data-testid="assistant-persona-btn" title={lang === 'zh' ? '人设风格、表情包图库、已学默契、常驻城市与新闻感知（助理也能通过工具自己改）' : 'Persona, stickers, learnings, home city & news'}>
              {lang === 'zh' ? '🎭 人设·表情·感知' : '🎭 Persona'}
            </Button>
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
              {lang === 'zh' ? `🧠 长期记忆库 (${memories.length} 条 · ${pinnedMemories.length} 常驻)` : `🧠 Memory Library (${memories.length})`}
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
        <form className="dt-form dt-assistant-composer" data-draft-managed onSubmit={event => { void submitMessage(event) }}>
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

                  {isBot && msg.sticker && (
                    <div data-testid={`assistant-sticker-${msg.id}`}>
                      <StickerImage sticker={msg.sticker} lang={lang} />
                    </div>
                  )}

                  {isBot && (replyMeta?.persistenceChanges?.length ?? 0) > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid={`assistant-persistence-changes-${msg.id}`}>
                      {replyMeta!.persistenceChanges!.map(ch => {
                        const shortCode = (ch.id.split('-').pop() ?? ch.id).slice(-4)
                        const domainText =
                          ch.domain === 'memory' ? (lang === 'zh' ? '记忆库' : 'Memory')
                            : ch.domain === 'learning' ? (lang === 'zh' ? '相处默契' : 'Learning')
                              : ch.domain === 'sticker' ? (lang === 'zh' ? '表情包' : 'Sticker')
                                : ch.domain === 'address' ? (lang === 'zh' ? '常驻地址' : 'Address')
                                  : (lang === 'zh' ? '人设配置' : 'Persona')
                        const statusTone = ch.status === 'pending' || ch.status === 'applied'
                          ? 'warning'
                          : ch.status === 'approved'
                            ? 'success'
                            : 'neutral'
                        const statusLabel =
                          ch.status === 'pending' ? (lang === 'zh' ? '🔒 待你同意' : '🔒 Approval needed')
                            : ch.status === 'applied' ? (lang === 'zh' ? '⚠️ 已修改' : '⚠️ Modified')
                              : ch.status === 'approved' ? (lang === 'zh' ? '✅ 已同意生效' : '✅ Approved')
                                : ch.status === 'rejected' ? (lang === 'zh' ? '✕ 已拒绝' : '✕ Rejected')
                                  : (lang === 'zh' ? '↩ 已撤回' : '↩ Undone')
                        const stamp = ch.undoneAt ?? ch.decidedAt ?? ch.createdAt
                        const isActing = actingChangeId === ch.id
                        return (
                          <div
                            key={ch.id}
                            className="dt-msg-receipt"
                            data-tone={ch.status === 'pending' || ch.status === 'applied' ? 'warning' : undefined}
                            data-testid={`persistence-change-${ch.id}`}
                          >
                            <div className="dt-msg-receipt-main">
                              <Tag tone={statusTone}>{statusLabel}</Tag>
                              <strong>{domainText}</strong>
                              <span className="dt-mono dt-msg-receipt-branch">#{shortCode}</span>
                              <span>{ch.summary}</span>
                              <span className="dt-hint">· {formatSmartTimestamp(stamp, lang)}</span>
                            </div>
                            <div className="dt-msg-head-actions">
                              {ch.status === 'pending' && (
                                <>
                                  <Button
                                    size="sm"
                                    variant="primary"
                                    disabled={isActing || busy}
                                    onClick={() => { void actOnPersistenceChange(ch.id, 'approve') }}
                                    data-testid={`persistence-approve-${ch.id}`}
                                  >
                                    {lang === 'zh' ? '✓ 同意' : 'Approve'}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={isActing || busy}
                                    onClick={() => { void actOnPersistenceChange(ch.id, 'reject') }}
                                    data-testid={`persistence-reject-${ch.id}`}
                                  >
                                    {lang === 'zh' ? '✕ 拒绝' : 'Reject'}
                                  </Button>
                                </>
                              )}
                              {(ch.status === 'applied' || ch.status === 'approved') && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={isActing || busy}
                                  onClick={() => { void actOnPersistenceChange(ch.id, 'undo') }}
                                  data-testid={`persistence-undo-${ch.id}`}
                                >
                                  {lang === 'zh' ? '↩ 撤回' : 'Undo'}
                                </Button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}

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
                        <figure key={index}>
                          <a href={src} download={image.name || 'image'} title={lang === 'zh' ? '下载原图' : 'Download original'}>
                            <img src={src} alt={image.name || (lang === 'zh' ? '图片' : 'Image')} loading="lazy" />
                          </a>
                          {!isBot && (
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setStickerSaveFor({ messageId: msg.id, imageIndex: index }); setStickerSaveName(''); setStickerSaveTags('') }} data-testid={`save-sticker-${msg.id}-${index}`}>
                              {lang === 'zh' ? '😀 存为表情包' : 'Save as sticker'}
                            </Button>
                          )}
                        </figure>
                      )
                    })}
                  </div>
                  {!isBot && stickerSaveFor?.messageId === msg.id && (
                    <div className="dt-sticker-save-form" data-testid="sticker-save-form">
                      <Input value={stickerSaveName} onChange={e => setStickerSaveName(e.target.value)} placeholder={lang === 'zh' ? '表情名字，如：摸鱼' : 'Sticker name'} />
                      <Input value={stickerSaveTags} onChange={e => setStickerSaveTags(e.target.value)} placeholder={lang === 'zh' ? '标签，如：开心, 日常' : 'Tags'} />
                      <Button size="sm" variant="primary" disabled={busy || !stickerSaveName.trim()} onClick={() => { void saveImageAsSticker() }}>{lang === 'zh' ? '保存到图库' : 'Save'}</Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setStickerSaveFor(null)}>{lang === 'zh' ? '取消' : 'Cancel'}</Button>
                    </div>
                  )}

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

      <PersonaAmbientWorkbench lang={lang} open={personaWorkbenchOpen} onClose={() => setPersonaWorkbenchOpen(false)} onAmbientChanged={setAmbientOverride} />

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

