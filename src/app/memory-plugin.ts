/**
 * First-Class Plugin Host (modeled after `@deepseek-ai/cordis` & `@deepseek-ai/dsh-plugin-manager`)
 * and Native Long-Term Memory Plugin (`@rharness/plugin-memory`).
 *
 * Every RHarness extension (including Agent Loops, Memory, Device Group, and UI Slot views) is represented
 * as a first-class plugin descriptor with:
 * - Cordis-compatible lifecycle (`apply` / dispose)
 * - Dynamic session tool injection (`agent.ctx.tools.register`)
 * - Dynamic systemPrompt section injection (`agent.ctx.systemPrompt.section`)
 * - UI Slot registration (`ctx.slots.register`)
 * - Live enable/disable toggle persisted in SQLite (`KV.plugins.state`)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { inspectClawFeedPluginRepo } from './personal-skills.ts'
import { loadPrivatePack } from './private-pack.ts'
import type { RegisteredToolSpec } from './standalone-host.ts'

export const MEMORY_BACKUP_RETENTION_DAYS = 30
export const MEMORY_BACKUP_RETENTION_MS = MEMORY_BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000

export type MemoryCategory = 'preference' | 'device' | 'project' | 'fact' | 'episodic' | 'milestone'

export interface MilestoneReminderRule {
  /** Target date in `MM-DD` (for yearly recurring birthdays/anniversaries) or `YYYY-MM-DD` (for one-time deadlines). */
  targetDate: string
  /** Recurrence pattern (`yearly` for birthdays/anniversaries/annual renewals, `once` for one-time milestones). */
  recurrence: 'yearly' | 'once'
  /** Advance reminder checkpoints in days before the target date (defaults to `[30, 14, 7, 1, 0]` = 1 month, 2 weeks, 1 week, 1 day, and on the day). */
  leadDays: number[]
}

export interface MilestoneCountdownStatus {
  memoryId: string
  title: string
  content: string
  targetDate: string
  recurrence: 'yearly' | 'once'
  nextOccurrenceDate: string
  daysUntil: number
  leadDays: number[]
  matchedCheckpointDay?: number
  stageLabel: string
}

export interface MemoryEntry {
  id: string
  title: string
  content: string
  category: MemoryCategory
  tags: string[]
  /** When true, this memory is automatically injected into every turn's System Prompt for Assistant and Worker roles. */
  pinned: boolean
  source: 'user' | 'assistant' | 'orchestrator' | 'worker'
  /** Optional milestone / anniversary countdown and multi-stage reminder configuration (`[-30, -14, -7, -1, 0]` days). */
  milestone?: MilestoneReminderRule
  /** Optional dense embedding vector (e.g. 768-dim from Ollama `nomic-embed-text`) for semantic hybrid search. */
  embedding?: number[]
  createdAt: string
  updatedAt: string
}

export interface MemoryConsolidationResult {
  extractedCount: number
  mergedCount: number
  purgedNoiseCount: number
  extractedEntries: MemoryEntry[]
  list: MemoryEntry[]
}

export interface MemoryBackupRecord {
  id: string
  reason: 'clear-all' | 'single-delete'
  deletedAt: string
  expiresAt: string
  filePath: string
  count: number
  entries: MemoryEntry[]
}

export interface PluginDescriptor {
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

export interface PluginRegistryState {
  disabledPlugins: string[]
}

export function defaultMemories(): MemoryEntry[] {
  const pack = loadPrivatePack()
  if (!pack?.manifest.seedMemories?.length) {
    return []
  }
  const now = new Date().toISOString()
  return pack.manifest.seedMemories.map(seed => ({
    ...seed,
    createdAt: now,
    updatedAt: now,
  }))
}

export const DEFAULT_MILESTONE_LEAD_DAYS = [30, 14, 7, 1, 0] as const

function chinaDateParts(now = new Date()): { year: number; month: number; day: number; ymd: string } {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const [y, m, d] = formatted.split('-').map(Number)
  return {
    year: y || now.getFullYear(),
    month: m || now.getMonth() + 1,
    day: d || now.getDate(),
    ymd: formatted,
  }
}

/**
 * Evaluates a milestone memory against the current Beijing date (`Asia/Shanghai`) and returns
 * the exact countdown (`daysUntil`), next occurrence `YYYY-MM-DD`, and whether today hits a
 * configured reminder checkpoint (e.g. 30 days / 14 days / 7 days / 1 day / 0 days before).
 */
export function evaluateMilestoneCountdown(
  entry: MemoryEntry,
  now = new Date(),
): MilestoneCountdownStatus | undefined {
  const rule = entry.milestone
  if (!rule?.targetDate) return undefined
  const today = chinaDateParts(now)
  const todayUtcMs = Date.UTC(today.year, today.month - 1, today.day)

  const raw = rule.targetDate.trim()
  const fullMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw)
  const mdMatch = /^(\d{1,2})-(\d{1,2})$/.exec(raw)

  let nextYear = today.year
  let month = 1
  let day = 1

  if (fullMatch) {
    const y = Number(fullMatch[1])
    month = Number(fullMatch[2])
    day = Number(fullMatch[3])
    if (rule.recurrence === 'once') {
      nextYear = y
    } else {
      nextYear = today.year
      if (Date.UTC(nextYear, month - 1, day) < todayUtcMs) {
        nextYear++
      }
    }
  } else if (mdMatch) {
    month = Number(mdMatch[1])
    day = Number(mdMatch[2])
    nextYear = today.year
    if (Date.UTC(nextYear, month - 1, day) < todayUtcMs) {
      nextYear++
    }
  } else {
    return undefined
  }

  const nextUtcMs = Date.UTC(nextYear, month - 1, day)
  const daysUntil = Math.round((nextUtcMs - todayUtcMs) / 86_400_000)
  if (daysUntil < 0) return undefined

