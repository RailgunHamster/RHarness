/**
 * Lossless Context DAG Engine (`@rharness/plugin-lossless-context`),
 * Self-Improving Friction & Correction Ledger (`@rharness/plugin-self-improving`),
 * and Ephemeral `/btw` Side-Question Support.
 *
 * Inspired by ClawHub's #1 community plugins (`Martian-Engineering/lossless-claw` & `pskoett/self-improving-agent`)
 * and OpenClaw's `/btw` side-question design:
 * 1. **Lossless Context DAG (`LcmDagState`)**:
 *    - Instead of dropping older messages outside the sliding window, older chunks of messages are hierarchically
 *      summarized into Level-1 Leaf Summaries and Level-2+ Condensed DAG Nodes, each linking back to exact
 *      source message IDs (`sourceMessageIds`) and child node IDs (`childNodeIds`).
 *    - Injects a compact DAG summary chain into the active prompt and exposes `lcm_grep`, `lcm_expand`, and `lcm_describe`
 *      so the agent can drill down into any historical summary node and recover 100% verbatim original messages.
 * 2. **Self-Improving Agent Ledger (`LearningEntry`)**:
 *    - Passively captures operational friction (tool errors, user corrections like "不对/不要这样/应该...",
 *      best practices, and capability gaps) into a structured ledger (`pending` -> `promoted` / `dismissed`),
 *      NEVER rewriting prompts behind the user's back (`propose` safety mode by default, 1-click promote to Memory).
 * 3. **Ephemeral `/btw` (or `/side` / `顺便问一下`) Side Questions**:
 *    - Detects `/btw <question>` or `/side <question>` prefixes so the user can ask a quick side question against a
 *      read-only snapshot of the current conversation without polluting formal chat history or interrupting ongoing work.
 */
import { z } from 'zod'
import type { MemoryEntry } from './memory-plugin.ts'
import type { RegisteredToolSpec } from './standalone-host.ts'

export interface LcmSummaryNode {
  id: string
  level: number // 1 = leaf chunk summary, 2+ = higher-order condensed summary
  title: string
  summary: string
  keyTopics: string[]
  startAt: string
  endAt: string
  sourceMessageIds: string[]
  childNodeIds?: string[]
  createdAt: string
}

export interface LcmDagState {
  nodes: LcmSummaryNode[]
  coveredMessageIds: string[]
}

export type LearningKind = 'correction' | 'tool_error' | 'best_practice' | 'feature_gap'

export interface LearningEntry {
  id: string
  kind: LearningKind
  title: string
  detail: string
  suggestedRule: string
  status: 'pending' | 'promoted' | 'dismissed'
  occurrences: number
  sourceSessionId?: string
  promotedMemoryId?: string
  createdAt: string
  updatedAt: string
}

export function defaultLcmDagState(): LcmDagState {
  return {
    nodes: [],
    coveredMessageIds: [],
  }
}

/**
 * Checks if a user message is an ephemeral `/btw` or `/side` side-question.
 */
export function parseBtwSideQuestion(rawText: string): { isBtw: boolean; question: string } {
  const trimmed = rawText.trim()
  const match = /^(?:\/btw|\/side|btw[:：])\s+([\s\S]+)$/i.exec(trimmed)
  if (match && match[1]?.trim()) {
    return { isBtw: true, question: match[1].trim() }
  }
  return { isBtw: false, question: trimmed }
}

function extractKeyTopicsFromChunk(texts: string[]): string[] {
  const joined = texts.join(' ')
  const topics = new Set<string>()
  for (const m of joined.matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,24}|[\u4e00-\u9fa5]{2,6}/g)) {
    const w = m[0]
    if (/^(?:我们|你们|他们|这个|那个|可以|已经|需要|现在|一下|什么|怎么|为什么|如果|因为|所以|好的|谢谢)$/.test(w)) {
      continue
    }
    topics.add(w)
    if (topics.size >= 10) break
  }
  return [...topics]
}

/**
 * Builds deterministic hierarchical L1 leaf summaries and L2 condensed DAG nodes for messages
 * that have fallen outside the active `freshTail` window, preserving 100% lossless links to raw message IDs.
 */
