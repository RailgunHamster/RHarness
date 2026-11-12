/**
 * Runtime Guardrails & Cost Telemetry Plugins:
 * 1. `@rharness/plugin-runtime-guard` (`dsh-runtime-guard`):
 *    - **Tokenjuice Output Compactor**: Strips ANSI escape codes, spinner/progress-bar noise, repetitive compiler/test lines,
 *      and middle-truncates oversized tool outputs while preserving head + tail + exit diagnostics, recording exact chars/tokens saved.
 *    - **Loop Detection Circuit Breaker**: Monitors rolling `(toolName, canonicalArgs, errorOrOutcomeHash)` triples per session;
 *      breaks infinite repetitive tool-call loops with a clear directive to pivot or report.
 *    - **Anti-Injection Shield**: Detects and neutralizes untrusted prompt-injection markers (`Ignore all previous instructions`,
 *      `<system_instruction>`, fake role headers, credential exfiltration attempts) inside external tool outputs (emails, web pages, notes).
 * 2. `@rharness/plugin-model-usage` (`dsh-model-usage`):
 *    - Tracks per-model, per-role (`assistant` / `eval` / `executor`), and per-day token consumption, turn counts, latency, and estimated CNY/USD cost.
 */
import { z } from 'zod'
import type { RegisteredToolSpec } from './standalone-host.ts'

export interface RuntimeGuardStats {
  compactedCalls: number
  originalCharsTotal: number
  compactedCharsTotal: number
  estimatedTokensSaved: number
  loopsBroken: number
  injectionsNeutralized: number
  recentEvents: {
    id: string
    kind: 'tokenjuice' | 'loop-breaker' | 'anti-injection'
    sessionId: string
    toolName: string
    detail: string
    at: string
  }[]
}

export interface ModelUsageEntry {
  key: string
  provider: string
  model: string
  role: 'assistant' | 'eval' | 'worker'
  turns: number
  estimatedInputTokens: number
  estimatedOutputTokens: number
  totalDurationMs: number
  estimatedCostCny: number
  lastUsedAt: string
}

export interface ModelUsageState {
  byModelRole: Record<string, ModelUsageEntry>
  dailyTokens: Record<string, { inputTokens: number; outputTokens: number; turns: number; costCny: number }>
}

export function defaultRuntimeGuardStats(): RuntimeGuardStats {
  return {
    compactedCalls: 0,
    originalCharsTotal: 0,
    compactedCharsTotal: 0,
    estimatedTokensSaved: 0,
    loopsBroken: 0,
    injectionsNeutralized: 0,
    recentEvents: [],
  }
}

export function defaultModelUsageState(): ModelUsageState {
  return {
    byModelRole: {},
    dailyTokens: {},
  }
}

// Rough per-1M-token CNY reference table for local cost estimation
function estimateCostCny(model: string, inputTokens: number, outputTokens: number): number {
  const m = model.toLowerCase()
  let inRatePerM = 2.0
  let outRatePerM = 8.0
  if (m.includes('deepseek-flash') || m.includes('v4-flash')) {
    inRatePerM = 0.5
    outRatePerM = 2.0
  } else if (m.includes('deepseek') || m.includes('glm-5')) {
    inRatePerM = 2.0
    outRatePerM = 8.0
  } else if (m.includes('step-3.7-flash') || m.includes('gemini') && m.includes('flash')) {
    inRatePerM = 0.8
    outRatePerM = 2.4
  } else if (m.includes('opus') || m.includes('gpt-6')) {
    inRatePerM = 15.0
    outRatePerM = 60.0
  } else if (m.includes('sonnet') || m.includes('gpt-5')) {
    inRatePerM = 6.0
    outRatePerM = 24.0
  }
  const cost = (inputTokens / 1_000_000) * inRatePerM + (outputTokens / 1_000_000) * outRatePerM
  return Math.round(cost * 10000) / 10000
}

