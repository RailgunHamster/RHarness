/**
 * Personal Assistant Persona, Stickers, Auto-Applied Learning & Ambient Awareness
 * (`@rharness/plugin-assistant-persona-ambient`).
 *
 * Strictly Personal-Assistant-only: this module is never mounted onto Engineering Eval or Worker sessions.
 *
 * - Persona: 3-layer contract (identity/anti-slop + style knobs + few-shot examples) with switchable presets.
 * - Kaomoji: categorized bank gated by density setting.
 * - Stickers: user-uploaded images under `~/.rharness/stickers/` (override `RHARNESS_STICKERS_DIR`),
 *   metadata in KV, managed via REST UI and Assistant tools (`sticker_list/add/update/delete`),
 *   delivered in Web bubbles and as real Feishu images.
 * - Persona Learning: auto-applied style/address/preference ledger with full UI/Agent CRUD audit.
 * - Ambient: Beijing time + lunar calendar + solar terms + workday rhythm (silent injection),
 *   home-city weather via Open-Meteo (no key, 45-min cache), multi-source RSS news brief (pull tool).
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { resolveDayCalendarStatus, type DayModeOverride } from './model-profiles.ts'
import type { RegisteredToolSpec } from './standalone-host.ts'

// ============================================================================
// Persona config & presets
// ============================================================================

export type PersonaPresetId = 'warm-witty' | 'lively-playful' | 'calm-gentle' | 'concise-neutral'
export type PersonaVerbosity = 'brief' | 'balanced' | 'detailed'
export type KaomojiDensity = 'off' | 'light' | 'rich'
export type HumorLevel = 'off' | 'light' | 'lively'
export type StickerFrequency = 'off' | 'occasional' | 'lively'

export interface AssistantPersonaConfig {
  presetId: PersonaPresetId
  assistantName: string
  userAddress: string
  verbosity: PersonaVerbosity
  kaomojiDensity: KaomojiDensity
  humorLevel: HumorLevel
  stickerFrequency: StickerFrequency
  stickerCooldownTurns: number
  learningEnabled: boolean
  customInstructions: string
}

export interface PersonaPresetInfo {
  id: PersonaPresetId
  label: { zh: string; en: string }
  description: { zh: string; en: string }
}

export const PERSONA_PRESETS: PersonaPresetInfo[] = [
  {
    id: 'warm-witty',
    label: { zh: '机灵温暖日常搭子', en: 'Warm & Witty Companion' },
    description: { zh: '自然口语短句、有主见会接梗、适度颜文字与表情包；干活与查事实时立刻利落严谨。', en: 'Natural short spoken sentences, opinionated and playful, moderate kaomoji/stickers; crisp and rigorous for work.' },
  },
  {
    id: 'lively-playful',
    label: { zh: '活泼俏皮玩伴', en: 'Lively & Playful' },
    description: { zh: '情绪价值拉满、反应夸张一点点、颜文字和表情包更勤；正事仍不含糊。', en: 'High energy, slightly exaggerated reactions, frequent kaomoji/stickers; still reliable for serious tasks.' },
  },
  {
    id: 'calm-gentle',
    label: { zh: '温和沉稳贴心助理', en: 'Calm & Gentle' },
    description: { zh: '语气柔和耐心、少玩梗、颜文字克制；适合偏好安静陪伴感的日常。', en: 'Soft, patient tone, few jokes, restrained kaomoji; quiet companionship.' },
  },
  {
    id: 'concise-neutral',
    label: { zh: '简洁中性高效', en: 'Concise & Neutral' },
    description: { zh: '几乎不玩梗不发表情包，只给结论和要点；最像专业工具。', en: 'Almost no jokes or stickers, conclusions and bullets only; most tool-like.' },
  },
]

export function defaultAssistantPersonaConfig(): AssistantPersonaConfig {
  return {
    presetId: 'warm-witty',
    assistantName: 'Claw',
    userAddress: '主人',
    verbosity: 'balanced',
    kaomojiDensity: 'light',
    humorLevel: 'light',
    stickerFrequency: 'occasional',
    stickerCooldownTurns: 2,
    learningEnabled: true,
    customInstructions: '',
  }
}

const PRESET_IDS = new Set<string>(PERSONA_PRESETS.map(p => p.id))

export function normalizeAssistantPersonaConfig(raw: unknown): AssistantPersonaConfig {
  const base = defaultAssistantPersonaConfig()
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Record<string, unknown>
  const str = (v: unknown, fallback: string, max = 40) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback)
  return {
    presetId: typeof r.presetId === 'string' && PRESET_IDS.has(r.presetId) ? (r.presetId as PersonaPresetId) : base.presetId,
    assistantName: str(r.assistantName, base.assistantName),
    userAddress: str(r.userAddress, base.userAddress),
    verbosity: r.verbosity === 'brief' || r.verbosity === 'detailed' ? r.verbosity : 'balanced',
    kaomojiDensity: r.kaomojiDensity === 'off' || r.kaomojiDensity === 'rich' ? r.kaomojiDensity : 'light',
    humorLevel: r.humorLevel === 'off' || r.humorLevel === 'lively' ? r.humorLevel : 'light',
    stickerFrequency: r.stickerFrequency === 'off' || r.stickerFrequency === 'lively' ? r.stickerFrequency : 'occasional',
    stickerCooldownTurns: typeof r.stickerCooldownTurns === 'number' && Number.isFinite(r.stickerCooldownTurns) ? Math.min(10, Math.max(0, Math.round(r.stickerCooldownTurns))) : base.stickerCooldownTurns,
    learningEnabled: r.learningEnabled !== false,
    customInstructions: typeof r.customInstructions === 'string' ? r.customInstructions.trim().slice(0, 800) : '',
  }
}

// ============================================================================
// Kaomoji bank
// ============================================================================

export const KAOMOJI_BANK: Record<string, string[]> = {
  happy: ['(｡•̀ᴗ-)✧', '(≧▽≦)', 'ヾ(≧▽≦*)o', '(๑˃̵ᴗ˂̵)و'],
  thinking: ['(´-ω-`)', '(•ิ_•ิ)?', '(￣～￣;)'],
  surprised: ['Σ(っ °Д °;)っ', '(⊙_⊙)？', 'Σ(ﾟдﾟ;)'],
  comfort: ['(´；ω；`)', '(っ´ω`c)', '摸摸头 (´･ω･`)っ'],
  proud: ['(￣▽￣)／', '✧(≖ ◡ ≖✿)', '(¬‿¬)'],
  speechless: ['(=_=)', '(¬_¬)', '(；￣Д￣)'],
  sleepy: ['(￣o￣) . z Z', '(´-ω-`)💤'],
  thanks: ['(人´∀`)♪', '(*´▽`*)', '(๑>◡<๑)'],
}

export function kaomojiForDensity(density: KaomojiDensity): Record<string, string[]> {
  if (density === 'off') return {}
  if (density === 'rich') return KAOMOJI_BANK
  const light: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(KAOMOJI_BANK)) light[k] = v.slice(0, 2)
  return light
}

// ============================================================================
// Persona learning ledger (auto-applied, fully auditable)
// ============================================================================

export type PersonaLearningKind = 'style' | 'address' | 'preference' | 'rapport' | 'boundary'

export interface PersonaLearningEntry {
  id: string
  kind: PersonaLearningKind
  content: string
  enabled: boolean
  source: 'user' | 'auto' | 'agent'
  createdAt: string
  updatedAt: string
}

export const PERSONA_LEARNING_MAX_ENTRIES = 60
export const PERSONA_LEARNING_PROMPT_CHAR_BUDGET = 1200

export function savePersonaLearning(
  entries: readonly PersonaLearningEntry[],
  input: { kind?: PersonaLearningKind; content: string; source?: PersonaLearningEntry['source'] },
  now = new Date(),
): { entry: PersonaLearningEntry; list: PersonaLearningEntry[] } {
  const content = input.content.trim().replace(/\s+/g, ' ').slice(0, 240)
  if (!content) throw new Error('Learning content is required')
  const kind: PersonaLearningKind = input.kind ?? 'preference'
  const existing = entries.find(e => e.content.toLowerCase() === content.toLowerCase())
  if (existing) {
    const updated = { ...existing, kind, enabled: true, updatedAt: now.toISOString() }
    return { entry: updated, list: entries.map(e => (e.id === existing.id ? updated : e)) }
  }
  const entry: PersonaLearningEntry = {
    id: `plearn-${now.getTime()}-${randomUUID().slice(0, 6)}`,
    kind,
    content,
    enabled: true,
    source: input.source ?? 'user',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
  return { entry, list: [...entries, entry].slice(-PERSONA_LEARNING_MAX_ENTRIES) }
}

export function buildPersonaLearningPromptSummary(entries: readonly PersonaLearningEntry[]): string {
  const enabled = entries.filter(e => e.enabled)
  if (!enabled.length) return ''
  const lines: string[] = []
  let used = 0
  for (const e of [...enabled].reverse()) {
    const line = `- [${e.kind}] ${e.content}`
    if (used + line.length > PERSONA_LEARNING_PROMPT_CHAR_BUDGET) break
    lines.push(line)
    used += line.length
  }
  return lines.reverse().join('\n')
}

/** Extracts explicit style/address/boundary instructions the user states in chat (auto-applied, user can delete in UI). */
export function extractPersonaLearningFromUserMessage(text: string): { kind: PersonaLearningKind; content: string } | undefined {
  const t = text.trim().replace(/^📱\s*\[飞书私聊\]\s*/, '')
  if (t.length < 4 || t.length > 300) return undefined
  if (/sk-|api[_-]?key|password|密码|身份证|银行卡|验证码/.test(t)) return undefined
  const addressMatch = /(?:以后)?叫我([^，。！？\s]{1,12})(?:[，。！？\s]|$)/.exec(t)
  if (addressMatch?.[1]) return { kind: 'address', content: `称呼用户为「${addressMatch[1]}」` }
  const dontAddress = /不要叫我([^，。！？\s]{1,12})/.exec(t)
  if (dontAddress?.[1]) return { kind: 'address', content: `不要称呼用户为「${dontAddress[1]}」` }
  const stylePatterns: { re: RegExp; kind: PersonaLearningKind }[] = [
    { re: /(?:以后|下次|记住)[^。！？]{0,60}(?:回复|说话|闲聊|语气|简短|详细|颜文字|表情包|列点|分点|口语|正式|玩梗|称呼)[^。！？]{0,60}/, kind: 'style' },
    { re: /(?:闲聊时|聊天时|回复时|说话时)[^。！？]{2,80}/, kind: 'style' },
    { re: /(?:别再|不要再|以后别|别老是)[^。！？]{2,60}/, kind: 'boundary' },
    { re: /(?:我喜欢|我不喜欢|我讨厌|我希望你)[^。！？]{2,60}(?:回复|语气|风格|颜文字|表情包|简短|详细|玩梗|称呼|列点)[^。！？]{0,30}/, kind: 'preference' },
  ]
  for (const { re, kind } of stylePatterns) {
    const m = re.exec(t)
    if (m?.[0]) return { kind, content: m[0].trim().slice(0, 160) }
  }
  return undefined
}

