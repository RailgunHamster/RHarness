/**
 * Claw Personal Assistant Plugin (`@rharness/claw-assistant`) and One-Way Verbatim Engineering Handoff Bridge.
 *
 * Flow:
 * 1. The user chats with the Personal Assistant (`claw-assistant-main`) using text and/or images.
 * 2. For daily Q&A, notes, and long-term memory (`memory_*`), the Personal Assistant handles them directly.
 * 3. When the Personal Assistant determines that the user's request requires engineering work:
 *    - The Assistant writes a brief `summary` and calls `assistant_forward_to_engineering`.
 *    - The bridge automatically packages the Assistant's `summary` TOGETHER WITH the user's **verbatim original words**
 *      and **all original images (`StoredPanelContent[]`)** from the assistant conversation, and delivers them into
 *      **`工程对话` (`panel:main`)**.
 *    - Both the `工程对话` chat stream and the Engineering Eval / Worker models receive the Assistant's brief summary,
 *      the user's exact original words, and the user's original images.
 *    - Engineering Eval (`eval.model`) retains full independent right to accept (`accept` / `attach`) or refuse (`ignore`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { key, latestReport, reasonText, threadKey, waitsForPerson } from '../core/index.ts'
import { KV } from '../kv.ts'
import { PANEL_SOURCE, panelTrigger } from '../sources/panel.ts'
import type { PanelContentPart, StoredPanelContent } from '../sources/panel-images.ts'
import { MEMORY_BACKUP_RETENTION_MS } from './memory-plugin.ts'
import type { Runtime } from './runtime.ts'
import type { RegisteredToolSpec } from './standalone-host.ts'

export const ASSISTANT_SESSION_ID = 'claw-assistant-main'
export const ASSISTANT_HANDOFF_CONVERSATION = 'main'

export interface EngineeringHandoffStatus {
  triggerId: string
  originalMessageId: string
  /** Brief summary written by the Personal Assistant when handing off to Engineering Chat. */
  summary: string
  /** Verbatim original words from the user's message(s) to the Personal Assistant. */
  originalText: string
  /** Number of original images from the user's message(s) delivered to Engineering Chat. */
  imageCount: number
  conversation: string
  state: 'evaluating' | 'accepted' | 'rejected'
  ticketId?: string
  ticketTitle?: string
  ticketState?: 'running' | 'completed' | 'failed' | 'stopped' | 'waiting'
  sessionId?: string
  nodeName?: string
  refusalReason?: string
  /** Active human question (`ticket.attention.question` or blocked question) requiring user confirmation. */
  attentionQuestion?: string
  /** Latest worker report summary (`orchestrator_report.summary`) for the ticket. */
  reportSummary?: string
  updatedAt: string
}