  const nextOccurrenceDate = `${nextYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const leadDays = rule.leadDays?.length ? [...rule.leadDays].sort((a, b) => b - a) : [...DEFAULT_MILESTONE_LEAD_DAYS]
  const matchedCheckpointDay = leadDays.find(d => d === daysUntil)

  const stageLabel =
    daysUntil === 0
      ? '🎉 今天到期/当日'
      : daysUntil === 1
        ? '⏰ 明天 (提前1天)'
        : daysUntil === 7
          ? '📅 提前 1 周 (7天)'
          : daysUntil === 14
            ? '📅 提前 2 周 (14天)'
            : daysUntil === 30
              ? '📅 提前 1 个月 (30天)'
              : `还有 ${daysUntil} 天`

  return {
    memoryId: entry.id,
    title: entry.title,
    content: entry.content,
    targetDate: rule.targetDate,
    recurrence: rule.recurrence,
    nextOccurrenceDate,
    daysUntil,
    leadDays,
    ...(matchedCheckpointDay !== undefined ? { matchedCheckpointDay } : {}),
    stageLabel,
  }
}

/**
 * Lists all upcoming milestones within `withinDays` (default 35 days) sorted by `daysUntil` ascending.
 * When `onlyCheckpointMatches` is true, returns only milestones whose `daysUntil` equals one of its
 * configured `leadDays` (e.g. `[30, 14, 7, 1, 0]`) for the daily 08:10 Morning Brief!
 */
export function getUpcomingMilestones(
  entries: readonly MemoryEntry[],
  options: { now?: Date; withinDays?: number; onlyCheckpointMatches?: boolean } = {},
): MilestoneCountdownStatus[] {
  const now = options.now ?? new Date()
  const maxDays = options.withinDays ?? 35
  const results: MilestoneCountdownStatus[] = []
  for (const entry of entries) {
    const status = evaluateMilestoneCountdown(entry, now)
    if (!status) continue
    if (status.daysUntil > maxDays) continue
    if (options.onlyCheckpointMatches && status.matchedCheckpointDay === undefined) continue
    results.push(status)
  }
  return results.sort((a, b) => a.daysUntil - b.daysUntil)
}

const SEMANTIC_SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['续费', '缴费', '充值', '话费', '手机', '套餐', '到期', '年底', '12月'],
  ['邮箱', '邮件', 'email', 'imap', '发信', '收件'],
  ['待办', '任务', '提醒', '日程', 'todo', '汇总', '早报'],
  ['行情', '黄金', '白银', '贵金属', '股票', 'a股', 'k线', 'market'],
  ['订单', '月报', '购物', '淘宝', '京东', '1688', '消费'],
  ['笔记', '知识', '思源', 'siyuan', 'wiki', '金库', 'zotero', '文献'],
  ['机器', '节点', '服务器', '电脑', '集群', '拓扑', 'tailscale'],
]

function extractSearchTokensAndBigrams(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens = new Set<string>()
  // Word / ASCII / number tokens
  for (const m of lower.matchAll(/[a-z0-9_.-]{2,}|\d+月\d*日?/g)) {
    tokens.add(m[0])
  }
  // CJK 2-char bigrams for fuzzy Chinese phrase matching
  const cjkRuns = lower.match(/[\u4e00-\u9fa5]{2,}/g) ?? []
  const stopWords = new Set(['什么', '怎么', '如何', '哪些', '一下', '一个', '我们', '我的', '目前', '现在', '请问', '帮我', '看看', '有没有', '有什么'])
  for (const run of cjkRuns) {
    if (run.length <= 4 && !stopWords.has(run)) tokens.add(run)
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2)
      if (!stopWords.has(bg)) tokens.add(bg)
    }
  }
  return [...tokens]
}

export function cosineSimilarity(a?: readonly number[], b?: readonly number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const va = a[i]!
    const vb = b[i]!
    dot += va * vb
    normA += va * va
    normB += vb * vb
  }
  if (normA <= 0 || normB <= 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Computes a hybrid relevance score combining exact term matches, CJK bigram overlap,
 * semantic synonym expansion, and optional dense vector cosine similarity.
 */
export function scoreMemoryRelevance(
  item: MemoryEntry,
  query: string,
  queryEmbedding?: readonly number[],
): number {
  const q = query.trim().toLowerCase()
  if (!q) return item.pinned ? 1 : 0.5
  const hayTitle = item.title.toLowerCase()
  const hayTags = item.tags.join(' ').toLowerCase()
  const hayBody = item.content.toLowerCase()
  const hayAll = `${hayTitle} ${hayTags} ${hayBody} ${item.category}`

  let score = 0
  const rawTerms = q.split(/\s+/).filter(Boolean)
  if (rawTerms.length > 0 && rawTerms.every(t => hayAll.includes(t))) {
    score += 10
  }
  for (const t of rawTerms) {
    if (hayTitle.includes(t)) score += 5
    if (hayTags.includes(t)) score += 4
    if (hayBody.includes(t)) score += 2
  }

  const queryGrams = extractSearchTokensAndBigrams(q)
  for (const gram of queryGrams) {
    if (hayTitle.includes(gram)) score += 2.5
    else if (hayTags.includes(gram)) score += 2.0
    else if (hayBody.includes(gram)) score += 1.0
  }

  // Semantic synonym expansion (e.g. "年底有什么要续费" -> matches "12月1日给手机缴费，优惠到期")
  for (const group of SEMANTIC_SYNONYM_GROUPS) {
    const queryHitsGroup = group.some(w => q.includes(w))
    if (queryHitsGroup) {
      const itemGroupHits = group.filter(w => hayAll.includes(w)).length
      if (itemGroupHits > 0) {
        score += itemGroupHits * 1.8
      }
    }
  }

  if (queryEmbedding && item.embedding) {
    const sim = cosineSimilarity(queryEmbedding, item.embedding)
    if (sim > 0.45) {
      score += sim * 8
    }
  }

  return score
}

export function searchMemories(
  entries: readonly MemoryEntry[],
  query?: string,
  category?: string,
  pinnedOnly?: boolean,
  queryEmbedding?: readonly number[],
): MemoryEntry[] {
  const q = (query ?? '').trim().toLowerCase()
  const terms = q ? q.split(/\s+/).filter(Boolean) : []
  const filtered = entries.filter(item => {
    if (category && category !== 'all' && item.category !== category) return false
    if (pinnedOnly && !item.pinned) return false
    if (!terms.length) return true
    const hay = `${item.title} ${item.content} ${item.category} ${item.tags.join(' ')}`.toLowerCase()
    if (terms.every(t => hay.includes(t))) return true
    return scoreMemoryRelevance(item, q, queryEmbedding) >= 2.0
  })

  return filtered.sort((a, b) => {
    if (q) {
      const sa = scoreMemoryRelevance(a, q, queryEmbedding)
      const sb = scoreMemoryRelevance(b, q, queryEmbedding)
      if (Math.abs(sa - sb) > 0.1) return sb - sa
    }
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.updatedAt.localeCompare(a.updatedAt)
  })
}

/**
 * Automatically recalls Top-K non-pinned memories relevant to the current user message
 * so the Assistant or Worker immediately has relevant historical facts without needing a tool call.
 */
export function recallRelevantMemoriesForTurn(
  entries: readonly MemoryEntry[],
  userText: string,
  maxItems = 4,
  queryEmbedding?: readonly number[],
): MemoryEntry[] {
  const clean = userText.trim()
  if (!clean) return []
  const candidates = entries
    .filter(e => !e.pinned)
    .map(entry => ({ entry, score: scoreMemoryRelevance(entry, clean, queryEmbedding) }))
    .filter(x => x.score >= 2.0)
    .sort((a, b) => b.score - a.score)
  return candidates.slice(0, maxItems).map(x => x.entry)
}

/**
 * Optional non-blocking helper to compute a dense embedding via local/LAN Ollama (`nomic-embed-text`).
 * Returns `undefined` immediately if Ollama is unreachable so RHarness never stalls.
 */
export async function computeOllamaEmbedding(
  text: string,
  baseUrl = process.env.RHARNESS_OLLAMA_URL || 'http://127.0.0.1:11434',
  model = 'nomic-embed-text',
): Promise<number[] | undefined> {
  const input = text.trim().slice(0, 2000)
  if (!input) return undefined
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: input }),
      signal: AbortSignal.timeout(1200),
    })
    if (!res.ok) return undefined
    const data = (await res.json()) as { embedding?: number[] }
    if (Array.isArray(data.embedding) && data.embedding.length > 0) {
      return data.embedding
    }
  } catch {
    /* Ollama offline or unreachable: fallback to lexical + synonym hybrid scoring */
  }
  return undefined
}

export function saveMemoryEntry(
  entries: readonly MemoryEntry[],
  input: {
    id?: string
    title: string
    content: string
    category?: MemoryCategory
    tags?: string[]
    pinned?: boolean
    source?: 'user' | 'assistant' | 'orchestrator' | 'worker'
    milestone?: MilestoneReminderRule | null
  },
): { entry: MemoryEntry; list: MemoryEntry[] } {
  const now = new Date().toISOString()
  const existingIdx = input.id
    ? entries.findIndex(e => e.id === input.id)
    : entries.findIndex(e => e.title.trim().toLowerCase() === input.title.trim().toLowerCase())

  const prev = existingIdx >= 0 ? entries[existingIdx] : undefined
  const resolvedMilestone =
    input.milestone === null
      ? undefined
      : (input.milestone ?? prev?.milestone)

  const entry: MemoryEntry = {
    id: prev?.id ?? input.id ?? `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: input.title.trim() || '未命名记忆',
    content: input.content.trim(),
    category: input.category ?? (resolvedMilestone ? 'milestone' : (prev?.category ?? 'fact')),
    tags: input.tags ?? prev?.tags ?? [],
    pinned: input.pinned ?? prev?.pinned ?? false,
    source: input.source ?? prev?.source ?? 'user',
    ...(resolvedMilestone ? { milestone: resolvedMilestone } : {}),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  }
  const next = [...entries]
  if (existingIdx >= 0) {
    next[existingIdx] = entry
  } else {
    next.unshift(entry)
  }
  return { entry, list: next }
}