// ============================================================================
// Stickers (user-uploaded files under ~/.rharness/stickers)
// ============================================================================

export interface StickerRecord {
  id: string
  name: string
  tags: string[]
  emotion?: string
  fileName: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  sizeBytes: number
  sha256: string
  createdAt: string
  updatedAt: string
  useCount: number
  lastUsedAt?: string
  source: 'upload' | 'chat' | 'feishu'
  feishuImageKey?: string
  /** Soft-delete marker (ISO): the sticker sits in the 1-day trash and can be restored until then. */
  deletedAt?: string
}

/** Deleted stickers are kept restorable for exactly 1 day, then purged for good (file removed). */
export const STICKER_TRASH_RETENTION_MS = 24 * 60 * 60 * 1000

export function isStickerTrashed(record: StickerRecord): boolean {
  return Boolean(record.deletedAt)
}
export function activeStickers(records: readonly StickerRecord[]): StickerRecord[] {
  return records.filter(r => !r.deletedAt)
}
export function trashedStickers(records: readonly StickerRecord[]): StickerRecord[] {
  return records.filter(r => Boolean(r.deletedAt))
}
export function stickerTrashPurgeAt(record: StickerRecord): string | undefined {
  if (!record.deletedAt) return undefined
  const t = Date.parse(record.deletedAt)
  return Number.isFinite(t) ? new Date(t + STICKER_TRASH_RETENTION_MS).toISOString() : undefined
}
/** Removes trash entries older than the 1-day retention (deleting their files). Returns the kept list + purged records. */
export function purgeExpiredStickerTrash(records: readonly StickerRecord[], now = new Date()): { list: StickerRecord[]; purged: StickerRecord[] } {
  const cutoff = now.getTime() - STICKER_TRASH_RETENTION_MS
  const purged: StickerRecord[] = []
  const list: StickerRecord[] = []
  for (const r of records) {
    const deletedAtMs = r.deletedAt ? Date.parse(r.deletedAt) : NaN
    if (r.deletedAt && (!Number.isFinite(deletedAtMs) || deletedAtMs <= cutoff)) purged.push(r)
    else list.push(r)
  }
  for (const r of purged) deleteStickerFile(r)
  return { list, purged }
}
/** Soft-delete: move a sticker into the 1-day trash (file kept, restorable). */
export function trashStickerRecord(records: readonly StickerRecord[], id: string, now = new Date()): { list: StickerRecord[]; entry?: StickerRecord } {
  let entry: StickerRecord | undefined
  const list = records.map(r => {
    if (r.id !== id || r.deletedAt) return r
    entry = { ...r, deletedAt: now.toISOString(), updatedAt: now.toISOString() }
    return entry
  })
  return { list, ...(entry ? { entry } : {}) }
}
/** Undo a soft-delete while the sticker is still inside the 1-day trash window. */
export function restoreStickerRecord(records: readonly StickerRecord[], id: string, now = new Date()): { list: StickerRecord[]; entry?: StickerRecord } {
  let entry: StickerRecord | undefined
  const list = records.map(r => {
    if (r.id !== id || !r.deletedAt) return r
    const { deletedAt: _drop, ...rest } = r
    entry = { ...rest, updatedAt: now.toISOString() }
    return entry
  })
  return { list, ...(entry ? { entry } : {}) }
}

export const STICKER_MAX_BYTES = 8 * 1024 * 1024
export const STICKER_MEDIA_EXT: Record<StickerRecord['mediaType'], string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

export function getStickerStorageDir(): string {
  const override = process.env.RHARNESS_STICKERS_DIR?.trim()
  return resolve(override ? override : join(homedir(), '.rharness', 'stickers'))
}

export function ensureStickerStorageDir(): string {
  const dir = getStickerStorageDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

export function resolveStickerFilePath(record: Pick<StickerRecord, 'fileName'>): string {
  const dir = ensureStickerStorageDir()
  const safe = basename(record.fileName)
  const full = resolve(dir, safe)
  if (!full.startsWith(dir)) throw new Error('Invalid sticker file path')
  return full
}

function detectStickerMediaType(buf: Buffer): StickerRecord['mediaType'] | undefined {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.toString('ascii', 0, 6))) return 'image/gif'
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

export function saveStickerFromBuffer(
  records: readonly StickerRecord[],
  input: { data: Buffer; name: string; tags?: string[]; emotion?: string; source?: StickerRecord['source'] },
  now = new Date(),
): { entry: StickerRecord; list: StickerRecord[] } {
  if (!input.data.length || input.data.length > STICKER_MAX_BYTES) throw new Error('Sticker image must be between 1 byte and 8 MiB')
  const mediaType = detectStickerMediaType(input.data)
  if (!mediaType) throw new Error('Sticker must be a PNG, JPEG, WebP, or GIF image')
  const sha256 = createHash('sha256').update(input.data).digest('hex')
  const dup = records.find(r => r.sha256 === sha256 && !r.deletedAt)
  if (dup) return { entry: dup, list: [...records] }
  const id = `stk-${now.getTime()}-${randomUUID().slice(0, 6)}`
  const fileName = `${id}${STICKER_MEDIA_EXT[mediaType]}`
  const dir = ensureStickerStorageDir()
  writeFileSync(join(dir, fileName), input.data, { mode: 0o600 })
  const entry: StickerRecord = {
    id,
    name: (input.name || '未命名表情').trim().slice(0, 40) || '未命名表情',
    tags: [...new Set((input.tags ?? []).map(t => t.trim().slice(0, 20)).filter(Boolean))].slice(0, 8),
    ...(input.emotion?.trim() ? { emotion: input.emotion.trim().slice(0, 20) } : {}),
    fileName,
    mediaType,
    sizeBytes: input.data.length,
    sha256,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    useCount: 0,
    source: input.source ?? 'upload',
  }
  return { entry, list: [...records, entry] }
}

export function saveStickerFromBase64(
  records: readonly StickerRecord[],
  input: { dataBase64: string; name: string; tags?: string[]; emotion?: string; source?: StickerRecord['source'] },
  now = new Date(),
): { entry: StickerRecord; list: StickerRecord[] } {
  const clean = input.dataBase64.replace(/^data:[^;,]+;base64,/, '')
  return saveStickerFromBuffer(records, { data: Buffer.from(clean, 'base64'), name: input.name, ...(input.tags ? { tags: input.tags } : {}), ...(input.emotion ? { emotion: input.emotion } : {}), ...(input.source ? { source: input.source } : {}) }, now)
}

export function readStickerFile(record: StickerRecord): Buffer | undefined {
  try {
    const p = resolveStickerFilePath(record)
    return existsSync(p) ? readFileSync(p) : undefined
  } catch { return undefined }
}

export function deleteStickerFile(record: StickerRecord): void {
  try { rmSync(resolveStickerFilePath(record), { force: true }) } catch {}
}

export function findSticker(records: readonly StickerRecord[], query: string): StickerRecord[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return records.filter(r => !r.deletedAt && (r.id === q || r.name.toLowerCase() === q || r.name.toLowerCase().includes(q) || r.tags.some(t => t.toLowerCase() === q || t.toLowerCase().includes(q)) || (r.emotion ?? '').toLowerCase() === q))
}

/** Parses a trailing `[sticker:<id|name|tag>]` marker the model may append; returns cleaned text + matched sticker. */
export function parseStickerMarker(text: string, records: readonly StickerRecord[]): { cleanText: string; sticker?: StickerRecord } {
  const m = /\[sticker:([^\]]{1,40})\]\s*$/.exec(text.trimEnd())
  if (!m?.[1]) return { cleanText: text }
  const cleanText = text.slice(0, m.index).trimEnd()
  const matches = findSticker(records, m[1])
  return matches[0] ? { cleanText, sticker: matches[0] } : { cleanText }
}

/** Enforces sticker frequency + cooldown against recent bot messages that already carried stickers. */
export function stickerAllowedByPolicy(
  config: AssistantPersonaConfig,
  recentBotStickerFlags: readonly boolean[],
): boolean {
  if (config.stickerFrequency === 'off') return false
  const cooldown = config.stickerCooldownTurns
  const recent = recentBotStickerFlags.slice(-Math.max(cooldown, 1))
  if (cooldown > 0 && recent.some(Boolean)) return false
  if (config.stickerFrequency === 'occasional') {
    // At most roughly 1 in 3 casual turns: block if any of last 2 bot turns had a sticker (in addition to cooldown above)
    if (recentBotStickerFlags.slice(-2).some(Boolean)) return false
  }
  return true
}

// ============================================================================
// Persona prompt section (Assistant-only)
// ============================================================================

const PRESET_FEW_SHOT: Record<PersonaPresetId, string[]> = {
  'warm-witty': [
    '用户：今天好累啊 → 助理：辛苦啦，先瘫一会儿 (´-ω-`) 正事我盯着，有动静第一时间喊你。',
    '用户：帮我看看明天天气 → 助理：明天多云转晴，18~26°C，早晚有点凉，出门加件薄外套就行。',
    '用户：这个方案行吗 → 助理：大方向没问题，就是第二步成本估得偏乐观，我建议留 20% 缓冲再推进。',
  ],
  'lively-playful': [
    '用户：搞定了！ → 助理：芜湖！🎉 就知道你能行 (≧▽≦) 接下来交给我收尾~',
    '用户：有点emo → 助理：抱抱 (っ´ω`c) 先吃点好的，天塌下来有我帮你顶着一半呢。',
  ],
  'calm-gentle': [
    '用户：今天好累啊 → 助理：辛苦了，先好好休息。剩下的事我都记下了，不用惦记。',
    '用户：帮我看看明天天气 → 助理：明天多云转晴，18~26°C。早晚稍凉，记得带件薄外套。',
  ],
  'concise-neutral': [
    '用户：帮我看看明天天气 → 助理：明天多云转晴，18~26°C，早晚凉。',
    '用户：这个方案行吗 → 助理：可行。第二步成本偏乐观，建议预留 20% 缓冲。',
  ],
}