export interface PendingUserQuestion {
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

export interface AssistantReplyToolCall {
  name: string
  args?: unknown
  output?: unknown
  isError?: boolean
  at?: string
}

export interface AssistantReplyMeta {
  model: { provider: string; model: string; reasoningEffort?: string }
  matchedSlot?: { label: string; startTime: string; endTime: string; dayType?: 'all' | 'workday' | 'holiday' }
  turn?: number
  durationMs?: number
  toolCalls?: AssistantReplyToolCall[]
  events?: { type: string; data: unknown; at: string }[]
}

export interface AssistantStoredMessage {
  id: string
  sender: 'operator' | 'claw-assistant'
  bot?: boolean
  text: string
  content?: StoredPanelContent[]
  at: string
  replyMeta?: AssistantReplyMeta
  handoff?: EngineeringHandoffStatus
}

export interface AssistantWireMessage {
  id: string
  sender: 'operator' | 'claw-assistant'
  bot?: boolean
  text: string
  content?: PanelContentPart[]
  at: string
  replyMeta?: AssistantReplyMeta
  handoff?: EngineeringHandoffStatus
}

export interface AssistantContextConfig {
  /** Maximum number of recent messages to include directly in each turn's prompt (`1` = only latest, `6` = default sliding window, `16` = extended window, `0` = all since `contextResetAt`). */
  recentMessagesLimit: number
  /** Optional ISO timestamp set when the user clicks "开启新窗口"; messages strictly before this timestamp are excluded from the active prompt and moved to the searchable archive (`memory_chat_search`). */
  contextResetAt?: string
  /** History of window reset timestamps for rendering visual dividers in the conversation stream. */
  windowResets?: string[]
}

export const DEFAULT_ASSISTANT_CONTEXT_CONFIG: AssistantContextConfig = {
  recentMessagesLimit: 6,
}

export interface AssistantChatBackupRecord {
  id: string
  reason: 'clear-all' | 'single-delete'
  deletedAt: string
  expiresAt: string
  filePath: string
  count: number
  messages: AssistantStoredMessage[]
}

export function getAssistantChatBackupDir(stateDir: string): string {
  return join(stateDir, 'assistant-chat-backups')
}

/**
 * Moves deleted/cleared Personal Assistant chat messages into `<stateDir>/assistant-chat-backups/<id>.json`
 * with a strict 30-day retention lock. Within 30 days, backups cannot be manually deleted and can be restored anytime;
 * after 30 days they are auto-purged.
 */
export function archiveAssistantMessagesToBackupDir(
  stateDir: string,
  messagesToArchive: readonly AssistantStoredMessage[],
  reason: 'clear-all' | 'single-delete',
  now = new Date(),
): AssistantChatBackupRecord | undefined {
  if (!messagesToArchive.length) return undefined
  const dir = getAssistantChatBackupDir(stateDir)
  mkdirSync(dir, { recursive: true })
  const deletedAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + MEMORY_BACKUP_RETENTION_MS).toISOString()
  const id = `chat-bak-${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`
  const filePath = join(dir, `${id}.json`)
  const record: AssistantChatBackupRecord = {
    id,
    reason,
    deletedAt,
    expiresAt,
    filePath,
    count: messagesToArchive.length,
    messages: [...messagesToArchive],
  }
  writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8')
  return record
}

/**
 * Scans `<stateDir>/assistant-chat-backups`, automatically deletes any backup older than 30 days (`expiresAt <= now`),
 * and returns all active (within 30-day regret window) chat backups sorted newest first.
 */
export function listAndPurgeAssistantChatBackups(stateDir: string, now = new Date()): AssistantChatBackupRecord[] {
  const dir = getAssistantChatBackupDir(stateDir)
  if (!existsSync(dir)) return []
  const nowMs = now.getTime()
  const active: AssistantChatBackupRecord[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const fullPath = join(dir, name)
    try {
      const parsed = JSON.parse(readFileSync(fullPath, 'utf8')) as AssistantChatBackupRecord
      const expMs = Date.parse(parsed.expiresAt)
      if (Number.isFinite(expMs) && expMs <= nowMs) {
        try { rmSync(fullPath, { force: true }) } catch {}
        continue
      }
      active.push({ ...parsed, filePath: fullPath })
    } catch { /* ignore unreadable file */ }
  }
  return active.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}

/**
 * Restores a chat backup from `<stateDir>/assistant-chat-backups` back into active Personal Assistant messages.
 */
export function restoreAssistantChatBackupFromDir(
  stateDir: string,
  backupId: string,
  currentMessages: readonly AssistantStoredMessage[],
  now = new Date(),
): { restoredCount: number; list: AssistantStoredMessage[]; backups: AssistantChatBackupRecord[] } {
  const activeBackups = listAndPurgeAssistantChatBackups(stateDir, now)
  const target = activeBackups.find(b => b.id === backupId)
  if (!target) {
    throw new Error(`Assistant chat backup ${backupId} not found or already expired`)
  }
  const byId = new Map<string, AssistantStoredMessage>()
  for (const m of currentMessages) byId.set(m.id, m)
  let restoredCount = 0
  for (const m of target.messages) {
    byId.set(m.id, m)
    restoredCount++
  }
  const merged = [...byId.values()].sort((a, b) => a.at.localeCompare(b.at))
  try { rmSync(target.filePath, { force: true }) } catch {}
  return {
    restoredCount,
    list: merged,
    backups: listAndPurgeAssistantChatBackups(stateDir, now),
  }
}

export function buildAssistantSystemPrompt(now = new Date()): string {
  const cnTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now)
  return [
    `Current Beijing Time (Asia/Shanghai, UTC+8): ${cnTime}. Always resolve relative dates like "今天" (today), "明天" (tomorrow), "本月" (this month), or "9号" against this exact current year and month.`,
    '',
    ASSISTANT_SYSTEM_PROMPT,
  ].join('\n')
}

