/** Shared standalone panel transport, session event types, message receipts, topic summaries, worker nodes, device groups, model profiles, and pipeline views. */
export type Lang = 'zh' | 'en'
export interface SessionEvent { seq?: number; type: string; data: unknown; at: string }
export interface TraceStep { seq: number; at: string; kind: string; title: string; detail?: string; id?: string; streaming?: boolean }
export interface SessionSummary {
  id: string; title: string; status: string; model: { provider: string; model: string; reasoningEffort?: string }
}
export interface SessionDetail extends SessionSummary {
  cwd: string; systemPrompt: string; tools: { name: string; description: string }[]
  events: SessionEvent[]; liveTrace?: TraceStep[]
}
export interface SessionUpdate {
  sessionId: string; status: string; events: SessionEvent[]; next: number; liveTrace?: TraceStep[]
}
export interface WorkerNodeInfo {
  id: string
  name: string
  url: string
  endpoints?: string[]
  hostname?: string
  tailscaleDnsName?: string
  tailscaleIps?: string[]
  lanIps?: string[]
  tags: string[]
  status: 'online' | 'offline'
  gitUrl?: string
  lastSeenAt: string
}
export type SlotDayTypeInfo = 'all' | 'workday' | 'holiday'
export type DayModeOverrideInfo = 'auto' | 'force-workday' | 'force-holiday'
export interface CalendarDayStatusInfo {
  dateStr: string
  weekdayIndex: number
  weekdayLabel: { zh: string; en: string }
  effectiveDayType: 'workday' | 'holiday'
  dayModeOverride: DayModeOverrideInfo
  reason: { zh: string; en: string }
}
export interface ModelSelectionInfo {
  provider: string
  model: string
  reasoningEffort?: string
}
export interface RoleTimeSlotRuleInfo {
  id: string
  label: string
  startTime: string
  endTime: string
  dayType?: SlotDayTypeInfo
  model: ModelSelectionInfo
  enabled: boolean
}
export interface RoleModelScheduleConfigInfo {
  defaultModel: ModelSelectionInfo
  timeSlots: RoleTimeSlotRuleInfo[]
}
export interface ModelProfileGroupInfo {
  id: string
  name: string
  assistant?: RoleModelScheduleConfigInfo
  eval: RoleModelScheduleConfigInfo
  executor: RoleModelScheduleConfigInfo
}
export interface ModelProfilesState {
  config: {
    activeProfileId: string
    dayModeOverride?: DayModeOverrideInfo
    customHolidays?: string[]
    customWorkdays?: string[]
    profiles: ModelProfileGroupInfo[]
  }
  activeProfile: ModelProfileGroupInfo
  assistantModel?: ModelSelectionInfo
  evalModel: ModelSelectionInfo
  executorModel: ModelSelectionInfo
  matchedAssistantSlot?: RoleTimeSlotRuleInfo
  matchedEvalSlot?: RoleTimeSlotRuleInfo
  matchedExecutorSlot?: RoleTimeSlotRuleInfo
  calendarStatus?: CalendarDayStatusInfo
}
export interface DeviceGroupMemberInfo {
  deviceId: string
  deviceName: string
  hostname?: string
  tailscaleDnsName?: string
  tailscaleIps?: string[]
  lanIps?: string[]
  endpoints: string[]
  tags: string[]
  gitUrl?: string
  canInvite: boolean
}
export interface DeviceGroupSummary {
  identity: {
    deviceId: string
    deviceName: string
    hostname?: string
    tailscaleDnsName?: string
    tailscaleIps?: string[]
    lanIps?: string[]
    endpoints: string[]
    tags: string[]
  }
  groupId?: string
  groupName?: string
  members?: DeviceGroupMemberInfo[]
}
export interface PanelMessageReceipt {
  triggerId: string
  kind: 'created' | 'followup' | 'evaluating' | 'queued' | 'filtered'
  ticketId?: string
  ticketTitle?: string
  ticketState?: 'running' | 'completed' | 'failed' | 'stopped' | 'waiting'
  sessionId?: string
  branch?: string
  nodeId?: string
  nodeName?: string
  acked?: boolean
  reportState?: string
  reportSummary?: string
  attentionQuestion?: string
  handbackReason?: string
}
export interface PanelTopicSummary {
  conversation: string
  title: string
  messageCount: number
  ticketCount: number
  status: 'running' | 'completed' | 'idle'
  updatedAt: string
}
export interface PipelineRow {
  triggerId: string
  source: string
  threadKey: string
  actor: string
  text: string
  at: string
  intake: {
    kind: 'created' | 'followup' | 'evaluating' | 'queued' | 'filtered' | 'ignored'
    label: { zh: string; en: string }
    detail: { zh: string; en: string }
  }
  ticket?: {
    id: string
    title: string
    state: 'running' | 'completed' | 'failed' | 'stopped' | 'waiting'
    branch?: string
    sessionId: string
    nodeId?: string
    nodeName?: string
    acked?: boolean
  }
  delivery: {
    state: 'running' | 'merged' | 'completed' | 'pending' | 'none'
    summary?: string
    at?: string
  }
}
export interface RoleModelsSummary {
  assistant?: { provider: string; model: string; reasoningEffort?: string } | null
  eval?: { provider: string; model: string; reasoningEffort?: string } | null
  executor?: { provider: string; model: string; reasoningEffort?: string } | null
}
export type MemoryCategoryInfo = 'preference' | 'device' | 'project' | 'fact' | 'episodic' | 'milestone'
export interface MilestoneReminderRuleInfo {
  targetDate: string
  recurrence: 'yearly' | 'once'
  leadDays: number[]
}
export interface MemoryEntryInfo {
  id: string
  title: string
  content: string
  category: MemoryCategoryInfo
  tags: string[]
  pinned: boolean
  source: 'user' | 'assistant' | 'orchestrator' | 'worker'
  milestone?: MilestoneReminderRuleInfo
  createdAt: string
  updatedAt: string
}
export interface MemoryBackupInfo {
  id: string
  reason: 'clear-all' | 'single-delete'
  deletedAt: string
  expiresAt: string
  filePath: string
  count: number
  entries: MemoryEntryInfo[]
}
export interface LiveSessionRunInfo {
  sessionId: string
  role: 'assistant' | 'eval' | 'worker'
  title: string
  ticketId?: string
  ticketTitle?: string
  model?: { provider: string; model: string; reasoningEffort?: string }
  startedAt: string
  stepCount: number
  phaseLabel: { zh: string; en: string }
  activeTool?: { name: string; argSummary?: string; running: boolean }
  streamingText?: string
}