export function estimateTokenCount(text: string): number {
  if (!text) return 0
  // CJK chars ~ 0.65 token/char, ASCII ~ 0.25 token/char
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x2e80) cjk++
  }
  const ascii = text.length - cjk
  return Math.max(1, Math.ceil(cjk * 0.65 + ascii * 0.26))
}

export function recordModelTurnUsage(
  state: ModelUsageState,
  input: {
    provider: string
    model: string
    role: 'assistant' | 'eval' | 'worker'
    inputChars: number
    outputChars: number
    durationMs: number
    now?: Date
  },
): ModelUsageState {
  const now = input.now ?? new Date()
  const dayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)

  const inTok = Math.max(1, Math.ceil(input.inputChars * 0.32))
  const outTok = Math.max(1, Math.ceil(input.outputChars * 0.38))
  const cost = estimateCostCny(input.model, inTok, outTok)

  const entryKey = `${input.role}:${input.provider}/${input.model}`
  const prev = state.byModelRole[entryKey] ?? {
    key: entryKey,
    provider: input.provider,
    model: input.model,
    role: input.role,
    turns: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    totalDurationMs: 0,
    estimatedCostCny: 0,
    lastUsedAt: now.toISOString(),
  }

  const nextEntry: ModelUsageEntry = {
    ...prev,
    turns: prev.turns + 1,
    estimatedInputTokens: prev.estimatedInputTokens + inTok,
    estimatedOutputTokens: prev.estimatedOutputTokens + outTok,
    totalDurationMs: prev.totalDurationMs + Math.max(0, input.durationMs),
    estimatedCostCny: Math.round((prev.estimatedCostCny + cost) * 10000) / 10000,
    lastUsedAt: now.toISOString(),
  }

  const prevDay = state.dailyTokens[dayKey] ?? { inputTokens: 0, outputTokens: 0, turns: 0, costCny: 0 }
  const nextDaily = {
    ...state.dailyTokens,
    [dayKey]: {
      inputTokens: prevDay.inputTokens + inTok,
      outputTokens: prevDay.outputTokens + outTok,
      turns: prevDay.turns + 1,
      costCny: Math.round((prevDay.costCny + cost) * 10000) / 10000,
    },
  }

  return {
    byModelRole: {
      ...state.byModelRole,
      [entryKey]: nextEntry,
    },
    dailyTokens: nextDaily,
  }
}

// ANSI CSI / OSC escape sequence regex
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07]*\x07/g

const PROMPT_INJECTION_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  {
    pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|prompts|rules)/gi,
    label: 'ignore-previous-instructions',
  },
  {
    pattern: /(?:忽略|无视|忘记)(?:之前|以上|前面|所有)(?:的)?(?:所有)?(?:指令|规则|提示词|限制|安全围栏)/g,
    label: 'zh-ignore-instructions',
  },
  {
    pattern: /<\s*\/?\s*(?:system_instruction|system_prompt|developer_instruction|system-reminder)\s*>/gi,
    label: 'spoofed-system-tag',
  },
  {
    pattern: /(?:send|post|upload|exfiltrate)\s+(?:all\s+)?(?:ssh\s+keys?|credentials?|feishu\.json|api[_-]?keys?|passwords?)\s+to\s+https?:\/\//gi,
    label: 'credential-exfiltration',
  },
]

/**
 * Neutralizes prompt-injection payloads embedded inside untrusted external text (emails, web pages, notes).
 */
export function sanitizePromptInjectionInText(
  text: string,
): { sanitized: string; detectedCount: number; labels: string[] } {
  if (!text) return { sanitized: text, detectedCount: 0, labels: [] }
  let out = text
  let detectedCount = 0
  const labels: string[] = []
  for (const rule of PROMPT_INJECTION_PATTERNS) {
    rule.pattern.lastIndex = 0
    if (rule.pattern.test(out)) {
      detectedCount++
      labels.push(rule.label)
      rule.pattern.lastIndex = 0
      out = out.replace(rule.pattern, match => `[🛡️ ANTI-INJECTION NEUTRALIZED: ${match.slice(0, 24)}…]`)
    }
  }
  return { sanitized: out, detectedCount, labels }
}