export const ASSISTANT_SYSTEM_PROMPT = [
  'You are the RHarness Personal Assistant (Claw Assistant), handling daily chat, personal notes/reminders, long-term memory (`memory_*`), and forwarding engineering/investigation tasks to Engineering Chat (`工程对话`).',
  'Style & Formatting: Reply in natural, concise Chinese. Use expressive Unicode emojis (such as 📋, ✅, ⏰, 📌, 💡, 🔍, 📅) for visual clarity and warmth.',
  '',
  '## Strict Two-Domain Boundary (CRITICAL)',
  '1. **What you handle directly in this window**:',
  '   - Daily Q&A, personal notes, reminders, preferences, and long-term memory (`memory_save`, `memory_search`, `memory_list`, `memory_delete`, `memory_consolidate`, `memory_chat_search`).',
  '   - **Birthdays, Anniversaries & Major Milestones (`category: "milestone"`)**:',
  '     - Whenever the user tells you a birthday, anniversary, annual renewal, or major deadline (e.g. "生日是5月20日", "纪念日是10月1日"), call `memory_save` with `category: "milestone"`, `target_date: "MM-DD"` (or `"YYYY-MM-DD"` for one-time), `recurrence: "yearly"`, and `lead_days: [30, 14, 7, 1, 0]` so multi-stage reminders trigger 1 month, 2 weeks, 1 week, 1 day before, and on the day!',
  '   - **Optional Personal Business & Knowledge Base Tools (`@rharness/plugin-personal-skills`, when enabled)**:',
  '     - **SiYuan Knowledge Base (`siyuan_notebooks`, `siyuan_search`, `siyuan_read`) — MANDATORY PERSONAL & TECH NOTE RECALL**:',
  '       - **CRITICAL ARCHITECTURE FACT**: `memory_search` ONLY stores brief preferences and milestone dates (birthdays/anniversaries). Almost ALL of the user\'s actual personal records, family/life anecdotes, quotes/things someone said, saved technical tools/frameworks, server/housing info, and project notes live in **SiYuan (`siyuan` shared workspace + `siyuan-rh` private workspace)**!',
  '       - **MANDATORY RULE**: Whenever the user asks about ANY personal/family anecdote, past event, what someone said, saved tool/framework name they forgot, or note—you MUST call `siyuan_search` AND then call `siyuan_read({ id: docId, instance })` to read the complete document Markdown before answering! **NEVER** tell the user "记忆库中没有记录" without checking `siyuan_search` first.',
  '       - Sensitive vault notebooks (`data`) and notes involving passwords, bank cards, ID cards, private keys, or 2FA recovery codes are blocked at the gateway level.',
  '     - Feishu Todo & Smart Calendar Dual-Write (`todo_list`, `todo_write`): list, add, complete, or delete tasks; when `todo_write(action="add")` includes a clock time (`due: "YYYY-MM-DD HH:mm"`), it dual-writes to Feishu Calendar (`calendarSync`) as well.',
  '     - Email (`email_check`, `email_read`) & Calendar (`calendar_add`): check unread emails in readonly mode or schedule calendar events.',
  '     - Market Watch (`market_summary`) & Order Analytics (`orders_report`, `data_sql_query`): read market snapshots or run exact read-only SQL aggregations (`SUM`, `GROUP BY`, `AVG`) over local SQLite/CSV datasets.',
  '     - Live Web Research & Clean Readability (`research_search`, `web_readability`): search the web via Tavily / SearXNG / DuckDuckGo and extract clean ad-free Markdown from URLs.',
  '     - Signed-In Chrome Browser (`browser_tabs`, `browser_open_tab`): inspect or open tabs in a signed-in Chrome instance.',
  '     - Durable Progress Card & Self-Improving Ledger (`progress_card_update`, `progress_card_clear`, `learning_log`, `lcm_grep`, `lcm_expand`, `model_usage_summary`): use `progress_card_update` for substantial multi-step tasks, `learning_log` when the user corrects a mistake, and `lcm_expand` to recover exact details from compressed history.',
  '     - Link Deduplication (`interest_dedup`) & Feishu Direct Message (`feishu_send_dm`).',
  '2. **What you MUST immediately forward to Engineering Chat (`assistant_forward_to_engineering`)**:',
  '   - You do **NOT** have access to the local machine\'s filesystem, processes, deployed services (such as local OpenClaw installations), or the `RHarness` repository.',
  '   - Whenever the user asks to:',
  '     (a) **Investigate, survey, or inspect** anything on the local machine, server cluster, existing local software/services, or codebase;',
  '     (b) **Design a technical plan, migration scheme, or architecture proposal** for RHarness or any repository/service;',
  '     (c) **Implement, modify, fix, test, or deploy** code or configurations;',
  '     You **MUST immediately call `assistant_forward_to_engineering`** in this turn with a concise `summary`! Do NOT try to guess or fabricate a technical/migration plan yourself without forwarding.',
  '3. **Verbatim Original Words, Images & Target Machine/Repo Context**:',
  '   - When you call `assistant_forward_to_engineering`, the bridge automatically packages your `summary` TOGETHER WITH the user\'s verbatim original message(s) and original image(s) and delivers them into Engineering Chat (`工程对话`), where the Engineering Eval and Worker agents (which have full shell and repository access) will evaluate and execute the work.',
  '   - If your Long-Term Memory or conversation context records WHICH machine or directory path the target repository/service lives on, pass that fact in `context_note` so Engineering Eval dispatches the ticket to the right computer.',
  '4. **Asking the User for Decisions (`assistant_ask_user`)**:',
  '   - Whenever you need the user\'s opinion, preference, or confirmation between choices, call `assistant_ask_user` with `question` and optional `options` (e.g. `["方案 A：...", "方案 B：..."]`) so the Web UI renders an interactive decision card for the user.',
  '5. **Lossless Context DAG & Historical Recall (`lcm_grep` / `lcm_expand`)**:',
  '   - Only the latest raw tail messages are passed directly in your prompt; earlier turns are compressed into the Lossless Context DAG. Whenever the user refers to earlier conversations or details before a window reset, call `lcm_grep` or `lcm_expand` to recover exact details.',
].join('\n')

