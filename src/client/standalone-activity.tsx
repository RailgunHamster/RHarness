/** Right-hand execution inspector: worktree merge bar, session selector, and unified causal execution stream. */
import { useEffect, useRef, useState } from 'react'
import { Button, Dot, Modal, Tag } from './controls.tsx'
import { MarkdownText as MarkdownLite } from './markdown-view.tsx'
import {
  formatSmartTimestamp,
  messageText,
  standaloneFetch,
  type AssistantChatBackupInfo,
  type AssistantContextConfigInfo,
  type AssistantMessageInfo,
  type ClawFeedItemInfo,
  type DeviceGroupSummary,
  type Lang,
  type MemoryBackupInfo,
  type MemoryEntryInfo,
  type ModelProfilesState,
  type PendingUserQuestionInfo,
  type PipelineRow,
  type PluginDescriptorInfo,
  type RoleModelsSummary,
  type SessionDetail,
  type SessionProgressCardInfo,
  type SessionSummary,
  type SessionsPayload,
  type SessionUpdate,
  type WorkerNodeInfo,
} from './standalone-api.ts'

interface InspectorWorktreeStatus {
  available: boolean
  branch: string
  head: string
  baseBranch: string
  baseHead: string
  dirtyFiles: string[]
  aheadCommits: { sha: string; subject: string }[]
  merged: boolean
  autoMerged?: boolean
}

export function useLiveSession(sessionId: string | undefined, revision = 0) {
  const [detail, setDetail] = useState<SessionDetail>()
  const [error, setError] = useState('')
  const [updated, setUpdated] = useState('')
  useEffect(() => {
    setDetail(undefined)
    setError('')
    setUpdated('')
    if (!sessionId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let cursor: number | undefined
    const path = `sessions/${encodeURIComponent(sessionId)}`
    const poll = async () => {
      try {
        if (cursor === undefined) {
          const initial = await standaloneFetch<SessionDetail>(path, 'GET', undefined, controller.signal)
          if (controller.signal.aborted) return
          cursor = initial.events.length
          setDetail(initial)
        } else {
          const update = await standaloneFetch<SessionUpdate>(`${path}/events?after=${cursor}`, 'GET', undefined, controller.signal)
          if (controller.signal.aborted) return
          if (update.next < cursor) {
            cursor = undefined
            setDetail(current => current && ({ ...current, status: update.status, events: [], liveTrace: [] }))
          } else {
            cursor = update.next
            setDetail(current => {
              if (!current) return current
              const nextTrace = update.liveTrace ?? current.liveTrace
              const traceUnchanged =
                (current.liveTrace?.length ?? 0) === (nextTrace?.length ?? 0) &&
                current.liveTrace?.at(-1)?.detail === nextTrace?.at(-1)?.detail &&
                current.liveTrace?.at(-1)?.streaming === nextTrace?.at(-1)?.streaming
              if (update.events.length === 0 && current.status === update.status && traceUnchanged) {
                return current
              }
              return {
                ...current,
                status: update.status,
                events: update.events.length ? [...current.events, ...update.events] : current.events,
                liveTrace: nextTrace,
              }
            })
          }
        }
        setError('')
        setUpdated(new Date().toLocaleTimeString())
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { void poll() }, 1000)
      }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [sessionId, revision])
  return { detail, error, updated }
}

function InspectorWorktreeBar({ ticketId, running, lang }: { ticketId: string; running: boolean; lang: Lang }) {
  const [wt, setWt] = useState<InspectorWorktreeStatus>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const res = await standaloneFetch<InspectorWorktreeStatus>(`tickets/${encodeURIComponent(ticketId)}/worktree`)
        if (active && res && typeof res.available === 'boolean') setWt(res)
      } catch {
        // Ignore when worktree endpoint is not mocked in unit tests
      }
    }
    void load()
    if (!running) return () => { active = false }
    const timer = setInterval(() => { void load() }, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [ticketId, running])

  if (!wt?.available) return null

  const mergeNow = async () => {
    if (busy) return
    setBusy(true)
    try {
      const res = await standaloneFetch<{ status: InspectorWorktreeStatus }>(
        `tickets/${encodeURIComponent(ticketId)}/worktree/merge`,
        'POST',
        { commitDirty: true, push: false },
      )
      setWt(res.status)
    } catch {
      // Handled in full ticket detail
    } finally {
      setBusy(false)
    }
  }

  return <div className="dt-insp-wt-bar">
    <div className="dt-insp-wt-main">
      <Tag tone={wt.merged ? 'success' : 'info'}>
        {wt.merged
          ? wt.autoMerged
            ? (lang === 'zh' ? `已自动合并到 ${wt.baseBranch}` : `Auto-merged into ${wt.baseBranch}`)
            : (lang === 'zh' ? `已与 ${wt.baseBranch} 同步` : `Synced with ${wt.baseBranch}`)
          : (lang === 'zh'
              ? `待合并 (${wt.aheadCommits.length} 提交${wt.dirtyFiles.length ? ` · ${wt.dirtyFiles.length} 改动` : ''})`
              : `Pending (${wt.aheadCommits.length} commits)`)}
      </Tag>
      <span className="dt-mono dt-hint">{wt.branch} ({wt.head}) → {wt.baseBranch} ({wt.baseHead})</span>
    </div>
    {!wt.merged && <Button size="sm" variant="outline" disabled={busy} onClick={() => { void mergeNow() }}>
      {busy ? (lang === 'zh' ? '合并中…' : 'Merging…') : (lang === 'zh' ? '立即合入' : 'Merge')}
    </Button>}
  </div>
}