export function ingestMessagesIntoLcmDag(
  dag: LcmDagState,
  allMessages: readonly { id: string; sender: string; bot?: boolean; text: string; at: string }[],
  freshTailCount = 6,
  chunkSize = 6,
): LcmDagState {
  if (allMessages.length <= freshTailCount) return dag
  const olderMessages = allMessages.slice(0, Math.max(0, allMessages.length - freshTailCount))
  const covered = new Set(dag.coveredMessageIds)
  const uncovered = olderMessages.filter(m => !covered.has(m.id) && m.text.trim().length > 0)
  if (uncovered.length < chunkSize) return dag

  const nextNodes = [...dag.nodes]
  const nextCovered = [...dag.coveredMessageIds]
  const nowIso = new Date().toISOString()

  // Group uncovered older messages into chunks of `chunkSize` -> L1 Leaf Summary Nodes
  for (let i = 0; i + chunkSize <= uncovered.length; i += chunkSize) {
    const chunk = uncovered.slice(i, i + chunkSize)
    const userLines = chunk
      .filter(m => !m.bot)
      .map(m => m.text.replace(/\s+/g, ' ').trim().slice(0, 90))
    const botLines = chunk
      .filter(m => m.bot)
      .map(m => m.text.replace(/\s+/g, ' ').trim().slice(0, 90))

    const topics = extractKeyTopicsFromChunk(chunk.map(m => m.text))
    const leafId = `lcm-L1-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const title = userLines[0]?.slice(0, 42) || topics.slice(0, 3).join(' / ') || '历史对话片段'
    const summaryParts: string[] = []
    if (userLines.length) summaryParts.push(`用户诉求：${userLines.join('；')}`)
    if (botLines.length) summaryParts.push(`助理结论：${botLines.slice(0, 2).join('；')}`)

    const leafNode: LcmSummaryNode = {
      id: leafId,
      level: 1,
      title,
      summary: summaryParts.join(' ｜ ').slice(0, 480),
      keyTopics: topics,
      startAt: chunk[0]!.at,
      endAt: chunk.at(-1)!.at,
      sourceMessageIds: chunk.map(m => m.id),
      createdAt: nowIso,
    }
    nextNodes.push(leafNode)
    for (const m of chunk) nextCovered.push(m.id)
  }

  // Condense every 4 uncondensed L1 nodes into a higher-level L2 DAG node
  const condensedChildSet = new Set(nextNodes.flatMap(n => n.childNodeIds ?? []))
  const uncondensedL1 = nextNodes.filter(n => n.level === 1 && !condensedChildSet.has(n.id))
  if (uncondensedL1.length >= 4) {
    const group = uncondensedL1.slice(0, 4)
    const l2Id = `lcm-L2-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const mergedTopics = [...new Set(group.flatMap(g => g.keyTopics))].slice(0, 12)
    nextNodes.push({
      id: l2Id,
      level: 2,
      title: `阶段汇总：${group.map(g => g.title.slice(0, 14)).join(' → ')}`,
      summary: group.map(g => `[${g.id}] ${g.summary.slice(0, 120)}`).join('\n'),
      keyTopics: mergedTopics,
      startAt: group[0]!.startAt,
      endAt: group.at(-1)!.endAt,
      sourceMessageIds: group.flatMap(g => g.sourceMessageIds),
      childNodeIds: group.map(g => g.id),
      createdAt: nowIso,
    })
  }

  return {
    nodes: nextNodes,
    coveredMessageIds: nextCovered,
  }
}

export function formatLosslessDagPromptSection(dag: LcmDagState): string {
  if (!dag.nodes.length) return ''
  // Present top-level (uncondensed) DAG nodes so prompt stays ultra-compact while preserving full lineage
  const condensedChildren = new Set(dag.nodes.flatMap(n => n.childNodeIds ?? []))
  const topNodes = dag.nodes.filter(n => !condensedChildren.has(n.id)).slice(-8)
  if (!topNodes.length) return ''
  return [
    '## Lossless Context DAG Summary Chain (`lcm_grep` / `lcm_expand`)',
    'Earlier conversation turns are compressed into a lossless DAG below. Raw messages are NEVER lost—call `lcm_expand(node_id)` or `lcm_grep(query)` anytime you need exact details, numbers, or verbatim quotes from an earlier turn:',
    ...topNodes.map(
      n =>
        `- **[${n.id} · L${n.level}]** (${n.startAt.slice(0, 10)}, ${n.sourceMessageIds.length} msgs) **${n.title}**: ${n.summary.slice(0, 220)}`,
    ),
  ].join('\n')
}