const ANTI_SLOP = [
  '禁止 AI 腔黑名单：不要说「好的呢」「很高兴为您解答」「总而言之」「综上所述」「希望对您有所帮助」「作为一个AI」。',
  '闲聊用自然口语短句，像熟人发微信；查事实、报数据、讲方案时立刻切换为利落严谨的结构化表达，不卖萌不绕弯。',
  '有自己的判断：方案有问题就直说并给替代建议，不要只会附和。',
]

export function buildPersonaPromptSection(
  config: AssistantPersonaConfig,
  learnings: readonly PersonaLearningEntry[],
  stickers: readonly StickerRecord[],
): string {
  const preset = PERSONA_PRESETS.find(p => p.id === config.presetId) ?? PERSONA_PRESETS[0]!
  const lines: string[] = [
    '## Personal Persona & Style (Personal Assistant Only)',
    `你的名字/自称：${config.assistantName}；称呼用户为「${config.userAddress}」。当前人设预设：${preset.label.zh} —— ${preset.description.zh}`,
    ...ANTI_SLOP.map(s => `- ${s}`),
  ]
  if (config.verbosity === 'brief') lines.push('- 回复长度：偏简短，先给结论，除非用户追问不展开。')
  else if (config.verbosity === 'detailed') lines.push('- 回复长度：可以详细展开背景与推理，但避免注水。')
  else lines.push('- 回复长度：适中，先结论后要点。')
  if (config.humorLevel === 'off') lines.push('- 幽默：关闭，不要玩梗调侃。')
  else if (config.humorLevel === 'lively') lines.push('- 幽默：可以活泼接梗、适度调侃，但不冒犯、不拿正事开玩笑。')
  else lines.push('- 幽默：轻度，有梗顺手接一下即可，不强行搞笑。')
  const kaomoji = kaomojiForDensity(config.kaomojiDensity)
  if (config.kaomojiDensity !== 'off') {
    lines.push(`- 颜文字：闲聊时可自然点缀（不要每句都加、不要重复同一个）。可选：${Object.entries(kaomoji).map(([k, v]) => `${k}: ${v.join(' ')}`).join('；')}`)
  } else {
    lines.push('- 颜文字：关闭，不要使用颜文字。')
  }
  if (config.stickerFrequency !== 'off' && stickers.length > 0) {
    const catalog = stickers.slice(0, 30).map(s => `${s.name}{${[...s.tags, ...(s.emotion ? [s.emotion] : [])].join('/') || '日常'}}`).join('、')
    lines.push(`- 表情包：闲聊氛围合适时，可在回复末尾单独追加一个标记 \`[sticker:表情名或标签]\`，系统会把它渲染成真实表情图片并执行频率冷却；严肃话题、报错、工程汇报时不要发表情包。当前图库：${catalog}`)
  } else if (config.stickerFrequency !== 'off') {
    lines.push('- 表情包：图库目前为空，不要编造 `[sticker:...]` 标记；用户上传后即可使用。')
  }
  if (config.customInstructions.trim()) lines.push(`- 用户自定义风格要求：${config.customInstructions.trim()}`)
  const learned = buildPersonaLearningPromptSummary(learnings)
  if (learned) lines.push('', '### 已学会的相处默契（自动学习生效中，用户可在面板增删）', learned)
  lines.push('', '### 语气示例（学习分寸，不要照抄）', ...PRESET_FEW_SHOT[config.presetId].map(s => `- ${s}`))
  lines.push('- 管理接口：用户让你增删表情包/学习条目/改常驻城市或人设时，直接调用 sticker_*、persona_learning_*、persona_*、ambient_* 工具执行，不要只口头答应。用户问路线/通勤时长/怎么走（「我回家要多久」「去公司怎么走」）时调用 `navigation_route`（起点默认主要常驻地址，可传 家/公司 等标签），把时长、距离和导航链接一起给到，不要凭感觉估路程时间。')
  return lines.join('\n')
}

// ============================================================================
// Ambient awareness: time rhythm, lunar, solar terms, weather, news
// ============================================================================

export interface AmbientHomeCity {
  name: string
  latitude: number
  longitude: number
  timezone: string
}

/** One resident address: free-form detailed address plus its geocoded city (weather granularity). */
export interface ResidentAddress {
  id: string
  /** Short human label, e.g. 家 / 公司 / 老家. */
  label: string
  /** Detailed address exactly as the user wrote it (district/street/building/room). */
  address: string
  /** Resolved city used for weather & coarse location context. */
  city: AmbientHomeCity
  /** Exactly one primary address when the list is non-empty; its city drives the weather baseline. */
  isPrimary: boolean
  createdAt: string
  updatedAt: string
}

export interface AssistantAmbientConfig {
  homeCity: AmbientHomeCity
  /** Multiple resident addresses; `homeCity` always mirrors the primary address's city when present. */
  residentAddresses: ResidentAddress[]
  weatherEnabled: boolean
  newsEnabled: boolean
}

export function defaultAssistantAmbientConfig(): AssistantAmbientConfig {
  return {
    homeCity: { name: '北京', latitude: 39.9042, longitude: 116.4074, timezone: 'Asia/Shanghai' },
    residentAddresses: [],
    weatherEnabled: true,
    newsEnabled: true,
  }
}

function normalizeHomeCity(raw: unknown, fallback: AmbientHomeCity): AmbientHomeCity {
  const city = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const lat = Number(city.latitude)
  const lon = Number(city.longitude)
  return {
    name: typeof city.name === 'string' && city.name.trim() ? city.name.trim().slice(0, 40) : fallback.name,
    latitude: Number.isFinite(lat) && lat >= -90 && lat <= 90 ? lat : fallback.latitude,
    longitude: Number.isFinite(lon) && lon >= -180 && lon <= 180 ? lon : fallback.longitude,
    timezone: typeof city.timezone === 'string' && city.timezone.trim() ? city.timezone.trim().slice(0, 60) : fallback.timezone,
  }
}

export const MAX_RESIDENT_ADDRESSES = 10

function normalizeResidentAddresses(raw: unknown): ResidentAddress[] {
  if (!Array.isArray(raw)) return []
  const out: ResidentAddress[] = []
  for (const item of raw.slice(0, MAX_RESIDENT_ADDRESSES)) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const address = typeof r.address === 'string' ? r.address.trim().slice(0, 160) : ''
    if (!address) continue
    const cityRaw = (r.city ?? {}) as Record<string, unknown>
    const lat = Number(cityRaw.latitude)
    const lon = Number(cityRaw.longitude)
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) continue
    const city = normalizeHomeCity(cityRaw, { name: '北京', latitude: lat, longitude: lon, timezone: 'Asia/Shanghai' })
    const id = typeof r.id === 'string' && r.id.trim()
      ? r.id.trim().slice(0, 60)
      : `addr-${createHash('sha256').update(`${address}|${city.name}`).digest('hex').slice(0, 10)}`
    out.push({
      id,
      label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 20) : '常驻地址',
      address,
      city,
      isPrimary: r.isPrimary === true,
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString(),
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date(0).toISOString(),
    })
  }
  if (out.length > 0) {
    const primaryIdx = out.findIndex(a => a.isPrimary)
    const keep = primaryIdx >= 0 ? primaryIdx : 0
    out.forEach((a, i) => { a.isPrimary = i === keep })
  }
  return out
}

export function normalizeAssistantAmbientConfig(raw: unknown): AssistantAmbientConfig {
  const base = defaultAssistantAmbientConfig()
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Record<string, unknown>
  const residentAddresses = normalizeResidentAddresses(r.residentAddresses)
  const primary = residentAddresses.find(a => a.isPrimary)
  return {
    // With resident addresses present, the weather baseline city always mirrors the primary address.
    homeCity: primary ? primary.city : normalizeHomeCity(r.homeCity, base.homeCity),
    residentAddresses,
    weatherEnabled: r.weatherEnabled !== false,
    newsEnabled: r.newsEnabled !== false,
  }
}

/** Adds or updates (same detailed address text) a resident address, returns the normalized config. */
export function upsertResidentAddress(
  config: AssistantAmbientConfig,
  input: { label?: string; address: string; city: AmbientHomeCity; makePrimary?: boolean },
  now = new Date(),
): { config: AssistantAmbientConfig; entry: ResidentAddress } {
  const address = input.address.trim().slice(0, 160)
  const existing = config.residentAddresses.find(a => a.address === address)
  const entry: ResidentAddress = existing
    ? {
        ...existing,
        ...(input.label?.trim() ? { label: input.label.trim().slice(0, 20) } : {}),
        city: input.city,
        isPrimary: input.makePrimary ? true : existing.isPrimary,
        updatedAt: now.toISOString(),
      }
    : {
        id: `addr-${now.getTime()}-${randomUUID().slice(0, 6)}`,
        label: input.label?.trim().slice(0, 20) || '常驻地址',
        address,
        city: input.city,
        isPrimary: input.makePrimary === true || config.residentAddresses.length === 0,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }
  const list = existing
    ? config.residentAddresses.map(a => (a.id === existing.id ? entry : entry.isPrimary ? { ...a, isPrimary: false } : a))
    : [...config.residentAddresses, ...(entry.isPrimary ? config.residentAddresses.map(a => ({ ...a, isPrimary: false })) : []), entry].slice(-MAX_RESIDENT_ADDRESSES)
  const normalized = normalizeAssistantAmbientConfig({ ...config, residentAddresses: list })
  return { config: normalized, entry: normalized.residentAddresses.find(a => a.address === address) ?? entry }
}

export function removeResidentAddress(config: AssistantAmbientConfig, id: string): AssistantAmbientConfig {
  return normalizeAssistantAmbientConfig({ ...config, residentAddresses: config.residentAddresses.filter(a => a.id !== id) })
}