export function getMemoryBackupDir(stateDir: string): string {
  return join(stateDir, 'memory-backups')
}

/**
 * Moves deleted/cleared memories into `<stateDir>/memory-backups/<id>.json` with a strict 30-day retention timestamp.
 * Within 30 days, backups cannot be manually deleted and can be restored at any time; after 30 days they are auto-purged.
 */
export function archiveMemoriesToBackupDir(
  stateDir: string,
  entriesToArchive: readonly MemoryEntry[],
  reason: 'clear-all' | 'single-delete',
  now = new Date(),
): MemoryBackupRecord | undefined {
  if (!entriesToArchive.length) return undefined
  const dir = getMemoryBackupDir(stateDir)
  mkdirSync(dir, { recursive: true })
  const deletedAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + MEMORY_BACKUP_RETENTION_MS).toISOString()
  const id = `mem-bak-${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`
  const filePath = join(dir, `${id}.json`)
  const record: MemoryBackupRecord = {
    id,
    reason,
    deletedAt,
    expiresAt,
    filePath,
    count: entriesToArchive.length,
    entries: [...entriesToArchive],
  }
  writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8')
  return record
}

/**
 * Scans `<stateDir>/memory-backups`, automatically deletes any backup older than 30 days (`expiresAt <= now`),
 * and returns all active (within 30-day regret window) backups sorted newest first.
 */
export function listAndPurgeMemoryBackups(stateDir: string, now = new Date()): MemoryBackupRecord[] {
  const dir = getMemoryBackupDir(stateDir)
  if (!existsSync(dir)) return []
  const nowMs = now.getTime()
  const active: MemoryBackupRecord[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const fullPath = join(dir, name)
    try {
      const parsed = JSON.parse(readFileSync(fullPath, 'utf8')) as MemoryBackupRecord
      const expMs = Date.parse(parsed.expiresAt)
      if (Number.isFinite(expMs) && expMs <= nowMs) {
        // 30-day retention expired: auto-delete from backup directory
        try { rmSync(fullPath, { force: true }) } catch {}
        continue
      }
      active.push({ ...parsed, filePath: fullPath })
    } catch { /* ignore unreadable file */ }
  }
  return active.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}

/**
 * Restores a backup from `<stateDir>/memory-backups` back into active memories.
 */
export function restoreMemoryBackupFromDir(
  stateDir: string,
  backupId: string,
  currentEntries: readonly MemoryEntry[],
  now = new Date(),
): { restoredCount: number; list: MemoryEntry[]; backups: MemoryBackupRecord[] } {
  const activeBackups = listAndPurgeMemoryBackups(stateDir, now)
  const target = activeBackups.find(b => b.id === backupId)
  if (!target) {
    throw new Error(`Memory backup ${backupId} not found or already expired`)
  }
  const merged = [...currentEntries]
  let restoredCount = 0
  for (const item of target.entries) {
    const existingIdx = merged.findIndex(e => e.id === item.id)
    if (existingIdx >= 0) {
      merged[existingIdx] = item
    } else {
      merged.unshift(item)
    }
    restoredCount++
  }
  try { rmSync(target.filePath, { force: true }) } catch {}
  return {
    restoredCount,
    list: merged,
    backups: listAndPurgeMemoryBackups(stateDir, now),
  }
}

export interface ArchivedChatMessage {
  id: string
  sender: string
  bot?: boolean
  text: string
  at: string
  hasImages?: boolean
}

const NOISE_MEMORY_RE = /HEARTBEAT_OK|心跳检查.*(?:静默|无新变化|沿用上一轮)|scribble a haiku|slants through the blind slats|openclaw-memory-promotion/i
const FORGET_INSTRUCTION_RE = /^(?:忘了|别记|不要记住|删除关于)/

/**
 * High-SNR extractor for a single user message (`!bot`):
 * Only extracts explicit long-term preferences, recurring/dated reminders, or environment/project facts.
 * Never captures casual questions, greetings, or system status messages.
 */
export function extractDurableMemoryFromUserMessage(
  text: string,
): { title: string; content: string; category: MemoryCategory; tags: string[]; milestone?: MilestoneReminderRule } | undefined {
  const clean = text.replace(/\r\n?/g, '\n').trim()
  if (!clean || clean.length < 6 || clean.length > 600) return undefined
  if (FORGET_INSTRUCTION_RE.test(clean) || NOISE_MEMORY_RE.test(clean)) return undefined
  // Skip pure questions unless they also state a clear rule/preference
  if (/^[?？]|^(?:为什么|怎么|如何|啥情况|你觉得|请问)/.test(clean) && !/(?:以后|记住|不要|我不希望|我不喜欢|每月|每年|\d+月\d+日|生日|纪念日)/.test(clean)) {
    return undefined
  }

  // 1. Dated / recurring milestone, birthday, anniversary, or deadline (e.g. "老婆生日是5月20日", "12月1日给手机缴费，优惠到期，一年一续")
  const mdDateMatch = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(clean)
  const isMilestoneEvent = /(?:生日|纪念日|结婚|周年|缴费|续费|到期|年检|保险|提醒|待办|还款|复诊|体检)/.test(clean)
  if (mdDateMatch && isMilestoneEvent) {
    const yearStr = mdDateMatch[1]
    const monthStr = String(Number(mdDateMatch[2])).padStart(2, '0')
    const dayStr = String(Number(mdDateMatch[3])).padStart(2, '0')
    const isYearly = /每年|一年一续|生日|纪念日|周年/.test(clean) || !yearStr
    const targetDate = isYearly ? `${monthStr}-${dayStr}` : `${yearStr}-${monthStr}-${dayStr}`
    const snippet = clean.split(/[。\n]/)[0]!.trim().slice(0, 80)
    return {
      title: `🎂 重大事件与纪念日：${snippet.slice(0, 36)}`,
      content: clean,
      category: 'milestone',
      tags: ['纪念日', '提醒', `${Number(mdDateMatch[2])}月${Number(mdDateMatch[3])}日`, ...extractSearchTokensAndBigrams(snippet).slice(0, 5)],
      milestone: {
        targetDate,
        recurrence: isYearly ? 'yearly' : 'once',
        leadDays: [...DEFAULT_MILESTONE_LEAD_DAYS],
      },
    }
  }

  // 2. Explicit standing user preference / boundary (e.g. "我不太希望复用OpenClaw的插件", "以后不要...", "我习惯...")
  const prefMatch = /(?:我不太希望|我不希望|我不喜欢|我偏好|我习惯|以后请|以后不要|原则上|记住[:：]?)\s*([^。\n]{4,100})/.exec(clean)
  if (prefMatch) {
    const core = prefMatch[1]!.trim()
    return {
      title: `用户偏好：${core.slice(0, 36)}`,
      content: clean,
      category: 'preference',
      tags: ['偏好', ...extractSearchTokensAndBigrams(core).slice(0, 6)],
    }
  }

  // 3. Explicit machine / repository / account location fact (e.g. "XX仓库在claw的C:/AI/...", "我的邮箱是...")
  const factMatch = /(?:仓库在|部署在|安装在|目录是|路径是|邮箱是|运行在)\s*([^。\n]{4,100})/.exec(clean)
  if (factMatch) {
    const core = factMatch[0]!.trim()
    return {
      title: `环境与资产事实：${core.slice(0, 36)}`,
      content: clean,
      category: 'device',
      tags: ['环境', '资产', ...extractSearchTokensAndBigrams(core).slice(0, 6)],
    }
  }

  return undefined
}