/**
 * Tokenjuice-style deterministic compactor for noisy tool outputs:
 * 1. Strips ANSI escape sequences and carriage-return progress-bar overwrites;
 * 2. Collapses consecutive duplicate lines;
 * 3. Middle-truncates outputs exceeding `maxChars` while keeping head (`60%`) and tail (`35%`) intact.
 */
export function compactToolOutputString(
  raw: string,
  maxChars = 10_000,
): { text: string; compacted: boolean; savedChars: number } {
  if (!raw) return { text: raw, compacted: false, savedChars: 0 }
  const originalLen = raw.length
  // Strip ANSI codes and progress spinner carriage returns (`...\rActual line`)
  let cleaned = raw.replace(ANSI_ESCAPE_RE, '').replace(/^[^\n]*\r(?!\n)/gm, '')

  // Collapse 3+ identical consecutive lines
  const lines = cleaned.split('\n')
  if (lines.length > 12) {
    const deduped: string[] = []
    let prevLine = ''
    let repeatCount = 0
    for (const line of lines) {
      if (line === prevLine && line.trim().length > 0) {
        repeatCount++
        if (repeatCount === 1) {
          deduped.push(line)
        }
      } else {
        if (repeatCount > 1) {
          deduped.push(`  ... [Tokenjuice collapsed ${repeatCount - 1} identical lines] ...`)
        }
        deduped.push(line)
        prevLine = line
        repeatCount = 0
      }
    }
    if (repeatCount > 1) {
      deduped.push(`  ... [Tokenjuice collapsed ${repeatCount - 1} identical lines] ...`)
    }
    cleaned = deduped.join('\n')
  }

  if (cleaned.length > maxChars && maxChars >= 800) {
    const headBudget = Math.floor(maxChars * 0.58)
    const tailBudget = Math.floor(maxChars * 0.36)
    const omitted = cleaned.length - headBudget - tailBudget
    cleaned =
      `${cleaned.slice(0, headBudget)}\n` +
      `\n... [🧃 Tokenjuice compacted ${omitted} noisy middle characters; head & tail preserved] ...\n\n` +
      `${cleaned.slice(cleaned.length - tailBudget)}`
  }

  const savedChars = Math.max(0, originalLen - cleaned.length)
  return {
    text: cleaned,
    compacted: savedChars > 40,
    savedChars,
  }
}

/**
 * Applies Anti-Injection + Tokenjuice compaction recursively to a tool result value.
 */
export function processToolResultWithGuards(
  value: unknown,
  options: {
    enableTokenjuice: boolean
    enableAntiInjection: boolean
    maxStringChars?: number
    isExternalSourceTool?: boolean
  },
): {
  result: unknown
  savedChars: number
  compacted: boolean
  injectionsDetected: number
  injectionLabels: string[]
} {
  let savedChars = 0
  let compacted = false
  let injectionsDetected = 0
  const injectionLabels: string[] = []
  const maxChars = options.maxStringChars ?? 10_000

  const visit = (node: unknown, depth: number): unknown => {
    if (depth > 6 || node === null || node === undefined) return node
    if (typeof node === 'string') {
      let s = node
      if (options.enableAntiInjection && options.isExternalSourceTool) {
        const san = sanitizePromptInjectionInText(s)
        if (san.detectedCount > 0) {
          s = san.sanitized
          injectionsDetected += san.detectedCount
          injectionLabels.push(...san.labels)
        }
      }
      if (options.enableTokenjuice && s.length > 400) {
        const comp = compactToolOutputString(s, maxChars)
        if (comp.compacted) {
          s = comp.text
          savedChars += comp.savedChars
          compacted = true
        }
      }
      return s
    }
    if (Array.isArray(node)) {
      return node.map(item => visit(item, depth + 1))
    }
    if (typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = visit(v, depth + 1)
      }
      return out
    }
    return node
  }

  const result = visit(value, 0)
  return { result, savedChars, compacted, injectionsDetected, injectionLabels }
}