/**
 * Extracts clickable option labels from numbered or bulleted lists in a question/report text (up to 4 options).
 */
export function extractOptionsFromText(text: string): string[] {
  const options: string[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    const match = /^(?:(\d+|[A-Da-d])[.)、：:]|[-*•]\s*(?:方案\s*[A-Da-d1-9]|选项\s*[A-Da-d1-9]))\s*(.+)$/.exec(line)
    if (match) {
      const prefix = match[1] ? `${match[1]}. ` : ''
      const body = (match[2] ?? '').trim().replace(/^[：:]\s*/, '')
      if (body && body.length <= 90) {
        options.push(`${prefix}${body}`)
      }
    }
    if (options.length >= 4) break
  }
  return options
}

/**
 * Collects all active questions/decisions waiting for the user across `Claw` (Personal Assistant),
 * `Eval` (Engineering Orchestrator), and `Worker` (Engineering Tickets).
 */
export function collectPendingQuestions(rt: Runtime): PendingUserQuestion[] {
  const result: PendingUserQuestion[] = []
  const seenTicketIds = new Set<string>()

  // 1. Stored Personal Assistant (`Claw`) structured questions
  const clawQuestions = rt.store.get(KV.assistant.questions) ?? []
  for (const q of clawQuestions) {
    result.push(q)
  }

  // 2. Open Engineering Tickets with `ticket.attention` (`person / answer`) or `blocked` waiting for a person
  for (const tk of rt.store.tickets.open()) {
    const rep = latestReport(tk)
    const hasAttention = Boolean(tk.attention?.question)
    const isBlockedWaiting = (rep?.state === 'blocked' || rep?.state === 'failed') && waitsForPerson(tk)
    if (!hasAttention && !isBlockedWaiting) continue

    seenTicketIds.add(tk.id)
    const questionText = tk.attention?.question ?? rep?.summary ?? '工单执行遇到分叉或阻塞，请确认下一步方案'
    const parsedOptions = extractOptionsFromText(`${questionText}\n${rep?.summary ?? ''}`)
    const panelFollow = tk.follows?.find(f => f.thread.startsWith(`${PANEL_SOURCE}:`))
    const conv = panelFollow ? panelFollow.thread.slice(`${PANEL_SOURCE}:`.length) : 'main'

    result.push({
      id: tk.attention?.id ?? `worker-blocked-${tk.id}`,
      role: 'worker',
      title: `工单 #${tk.id.slice(0, 6)} · ${tk.title}`,
      question: questionText,
      ...(hasAttention && rep?.summary && rep.summary !== questionText ? { context: rep.summary.slice(0, 400) } : {}),
      ...(parsedOptions.length > 0 ? { options: parsedOptions } : {}),
      ticketId: tk.id,
      ...(tk.attention?.triggerId ? { triggerId: tk.attention.triggerId } : {}),
      conversation: conv,
      createdAt: rep?.at ?? tk.updatedAt,
    })
  }

  // 3. Engineering Eval (`orchestrator`) questions posted in `panel:main` awaiting user reply
  const mainMsgs = rt.store.get(KV.panel.messages('main')) ?? []
  const lastMainMsg = mainMsgs.at(-1)
  if (lastMainMsg?.bot && (/[?？]/.test(lastMainMsg.text) || /需要你做决定|请确认|你的意见/.test(lastMainMsg.text))) {
    // Only add if not already covered by an open ticket's attention card
    const alreadyCovered = [...seenTicketIds].some(id => lastMainMsg.text.includes(id.slice(0, 6)))
    if (!alreadyCovered || seenTicketIds.size === 0) {
      const parsedOptions = extractOptionsFromText(lastMainMsg.text)
      result.push({
        id: `eval-msg-${lastMainMsg.id}`,
        role: 'eval',
        title: '工程主控 (Eval / Orchestrator) 征求您的意见',
        question: lastMainMsg.text,
        ...(parsedOptions.length > 0 ? { options: parsedOptions } : {}),
        conversation: 'main',
        createdAt: lastMainMsg.at,
      })
    }
  }

  return result
}