/**
 * Practical Memory Consolidation (replaces OpenClaw's prose-poetry `Dreaming` cron):
 * 1. Purges any low-SNR heartbeat/poem garbage (`HEARTBEAT_OK`, `心跳检查：无新变化`, etc.);
 * 2. Deduplicates entries with identical normalized titles or near-identical content;
 * 3. Scans recent user chat messages (`!bot`) to extract durable preferences, reminders, and asset facts.
 */
export function consolidateMemories(
  currentEntries: readonly MemoryEntry[],
  chatMessages: readonly ArchivedChatMessage[] = [],
  archiveRemoved?: (removed: MemoryEntry[]) => void,
): MemoryConsolidationResult {
  const removedForBackup: MemoryEntry[] = []
  let purgedNoiseCount = 0
  let mergedCount = 0

  // Step 1: Purge heartbeat / prose-diary noise
  const cleanList: MemoryEntry[] = []
  for (const entry of currentEntries) {
    if (NOISE_MEMORY_RE.test(entry.title) || NOISE_MEMORY_RE.test(entry.content)) {
      removedForBackup.push(entry)
      purgedNoiseCount++
      continue
    }
    cleanList.push(entry)
  }

  // Step 2: Deduplicate by normalized title or high content overlap
  const deduped: MemoryEntry[] = []
  for (const item of cleanList) {
    const normTitle = item.title.trim().toLowerCase().replace(/\s+/g, ' ')
    const dupIdx = deduped.findIndex(existing => {
      const exTitle = existing.title.trim().toLowerCase().replace(/\s+/g, ' ')
      if (exTitle === normTitle) return true
      if (existing.category === item.category && existing.content.trim() === item.content.trim()) return true
      return false
    })
    if (dupIdx >= 0) {
      const winner = deduped[dupIdx]!
      removedForBackup.push(item)
      mergedCount++
      // Merge tags and keep pinned if either was pinned
      const mergedTags = [...new Set([...winner.tags, ...item.tags])]
      deduped[dupIdx] = {
        ...winner,
        pinned: winner.pinned || item.pinned,
        tags: mergedTags,
        content: item.updatedAt > winner.updatedAt ? item.content : winner.content,
        updatedAt: item.updatedAt > winner.updatedAt ? item.updatedAt : winner.updatedAt,
      }
    } else {
      deduped.push(item)
    }
  }

  // Step 3: Extract high-SNR facts/preferences/reminders from user chat messages
  let working = [...deduped]
  const extractedEntries: MemoryEntry[] = []
  for (const msg of chatMessages) {
    if (msg.bot) continue
    const candidate = extractDurableMemoryFromUserMessage(msg.text)
    if (!candidate) continue
    const alreadyExists = working.some(
      e =>
        e.title.toLowerCase() === candidate.title.toLowerCase() ||
        e.content.includes(candidate.content) ||
        candidate.content.includes(e.content),
    )
    if (alreadyExists) continue
    const saved = saveMemoryEntry(working, {
      ...candidate,
      pinned: false,
      source: 'assistant',
    })
    working = saved.list
    extractedEntries.push(saved.entry)
  }

  if (removedForBackup.length > 0) {
    archiveRemoved?.(removedForBackup)
  }

  return {
    extractedCount: extractedEntries.length,
    mergedCount,
    purgedNoiseCount,
    extractedEntries,
    list: working,
  }
}

export const SIYUAN_DIRECTORY_PROMPT_SUMMARY = [
  '## SiYuan Dual-Instance Knowledge Base (`siyuan_search` / `siyuan_read` / `siyuan_notebooks`)',
  'Long-form notes and reference documents can be queried read-only across configured SiYuan instances (`siyuan` shared workspace and `siyuan-rh` private workspace). Call `siyuan_search` and `siyuan_read` whenever the user asks about saved notes or documents:',
  '- **`siyuan` (🏠 Shared Workspace, `instance: "siyuan"`)**',
  '- **`siyuan-rh` (🔒 Private Workspace, `instance: "siyuan-rh"`)**',
  '- **🔒 Privacy Guardrail**: Vault notebooks (`data`, `secret`, `vault`) and notes involving passwords, bank cards, ID cards, private keys, or 2FA recovery codes are blocked at the gateway level (`blockedByPrivacyGuard: true`) and inline secrets are automatically redacted.',
].join('\n')

export function formatPinnedMemoryPromptSection(
  entries: readonly MemoryEntry[],
  chatArchiveSummary?: {
    archivedCount: number
    totalCount: number
    recentLimit: number
    contextResetAt?: string
    latestUserQuery?: string
  },
): string {
  const pinned = entries.filter(e => e.pinned)
  const lines = pinned.map(
    e => `- [${e.category}${e.tags.length ? ` | ${e.tags.join(', ')}` : ''}] **${e.title}**: ${e.content}`,
  )
  const parts: string[] = []
  if (lines.length > 0) {
    parts.push(
      '## RHarness Long-Term Memory (Pinned Context)',
      'The following persistent facts and user preferences are active across sessions. Use `memory_search`, `memory_save`, `memory_list`, `memory_delete`, or `memory_consolidate` when you need to recall or record durable user preferences, server facts, or milestone reminders (birthdays/anniversaries/renewals with `target_date` and `lead_days: [30, 14, 7, 1, 0]`):',
      ...lines,
    )
  }
  const upcomingMilestones = getUpcomingMilestones(entries, { withinDays: 35 })
  if (upcomingMilestones.length > 0) {
    parts.push(
      '## Upcoming Milestones & Anniversaries (Within 35 Days)',
      ...upcomingMilestones.map(
        m =>
          `- 🎂 **${m.title}** (${m.nextOccurrenceDate} · **${m.stageLabel}** · 提醒阶梯: 提前 ${m.leadDays.join('/')} 天): ${m.content}`,
      ),
    )
  }
  if (chatArchiveSummary?.latestUserQuery) {
    const recalled = recallRelevantMemoriesForTurn(entries, chatArchiveSummary.latestUserQuery, 4)
    if (recalled.length > 0) {
      parts.push(
        '## Auto-Recalled Relevant Memories (Hybrid Match for Current Message)',
        ...recalled.map(
          e => `- [${e.category}${e.tags.length ? ` | ${e.tags.join(', ')}` : ''}] **${e.title}**: ${e.content}`,
        ),
      )
    }
  }
  const packSummary = loadPrivatePack()?.manifest.siyuanPromptSummary
  if (packSummary) {
    parts.push(packSummary)
  } else if (loadPrivatePack()?.manifest.enablePersonalSkillsPlugin) {
    parts.push(SIYUAN_DIRECTORY_PROMPT_SUMMARY)
  }
  if (chatArchiveSummary && chatArchiveSummary.archivedCount > 0) {
    parts.push(
      '## Historical Chat Archive (`lcm_grep` / `lcm_expand`)',
      `- Passing the latest ${chatArchiveSummary.recentLimit > 0 ? `${chatArchiveSummary.recentLimit} raw tail messages` : 'messages since last window reset'}${chatArchiveSummary.contextResetAt ? ` (window reset at ${chatArchiveSummary.contextResetAt})` : ''}; **${chatArchiveSummary.archivedCount} earlier messages** (out of ${chatArchiveSummary.totalCount}) are preserved in the Lossless Context DAG and archive.`,
      '- Whenever the user asks about earlier conversations or details outside the tail window, call `lcm_grep` (with optional `query`, `before`, `after`, `offset`, `limit`) or `lcm_expand(node_id)`.',
    )
  }
  return parts.join('\n')
}