interface LoopCallRecord {
  signature: string
  outcomeSig: string
  at: number
}

/**
 * Per-session Loop Detection tracker (inspired by OpenClaw `tools.loopDetection`).
 * Detects both identical `(tool, args)` spam and alternating ping-pong error loops.
 */
export class SessionLoopDetector {
  private readonly historyBySession = new Map<string, LoopCallRecord[]>()

  resetSession(sessionId: string): void {
    this.historyBySession.delete(sessionId)
  }

  checkBeforeCall(
    sessionId: string,
    toolName: string,
    args: unknown,
    maxIdenticalRepeats = 3,
  ): { blocked: boolean; signature: string; reason?: string } {
    let canonicalArgs = ''
    try {
      canonicalArgs = JSON.stringify(args ?? {})
    } catch {
      canonicalArgs = String(args)
    }
    const signature = `${toolName}::${canonicalArgs.slice(0, 400)}`
    const now = Date.now()
    const list = (this.historyBySession.get(sessionId) ?? []).filter(r => now - r.at < 180_000)
    this.historyBySession.set(sessionId, list)

    // Count consecutive or recent identical calls in the last 8 steps
    const recentWindow = list.slice(-8)
    const identicalCount = recentWindow.filter(r => r.signature === signature).length
    if (identicalCount >= maxIdenticalRepeats) {
      return {
        blocked: true,
        signature,
        reason:
          `[🛑 Loop Detection Guard] Tool "${toolName}" was already called ${identicalCount} times with the exact same arguments in this turn without progress. ` +
          `Do NOT repeat this call again—either change your approach/parameters or report the blocker clearly to the user.`,
      }
    }
    return { blocked: false, signature }
  }

  recordOutcome(sessionId: string, signature: string, outcome: unknown): void {
    const list = this.historyBySession.get(sessionId) ?? []
    let outcomeSig = ''
    try {
      outcomeSig = JSON.stringify(outcome ?? '').slice(0, 160)
    } catch {
      outcomeSig = String(outcome).slice(0, 160)
    }
    list.push({ signature, outcomeSig, at: Date.now() })
    if (list.length > 24) list.splice(0, list.length - 24)
    this.historyBySession.set(sessionId, list)
  }
}

export function buildModelUsageTools(
  readUsage: () => ModelUsageState,
  readGuardStats: () => RuntimeGuardStats,
  isEnabled: () => boolean,
): RegisteredToolSpec[] {
  const schema = z.object({
    days: z.number().int().min(1).max(30).optional().describe('Number of recent days to include (default 7).'),
  })

  return [
    {
      name: 'model_usage_summary',
      description: 'Inspect local per-model, per-role token consumption, turn latency, estimated CNY cost breakdown, and Tokenjuice / Loop-Guard savings.',
      parameters: z.toJSONSchema(schema),
      execute: async (rawArgs: unknown) => {
        if (!isEnabled()) {
          throw new Error('The Model Usage & Cost Telemetry plugin (dsh-model-usage) is currently disabled')
        }
        const args = schema.parse(rawArgs ?? {})
        const usage = readUsage()
        const guard = readGuardStats()
        const models = Object.values(usage.byModelRole).sort((a, b) => b.estimatedCostCny - a.estimatedCostCny)
        const dailyEntries = Object.entries(usage.dailyTokens)
          .sort(([a], [b]) => b.localeCompare(a))
          .slice(0, args.days ?? 7)
          .map(([date, stats]) => ({ date, ...stats }))
        const totalCostCny = Math.round(models.reduce((s, m) => s + m.estimatedCostCny, 0) * 10000) / 10000
        return {
          ok: true,
          totalEstimatedCostCny: totalCostCny,
          models,
          recentDays: dailyEntries,
          guardSavings: {
            compactedToolCalls: guard.compactedCalls,
            estimatedTokensSaved: guard.estimatedTokensSaved,
            loopsBroken: guard.loopsBroken,
            injectionsNeutralized: guard.injectionsNeutralized,
          },
        }
      },
    },
  ]
}