/**
 * Resolves the live Engineering evaluation / ticket status for a forwarded `Trigger`.
 */
export function resolveHandoffStatus(rt: Runtime, handoff: EngineeringHandoffStatus): EngineeringHandoffStatus {
  const trigId = handoff.triggerId
  const conv = handoff.conversation || ASSISTANT_HANDOFF_CONVERSATION
  const tKey = threadKey({ source: PANEL_SOURCE, id: conv })
  const disp = rt.store.triggers.disposition(trigId)
  const dec = disp?.decisionId
    ? rt.store.decisions.get(disp.decisionId)
    : rt.store.decisions.byThread(tKey).find(d => d.triggerIds.includes(trigId))

  if (!dec && !disp?.fanout.length) {
    return { ...handoff, state: 'evaluating' }
  }

  if (dec?.kind === 'ignore' || dec?.kind === 'unavailable') {
    return {
      ...handoff,
      state: 'rejected',
      refusalReason: reasonText(dec.reason) || 'Engineering Eval declined this request',
      updatedAt: dec.at,
    }
  }

  const ticketId = dec?.ticketId ?? disp?.fanout[0]
  const tk = ticketId ? rt.store.tickets.get(ticketId) : undefined
  if (tk) {
    const rep = latestReport(tk)
    const assignedNode = rt.store.get(KV.nodes.ticketNode(tk.id))
    const attentionQuestion =
      tk.attention?.question ??
      (!tk.ended && (rep?.state === 'blocked' || rep?.state === 'failed') && waitsForPerson(tk) ? rep?.summary : undefined)
    const ticketState: EngineeringHandoffStatus['ticketState'] = !tk.ended
      ? (attentionQuestion || rep?.state === 'waiting' || rep?.state === 'blocked' ? 'waiting' : 'running')
      : (tk.ended.outcome === 'completed' || tk.ended.outcome === 'merged' ? 'completed' : tk.ended.outcome === 'stopped' ? 'stopped' : 'failed')
    return {
      ...handoff,
      state: 'accepted',
      ticketId: tk.id,
      ticketTitle: tk.title,
      ticketState,
      sessionId: `worker-${tk.id}`,
      ...(assignedNode?.nodeName ? { nodeName: assignedNode.nodeName } : {}),
      ...(attentionQuestion ? { attentionQuestion } : {}),
      ...(rep?.summary ? { reportSummary: rep.summary.slice(0, 600) } : {}),
      updatedAt: tk.updatedAt,
    }
  }

  return handoff
}