export function buildLosslessContextTools(
  readDag: () => LcmDagState,
  readRawMessages: () => readonly { id: string; sender: string; bot?: boolean; text: string; at: string }[],
  isEnabled: () => boolean,
): RegisteredToolSpec[] {
  const grepSchema = z.object({
    query: z.string().optional().describe('Optional keyword or phrase to search across Lossless DAG summary nodes and raw historical messages. Omit to browse chronological chat history.'),
    before: z.string().optional().describe('Optional ISO timestamp; only include messages strictly before this time.'),
    after: z.string().optional().describe('Optional ISO timestamp; only include messages strictly after this time.'),
    offset: z.number().int().min(0).optional().describe('Pagination offset for raw messages (newest first). Defaults to 0.'),
    limit: z.number().int().min(1).max(50).optional().describe('Max matches to return (default 12).'),
  })

  const expandSchema = z.object({
    node_id: z.string().min(1).describe('Lossless DAG summary node ID (e.g. "lcm-L1-..." or "lcm-L2-...") to expand back into its verbatim source messages.'),
  })

  return [
    {
      name: 'lcm_grep',
      description: 'Search or page through the Lossless Context DAG summaries and underlying raw historical chat messages by keyword, time range (`before`/`after`), or `offset`/`limit` (`Martian-Engineering/lossless-claw` pattern; replaces legacy `memory_chat_search`).',
      parameters: z.toJSONSchema(grepSchema),
      execute: async (rawArgs: unknown) => {
        if (!isEnabled()) throw new Error('Lossless Context plugin (dsh-lossless-context) is disabled')
        const args = grepSchema.parse(rawArgs ?? {})
        const q = (args.query ?? '').trim().toLowerCase()
        const terms = q ? q.split(/\s+/).filter(Boolean) : []
        const offset = args.offset ?? 0
        const limit = args.limit ?? 12
        const dag = readDag()
        const matchedNodes = q
          ? dag.nodes
              .filter(n => {
                const hay = `${n.title} ${n.summary} ${n.keyTopics.join(' ')}`.toLowerCase()
                return terms.every(t => hay.includes(t))
              })
              .slice(-limit)
          : dag.nodes.slice(-limit)
        const allRaw = readRawMessages()
        const filteredRaw = allRaw.filter(m => {
          if (args.before && m.at >= args.before) return false
          if (args.after && m.at <= args.after) return false
          if (!terms.length) return true
          const hay = `${m.sender} ${m.text}`.toLowerCase()
          return terms.every(t => hay.includes(t))
        })
        const page = [...filteredRaw].reverse().slice(offset, offset + limit).reverse()
        return {
          ok: true,
          query: args.query ?? '',
          totalRawArchived: allRaw.length,
          matchedRawCount: filteredRaw.length,
          matchedSummaryNodes: matchedNodes,
          matchedRawMessages: page,
        }
      },
    },
    {
      name: 'lcm_expand',
      description: 'Expand a Lossless Context DAG node (`lcm-L1-*` or `lcm-L2-*`) to recover its child summaries and 100% verbatim original messages.',
      parameters: z.toJSONSchema(expandSchema),
      execute: async (rawArgs: unknown) => {
        if (!isEnabled()) throw new Error('Lossless Context plugin (dsh-lossless-context) is disabled')
        const args = expandSchema.parse(rawArgs ?? {})
        const dag = readDag()
        const node = dag.nodes.find(n => n.id === args.node_id.trim())
        if (!node) {
          return { ok: false, error: `DAG node not found: ${args.node_id}` }
        }
        const rawMap = new Map(readRawMessages().map(m => [m.id, m]))
        const verbatimMessages = node.sourceMessageIds.flatMap(id => {
          const found = rawMap.get(id)
          return found ? [found] : []
        })
        const childNodes = (node.childNodeIds ?? []).flatMap(cid => {
          const found = dag.nodes.find(n => n.id === cid)
          return found ? [found] : []
        })
        return {
          ok: true,
          node,
          childNodes,
          verbatimMessages,
        }
      },
    },
  ]
}

// ============================================================================
// Self-Improving Friction & Correction Ledger (`@rharness/plugin-self-improving`)
// ============================================================================

const USER_CORRECTION_RE =
  /(?:不对|错了|不是这样|不要这样|别再|以后别|应该用|正确做法是|记住下次|怎么又|别混在一起|不要混到)/