export function buildMemoryPluginTools(
  readEntries: () => MemoryEntry[],
  writeEntries: (next: MemoryEntry[]) => void,
  role: 'assistant' | 'orchestrator' | 'worker',
  readChatArchive?: () => ArchivedChatMessage[],
  archiveDeleted?: (removed: MemoryEntry[]) => void,
  federatedNotesSearch?: (query: string) => Promise<{ count: number; items: unknown[] } | undefined>,
): RegisteredToolSpec[] {
  const saveSchema = z.object({
    id: z.string().optional().describe('Optional existing memory ID to update.'),
    title: z.string().min(1).max(160).describe('Concise title of the memory entry.'),
    content: z.string().min(1).max(4000).describe('Fact, preference, or note to remember across sessions.'),
    category: z.enum(['preference', 'device', 'project', 'fact', 'episodic', 'milestone']).optional().describe('Memory category ("milestone" for birthdays, anniversaries, or annual renewals).'),
    tags: z.array(z.string()).optional().describe('Keywords or tags for retrieval.'),
    pinned: z.boolean().optional().describe('Set true for standing user preferences or core device facts that should be injected into every turn.'),
    target_date: z.string().optional().describe('Optional for milestone/anniversary/birthday/renewal: "MM-DD" (for yearly recurring events like "05-20" or "12-01") or "YYYY-MM-DD" (for one-time deadlines).'),
    recurrence: z.enum(['yearly', 'once']).optional().describe('Optional for milestone: "yearly" (default for birthdays/anniversaries) or "once".'),
    lead_days: z.array(z.number().int().min(0).max(365)).optional().describe('Advance reminder days before target_date (defaults to [30, 14, 7, 1, 0] = 1 month, 2 weeks, 1 week, 1 day, and on the day).'),
  })
  const searchSchema = z.object({
    query: z.string().optional().describe('Keywords or natural-language question to search across title, content, tags, and semantic synonyms.'),
    category: z.enum(['all', 'preference', 'device', 'project', 'fact', 'episodic', 'milestone']).optional(),
    pinned_only: z.boolean().optional(),
  })
  const deleteSchema = z.object({
    id: z.string().min(1).describe('ID of the memory entry to remove.'),
  })

  return [
    {
      name: 'memory_save',
      description: 'Save or update a long-term memory entry (user preference, device address, project convention, or milestone/birthday/anniversary with `target_date` and `lead_days: [30, 14, 7, 1, 0]`) in the RHarness Memory plugin.',
      parameters: z.toJSONSchema(saveSchema),
      execute: async (rawArgs: unknown) => {
        const args = saveSchema.parse(rawArgs ?? {})
        const milestone: MilestoneReminderRule | undefined = args.target_date
          ? {
              targetDate: args.target_date.trim(),
              recurrence: args.recurrence ?? (/^\d{4}-/.test(args.target_date.trim()) ? 'once' : 'yearly'),
              leadDays: args.lead_days?.length ? args.lead_days : [...DEFAULT_MILESTONE_LEAD_DAYS],
            }
          : undefined
        const { entry, list } = saveMemoryEntry(readEntries(), {
          ...args,
          ...(milestone ? { category: 'milestone', milestone } : {}),
          source: role,
        })
        writeEntries(list)
        return {
          saved: true,
          memory: entry,
          ...(entry.milestone ? { countdown: evaluateMilestoneCountdown(entry) } : {}),
        }
      },
    },
    {
      name: 'memory_search',
      description: 'Search long-term memories by keyword, category, or pinned status (also automatically federates into SiYuan Knowledge Base notes when connected).',
      parameters: z.toJSONSchema(searchSchema),
      execute: async (rawArgs: unknown) => {
        const args = searchSchema.parse(rawArgs ?? {})
        const items = searchMemories(readEntries(), args.query, args.category, args.pinned_only)
        let siyuanNotesMatched: { count: number; hint: string; items: unknown[] } | undefined
        if (args.query?.trim() && federatedNotesSearch) {
          try {
            const notes = await federatedNotesSearch(args.query.trim())
            if (notes && notes.count > 0) {
              siyuanNotesMatched = {
                count: notes.count,
                hint: 'Matching notes were found in SiYuan Knowledge Base! Call `siyuan_read({ id: docId, instance })` on the relevant document to read its FULL Markdown content before replying.',
                items: notes.items,
              }
            }
          } catch {}
        }
        return {
          count: items.length,
          items: items.slice(0, 25),
          ...(siyuanNotesMatched ? { siyuanNotesMatched } : {}),
        }
      },
    },
    {
      name: 'memory_list',
      description: 'List all pinned and recent long-term memories.',
      parameters: z.toJSONSchema(z.object({})),
      execute: async () => {
        const items = searchMemories(readEntries())
        return { count: items.length, items: items.slice(0, 30) }
      },
    },
    {
      name: 'memory_delete',
      description: 'Delete a long-term memory entry by ID (moved to the 30-day protected backup directory where it can be restored within 30 days).',
      parameters: z.toJSONSchema(deleteSchema),
      execute: async (rawArgs: unknown) => {
        const args = deleteSchema.parse(rawArgs ?? {})
        const before = readEntries()
        const removed = before.filter(e => e.id === args.id)
        const next = before.filter(e => e.id !== args.id)
        if (removed.length > 0) {
          archiveDeleted?.(removed)
        }
        writeEntries(next)
        return { deleted: next.length < before.length, id: args.id }
      },
    },
    {
      name: 'memory_consolidate',
      description: 'Run practical memory consolidation: purges any low-SNR heartbeat/status noise, deduplicates and merges overlapping memories, and extracts durable user preferences, reminders, and asset facts from recent user chat messages.',
      parameters: z.toJSONSchema(z.object({})),
      execute: async () => {
        const res = consolidateMemories(
          readEntries(),
          readChatArchive ? readChatArchive() : [],
          archiveDeleted,
        )
        writeEntries(res.list)
        return {
          consolidated: true,
          extractedCount: res.extractedCount,
          mergedCount: res.mergedCount,
          purgedNoiseCount: res.purgedNoiseCount,
          totalMemories: res.list.length,
          extractedEntries: res.extractedEntries,
        }
      },
    },
  ]
}