/**
 * Packages the Personal Assistant's brief summary TOGETHER WITH the user's verbatim original message(s)
 * and original images (`StoredPanelContent[]`) and delivers them into `工程对话` (`panel:main`).
 */
export async function forwardAssistantMessageToEngineering(
  rt: Runtime,
  input: {
    originalMessageId?: string
    messageIds?: string[]
    summary?: string
    originalText?: string
    contextNote?: string
    conversation?: string
    sender?: string
  },
): Promise<EngineeringHandoffStatus> {
  const messages = rt.store.get(KV.assistant.messages) ?? []

  // Collect the user's original message(s) from the assistant conversation
  const requestedIds = [
    ...(input.originalMessageId ? [input.originalMessageId] : []),
    ...(input.messageIds ?? []),
  ].filter(Boolean)

  let sourceUserMessages: AssistantStoredMessage[] = []
  if (requestedIds.length > 0) {
    sourceUserMessages = messages.filter(m => requestedIds.includes(m.id))
  }
  if (sourceUserMessages.length === 0) {
    const latestUserMsg = [...messages].reverse().find(m => !m.bot && (m.text.trim() || m.content?.some(c => c.type === 'image')))
    if (latestUserMsg) sourceUserMessages = [latestUserMsg]
  }

  const primaryMsg = sourceUserMessages.at(-1)
  if (primaryMsg?.handoff) {
    return resolveHandoffStatus(rt, primaryMsg.handoff)
  }

  const verbatimFromStore = sourceUserMessages
    .map(m => m.text.trim())
    .filter(Boolean)
    .join('\n\n')
  const originalText = (verbatimFromStore || input.originalText || '').trim()
  if (!originalText) {
    throw new Error('originalText is required when forwarding to Engineering Chat')
  }

  // Collect all original images from the user's message(s) to the Assistant
  const imageParts: StoredPanelContent[] = sourceUserMessages.flatMap(m =>
    (m.content ?? []).filter(part => part.type === 'image'),
  )
  const imageCount = imageParts.length

  const summary = (
    input.summary?.trim() ||
    input.contextNote?.trim() ||
    (originalText.length > 80 ? `${originalText.slice(0, 80)}…` : originalText)
  )

  const targetConversation = input.conversation?.trim() || ASSISTANT_HANDOFF_CONVERSATION
  const msgId = `handoff-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const at = new Date().toISOString()

  // Build the combined message delivered to Engineering Chat (`工程对话`):
  // 1. Assistant's brief summary
  // 2. User's verbatim original words
  // 3. User's original images attached in `content`
  const combinedText = [
    `**【个人助理转交总结】**\n${summary}`,
    `**【附：用户给个人助理的原话${imageCount > 0 ? `（含 ${imageCount} 张原图）` : ''}】**\n${originalText}`,
  ].join('\n\n')

  const combinedContent: StoredPanelContent[] = [
    { type: 'text', text: combinedText },
    ...imageParts,
  ]

  const trigger = panelTrigger({
    id: msgId,
    conversation: targetConversation,
    sender: input.sender ?? 'operator',
    text: combinedText,
    at,
    addressed: 'direct',
    content: combinedContent,
  })

  const tKey = threadKey(trigger.threads[0]!)
  const existingThread = rt.store.threads.get(tKey)
  if (existingThread && existingThread.subscriptions.length > 0) {
    const liveSubs = existingThread.subscriptions.filter(subId => !rt.store.tickets.get(subId)?.ended)
    if (liveSubs.length !== existingThread.subscriptions.length) {
      rt.store.threads.save({ ...existingThread, subscriptions: liveSubs })
    }
  }

  rt.receive(trigger)
  rt.store.threads.describe(tKey, {
    label: `Panel: ${targetConversation}`,
    facts: { conversation: { label: { zh: '对话', en: 'Conversation' }, value: targetConversation } },
  })

  const panelListKey = KV.panel.messages(targetConversation)
  const panelExisting = rt.store.get(panelListKey) ?? []
  panelExisting.push({
    id: msgId,
    conversation: targetConversation,
    sender: input.sender ?? 'operator',
    text: combinedText,
    content: combinedContent,
    at,
  })
  rt.store.set(panelListKey, panelExisting)

  const handoff: EngineeringHandoffStatus = {
    triggerId: key(PANEL_SOURCE, msgId),
    originalMessageId: primaryMsg?.id ?? msgId,
    summary,
    originalText,
    imageCount,
    conversation: targetConversation,
    state: 'evaluating',
    updatedAt: at,
  }

  if (primaryMsg) {
    primaryMsg.handoff = handoff
    rt.store.set(KV.assistant.messages, messages)
  }

  await rt.pump()
  return resolveHandoffStatus(rt, handoff)
}

export function buildAssistantBridgeTools(getRuntime: () => Runtime | undefined): RegisteredToolSpec[] {
  const forwardSchema = z.object({
    summary: z.string().min(1).max(600).describe('Brief summary of the engineering task distilled from your conversation with the user.'),
    context_note: z.string().max(600).optional().describe('Optional context facts from memory or conversation, such as which machine/node or directory path the target repository or service lives on.'),
    message_ids: z.array(z.string()).optional().describe('Optional IDs of the user message(s) in this conversation; their verbatim original text and original images will be automatically attached and sent to Engineering Chat.'),
    original_message_id: z.string().optional().describe('Optional single user message ID being forwarded.'),
    original_text: z.string().max(8000).optional().describe('Optional fallback verbatim user text if no stored message ID is referenced.'),
  })

  const askUserSchema = z.object({
    title: z.string().max(120).optional().describe('Short title of the decision needed from the user.'),
    question: z.string().min(1).max(1500).describe('The concrete question or decision to ask the user.'),
    context: z.string().max(600).optional().describe('Optional brief background or trade-off explanation.'),
    options: z.array(z.string().min(1).max(160)).max(6).optional().describe('Optional list of clickable answer choices for the user.'),
  })

  return [
    {
      name: 'assistant_forward_to_engineering',
      description: 'When a conversation with the user requires engineering or code changes, call this tool with a brief `summary`. It automatically attaches the user\'s verbatim original words and original images and sends them into Engineering Chat (`工程对话`) for Engineering Eval.',
      parameters: z.toJSONSchema(forwardSchema),
      execute: async (rawArgs: unknown) => {
        const rt = getRuntime()
        if (!rt) throw new Error('Engineering Runtime is not ready')
        const args = forwardSchema.parse(rawArgs ?? {})
        const status = await forwardAssistantMessageToEngineering(rt, {
          summary: args.summary,
          ...(args.context_note ? { contextNote: args.context_note } : {}),
          ...(args.message_ids ? { messageIds: args.message_ids } : {}),
          ...(args.original_message_id ? { originalMessageId: args.original_message_id } : {}),
          ...(args.original_text ? { originalText: args.original_text } : {}),
        })
        return {
          forwarded: true,
          handoff: status,
          note: 'Delivered your summary along with the user\'s verbatim original words and images into Engineering Chat (工程对话).',
        }
      },
    },
    {
      name: 'assistant_ask_user',
      description: 'Present an interactive decision card in the Web UI when you need the user\'s opinion, preference, or confirmation between options.',
      parameters: z.toJSONSchema(askUserSchema),
      execute: async (rawArgs: unknown) => {
        const rt = getRuntime()
        if (!rt) throw new Error('Runtime is not ready')
        const args = askUserSchema.parse(rawArgs ?? {})
        const qId = `claw-q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        const item: PendingUserQuestion = {
          id: qId,
          role: 'claw',
          title: args.title?.trim() || '个人助理 (Claw) 征求您的意见',
          question: args.question.trim(),
          ...(args.context?.trim() ? { context: args.context.trim() } : {}),
          ...(args.options?.length ? { options: args.options } : {}),
          createdAt: new Date().toISOString(),
        }
        const existing = rt.store.get(KV.assistant.questions) ?? []
        existing.push(item)
        rt.store.set(KV.assistant.questions, existing)
        return {
          asked: true,
          questionId: qId,
          note: 'Interactive decision card displayed to the user in the Web Panel.',
        }
      },
    },
  ]
}