export function detectUserCorrectionFromMessage(
  userText: string,
  sessionId?: string,
): Omit<LearningEntry, 'id' | 'occurrences' | 'status' | 'createdAt' | 'updatedAt'> | undefined {
  const clean = userText.replace(/\r\n?/g, '\n').trim()
  if (!clean || clean.length < 5 || clean.length > 500) return undefined
  if (!USER_CORRECTION_RE.test(clean)) return undefined
  const firstSentence = clean.split(/[。\n！？!?]/)[0]!.trim().slice(0, 60)
  return {
    kind: 'correction',
    title: `用户纠偏：${firstSentence}`,
    detail: clean,
    suggestedRule: `遵循用户纠正偏好：${clean.slice(0, 180)}`,
    ...(sessionId ? { sourceSessionId: sessionId } : {}),
  }
}

export function recordLearningEvent(
  entries: readonly LearningEntry[],
  input: {
    kind: LearningKind
    title: string
    detail: string
    suggestedRule: string
    sourceSessionId?: string
  },
): { entry: LearningEntry; list: LearningEntry[] } {
  const now = new Date().toISOString()
  const normTitle = input.title.trim().toLowerCase()
  const existingIdx = entries.findIndex(e => e.title.trim().toLowerCase() === normTitle)
  if (existingIdx >= 0) {
    const prev = entries[existingIdx]!
    const updated: LearningEntry = {
      ...prev,
      detail: input.detail.trim() || prev.detail,
      suggestedRule: input.suggestedRule.trim() || prev.suggestedRule,
      occurrences: prev.occurrences + 1,
      updatedAt: now,
    }
    const next = [...entries]
    next[existingIdx] = updated
    return { entry: updated, list: next }
  }
  const created: LearningEntry = {
    id: `learn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    kind: input.kind,
    title: input.title.trim().slice(0, 120),
    detail: input.detail.trim().slice(0, 1500),
    suggestedRule: input.suggestedRule.trim().slice(0, 600),
    status: 'pending',
    occurrences: 1,
    ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
    createdAt: now,
    updatedAt: now,
  }
  return { entry: created, list: [created, ...entries].slice(0, 200) }
}

export function buildSelfImprovingTools(options: {
  readLearnings: () => LearningEntry[]
  writeLearnings: (next: LearningEntry[]) => void
  promoteToMemory: (learning: LearningEntry) => MemoryEntry
  isEnabled: () => boolean
}): RegisteredToolSpec[] {
  const logSchema = z.object({
    kind: z.enum(['correction', 'tool_error', 'best_practice', 'feature_gap']).describe('Type of operational learning.'),
    title: z.string().min(1).max(120).describe('Concise summary of the mistake, user correction, or discovered best practice.'),
    detail: z.string().min(1).max(1500).describe('What happened and why.'),
    suggested_rule: z.string().min(1).max(500).describe('Concrete reusable rule or procedure so future sessions do not repeat the mistake.'),
  })

  const listSchema = z.object({
    status: z.enum(['all', 'pending', 'promoted', 'dismissed']).optional(),
  })

  return [
    {
      name: 'learning_log',
      description: 'Record a user correction, unexpected tool pitfall, or reusable best practice into the Self-Improving Ledger (`pskoett/self-improving-agent` propose-mode pattern) for review and promotion.',
      parameters: z.toJSONSchema(logSchema),
      execute: async (rawArgs: unknown) => {
        if (!options.isEnabled()) throw new Error('Self-Improving Agent plugin (dsh-self-improving) is disabled')
        const args = logSchema.parse(rawArgs ?? {})
        const { entry, list } = recordLearningEvent(options.readLearnings(), {
          kind: args.kind,
          title: args.title,
          detail: args.detail,
          suggestedRule: args.suggested_rule,
        })
        options.writeLearnings(list)
        return { ok: true, recorded: entry }
      },
    },
    {
      name: 'learning_list',
      description: 'List captured learnings, user corrections, and error patterns from the Self-Improving Ledger.',
      parameters: z.toJSONSchema(listSchema),
      execute: async (rawArgs: unknown) => {
        if (!options.isEnabled()) throw new Error('Self-Improving Agent plugin (dsh-self-improving) is disabled')
        const args = listSchema.parse(rawArgs ?? {})
        const all = options.readLearnings()
        const filtered = args.status && args.status !== 'all' ? all.filter(i => i.status === args.status) : all
        return { ok: true, count: filtered.length, items: filtered.slice(0, 30) }
      },
    },
  ]
}