export function setPrimaryResidentAddress(config: AssistantAmbientConfig, id: string): AssistantAmbientConfig {
  return normalizeAssistantAmbientConfig({
    ...config,
    residentAddresses: config.residentAddresses.map(a => ({ ...a, isPrimary: a.id === id })),
  })
}

export interface WeatherCache {
  cityName: string
  fetchedAt: string
  current: { temperatureC: number; weatherCode: number; label: string; humidityPct?: number; precipitationProbabilityPct?: number }
  today: { minC: number; maxC: number; label: string }
  tomorrow?: { minC: number; maxC: number; label: string }
  tonightRainProbabilityPct?: number
  oneLiner: string
}

export interface NewsItem { title: string; url: string; source: string; topic: string; publishedAt?: string }
export interface NewsCache { fetchedAt: string; items: NewsItem[] }

export const WEATHER_CACHE_TTL_MS = 45 * 60 * 1000
export const NEWS_CACHE_TTL_MS = 90 * 60 * 1000

export function isWeatherCacheFresh(cache: WeatherCache | undefined, cityName: string, now = new Date()): boolean {
  if (!cache || cache.cityName !== cityName) return false
  const t = Date.parse(cache.fetchedAt)
  return Number.isFinite(t) && now.getTime() - t < WEATHER_CACHE_TTL_MS
}
export function isNewsCacheFresh(cache: NewsCache | undefined, now = new Date()): boolean {
  if (!cache) return false
  const t = Date.parse(cache.fetchedAt)
  return Number.isFinite(t) && now.getTime() - t < NEWS_CACHE_TTL_MS
}

const WMO_LABELS: Record<number, string> = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '暴雨阵雨', 85: '阵雪', 86: '阵雪', 95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹',
}
export function wmoWeatherLabel(code: number): string {
  return WMO_LABELS[code] ?? '多变天气'
}

/** 24 solar terms with typical Gregorian dates (month, day). Deterministic, no dependency. */
const SOLAR_TERMS: { name: string; month: number; day: number }[] = [
  { name: '小寒', month: 1, day: 5 }, { name: '大寒', month: 1, day: 20 },
  { name: '立春', month: 2, day: 4 }, { name: '雨水', month: 2, day: 19 },
  { name: '惊蛰', month: 3, day: 5 }, { name: '春分', month: 3, day: 20 },
  { name: '清明', month: 4, day: 5 }, { name: '谷雨', month: 4, day: 20 },
  { name: '立夏', month: 5, day: 5 }, { name: '小满', month: 5, day: 21 },
  { name: '芒种', month: 6, day: 5 }, { name: '夏至', month: 6, day: 21 },
  { name: '小暑', month: 7, day: 7 }, { name: '大暑', month: 7, day: 22 },
  { name: '立秋', month: 8, day: 7 }, { name: '处暑', month: 8, day: 23 },
  { name: '白露', month: 9, day: 7 }, { name: '秋分', month: 9, day: 23 },
  { name: '寒露', month: 10, day: 8 }, { name: '霜降', month: 10, day: 23 },
  { name: '立冬', month: 11, day: 7 }, { name: '小雪', month: 11, day: 22 },
  { name: '大雪', month: 12, day: 7 }, { name: '冬至', month: 12, day: 21 },
]

export function resolveSolarTerm(now = new Date()): { current: string; next: string; daysToNext: number } {
  const year = now.getFullYear()
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const today = startOfDay(now)
  const points = SOLAR_TERMS.map(t => ({ name: t.name, at: new Date(year, t.month - 1, t.day).getTime() }))
  // Include next year's first terms for wrap-around
  const extended = [...points, { name: '小寒', at: new Date(year + 1, 0, 5).getTime() }, { name: '大寒', at: new Date(year + 1, 0, 20).getTime() }]
  let current = '冬至'
  let next = extended[0]!
  for (let i = 0; i < extended.length; i++) {
    if (extended[i]!.at <= today) current = extended[i]!.name
    if (extended[i]!.at > today) { next = extended[i]!; break }
  }
  if (today < points[0]!.at) current = '冬至'
  return { current, next: next.name, daysToNext: Math.max(0, Math.round((next.at - today) / 86400000)) }
}

export function formatLunarDate(now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric' }).format(now)
  } catch { return '' }
}

export function timePeriodLabel(now = new Date()): string {
  // Beijing hour regardless of host timezone
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(now))
  if (hour < 5) return '深夜'
  if (hour < 8) return '清晨'
  if (hour < 11) return '上午'
  if (hour < 13) return '中午'
  if (hour < 17) return '下午'
  if (hour < 19) return '傍晚'
  if (hour < 23) return '夜晚'
  return '深夜'
}

export interface AmbientSnapshot {
  at: string
  beijingTime: string
  lunarDate: string
  solarTerm: { current: string; next: string; daysToNext: number }
  period: string
  dayType: 'workday' | 'holiday'
  dayReason: string
  weekdayLabel: string
  homeCity: AmbientHomeCity
  residentAddresses: ResidentAddress[]
  weather?: WeatherCache
  weatherStale?: boolean
  oneLiner: string
}

export function buildAmbientSnapshot(
  config: AssistantAmbientConfig,
  weatherCache: WeatherCache | undefined,
  now = new Date(),
  calendarOptions?: { dayModeOverride?: DayModeOverride; customHolidays?: readonly string[]; customWorkdays?: readonly string[] },
): AmbientSnapshot {
  const beijingTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(now)
  const lunarDate = formatLunarDate(now)
  const solarTerm = resolveSolarTerm(now)
  const period = timePeriodLabel(now)
  // Day rhythm computed on Beijing calendar date
  const beijingParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  const [by, bm, bd] = beijingParts.split('-').map(Number)
  const beijingDate = new Date(by ?? now.getFullYear(), (bm ?? 1) - 1, bd ?? now.getDate())
  const day = resolveDayCalendarStatus(beijingDate, calendarOptions)
  const weatherFresh = isWeatherCacheFresh(weatherCache, config.homeCity.name, now)
  const weather = weatherCache && weatherCache.cityName === config.homeCity.name ? weatherCache : undefined
  const parts = [
    `📍 ${config.homeCity.name}`,
    ...(weather ? [`${Math.round(weather.current.temperatureC)}°C ${weather.current.label}`] : []),
    ...(lunarDate ? [`农历${lunarDate.replace(/^\d+年/, '')}`] : []),
    `${solarTerm.current} · 距${solarTerm.next} ${solarTerm.daysToNext} 天`,
    day.effectiveDayType === 'workday' ? '工作日' : '休息日',
  ]
  return {
    at: now.toISOString(),
    beijingTime,
    lunarDate,
    solarTerm,
    period,
    dayType: day.effectiveDayType,
    dayReason: day.reason.zh,
    weekdayLabel: day.weekdayLabel.zh,
    homeCity: config.homeCity,
    residentAddresses: config.residentAddresses,
    ...(weather ? { weather } : {}),
    ...(weather && !weatherFresh ? { weatherStale: true } : {}),
    oneLiner: parts.join(' · '),
  }
}

export function buildAmbientPromptSection(snapshot: AmbientSnapshot): string {
  const lines = [
    '## Ambient Awareness (silent background context — use naturally, do not recite unbidden)',
    `- Now: ${snapshot.beijingTime}（${snapshot.period}），农历${snapshot.lunarDate || '—'}，${snapshot.solarTerm.current}（距${snapshot.solarTerm.next}还有 ${snapshot.solarTerm.daysToNext} 天），${snapshot.weekdayLabel} · ${snapshot.dayType === 'workday' ? '工作日' : '休息日'}（${snapshot.dayReason}）。`,
  ]
  if (snapshot.weather) lines.push(`- 常驻城市 ${snapshot.homeCity.name} 天气：${snapshot.weather.oneLiner}${snapshot.weatherStale ? '（缓存稍旧）' : ''}。用户问天气/出行/穿衣时优先用这里的数据，需要其他城市或逐日详情再调用 \`weather_query\`。`)
  for (const addr of snapshot.residentAddresses) {
    lines.push(`- 常驻地址${addr.isPrimary ? '（主要，天气基准）' : ''}「${addr.label}」：${addr.address}（所在城市：${addr.city.name}）。用户聊通勤、外卖、快递、附近生活或出行时按这个地址理解，不要主动复述完整门牌号，除非用户问起。`)
  }
  lines.push('- 用户问「最近有什么新闻/热点」时调用 `news_brief`（可带 topic：科技/AI/财经/综合），不要凭训练记忆编造新闻。')
  return lines.join('\n')
}

// ---- Open-Meteo (no API key) ----

type FetchFn = typeof fetch

export interface CityCandidate extends AmbientHomeCity {
  admin1?: string
  country?: string
  population?: number
  /** Which (possibly degraded) query variant produced this candidate. */
  matchedQuery: string
}

/**
 * Degrades a free-form place query (often a detailed street address like
 * "上海市徐汇区梅陇十一村46号401", which geocoders cannot resolve directly) into
 * progressively coarser variants: full text → text without the trailing
 * number-led suffix → district → municipality/city → city without the 市 suffix.
 */