export interface EngineeringHandoffInfo {
  triggerId: string
  originalMessageId?: string
  summary?: string
  originalText: string
  imageCount?: number
  conversation?: string
  contextNote?: string
  state: 'evaluating' | 'accepted' | 'rejected'
  ticketId?: string
  ticketTitle?: string
  ticketState?: 'running' | 'completed' | 'failed' | 'stopped' | 'waiting'
  nodeName?: string
  refusalReason?: string
  attentionQuestion?: string
  reportSummary?: string
  liveRun?: LiveSessionRunInfo
}
export interface PendingUserQuestionInfo {
  id: string
  role: 'claw' | 'eval' | 'worker'
  title: string
  question: string
  context?: string
  options?: string[]
  ticketId?: string
  triggerId?: string
  conversation?: string
  createdAt: string
}
export interface AssistantReplyToolCallInfo {
  name: string
  args?: unknown
  output?: unknown
  isError?: boolean
  at?: string
}
export interface AssistantReplyMetaInfo {
  model: { provider: string; model: string; reasoningEffort?: string }
  matchedSlot?: { label: string; startTime: string; endTime: string; dayType?: SlotDayTypeInfo }
  turn?: number
  durationMs?: number
  toolCalls?: AssistantReplyToolCallInfo[]
  events?: SessionEvent[]
}
export interface AssistantContextConfigInfo {
  recentMessagesLimit: number
  contextResetAt?: string
  windowResets?: string[]
}
export interface AssistantMessageInfo {
  id: string
  sender: string
  bot?: boolean
  text: string
  content?: ({ type: 'text'; text: string } | { type: 'image'; mediaType: string; data: string; name?: string })[]
  at: string
  replyMeta?: AssistantReplyMetaInfo
  handoff?: EngineeringHandoffInfo
}
export interface AssistantChatBackupInfo {
  id: string
  reason: 'clear-all' | 'single-delete'
  deletedAt: string
  expiresAt: string
  filePath: string
  count: number
  messages: AssistantMessageInfo[]
}
export interface PluginDescriptorInfo {
  id: string
  packageName: string
  title: { zh: string; en: string }
  description: { zh: string; en: string }
  category: 'assistant' | 'memory' | 'ui-slot' | 'distributed' | 'scheduler' | 'source' | 'core'
  enabled: boolean
  canToggle: boolean
  roles: ('assistant' | 'orchestrator' | 'worker' | 'ui-slot')[]
  tools: string[]
  promptSection?: string
  uiSlot?: string
  stats?: { zh: string; en: string }
}
export interface ClawFeedItemInfo {
  id: string
  user: string
  tag: '验证码' | '重要' | '普通' | string
  message: string
  at: string
}
export interface SessionProgressCardInfo {
  sessionId: string
  title: string
  markdown?: string
  steps: { step: string; status: 'pending' | 'in_progress' | 'completed' }[]
  completedCount: number
  totalCount: number
  percent: number
  updatedAt: string
}
export interface SessionsPayload {
  sessions: SessionSummary[]
  roleModels?: RoleModelsSummary
  modelProfiles?: ModelProfilesState
  deviceGroup?: DeviceGroupSummary
  load?: { running: number; maxWorkers: number }
  nodes?: WorkerNodeInfo[]
  memories?: MemoryEntryInfo[]
  memoryBackups?: MemoryBackupInfo[]
  plugins?: PluginDescriptorInfo[]
  assistantMessages?: AssistantMessageInfo[]
  assistantLiveRun?: LiveSessionRunInfo | null
  assistantChatBackups?: AssistantChatBackupInfo[]
  assistantContextConfig?: AssistantContextConfigInfo
  clawfeedItems?: ClawFeedItemInfo[]
  progressCards?: Record<string, SessionProgressCardInfo>
  pendingQuestions?: PendingUserQuestionInfo[]
  pipeline?: PipelineRow[]
}
export async function standaloneFetch<R>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<R> {
  const res = await fetch(`/orchestrator/standalone/${path}`, {
    method, signal,
    headers: { 'x-orchestrator-request': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const data = await res.json() as R & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)
  return data
}
export function formatSmartTimestamp(at: string | undefined, lang: Lang = 'zh', now = new Date()): string {
  if (!at) return ''
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const timePart = `${hh}:${mm}:${ss}`
  const isSameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (isSameDay) {
    return timePart
  }
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const day = d.getDate()
  if (lang === 'zh') {
    return `${y}年${m}月${day}日 ${timePart}`
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')} ${timePart}`
}
export function messageText(data: unknown): string {
  if (!data || typeof data !== 'object') return typeof data === 'string' ? data : ''
  const record = data as Record<string, unknown>
  const message = record.message && typeof record.message === 'object' ? record.message as Record<string, unknown> : record
  const content = message.content ?? record.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(part => {
    if (typeof part === 'string') return [part]
    if (!part || typeof part !== 'object') return []
    const value = part as Record<string, unknown>
    return value.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  }).join('')
}