export function buildPluginCatalog(input: {
  disabledPlugins: readonly string[]
  memoryCount: number
  pinnedMemoryCount: number
  nodeCount: number
  profileCount: number
  assistantMessageCount?: number
  pipelineCount?: number
  ticketCount?: number
  tokensSaved?: number
  totalCostCny?: number
  lcmNodeCount?: number
  learningCount?: number
  progressCardCount?: number
  extraPrivatePlugins?: PluginDescriptor[]
  sourcesEnabled: { panel: boolean; feishu: boolean; github: boolean }
}): PluginDescriptor[] {
  const isEnabled = (id: string) => !input.disabledPlugins.includes(id)
  const pack = loadPrivatePack()
  const repo = inspectClawFeedPluginRepo()
  const showPersonalSkills = Boolean(pack?.manifest.enablePersonalSkillsPlugin)
  const showClawFeed = Boolean(pack?.manifest.enableClawFeedPlugin || repo.found)
  return [
    {
      id: 'dsh-claw-assistant',
      packageName: '@rharness/plugin-claw-assistant',
      title: { zh: '个人助理与单向工程转交 (Claw Assistant)', en: 'Personal Assistant & One-Way Engineering Handoff' },
      description: {
        zh: '排在顶栏第 1 位的独立个人助理窗口，处理日常问答、备忘与长期记忆；当产生工程需求时，携用户一字不改的原话单向递交至工程引擎，由工程 Eval 独立研判接单或拒收。',
        en: 'First-tab personal assistant loop with verbatim one-way handoff to Engineering Eval (which retains full right to accept or refuse).',
      },
      category: 'assistant',
      enabled: isEnabled('dsh-claw-assistant'),
      canToggle: true,
      roles: ['assistant', 'ui-slot'],
      tools: ['assistant_forward_to_engineering'],
      promptSection: 'rharness-claw-assistant-persona',
      uiSlot: 'topbar.tab#1: 个人助理',
      stats: {
        zh: `${input.assistantMessageCount ?? 0} 条助理消息`,
        en: `${input.assistantMessageCount ?? 0} assistant messages`,
      },
    },
    ...(showPersonalSkills
      ? [
          {
            id: 'dsh-personal-skills',
            packageName: '@rharness/plugin-personal-skills',
            title: { zh: '个人日常业务与知识库桥接 (Personal Skills & SiYuan + Feishu DM)', en: 'Personal Business, SiYuan & Feishu DM Bridge' },
            description: {
              zh: '通过本地私有扩展包启用：挂载思源笔记只读检索、飞书待办与日历双写、邮箱 IMAP 检视、行情快照、月度订单统计、PDF OCR、音视频转写与飞书私聊直连。',
              en: 'Optional private-pack business skill suite including SiYuan notes, Feishu Todo+Calendar, Email IMAP, Orders Report, PDF OCR, Audio ASR, and Feishu DM.',
            },
            category: 'assistant' as const,
            enabled: isEnabled('dsh-personal-skills'),
            canToggle: true,
            roles: ['assistant', 'worker'] as ('assistant' | 'worker')[],
            tools: ['siyuan_notebooks', 'siyuan_search', 'siyuan_read', 'todo_list', 'todo_write', 'email_check', 'email_read', 'calendar_add', 'market_summary', 'orders_report', 'pdf_archive', 'audio_transcribe', 'interest_dedup', 'feishu_send_dm'],
            stats: {
              zh: '14 项业务与知识库工具',
              en: '14 business & note tools',
            },
          },
        ]
      : []),
    ...(showClawFeed
      ? [
          {
            id: 'dsh-clawfeed',
            packageName: repo.found
              ? `@rharness/plugin-clawfeed (git: ${repo.repoPath}${repo.commit ? ` @ ${repo.commit}` : ''})`
              : '@rharness/plugin-clawfeed',
            title: { zh: '外部独立插件：手机通知与验证码网关 (ClawFeed)', en: 'External Plugin: ClawFeed Mobile Notification & OTP Ingress' },
            description: {
              zh: '外部手机通知与验证码接收插件：确定性分类 [验证码]/[重要]/[普通]，零 Token 落盘并在顶栏独立「📱 手机通知」窗口展示。',
              en: 'External mobile SMS/notification ingress plugin displaying categorized notifications and 1-click OTP copy in a dedicated tab.',
            },
            category: 'source' as const,
            enabled: isEnabled('dsh-clawfeed'),
            canToggle: true,
            roles: ['assistant', 'worker', 'ui-slot'] as ('assistant' | 'worker' | 'ui-slot')[],
            tools: ['clawfeed_status', 'clawfeed_recent', 'clawfeed_pause'],
            uiSlot: 'topbar.tab: 📱 手机通知',
            stats: repo.found
              ? {
                  zh: `独立 Git 仓库 (${repo.branch ?? 'main'}${repo.commit ? ` · ${repo.commit}` : ''})`,
                  en: `Standalone Git repo (${repo.branch ?? 'main'}${repo.commit ? ` · ${repo.commit}` : ''})`,
                }
              : { zh: '外部网关已连接', en: 'External sink connected' },
          },
        ]
      : []),
    {
      id: 'ui-workbench',
      packageName: '@rharness/ui-engineering-workbench',
      title: { zh: 'UI 视图插件：工程对话与实时检视台 (Engineering Chat Slot)', en: 'UI Slot Plugin: Engineering Chat & Live Inspector' },
      description: {
        zh: '排在顶栏第 2 位的「工程对话」工作台插槽（左侧话题列表、全宽工程对话与内联工单回执、下方实时执行检视器）。关闭后顶栏「工程对话」窗口实时卸载。',
        en: 'Second-tab 3-column Engineering Chat workbench and live execution inspector slot.',
      },
      category: 'ui-slot',
      enabled: isEnabled('ui-workbench'),
      canToggle: true,
      roles: ['orchestrator', 'worker', 'ui-slot'],
      tools: [],
      uiSlot: 'topbar.tab#2: 工程对话',
      stats: {
        zh: `${input.ticketCount ?? 0} 个运行中工单`,
        en: `${input.ticketCount ?? 0} running tickets`,
      },
    },
    {
      id: 'dsh-memory',
      packageName: '@rharness/plugin-memory',
      title: { zh: '高信噪比长期记忆与混合自动召回引擎 (Memory & Hybrid Auto-Recall Engine)', en: 'High-SNR Long-Term Memory & Hybrid Auto-Recall Engine' },
      description: {
        zh: '排在顶栏第 3 位「记忆与插件」，仅挂载至「个人助理」与「工程 Worker」，绝不污染工程 Eval 主控会话（complete: true）。专注记录高纯度用户偏好、设备拓扑与周期提醒，结合每轮混合语义自动召回 (Auto-Recall) 与思源双实例目录索引注入。',
        en: 'Mounted exclusively onto Personal Assistant and Worker sessions with Pinned Context, Per-Turn Hybrid Auto-Recall, Practical Consolidation, and SiYuan Dual-Instance Directory Summary.',
      },
      category: 'memory',
      enabled: isEnabled('dsh-memory'),
      canToggle: true,
      roles: ['assistant', 'worker', 'ui-slot'],
      tools: ['memory_save', 'memory_search', 'memory_list', 'memory_delete', 'memory_consolidate'],
      promptSection: 'rharness-long-term-memory',
      uiSlot: 'topbar.tab#4: 记忆与插件',
      stats: {
        zh: `${input.memoryCount} 条记忆 (${input.pinnedMemoryCount} 条常驻注入)`,
        en: `${input.memoryCount} entries (${input.pinnedMemoryCount} pinned)`,
      },
    },
    {
      id: 'dsh-runtime-guard',
      packageName: '@rharness/plugin-runtime-guard',
      title: { zh: '运行护栏套件：Tokenjuice 输出脱水 + 死循环熔断 + 防提示注入 (Runtime Guardrails)', en: 'Runtime Guardrails: Tokenjuice + Loop Breaker + Anti-Injection' },
      description: {
        zh: '融合官方与社区高赞安全护栏：1) Tokenjuice 自动清洗 ANSI 码与重复日志、折叠超长中段输出以省 Token；2) Loop Detection 拦截连续重复撞墙的工具死循环；3) Anti-Injection 自动净化外部网页/邮件中的提示注入指令。',
        en: 'Combines Tokenjuice output compaction, repetitive tool-loop circuit breaking, and external prompt-injection sanitization.',
      },
      category: 'core',
      enabled: isEnabled('dsh-runtime-guard'),
      canToggle: true,
      roles: ['assistant', 'worker'],
      tools: ['middleware:tokenjuice', 'middleware:loop_breaker', 'middleware:anti_injection'],
      stats: {
        zh: `已省 ${input.tokensSaved ?? 0} Tokens`,
        en: `${input.tokensSaved ?? 0} tokens saved`,
      },
    },
    {
      id: 'dsh-model-usage',
      packageName: '@rharness/plugin-model-usage',
      title: { zh: '模型调用成本与耗时账单监控 (Model Usage & Cost Telemetry)', en: 'Per-Model Token & Cost Telemetry' },
      description: {
        zh: '吸收 steipete/model-usage 与 opik 可观测设计：按角色 (Claw / Eval / Worker)、模型与日期统计本地输入/输出 Token、平均耗时与估算费用明细。',
        en: 'Tracks per-model, per-role, and daily token usage, turn latency, and estimated cost breakdowns.',
      },
      category: 'scheduler',
      enabled: isEnabled('dsh-model-usage'),
      canToggle: true,
      roles: ['assistant', 'orchestrator', 'worker'],
      tools: ['model_usage_summary'],
      stats: {
        zh: `累计估算 ¥${(input.totalCostCny ?? 0).toFixed(3)}`,
        en: `Est. ¥${(input.totalCostCny ?? 0).toFixed(3)}`,
      },
    },
    {
      id: 'dsh-lossless-context',
      packageName: '@rharness/plugin-lossless-context',
      title: { zh: '无损分层摘要树上下文引擎 (Lossless Context DAG · lossless-claw)', en: 'Lossless Hierarchical DAG Context Engine' },
      description: {
        zh: '吸收社区高星 Martian-Engineering/lossless-claw 架构：滑出活跃窗口的历史对话自动构建 L1 叶子摘要与 L2 阶段汇总 DAG 树，保留 100% 原始消息指针，支持 lcm_grep 搜索与 lcm_expand 无损展开。',
        en: 'Compresses older chat turns into a hierarchical L1/L2 DAG summary tree while preserving 100% verbatim message recall via lcm_grep and lcm_expand.',
      },
      category: 'memory',
      enabled: isEnabled('dsh-lossless-context'),
      canToggle: true,
      roles: ['assistant', 'worker'],
      tools: ['lcm_grep', 'lcm_expand'],
      promptSection: 'rharness-lossless-dag',
      stats: {
        zh: `${input.lcmNodeCount ?? 0} 个 DAG 摘要节点`,
        en: `${input.lcmNodeCount ?? 0} DAG summary nodes`,
      },
    },
    {
      id: 'dsh-self-improving',
      packageName: '@rharness/plugin-self-improving',
      title: { zh: '复利纠错与经验晋升引擎 + /btw 旁路快问 (Self-Improving Propose Ledger & /btw)', en: 'Self-Improving Propose Ledger & Ephemeral /btw Side Chat' },
      description: {
        zh: '吸收 ClawHub 下载第 1 的 self-improving-agent（采用安全受控的 Propose 审阅晋升模式，绝不暗改 Prompt）：自动捕获用户纠偏与工具踩坑记入经验账本，支持一键晋升为常驻记忆；同时支持 /btw 零污染旁路快问。',
        en: 'Captures user corrections and tool pitfalls into a reviewable ledger for 1-click promotion to Long-Term Memory, plus ephemeral /btw side questions.',
      },
      category: 'memory',
      enabled: isEnabled('dsh-self-improving'),
      canToggle: true,
      roles: ['assistant', 'worker'],
      tools: ['learning_log', 'learning_list', '/btw'],
      stats: {
        zh: `${input.learningCount ?? 0} 条经验记录`,
        en: `${input.learningCount ?? 0} learning entries`,
      },
    },
    {
      id: 'dsh-web-research',
      packageName: '@rharness/plugin-web-research',
      title: { zh: '多源联网搜索与正文净化提炼 (Tavily / SearXNG / Readability)', en: 'Multi-Source Web Search & Clean Readability Extractor' },
      description: {
        zh: '吸收 tavily-search、searxng 与 web-readability / summarize 组合流水线：支持 Tavily / SearXNG / DuckDuckGo 自动降级实时联网检索，并将网页一键净化为无广告干净 Markdown（内置防注入清洗）。',
        en: 'Multi-engine live web search (Tavily -> SearXNG -> DuckDuckGo) paired with clean ad-free Markdown extraction.',
      },
      category: 'assistant',
      enabled: isEnabled('dsh-web-research'),
      canToggle: true,
      roles: ['assistant', 'worker'],
      tools: ['research_search', 'web_readability'],
    },
    {
      id: 'dsh-browser-bridge',
      packageName: '@rharness/plugin-browser-bridge',
      title: { zh: '登录态 Chrome 浏览器桥接插件 (Signed-In Chrome CDP & Relay Bridge)', en: 'Signed-In Chrome CDP & Extension Relay Bridge' },
      description: {
        zh: '吸收 chrome-extension 与 agent-browser 机制：自动连接本机或 claw 节点的已登录 Chrome (:9222 CDP 或 :18799 扩展中继)，免重启保留淘宝/京东/知乎/小红书登录态列出或打开标签页。',
        en: 'Connects to signed-in Chrome via local/claw CDP (:9222) or Extension Relay (:18799) without losing login sessions.',
      },
      category: 'assistant',
      enabled: isEnabled('dsh-browser-bridge'),
      canToggle: true,
      roles: ['assistant', 'worker'],
      tools: ['browser_tabs', 'browser_open_tab'],
    },
    {
      id: 'dsh-progress-card',
      packageName: '@rharness/plugin-progress-card',
      title: { zh: '单会话原地持久进度卡 (In-Place Durable Progress Card)', en: 'Durable In-Place Session Progress Card' },
      description: {
        zh: '吸收 OpenClaw progress_card 设计：长任务只维护唯一一张原地刷新的步骤进度条卡片，刷新网页不丢进度、不在聊天流刷屏流水账。',
        en: 'Maintains a single durable in-place step checklist and progress bar per session without spamming chat.',
      },
      category: 'ui-slot',
      enabled: isEnabled('dsh-progress-card'),
      canToggle: true,
      roles: ['assistant', 'worker', 'ui-slot'],
      tools: ['progress_card_update', 'progress_card_clear'],
      uiSlot: 'chat.banner: 原地步骤进度卡',
      stats: {
        zh: `${input.progressCardCount ?? 0} 张活跃进度卡`,
        en: `${input.progressCardCount ?? 0} active cards`,
      },
    },
    {
      id: 'dsh-data-sql',
      packageName: '@rharness/plugin-data-sql',
      title: { zh: '本地数据表与订单 SQL 精确分析引擎 (Data SQL Analytics · DuckDB Pattern)', en: 'Read-Only SQL Analytics over Orders & CSVs' },
      description: {
        zh: '吸收社区 duckdb 技能设计：对本地 SQLite 订单库 (orders.db)、收藏表或任意本地 CSV 执行只读 SQL 聚合查询 (SUM/GROUP BY/AVG)，彻底杜绝大模型心算算错账。',
        en: 'Executes exact read-only SQL aggregations over orders.db, interests.csv, or local CSV files.',
      },
      category: 'assistant',
      enabled: isEnabled('dsh-data-sql'),
      canToggle: true,
      roles: ['assistant', 'worker'],
      tools: ['data_sql_query'],
    },
    {
      id: 'dsh-tool-search',
      packageName: '@rharness/plugin-tool-search',
      title: { zh: '大规模工具目录检索与参数自省 (Tool Catalog Search & Describe)', en: 'Tool Catalog Discovery & Schema Introspection' },
      description: {
        zh: '吸收 OpenClaw Tool Search 与 find-skills 机制：支持按关键词跨插件检索当前会话挂载的所有工具并查看精确 JSON Schema。',
        en: 'Allows agents to search and inspect schemas across large multi-plugin tool catalogs.',
      },
      category: 'core',
      enabled: isEnabled('dsh-tool-search'),
      canToggle: true,
      roles: ['assistant', 'worker'],
      tools: ['tool_catalog_search', 'tool_catalog_describe'],
    },
    ...(input.extraPrivatePlugins ?? []).map(pl => ({
      ...pl,
      enabled: isEnabled(pl.id),
    })),
    {
      id: 'ui-pipeline',
      packageName: '@rharness/ui-pipeline-slot',
      title: { zh: 'UI 视图插件：4 阶段管线追踪视图 (Pipeline Audit Slot)', en: 'UI Slot Plugin: 4-Stage Pipeline Audit' },
      description: {
        zh: '排在顶栏第 4 位的全链路管线追踪插槽（Source → Intake/Eval → Ticket → Outbox/Git）。关闭后顶栏「管线追踪」窗口实时卸载。',
        en: 'Fourth-tab UI slot plugin registering the 4-stage pipeline audit view.',
      },
      category: 'ui-slot',
      enabled: isEnabled('ui-pipeline'),
      canToggle: true,
      roles: ['ui-slot'],
      tools: [],
      uiSlot: 'topbar.tab#4: 管线追踪',
      stats: {
        zh: `${input.pipelineCount ?? 0} 条全链路记录`,
        en: `${input.pipelineCount ?? 0} pipeline records`,
      },
    },
    {
      id: 'ui-management',
      packageName: '@rharness/ui-management-slot',
      title: { zh: 'UI 视图插件：系统管理与策略审计套件 (System Admin Slot)', en: 'UI Slot Plugin: System Management Suite' },
      description: {
        zh: '排在顶栏第 5 位的 dsh-superagent 系统管理套件插槽（含概览、来源状态、触发器、评估记录、执行队列、准入策略与 Prompt 版本管理）。关闭后顶栏「系统管理」窗口实时卸载。',
        en: 'Fifth-tab UI slot plugin mounting Overview, Sources, Triggers, Evals, Execution, Policy, and Prompt version settings.',
      },
      category: 'ui-slot',
      enabled: isEnabled('ui-management'),
      canToggle: true,
      roles: ['orchestrator', 'ui-slot'],
      tools: ['orchestrator_settings_save', 'orchestrator_prompts_save'],
      uiSlot: 'topbar.tab#5: 系统管理',
    },
    {
      id: 'dsh-device-group',
      packageName: '@rharness/plugin-device-group',
      title: { zh: '分布式设备组与四重地址容灾 (RHFiles + RHRemote Device Group)', en: 'Distributed Device Group & Multi-Path Failover' },
      description: {
        zh: '融合 RHFiles ECDSA P-256 签名设备组与 RHRemote 四重地址自动回退（局域网 IP → 机器名 → Tailscale MagicDNS → Tailscale IP），支持跨机派单与 Git Bundle 自动合入。关闭后隐藏顶栏「节点」弹窗入口并仅在本机执行。',
        en: 'ECDSA P-256 device group pairing, multi-address failover (LAN + Hostname + MagicDNS + Tailscale IP), and P2P Git merge.',
      },
      category: 'distributed',
      enabled: isEnabled('dsh-device-group'),
      canToggle: true,
      roles: ['orchestrator', 'worker', 'ui-slot'],
      tools: ['orchestrator_route(worker_node)'],
      uiSlot: 'topbar.action: 节点管理弹窗',
      stats: {
        zh: `${input.nodeCount} 台已认证节点在线`,
        en: `${input.nodeCount} verified nodes online`,
      },
    },
    {
      id: 'dsh-model-profiles',
      packageName: '@rharness/plugin-model-profiles',
      title: { zh: '模型配置组 (1/2/3) 与角色 N 段分时调度 (Model Profiles)', en: 'Model Profiles & Per-Role N-Slot Scheduler' },
      description: {
        zh: '支持顶栏配置组 (组1/组2/组3) 一键切换，并在每个配置组内为 Eval 与 Worker 角色分别配置默认模型及任意 N 段高低峰时间窗口。关闭后隐藏顶栏配置组切换器。',
        en: 'Quick-switch profile groups (1/2/3) with per-role default models and N time-of-day scheduling slots.',
      },
      category: 'scheduler',
      enabled: isEnabled('dsh-model-profiles'),
      canToggle: true,
      roles: ['assistant', 'orchestrator', 'worker', 'ui-slot'],
      tools: [],
      uiSlot: 'topbar.action: 组1/组2/组3 与配置组弹窗',
      stats: {
        zh: `${input.profileCount} 个配置组已就绪`,
        en: `${input.profileCount} profile groups configured`,
      },
    },
    {
      id: 'dsh-worktree-merge',
      packageName: '@rharness/plugin-worktree-merge',
      title: { zh: 'Git Worktree 独立分支隔离与自动合入 (Worktree Auto-Merge)', en: 'Git Worktree Isolation & Auto-Merge' },
      description: {
        zh: '为每个工单检出独立 Git Worktree 分支 (agent/<slug>)，并在 Worker 汇报 ready 时自动提交未暂存改动并无冲突合入 main 分支。',
        en: 'Checks out an isolated Git worktree branch per Ticket and auto-merges into main when the worker reports ready.',
      },
      category: 'distributed',
      enabled: isEnabled('dsh-worktree-merge'),
      canToggle: true,
      roles: ['worker', 'ui-slot'],
      tools: ['orchestrator_report', 'autoMergeTicketWorktree'],
      uiSlot: 'inspector.header: Worktree 分支状态栏',
    },
    {
      id: 'dsh-superagent-core',
      packageName: 'dsh-superagent',
      title: { zh: '工程准入评估与工单引擎核心 (dsh-superagent Core Engine)', en: 'Engineering Eval & Ticket Engine Core' },
      description: {
        zh: 'dsh-superagent 核心状态机（Source → Trigger → Thread → Eval → Ticket → Assignment → Outbox），严格维护 Mandate 授权、并发槽位与审计不变式。',
        en: 'Core dsh-superagent state machine (Intake, Evals, Tickets, Assignments, Replies, and MasterAssessor).',
      },
      category: 'core',
      enabled: true,
      canToggle: false,
      roles: ['orchestrator', 'worker'],
      tools: [
        'orchestrator_route',
        'orchestrator_eval',
        'orchestrator_eval_read',
        'orchestrator_eval_decide',
        'orchestrator_reply',
        'orchestrator_read',
        'orchestrator_ack',
        'orchestrator_trigger_handback',
      ],
      promptSection: 'runtime/master (complete: true) & runtime/worker',
    },
    {
      id: 'dsh-multi-driver',
      packageName: '@rharness/plugin-multi-driver',
      title: { zh: '多模型宿主驱动与人工控制台 (DSH / Codex / Claude / Cursor / Human)', en: 'Multi-Provider Session Host & Human Console' },
      description: {
        zh: '统一 Session 宿主协议，支持为不同角色分别选择 DSH、Codex app-server、Claude、Cursor CLI 或人工通过调试控制台扮演角色。',
        en: 'Unified multi-provider session driver supporting DSH, Codex, Claude, Cursor CLI, and Human console actors.',
      },
      category: 'core',
      enabled: true,
      canToggle: false,
      roles: ['assistant', 'orchestrator', 'worker', 'ui-slot'],
      tools: ['runDshTurn', 'runCodexTurn', 'runCursorTurn'],
      uiSlot: 'modal: 调试控制台 (Session Console)',
    },
    {
      id: 'dsh-superagent-panel',
      packageName: 'dsh-superagent/panel-watch',
      title: { zh: '消息源插件：工程对话面板源 (Engineering Panel Source)', en: 'Source Plugin: Engineering Panel Source' },
      description: {
        zh: '接收「工程对话」工作台提交的研发需求与图文附件，驱动工单回执卡与话题状态更新。',
        en: 'Receives engineering requests and image attachments from the Engineering Chat workbench.',
      },
      category: 'source',
      enabled: input.sourcesEnabled.panel && isEnabled('dsh-superagent-panel'),
      canToggle: true,
      roles: ['orchestrator', 'worker'],
      tools: ['orchestrator_reply'],
      uiSlot: 'workbench.composer: 工程对话输入源',
    },
    {
      id: 'dsh-superagent-github',
      packageName: 'dsh-superagent/github-watch',
      title: { zh: '消息源插件：GitHub 仓库源 (GitHub Repository Source)', en: 'Source Plugin: GitHub Repository Source' },
      description: {
        zh: '监听 GitHub Issue、PR 评审与 CI 状态变化，并绑定工单分支 PR。',
        en: 'Watches GitHub Issues, PR reviews, and CI status changes.',
      },
      category: 'source',
      enabled: input.sourcesEnabled.github && isEnabled('dsh-superagent-github'),
      canToggle: true,
      roles: ['orchestrator', 'worker'],
      tools: ['orchestrator_report(pr_number)'],
    },
  ]
}