export function SessionActivity({ detail, lang }: { detail: SessionDetail; lang: Lang }) {
  const [follow, setFollow] = useState(true)
  const [fullscreenReplyKey, setFullscreenReplyKey] = useState<string | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const trace = detail.liveTrace ?? []
  const traceReplies = trace.filter(step => step.kind === 'assistant')
  const replies = traceReplies.length ? traceReplies.map(step => ({ key: step.id ?? `trace-${step.seq}`, at: step.at, text: step.detail || step.title }))
    : detail.events.filter(event => event.type === 'assistant/message').map((event, index) => ({
      key: `event-${event.seq ?? index}`, at: event.at, text: messageText(event.data),
    })).filter(reply => reply.text.trim())
  const tools = trace.filter(step => step.kind !== 'assistant')
  useEffect(() => {
    if (!follow || !viewport.current) return
    viewport.current.scrollTop = viewport.current.scrollHeight
    const raf = requestAnimationFrame(() => {
      if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [follow, detail.id, replies.map(reply => reply.text).join(''), tools.length])
  const fullReply = fullscreenReplyKey ? replies.find(r => r.key === fullscreenReplyKey) : undefined
  return <div className="dt-activity">
    <div className="dt-activity-toolbar">
      <span className="dt-activity-state"><Dot state={detail.status === 'running' ? 'ongoing' : 'idle'} />
        {detail.status === 'running' ? (lang === 'zh' ? '正在执行' : 'Running') : (lang === 'zh' ? '等待下一条消息' : 'Waiting for a message')}
        {detail.model?.model && <span className="dt-mono dt-hint"> · {detail.model.provider}/{detail.model.model}</span>}
      </span>
      <Button size="sm" variant="ghost" aria-pressed={follow} onClick={() => setFollow(value => !value)}>
        {lang === 'zh' ? (follow ? '自动跟随：开' : '自动跟随：关') : (follow ? 'Follow: on' : 'Follow: off')}
      </Button>
    </div>
    <div className="dt-activity-feed" ref={viewport} onScroll={() => {
      const node = viewport.current
      if (node && node.scrollHeight - node.scrollTop - node.clientHeight > 80) setFollow(false)
    }} tabIndex={0} aria-label={lang === 'zh' ? '实时助手回复' : 'Live assistant replies'}>
      {!replies.length && <p className="dt-hint">{loadedReplyHint(lang)}</p>}
      {replies.map(reply => <article className="dt-session-reply" key={reply.key}>
        <div className="dt-session-reply-head">
          <strong>{lang === 'zh' ? '助手' : 'Assistant'}</strong>
          <div className="dt-msg-head-actions">
            <time dateTime={reply.at}>{reply.at ? formatSmartTimestamp(reply.at, lang) : ''}</time>
            <Button size="sm" variant="ghost" onClick={() => setFullscreenReplyKey(reply.key)}>
              {lang === 'zh' ? '放大查看' : 'Expand'}
            </Button>
          </div>
        </div>
        <MarkdownLite text={reply.text} />
      </article>)}
    </div>
    <details className="dt-activity-tools" open={detail.status === 'running' || tools.length > 0}>
      <summary>{lang === 'zh' ? '工具与执行进展' : 'Tools and execution'} ({tools.length})</summary>
      <div className="dt-activity-tool-list">{tools.slice(-60).reverse().map(step => <details key={step.id ?? `${step.seq}-${step.kind}`}>
        <summary><time>{step.at ? formatSmartTimestamp(step.at, lang) : ''}</time> {step.title}</summary>
        {step.detail && <pre>{step.detail}</pre>}
      </details>)}</div>
    </details>
    <Modal
      className="dt-fullscreen-modal"
      open={Boolean(fullReply)}
      onClose={() => setFullscreenReplyKey(null)}
      title={fullReply ? `${detail.title} · ${formatSmartTimestamp(fullReply.at, lang)}` : ''}
      closeLabel={lang === 'zh' ? '关闭 (ESC)' : 'Close (ESC)'}
      description={detail.model?.model ? `${detail.model.provider} / ${detail.model.model}` : undefined}
      footer={
        <Button size="sm" variant="primary" onClick={() => setFullscreenReplyKey(null)}>
          {lang === 'zh' ? '关闭 (ESC)' : 'Close (ESC)'}
        </Button>
      }
    >
      {fullReply && (
        <div className="dt-panel-message" data-bot="true">
          <MarkdownLite text={fullReply.text} />
        </div>
      )}
    </Modal>
  </div>
}
function loadedReplyHint(lang: Lang): string {
  return lang === 'zh' ? '等待助手回复，执行中的工具进展会在下方更新。' : 'Waiting for a reply. Tool activity appears below.'
}

export function LiveWorkspace({
  lang,
  onOpenSession,
  inspectedSessionId,
  preferredSessionId,
  onSelectSession,
  onMetaUpdate,
}: {
  lang: Lang
  onOpenSession: (id: string) => void
  inspectedSessionId?: string | undefined
  preferredSessionId?: string | undefined
  onSelectSession?: ((id: string) => void) | undefined
  onMetaUpdate?: ((meta: {
    roleModels?: RoleModelsSummary
    modelProfiles?: ModelProfilesState
    deviceGroup?: DeviceGroupSummary
    load?: { running: number; maxWorkers: number }
    nodes?: WorkerNodeInfo[]
    memories?: MemoryEntryInfo[]
    memoryBackups?: MemoryBackupInfo[]
    plugins?: PluginDescriptorInfo[]
    assistantMessages?: AssistantMessageInfo[]
    assistantChatBackups?: AssistantChatBackupInfo[]
    assistantContextConfig?: AssistantContextConfigInfo
    clawfeedItems?: ClawFeedItemInfo[]
    progressCards?: Record<string, SessionProgressCardInfo>
    pendingQuestions?: PendingUserQuestionInfo[]
    pipeline?: PipelineRow[]
  }) => void) | undefined
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selected, setSelected] = useState('')
  const [manual, setManual] = useState(false)
  const [error, setError] = useState('')
  const sessionsRef = useRef<SessionSummary[]>([])
  sessionsRef.current = sessions

  const chooseAutoSession = (list: SessionSummary[], current: string, prefId?: string): string => {
    const runningWorker = list.find(s => s.id.startsWith('worker-') && s.status === 'running')
    if (prefId) {
      const pref = list.find(s => s.id === prefId)
      if (pref?.status === 'running') return pref.id
      if (runningWorker) return runningWorker.id
      if (pref) return pref.id
    }
    if (runningWorker) return runningWorker.id
    const anyRunning = list.find(s => s.status === 'running')
    if (anyRunning) return anyRunning.id
    const latestWorker = [...list].reverse().find(s => s.id.startsWith('worker-'))
    if (!prefId && current === 'claw-assistant-main' && latestWorker) return latestWorker.id
    return (list.find(s => s.id === current) ?? latestWorker ?? list.at(-1))?.id ?? ''
  }

  useEffect(() => {
    if (inspectedSessionId) {
      setManual(true)
      setSelected(inspectedSessionId)
    }
  }, [inspectedSessionId])

  useEffect(() => {
    if (manual || !sessionsRef.current.length) return
    setSelected(current => chooseAutoSession(sessionsRef.current, current, preferredSessionId))
  }, [manual, preferredSessionId])

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const result = await standaloneFetch<SessionsPayload>('sessions', 'GET', undefined, controller.signal)
        if (controller.signal.aborted) return
        setSessions(result.sessions)
        onMetaUpdate?.({
          ...(result.roleModels ? { roleModels: result.roleModels } : {}),
          ...(result.modelProfiles ? { modelProfiles: result.modelProfiles } : {}),
          ...(result.deviceGroup ? { deviceGroup: result.deviceGroup } : {}),
          ...(result.load ? { load: result.load } : {}),
          ...(result.nodes ? { nodes: result.nodes } : {}),
          ...(result.memories ? { memories: result.memories } : {}),
          ...(result.memoryBackups ? { memoryBackups: result.memoryBackups } : {}),
          ...(result.plugins ? { plugins: result.plugins } : {}),
          ...(result.assistantMessages ? { assistantMessages: result.assistantMessages } : {}),
          ...(result.assistantChatBackups ? { assistantChatBackups: result.assistantChatBackups } : {}),
          ...(result.assistantContextConfig ? { assistantContextConfig: result.assistantContextConfig } : {}),
          ...(result.clawfeedItems ? { clawfeedItems: result.clawfeedItems } : {}),
          ...(result.progressCards ? { progressCards: result.progressCards } : {}),
          ...(result.pendingQuestions ? { pendingQuestions: result.pendingQuestions } : {}),
          ...(result.pipeline ? { pipeline: result.pipeline } : {}),
        })
        setSelected(current => {
          if (manual && result.sessions.some(session => session.id === current)) return current
          return chooseAutoSession(result.sessions, current, preferredSessionId)
        })
        setError('')
      } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)) }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => { void poll() }, 2000) }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [manual, preferredSessionId, onMetaUpdate])

  const live = useLiveSession(selected || undefined)
  const ticketId = selected.startsWith('worker-') ? selected.slice('worker-'.length) : undefined

  return <section id="live-execution" className="dt-live-workspace" aria-label={lang === 'zh' ? '实时执行' : 'Live execution'}>
    <div className="dt-live-head"><div><h2>{lang === 'zh' ? '实时执行检视器' : 'Live execution inspector'}</h2>
      <span className="dt-hint">{lang === 'zh' ? '点击左侧消息回执可切换检视目标 · 每秒自动更新' : 'Click any message receipt to inspect · Updates every second'}
        {live.updated && ` · ${live.updated}`}</span></div>
      <div className="dt-row-buttons">
        {manual && <Button size="sm" onClick={() => setManual(false)}>{lang === 'zh' ? '自动关注运行中的工单' : 'Follow running tickets'}</Button>}
        {selected && <Button size="sm" variant="outline" onClick={() => onOpenSession(selected)}>{lang === 'zh' ? '调试控制台' : 'Debug console'}</Button>}
      </div>
    </div>
    <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '当前检视会话' : 'Inspected session'}</span>
      <select className="dt-select" value={selected} onChange={event => {
        setManual(true)
        setSelected(event.target.value)
        onSelectSession?.(event.target.value)
      }}>
        {!sessions.length && <option value="">{lang === 'zh' ? '暂无会话' : 'No sessions yet'}</option>}
        {sessions.map(session => <option key={session.id} value={session.id}>
          {session.id === 'claw-assistant-main'
            ? (lang === 'zh' ? '个人助理' : 'Assistant')
            : session.id.startsWith('worker-')
              ? (lang === 'zh' ? '工单' : 'Ticket')
              : (lang === 'zh' ? '工程主控' : 'Main')} · {session.title} · {session.status}
        </option>)}
      </select>
    </label>
    {ticketId && <InspectorWorktreeBar ticketId={ticketId} running={live.detail?.status === 'running'} lang={lang} />}
    {(error || live.error) && <p className="dt-error" role="status">{lang === 'zh' ? '连接中断，正在重试：' : 'Connection lost, retrying: '}{error || live.error}</p>}
    {live.detail ? <SessionActivity key={selected} detail={live.detail} lang={lang} /> : <p className="dt-hint">{lang === 'zh' ? '等待会话活动…' : 'Waiting for session activity…'}</p>}
  </section>
}