export function cityQueryVariants(query: string): string[] {
  const q = query.trim().replace(/\s+/g, ' ')
  if (!q) return []
  const variants: string[] = [q]
  const noNumberTail = q.replace(/\d[\d\s号楼栋单元室层#-]*.*$/, '').trim()
  if (noNumberTail && noNumberTail !== q) variants.push(noNumberTail)
  const cityMatch = /([\u4e00-\u9fa5]{2,8}?市)/.exec(q)
  const city = cityMatch?.[1]
  if (city) {
    const afterCity = q.slice((cityMatch?.index ?? 0) + city.length)
    const district = /([\u4e00-\u9fa5]{2,6}?(?:区|县))/.exec(afterCity)?.[1]
    if (district) {
      variants.push(district)
      variants.push(district.replace(/(?:区|县)$/, ''))
    }
    variants.push(city)
    variants.push(city.replace(/市$/, ''))
  }
  const countyLevel = /([\u4e00-\u9fa5]{2,8}?(?:县|区))/.exec(q)?.[1]
  if (countyLevel) variants.push(countyLevel)
  return [...new Set(variants.map(v => v.trim()).filter(v => v.length >= 2))]
}

/**
 * Searches Open-Meteo geocoding with progressively degraded query variants and merges
 * the hits into a de-duplicated candidate list, so users pick their city from a list
 * instead of hitting a bare "City not found" for detailed addresses.
 */
export async function searchCityCandidates(query: string, fetcher: FetchFn = fetch): Promise<CityCandidate[]> {
  const variants = cityQueryVariants(query)
  const isCjkQuery = /[\u4e00-\u9fa5]/.test(query)
  const cityFromQuery = /([\u4e00-\u9fa5]{2,8}?市)/.exec(query)?.[1]
  const scored: { candidate: CityCandidate; variantIndex: number }[] = []
  const seen = new Set<string>()
  for (const [variantIndex, variant] of variants.entries()) {
    try {
      const res = await fetcher(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(variant)}&count=6&language=zh&format=json`, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) continue
      const data = (await res.json()) as { results?: { name?: string; latitude?: number; longitude?: number; timezone?: string; country?: string; admin1?: string; population?: number }[] }
      for (const hit of data.results ?? []) {
        if (typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number' || !hit.name) continue
        const key = `${hit.name}|${hit.latitude.toFixed(2)}|${hit.longitude.toFixed(2)}`
        if (seen.has(key)) continue
        seen.add(key)
        scored.push({
          variantIndex,
          candidate: {
            name: hit.name,
            latitude: hit.latitude,
            longitude: hit.longitude,
            timezone: hit.timezone || 'Asia/Shanghai',
            ...(hit.admin1 ? { admin1: hit.admin1 } : {}),
            ...(hit.country ? { country: hit.country } : {}),
            ...(typeof hit.population === 'number' ? { population: hit.population } : {}),
            matchedQuery: variant,
          },
        })
      }
    } catch { /* try the next, coarser variant */ }
  }
  // Rank so the *right* same-named place wins: for Chinese queries, Chinese results first
  // (a query for 上海市 otherwise surfaces Shanghai, Illinois), then places inside the
  // province/city named in the query, exact name hits, big populations, earlier variants.
  scored.sort((a, b) => {
    const countryRank = (c: CityCandidate) => (isCjkQuery && c.country !== '中国' ? 1 : 0)
    const adminRank = (c: CityCandidate) => (cityFromQuery && (c.admin1 === cityFromQuery || c.name === cityFromQuery) ? 0 : 1)
    const exactRank = (s: { candidate: CityCandidate }) => (s.candidate.name === s.candidate.matchedQuery ? 0 : 1)
    return (
      countryRank(a.candidate) - countryRank(b.candidate) ||
      adminRank(a.candidate) - adminRank(b.candidate) ||
      exactRank(a) - exactRank(b) ||
      (b.candidate.population ?? 0) - (a.candidate.population ?? 0) ||
      a.variantIndex - b.variantIndex
    )
  })
  return scored.slice(0, 10).map(s => s.candidate)
}

export async function geocodeCity(name: string, fetcher: FetchFn = fetch): Promise<AmbientHomeCity | undefined> {
  const candidates = await searchCityCandidates(name, fetcher)
  const hit = candidates[0]
  if (!hit) return undefined
  return { name: hit.name, latitude: hit.latitude, longitude: hit.longitude, timezone: hit.timezone }
}

export async function fetchWeatherForCity(city: AmbientHomeCity, fetcher: FetchFn = fetch, now = new Date()): Promise<WeatherCache> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.latitude}&longitude=${city.longitude}&current=temperature_2m,relative_humidity_2m,weather_code&hourly=precipitation_probability&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=${encodeURIComponent(city.timezone || 'Asia/Shanghai')}&forecast_days=3`
  const res = await fetcher(url, { signal: AbortSignal.timeout(12_000) })
  if (!res.ok) throw new Error(`Open-Meteo weather failed: HTTP ${res.status}`)
  const data = (await res.json()) as {
    current?: { temperature_2m?: number; relative_humidity_2m?: number; weather_code?: number }
    hourly?: { time?: string[]; precipitation_probability?: (number | null)[] }
    daily?: { weather_code?: number[]; temperature_2m_max?: number[]; temperature_2m_min?: number[] }
  }
  const temp = Number(data.current?.temperature_2m ?? 0)
  const code = Number(data.current?.weather_code ?? 3)
  const label = wmoWeatherLabel(code)
  const todayMax = Number(data.daily?.temperature_2m_max?.[0] ?? temp)
  const todayMin = Number(data.daily?.temperature_2m_min?.[0] ?? temp)
  const tomorrowMax = data.daily?.temperature_2m_max?.[1]
  const tomorrowMin = data.daily?.temperature_2m_min?.[1]
  const tomorrowCode = data.daily?.weather_code?.[1]
  // Tonight (18:00-24:00 local) max precipitation probability
  let tonightRain: number | undefined
  const times = data.hourly?.time ?? []
  const probs = data.hourly?.precipitation_probability ?? []
  const todayStr = times[0]?.slice(0, 10)
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!
    if (todayStr && t.startsWith(todayStr)) {
      const hour = Number(t.slice(11, 13))
      const p = probs[i]
      if (hour >= 18 && typeof p === 'number') tonightRain = Math.max(tonightRain ?? 0, p)
    }
  }
  const oneLinerParts = [
    `${city.name} ${Math.round(temp)}°C ${label}`,
    `今日 ${Math.round(todayMin)}~${Math.round(todayMax)}°C`,
    ...(tonightRain !== undefined && tonightRain >= 30 ? [`今晚降雨概率 ${Math.round(tonightRain)}%`] : []),
    ...(typeof tomorrowMax === 'number' && typeof tomorrowMin === 'number' ? [`明日 ${Math.round(tomorrowMin)}~${Math.round(tomorrowMax)}°C ${wmoWeatherLabel(Number(tomorrowCode ?? 3))}`] : []),
  ]
  return {
    cityName: city.name,
    fetchedAt: now.toISOString(),
    current: { temperatureC: temp, weatherCode: code, label, ...(typeof data.current?.relative_humidity_2m === 'number' ? { humidityPct: data.current.relative_humidity_2m } : {}), ...(tonightRain !== undefined ? { precipitationProbabilityPct: tonightRain } : {}) },
    today: { minC: todayMin, maxC: todayMax, label },
    ...(typeof tomorrowMax === 'number' && typeof tomorrowMin === 'number' ? { tomorrow: { minC: tomorrowMin, maxC: tomorrowMax, label: wmoWeatherLabel(Number(tomorrowCode ?? 3)) } } : {}),
    ...(tonightRain !== undefined ? { tonightRainProbabilityPct: tonightRain } : {}),
    oneLiner: oneLinerParts.join('，'),
  }
}

// ---- News (public RSS, no key) ----

export const NEWS_FEEDS: { topic: string; url: string; source: string }[] = [
  { topic: '综合', url: 'https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans', source: 'Google News' },
  { topic: '科技', url: 'https://news.google.com/rss/search?q=%E7%A7%91%E6%8A%80&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', source: 'Google News 科技' },
  { topic: 'AI', url: 'https://news.google.com/rss/search?q=%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD+AI&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', source: 'Google News AI' },
  { topic: '财经', url: 'https://news.google.com/rss/search?q=%E8%B4%A2%E7%BB%8F+%E8%82%A1%E5%B8%82&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', source: 'Google News 财经' },
]

function decodeXmlEntities(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim()
}

export function parseRssItems(xml: string, topic: string, source: string, limit = 12): NewsItem[] {
  const items: NewsItem[] = []
  const itemRe = /<item>([\s\S]*?)<\/item>/g
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null && items.length < limit) {
    const block = m[1]!
    const title = decodeXmlEntities(/<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? '')
    const link = decodeXmlEntities(/<link>([\s\S]*?)<\/link>/.exec(block)?.[1] ?? '')
    const pub = decodeXmlEntities(/<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1] ?? '')
    if (!title || !link) continue
    items.push({ title, url: link, source, topic, ...(pub ? { publishedAt: pub } : {}) })
  }
  return items
}

export async function fetchAllNews(fetcher: FetchFn = fetch, now = new Date()): Promise<NewsCache> {
  const settled = await Promise.allSettled(NEWS_FEEDS.map(async feed => {
    const res = await fetcher(feed.url, { signal: AbortSignal.timeout(12_000), headers: { 'user-agent': 'RHarness/1.0' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return parseRssItems(await res.text(), feed.topic, feed.source)
  }))
  const items = settled.flatMap(s => (s.status === 'fulfilled' ? s.value : []))
  return { fetchedAt: now.toISOString(), items }
}

export function getNewsBrief(cache: NewsCache | undefined, topic?: string, limit = 8): { fetchedAt?: string; topic: string; items: NewsItem[] } {
  const t = (topic ?? '综合').trim() || '综合'
  const all = cache?.items ?? []
  const filtered = t === '综合' ? all : all.filter(i => i.topic === t || i.topic === '综合')
  const seen = new Set<string>()
  const items: NewsItem[] = []
  for (const i of filtered) {
    if (seen.has(i.title)) continue
    seen.add(i.title)
    items.push(i)
    if (items.length >= limit) break
  }
  return { ...(cache ? { fetchedAt: cache.fetchedAt } : {}), topic: t, items }
}

// ============================================================================
// Navigation (Amap route planning + map deep links, resident-address aware)
// ============================================================================

export type NavigationMode = 'driving' | 'transit' | 'walking'

export interface NavigationPoint { label: string; longitude?: number; latitude?: number; cityName?: string }

export interface NavigationResult {
  provider: 'amap' | 'links'
  mode: NavigationMode
  origin: NavigationPoint
  destination: NavigationPoint
  distanceKm?: number
  durationMin?: number
  durationText?: string
  steps: string[]
  links: { amap?: string; baidu: string }
  note?: string
}

export function formatDurationZh(totalMinutes: number): string {
  const min = Math.max(1, Math.round(totalMinutes))
  if (min < 60) return `约 ${min} 分钟`
  const h = Math.floor(min / 60)
  const rest = min % 60
  return rest > 0 ? `约 ${h} 小时 ${rest} 分钟` : `约 ${h} 小时`
}

const NAV_MODE_LABEL: Record<NavigationMode, string> = { driving: '驾车', transit: '公交/地铁', walking: '步行' }

export function buildAmapNavigationUrl(origin: NavigationPoint, destination: NavigationPoint, mode: NavigationMode): string | undefined {
  if (origin.longitude === undefined || origin.latitude === undefined || destination.longitude === undefined || destination.latitude === undefined) return undefined
  const modeParam = mode === 'driving' ? 'car' : mode === 'transit' ? 'bus' : 'walk'
  const from = `${origin.longitude},${origin.latitude},${encodeURIComponent(origin.label)}`
  const to = `${destination.longitude},${destination.latitude},${encodeURIComponent(destination.label)}`
  return `https://uri.amap.com/navigation?from=${from}&to=${to}&mode=${modeParam}&policy=1&src=rharness&coordinate=gaode&callnative=1`
}

export function buildBaiduNavigationUrl(originText: string | undefined, destinationText: string, mode: NavigationMode, region?: string): string {
  const modeParam = mode === 'driving' ? 'driving' : mode === 'transit' ? 'transit' : 'walking'
  const params = new URLSearchParams({
    ...(originText ? { origin: originText } : {}),
    destination: destinationText,
    mode: modeParam,
    ...(region ? { region } : {}),
    output: 'html',
    src: 'rharness',
  })
  return `https://api.map.baidu.com/direction?${params.toString()}`
}

interface AmapGeocodeHit { longitude: number; latitude: number; formattedAddress: string; city?: string }

export async function geocodeWithAmap(address: string, apiKey: string, fetcher: FetchFn = fetch): Promise<AmapGeocodeHit | undefined> {
  const res = await fetcher(`https://restapi.amap.com/v3/geocode/geo?key=${encodeURIComponent(apiKey)}&address=${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) return undefined
  const data = (await res.json()) as { status?: string; geocodes?: { location?: string; formatted_address?: string; city?: string | string[] }[] }
  if (data.status !== '1') return undefined
  const hit = data.geocodes?.[0]
  const [lon, lat] = (hit?.location ?? '').split(',').map(Number)
  if (!hit || !Number.isFinite(lon) || !Number.isFinite(lat)) return undefined
  return { longitude: lon!, latitude: lat!, formattedAddress: hit.formatted_address ?? address, ...(typeof hit.city === 'string' && hit.city ? { city: hit.city } : {}) }
}

/** Amap direction planning (driving is traffic-aware). Throws Error(info) on API-level failures. */
export async function planRouteWithAmap(input: {
  origin: { longitude: number; latitude: number }
  destination: { longitude: number; latitude: number }
  mode: NavigationMode
  originCity?: string
  apiKey: string
  fetcher?: FetchFn
}): Promise<{ distanceKm: number; durationMin: number; steps: string[] }> {
  const fetcher = input.fetcher ?? fetch
  const origin = `${input.origin.longitude},${input.origin.latitude}`
  const destination = `${input.destination.longitude},${input.destination.latitude}`
  const key = encodeURIComponent(input.apiKey)
  if (input.mode === 'transit') {
    const city = encodeURIComponent((input.originCity ?? '').replace(/市$/, '') || '上海')
    const res = await fetcher(`https://restapi.amap.com/v3/direction/transit/integrated?key=${key}&origin=${origin}&destination=${destination}&city=${city}&extensions=base`, { signal: AbortSignal.timeout(12_000) })
    const data = (await res.json()) as { status?: string; info?: string; route?: { transits?: { distance?: string; duration?: string; segments?: { bus?: { buslines?: { name?: string; departure_stop?: { name?: string }; arrival_stop?: { name?: string } }[] }; walking?: { distance?: string } }[] }[] } }
    if (data.status !== '1') throw new Error(`Amap transit failed: ${data.info ?? 'unknown'}`)
    const best = data.route?.transits?.[0]
    if (!best) throw new Error('Amap transit returned no route')
    const steps: string[] = []
    for (const seg of best.segments ?? []) {
      const walkM = Number(seg.walking?.distance ?? 0)
      if (walkM > 30) steps.push(`步行约 ${Math.round(walkM)} 米`)
      const line = seg.bus?.buslines?.[0]
      if (line?.name) steps.push(`乘坐 ${line.name}：${line.departure_stop?.name ?? ''} → ${line.arrival_stop?.name ?? ''}`)
    }
    return { distanceKm: Number(best.distance ?? 0) / 1000, durationMin: Number(best.duration ?? 0) / 60, steps: steps.slice(0, 10) }
  }
  const kind = input.mode === 'walking' ? 'walking' : 'driving'
  const res = await fetcher(`https://restapi.amap.com/v3/direction/${kind}?key=${key}&origin=${origin}&destination=${destination}&extensions=base`, { signal: AbortSignal.timeout(12_000) })
  const data = (await res.json()) as { status?: string; info?: string; route?: { paths?: { distance?: string; duration?: string; steps?: { instruction?: string }[] }[] } }
  if (data.status !== '1') throw new Error(`Amap ${kind} failed: ${data.info ?? 'unknown'}`)
  const best = data.route?.paths?.[0]
  if (!best) throw new Error(`Amap ${kind} returned no route`)
  return {
    distanceKm: Number(best.distance ?? 0) / 1000,
    durationMin: Number(best.duration ?? 0) / 60,
    steps: (best.steps ?? []).map(s => s.instruction ?? '').filter(Boolean).slice(0, 8),
  }
}

/**
 * End-to-end navigation orchestration shared by the Assistant tool and the Web UI:
 * resolves endpoints from resident addresses (label match → detailed address geocode →
 * city-level coordinates), plans with Amap when a key is configured, and always returns
 * map deep links so the user can jump into a maps app either way.
 */
export async function planNavigation(input: {
  fromText?: string
  toText: string
  mode?: NavigationMode
  addresses: readonly ResidentAddress[]
  amapKey?: string
  fetcher?: FetchFn
}): Promise<NavigationResult> {
  const fetcher = input.fetcher ?? fetch
  const mode: NavigationMode = input.mode ?? 'driving'
  const resolveEndpoint = async (text: string | undefined, role: 'origin' | 'destination'): Promise<{ point: NavigationPoint; addressText: string }> => {
    const t = (text ?? '').trim()
    const primary = input.addresses.find(a => a.isPrimary) ?? input.addresses[0]
    if (!t && role === 'origin' && primary) {
      const base: NavigationPoint = { label: primary.label, longitude: primary.city.longitude, latitude: primary.city.latitude, cityName: primary.city.name }
      if (input.amapKey) {
        const geo = await geocodeWithAmap(primary.address, input.amapKey, fetcher).catch(() => undefined)
        if (geo) return { point: { ...base, longitude: geo.longitude, latitude: geo.latitude }, addressText: primary.address }
      }
      return { point: base, addressText: primary.address }
    }
    const matched = t
      ? input.addresses.find(a => a.label === t || a.label.includes(t) || a.address.includes(t))
      : undefined
    if (matched) {
      const base: NavigationPoint = { label: matched.label, longitude: matched.city.longitude, latitude: matched.city.latitude, cityName: matched.city.name }
      if (input.amapKey) {
        const geo = await geocodeWithAmap(matched.address, input.amapKey, fetcher).catch(() => undefined)
        if (geo) return { point: { ...base, longitude: geo.longitude, latitude: geo.latitude }, addressText: matched.address }
      }
      return { point: base, addressText: matched.address }
    }
    const label = t || (role === 'origin' ? '起点' : '目的地')
    if (input.amapKey && t) {
      const geo = await geocodeWithAmap(t, input.amapKey, fetcher).catch(() => undefined)
      if (geo) return { point: { label, longitude: geo.longitude, latitude: geo.latitude, ...(geo.city ? { cityName: geo.city } : {}) }, addressText: t }
    }
    if (t) {
      const candidate = (await searchCityCandidates(t, fetcher).catch(() => []))[0]
      if (candidate) return { point: { label, longitude: candidate.longitude, latitude: candidate.latitude, cityName: candidate.name }, addressText: t }
    }
    return { point: { label }, addressText: t }
  }
  const origin = await resolveEndpoint(input.fromText, 'origin')
  const destination = await resolveEndpoint(input.toText, 'destination')
  const links = {
    ...(buildAmapNavigationUrl(origin.point, destination.point, mode) ? { amap: buildAmapNavigationUrl(origin.point, destination.point, mode)! } : {}),
    baidu: buildBaiduNavigationUrl(origin.addressText || undefined, destination.addressText, mode, destination.point.cityName ?? origin.point.cityName),
  }
  const base: NavigationResult = { provider: 'links', mode, origin: origin.point, destination: destination.point, steps: [], links }
  if (!input.amapKey) {
    return { ...base, note: '尚未配置高德地图 Key，暂时只能提供导航链接（点开直接跳地图 App）。配置后助理可直接报距离、时长与实时路况。' }
  }
  if (origin.point.longitude === undefined || destination.point.longitude === undefined) {
    return { ...base, note: '有一端地址没能定位到坐标，先给导航链接；把地址写得更完整（带城市名）会更准。' }
  }
  const originLon = origin.point.longitude
  const originLat = origin.point.latitude
  const destLon = destination.point.longitude
  const destLat = destination.point.latitude
  if (originLon === undefined || originLat === undefined || destLon === undefined || destLat === undefined) {
    return { ...base, note: '有一端地址没能定位到坐标，先给导航链接；把地址写得更完整（带城市名）会更准。' }
  }
  try {
    const route = await planRouteWithAmap({
      origin: { longitude: originLon, latitude: originLat },
      destination: { longitude: destLon, latitude: destLat },
      mode,
      ...(origin.point.cityName ? { originCity: origin.point.cityName } : {}),
      apiKey: input.amapKey,
      fetcher,
    })
    return {
      ...base,
      provider: 'amap',
      distanceKm: Math.round(route.distanceKm * 10) / 10,
      durationMin: Math.round(route.durationMin),
      durationText: formatDurationZh(route.durationMin),
      steps: route.steps,
      note: `${NAV_MODE_LABEL[mode]}路线（高德${mode === 'driving' ? '，含实时路况' : ''}）：${origin.point.label} → ${destination.point.label}`,
    }
  } catch (err) {
    return { ...base, note: `高德路线规划暂时失败（${err instanceof Error ? err.message : String(err)}），先用导航链接打开地图查看。` }
  }
}

// ============================================================================
// Assistant-only tools
// ============================================================================

export interface PersonaAmbientToolDeps {
  isEnabled: () => boolean
  getPersonaConfig: () => AssistantPersonaConfig
  setPersonaConfig: (next: AssistantPersonaConfig) => void
  getLearnings: () => PersonaLearningEntry[]
  setLearnings: (next: PersonaLearningEntry[]) => void
  getStickers: () => StickerRecord[]
  setStickers: (next: StickerRecord[]) => void
  getAmbientConfig: () => AssistantAmbientConfig
  setAmbientConfig: (next: AssistantAmbientConfig) => void
  getWeatherCache: () => WeatherCache | undefined
  setWeatherCache: (next: WeatherCache) => void
  getNewsCache: () => NewsCache | undefined
  setNewsCache: (next: NewsCache) => void
  /** Reads stored assistant messages (for sticker_add_from_message). Content parts use StoredPanelContent shape. */
  getAssistantMessages: () => readonly { id: string; bot?: boolean; at: string; content?: readonly unknown[] }[]
  readStoredImageBytes: (imagePart: unknown) => Promise<Buffer | undefined>
  /** Amap (高德) Web-Service key for navigation; when unset, navigation degrades to map deep links. */
  getAmapApiKey?: () => string | undefined
}

export function buildAssistantPersonaAmbientTools(deps: PersonaAmbientToolDeps): RegisteredToolSpec[] {
  const guard = () => { if (!deps.isEnabled()) throw new Error('Assistant Persona & Ambient plugin is disabled') }
  const personaGetSchema = z.object({})
  const personaUpdateSchema = z.object({
    presetId: z.enum(['warm-witty', 'lively-playful', 'calm-gentle', 'concise-neutral']).optional(),
    assistantName: z.string().optional(),
    userAddress: z.string().optional(),
    verbosity: z.enum(['brief', 'balanced', 'detailed']).optional(),
    kaomojiDensity: z.enum(['off', 'light', 'rich']).optional(),
    humorLevel: z.enum(['off', 'light', 'lively']).optional(),
    stickerFrequency: z.enum(['off', 'occasional', 'lively']).optional(),
    stickerCooldownTurns: z.number().int().min(0).max(10).optional(),
    learningEnabled: z.boolean().optional(),
    customInstructions: z.string().optional(),
  })
  const stickerListSchema = z.object({ query: z.string().optional() })
  const stickerDeleteSchema = z.object({ id_or_name: z.string().min(1) })
  const stickerUpdateSchema = z.object({ id_or_name: z.string().min(1), name: z.string().optional(), tags: z.array(z.string()).optional(), emotion: z.string().optional() })
  const stickerAddFromMessageSchema = z.object({
    name: z.string().min(1).describe('Sticker display name, e.g. "摸鱼"'),
    tags: z.array(z.string()).optional(),
    emotion: z.string().optional(),
    message_id: z.string().optional().describe('Assistant message ID containing the image. Defaults to the latest user message with an image.'),
    image_index: z.number().int().min(0).optional(),
  })
  const learningListSchema = z.object({})
  const learningAddSchema = z.object({ content: z.string().min(2), kind: z.enum(['style', 'address', 'preference', 'rapport', 'boundary']).optional() })
  const learningDeleteSchema = z.object({ id_or_text: z.string().min(1) })
  const ambientGetSchema = z.object({})
  const ambientSetCitySchema = z.object({ city: z.string().min(1).describe('New home/resident city name, e.g. "上海"') })
  const ambientSaveAddressSchema = z.object({
    label: z.string().optional().describe('Short label, e.g. 家 / 公司 / 老家'),
    address: z.string().min(1).describe('Detailed address exactly as the user states it'),
    city: z.string().optional().describe('City the address belongs to; geocoded from the address when omitted'),
    make_primary: z.boolean().optional().describe('Make this the primary address (weather baseline city)'),
  })
  const ambientDeleteAddressSchema = z.object({ id_or_label: z.string().min(1) })
  const navigationRouteSchema = z.object({
    from: z.string().optional().describe('Origin: a saved address label （家/公司）, a detailed address, or a place name. Defaults to the primary resident address.'),
    to: z.string().min(1).describe('Destination: address label, detailed address, or place name'),
    mode: z.enum(['driving', 'transit', 'walking']).optional().describe('Travel mode, default driving'),
  })
  const weatherQuerySchema = z.object({ city: z.string().optional().describe('City name. Defaults to the configured home city.') })
  const newsBriefSchema = z.object({ topic: z.string().optional().describe('综合 / 科技 / AI / 财经. Defaults to 综合.') })

  return [
    {
      name: 'persona_get',
      description: 'Get the current Personal Assistant persona config (preset, address, verbosity, kaomoji/humor/sticker knobs, custom instructions).',
      parameters: z.toJSONSchema(personaGetSchema),
      execute: async () => { guard(); return { ok: true, config: deps.getPersonaConfig(), presets: PERSONA_PRESETS } },
    },
    {
      name: 'persona_update',
      description: 'Update Personal Assistant persona knobs when the user asks (e.g. "以后简短点", "颜文字多一点", "换个活泼人设"). Takes effect next turn and mirrors in the Web UI workbench.',
      parameters: z.toJSONSchema(personaUpdateSchema),
      execute: async (raw: unknown) => {
        guard()
        const args = personaUpdateSchema.parse(raw ?? {})
        const next = normalizeAssistantPersonaConfig({ ...deps.getPersonaConfig(), ...args })
        deps.setPersonaConfig(next)
        return { ok: true, config: next }
      },
    },
    {
      name: 'sticker_list',
      description: 'List stickers in the user-uploaded sticker gallery (~/.rharness/stickers), optionally filtered by name/tag/emotion query. Use before sticker_delete/update to resolve the exact sticker.',
      parameters: z.toJSONSchema(stickerListSchema),
      execute: async (raw: unknown) => {
        guard()
        const args = stickerListSchema.parse(raw ?? {})
        const all = deps.getStickers()
        const items = args.query ? findSticker(all, args.query) : activeStickers(all)
        return { ok: true, count: items.length, stickers: items.map(s => ({ id: s.id, name: s.name, tags: s.tags, emotion: s.emotion, sizeBytes: s.sizeBytes, useCount: s.useCount, createdAt: s.createdAt })) }
      },
    },
    {
      name: 'sticker_add_from_message',
      description: 'Save an image the user just sent in this Assistant conversation as a reusable sticker. Use when the user says e.g. "把我刚发的图存为表情包，名字叫摸鱼，标签：开心".',
      parameters: z.toJSONSchema(stickerAddFromMessageSchema),
      execute: async (raw: unknown) => {
        guard()
        const args = stickerAddFromMessageSchema.parse(raw ?? {})
        const msgs = deps.getAssistantMessages()
        const candidates = args.message_id ? msgs.filter(m => m.id === args.message_id) : [...msgs].reverse().filter(m => !m.bot)
        let saved: { entry: StickerRecord; list: StickerRecord[] } | undefined
        for (const msg of candidates) {
          const images = (msg.content ?? []).filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object' && (p as Record<string, unknown>).type === 'image')
          const part = images[args.image_index ?? 0]
          if (!part) continue
          const bytes = await deps.readStoredImageBytes(part)
          if (!bytes) continue
          saved = saveStickerFromBuffer(deps.getStickers(), { data: bytes, name: args.name, ...(args.tags ? { tags: args.tags } : {}), ...(args.emotion ? { emotion: args.emotion } : {}), source: 'chat' })
          break
        }
        if (!saved) return { ok: false, error: 'No usable image found in the referenced/recent user message. Ask the user to send the image again, or upload it in the Web UI sticker gallery.' }
        deps.setStickers(saved.list)
        return { ok: true, sticker: { id: saved.entry.id, name: saved.entry.name, tags: saved.entry.tags, emotion: saved.entry.emotion } }
      },
    },
    {
      name: 'sticker_delete',
      description: 'Move a sticker into the 1-day trash by exact ID or unambiguous name/tag (from sticker_list). It stays restorable for 24 hours (UI trash section or sticker_restore), then is permanently purged. Use when the user says "删掉那个叫XX的表情包".',
      parameters: z.toJSONSchema(stickerDeleteSchema),
      execute: async (raw: unknown) => {
        guard()
        const args = stickerDeleteSchema.parse(raw ?? {})
        const all = deps.getStickers()
        const matches = findSticker(all, args.id_or_name)
        if (matches.length === 0) return { ok: false, error: `Sticker not found: ${args.id_or_name}` }
        if (matches.length > 1) return { ok: false, error: 'Multiple stickers match; ask the user to pick one', candidates: matches.map(s => ({ id: s.id, name: s.name, tags: s.tags })) }
        const target = matches[0]!
        const trashed = trashStickerRecord(all, target.id)
        deps.setStickers(trashed.list)
        return { ok: true, trashed: { id: target.id, name: target.name }, restorableUntil: stickerTrashPurgeAt(trashed.entry ?? target), note: 'Sticker moved to the 1-day trash; call sticker_restore within 24h to undo, after which it is permanently deleted.' }
      },
    },
    {
      name: 'sticker_restore',
      description: 'Restore a sticker from the 1-day trash (undo a recent sticker_delete) by ID or unambiguous name/tag. Only works within 24 hours of deletion.',
      parameters: z.toJSONSchema(stickerDeleteSchema),
      execute: async (raw: unknown) => {
        guard()
        const args = stickerDeleteSchema.parse(raw ?? {})
        const all = deps.getStickers()
        const q = args.id_or_name.trim().toLowerCase()
        const matches = trashedStickers(all).filter(s => s.id === q || s.name.toLowerCase() === q || s.name.toLowerCase().includes(q) || s.tags.some(t => t.toLowerCase().includes(q)))
        if (matches.length === 0) return { ok: false, error: `No trashed sticker matches: ${args.id_or_name} (trash only keeps stickers for 1 day)` }
        if (matches.length > 1) return { ok: false, error: 'Multiple trashed stickers match; ask the user to pick one', candidates: matches.map(s => ({ id: s.id, name: s.name })) }
        const restored = restoreStickerRecord(all, matches[0]!.id)
        deps.setStickers(restored.list)
        return { ok: true, restored: { id: matches[0]!.id, name: matches[0]!.name } }
      },
    },
    {
      name: 'sticker_update',
      description: 'Rename a sticker or update its tags/emotion by ID or unambiguous name.',
      parameters: z.toJSONSchema(stickerUpdateSchema),
      execute: async (raw: unknown) => {
        guard()
        const args = stickerUpdateSchema.parse(raw ?? {})
        const all = deps.getStickers()
        const matches = findSticker(all, args.id_or_name)
        if (matches.length !== 1) return { ok: false, error: matches.length === 0 ? 'Sticker not found' : 'Multiple stickers match', candidates: matches.map(s => ({ id: s.id, name: s.name })) }
        const target = matches[0]!
        const updated: StickerRecord = {
          ...target,
          ...(args.name ? { name: args.name.trim().slice(0, 40) } : {}),
          ...(args.tags ? { tags: [...new Set(args.tags.map(t => t.trim()).filter(Boolean))].slice(0, 8) } : {}),
          ...(args.emotion !== undefined ? { emotion: args.emotion.trim().slice(0, 20) || undefined } : {}),
          updatedAt: new Date().toISOString(),
        }
        deps.setStickers(all.map(s => (s.id === target.id ? updated : s)))
        return { ok: true, sticker: { id: updated.id, name: updated.name, tags: updated.tags, emotion: updated.emotion } }
      },
    },
    {
      name: 'persona_learning_list',
      description: 'List auto-applied persona learnings (style/address/preferences the assistant has learned). Use when the user asks "你都学了些什么" or before deleting one.',
      parameters: z.toJSONSchema(learningListSchema),
      execute: async () => { guard(); return { ok: true, learnings: deps.getLearnings() } },
    },
    {
      name: 'persona_learning_add',
      description: 'Explicitly teach the assistant a style/address/preference learning that auto-applies (e.g. "记住：闲聊时简短一点"). Mirrors in the Web UI learned-knowledge manager.',
      parameters: z.toJSONSchema(learningAddSchema),
      execute: async (raw: unknown) => {
        guard()
        const args = learningAddSchema.parse(raw ?? {})
        const saved = savePersonaLearning(deps.getLearnings(), { content: args.content, ...(args.kind ? { kind: args.kind } : {}), source: 'agent' })
        deps.setLearnings(saved.list)
        return { ok: true, entry: saved.entry }
      },
    },
    {
      name: 'persona_learning_delete',
      description: 'Forget/delete a persona learning by ID or matching text (from persona_learning_list). Use when the user says "忘掉你学的XX那条".',
      parameters: z.toJSONSchema(learningDeleteSchema),
      execute: async (raw: unknown) => {
        guard()
        const args = learningDeleteSchema.parse(raw ?? {})
        const all = deps.getLearnings()
        const q = args.id_or_text.trim().toLowerCase()
        const matches = all.filter(e => e.id === q || e.content.toLowerCase().includes(q))
        if (matches.length === 0) return { ok: false, error: 'Learning not found' }
        if (matches.length > 1) return { ok: false, error: 'Multiple learnings match', candidates: matches.map(e => ({ id: e.id, content: e.content })) }
        deps.setLearnings(all.filter(e => e.id !== matches[0]!.id))
        return { ok: true, deleted: matches[0] }
      },
    },
    {
      name: 'ambient_get',
      description: 'Get current ambient context: Beijing time, lunar date, solar term, workday rhythm, home city and cached weather.',
      parameters: z.toJSONSchema(ambientGetSchema),
      execute: async () => { guard(); return { ok: true, config: deps.getAmbientConfig(), snapshot: buildAmbientSnapshot(deps.getAmbientConfig(), deps.getWeatherCache()) } },
    },
    {
      name: 'ambient_set_home_city',
      description: 'Change the resident/home city used for weather and ambient context (geocoded via Open-Meteo, detailed addresses degrade to their city automatically, weather refreshed immediately). If resident addresses exist, this updates the primary address\'s city. Use when the user says "把常驻城市改成上海". Mirrors in Web UI.',
      parameters: z.toJSONSchema(ambientSetCitySchema),
      execute: async (raw: unknown) => {
        guard()
        const args = ambientSetCitySchema.parse(raw ?? {})
        const city = await geocodeCity(args.city)
        if (!city) return { ok: false, error: `No city matched "${args.city}" even after degrading the query to district/city level; ask the user for a shorter city or district name.` }
        const current = deps.getAmbientConfig()
        const next = normalizeAssistantAmbientConfig({
          ...current,
          homeCity: city,
          residentAddresses: current.residentAddresses.map(a => (a.isPrimary ? { ...a, city } : a)),
        })
        deps.setAmbientConfig(next)
        try {
          const weather = await fetchWeatherForCity(city)
          deps.setWeatherCache(weather)
          return { ok: true, config: next, weather }
        } catch (err) {
          return { ok: true, config: next, weatherError: err instanceof Error ? err.message : String(err) }
        }
      },
    },
    {
      name: 'ambient_save_address',
      description: 'Save one of the user\'s resident addresses (multiple allowed: 家/公司/老家…). `address` is the detailed free-form address; `city` is optional — when omitted it is geocoded from the address itself (degraded to district/city level). The first address (or make_primary=true) becomes the primary whose city drives weather. Use when the user says "记住我家地址是…/我公司在…".',
      parameters: z.toJSONSchema(ambientSaveAddressSchema),
      execute: async (raw: unknown) => {
        guard()
        const args = ambientSaveAddressSchema.parse(raw ?? {})
        const city = await geocodeCity(args.city?.trim() || args.address)
        if (!city) return { ok: false, error: `No city matched for address "${args.address}"; ask the user which city it is in.` }
        const saved = upsertResidentAddress(deps.getAmbientConfig(), {
          address: args.address,
          ...(args.label ? { label: args.label } : {}),
          city,
          ...(args.make_primary ? { makePrimary: true } : {}),
        })
        deps.setAmbientConfig(saved.config)
        if (saved.entry.isPrimary) {
          try { deps.setWeatherCache(await fetchWeatherForCity(saved.entry.city)) } catch { /* weather refresh is best-effort */ }
        }
        return { ok: true, address: saved.entry, addresses: saved.config.residentAddresses, homeCity: saved.config.homeCity }
      },
    },
    {
      name: 'ambient_delete_address',
      description: 'Delete a saved resident address by ID or unambiguous label/address fragment (see ambient_get). Deleting the primary promotes the next address and re-bases the weather city.',
      parameters: z.toJSONSchema(ambientDeleteAddressSchema),
      execute: async (raw: unknown) => {
        guard()
        const args = ambientDeleteAddressSchema.parse(raw ?? {})
        const cfg = deps.getAmbientConfig()
        const q = args.id_or_label.trim().toLowerCase()
        const matches = cfg.residentAddresses.filter(a => a.id === q || a.label.toLowerCase() === q || a.address.toLowerCase().includes(q))
        if (matches.length === 0) return { ok: false, error: `No resident address matches: ${args.id_or_label}` }
        if (matches.length > 1) return { ok: false, error: 'Multiple addresses match; ask the user to pick one', candidates: matches.map(a => ({ id: a.id, label: a.label, address: a.address })) }
        const next = removeResidentAddress(cfg, matches[0]!.id)
        deps.setAmbientConfig(next)
        return { ok: true, deleted: { id: matches[0]!.id, label: matches[0]!.label }, addresses: next.residentAddresses, homeCity: next.homeCity }
      },
    },
    {
      name: 'navigation_route',
      description: 'Plan a route and (when an Amap key is configured) report distance, duration (traffic-aware for driving) and step summary; always returns Amap/Baidu navigation deep links the user can tap to start navigating. Origin defaults to the primary resident address; origin/destination may be saved address labels （家/公司）, detailed addresses, or place names. Use for "我回家要多久", "去X怎么走", "导航去X".',
      parameters: z.toJSONSchema(navigationRouteSchema),
      execute: async (raw: unknown) => {
        guard()
        const args = navigationRouteSchema.parse(raw ?? {})
        const cfg = deps.getAmbientConfig()
        const result = await planNavigation({
          ...(args.from ? { fromText: args.from } : {}),
          toText: args.to,
          ...(args.mode ? { mode: args.mode } : {}),
          addresses: cfg.residentAddresses,
          ...(deps.getAmapApiKey?.() ? { amapKey: deps.getAmapApiKey() } : {}),
        })
        return { ok: true, ...result }
      },
    },
    {
      name: 'weather_query',
      description: 'Query weather for the home city (default, uses 45-min cache) or any other city (geocoded live). Use for forecasts, trips, or clothing advice.',
      parameters: z.toJSONSchema(weatherQuerySchema),
      execute: async (raw: unknown) => {
        guard()
        const args = weatherQuerySchema.parse(raw ?? {})
        const cfg = deps.getAmbientConfig()
        if (!args.city || args.city.trim() === cfg.homeCity.name) {
          const cached = deps.getWeatherCache()
          if (isWeatherCacheFresh(cached, cfg.homeCity.name)) return { ok: true, cached: true, weather: cached }
          const weather = await fetchWeatherForCity(cfg.homeCity)
          deps.setWeatherCache(weather)
          return { ok: true, cached: false, weather }
        }
        const city = await geocodeCity(args.city)
        if (!city) return { ok: false, error: `No city matched "${args.city}" even after degrading the query to district/city level; ask the user for a shorter city or district name.` }
        const weather = await fetchWeatherForCity(city)
        return { ok: true, cached: false, city, weather }
      },
    },
    {
      name: 'news_brief',
      description: 'Get recent news headlines (综合/科技/AI/财经) from the background RSS cache (refreshed if stale). Use when the user asks about recent news/hot topics; then use web_readability to deep-read a chosen story.',
      parameters: z.toJSONSchema(newsBriefSchema),
      execute: async (raw: unknown) => {
        guard()
        const args = newsBriefSchema.parse(raw ?? {})
        let cache = deps.getNewsCache()
        if (!isNewsCacheFresh(cache)) {
          try {
            cache = await fetchAllNews()
            deps.setNewsCache(cache)
          } catch { /* serve stale cache below */ }
        }
        return { ok: true, ...getNewsBrief(cache, args.topic) }
      },
    },
  ]
}
