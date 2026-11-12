/**
 * Batch 3 + Batch 4 First-Class Plugins:
 * 1. `@rharness/plugin-web-research` (`dsh-web-research`):
 *    - `research_search`: Multi-engine web search (Tavily API -> SearXNG -> DuckDuckGo zero-key HTML fallback).
 *    - `web_readability`: Clean article/Markdown extraction (strips scripts, navs, ads, styles + Anti-Injection sanitization).
 * 2. `@rharness/plugin-browser-bridge` (`dsh-browser-bridge`):
 *    - Connects to signed-in Chrome via CDP (`9222`) or Chrome Extension Relay (`18799`, reading `browser-extension-relay.secret`),
 *      supporting `browser_tabs`, `browser_open`, and `browser_extract` with cross-node fallback to `claw`.
 * 3. `@rharness/plugin-progress-card` (`dsh-progress-card`):
 *    - Durable single-card in-place step & progress bar tracker per session (`progress_card_update` / `progress_card_clear`).
 * 4. `@rharness/plugin-data-sql` (`dsh-data-sql`):
 *    - `data_sql_query`: Read-only SQL analytics over `orders.db` (`orders`), `interests.csv` (`interests`), or any local CSV/JSON file
 *      loaded into an in-memory `node:sqlite` engine (inspired by ClawHub's `duckdb` skill).
 * 5. `@rharness/plugin-tool-search` (`dsh-tool-search`):
 *    - `tool_catalog_search` & `tool_catalog_describe`: Fast keyword/capability discovery across all registered RHarness tools.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { loadPrivatePack } from './private-pack.ts'
import { sanitizePromptInjectionInText } from './runtime-guard-plugin.ts'
import type { RegisteredToolSpec } from './standalone-host.ts'
import type { WorkerNodeRecord } from './worker-nodes.ts'

// ============================================================================
// 1. Web Search + Clean Readability (`@rharness/plugin-web-research`)
// ============================================================================

export interface WebSearchHit {
  title: string
  url: string
  snippet: string
  source: string
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
}

/**
 * Extracts clean readable Markdown from raw HTML (`@openclaw/web-readability` + `steipete/summarize` pattern).
 */
export function extractReadableMarkdownFromHtml(html: string, sourceUrl = ''): { title: string; markdown: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const rawTitle = decodeHtmlEntities((titleMatch?.[1] ?? '').replace(/\s+/g, ' ').trim())

  // Prefer `<article>` or `<main>` when present so headers/sidebars/footers are dropped cleanly
  const articleMatch =
    /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html) ??
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html) ??
    /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)

  let body = articleMatch?.[1] ?? html
  body = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(?:script|style|noscript|svg|iframe|nav|footer|aside|form)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg|iframe|nav|footer|aside|form)>/gi, '\n')
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<h[4-6]\b[^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n#### $1\n')
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const cleanLabel = label.replace(/<[^>]+>/g, '').trim()
      if (!cleanLabel) return ''
      try {
        const resolved = sourceUrl ? new URL(href, sourceUrl).href : href
        if (/^https?:\/\//i.test(resolved)) return `[${cleanLabel}](${resolved})`
      } catch {}
      return cleanLabel
    })
    .replace(/<(?:p|div|section|br|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')

  const decoded = decodeHtmlEntities(body)
    .split('\n')
    .map(l => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const sanitized = sanitizePromptInjectionInText(decoded).sanitized
  return {
    title: rawTitle || sourceUrl,
    markdown: sanitized.slice(0, 28_000),
  }
}

export async function runMultiSourceWebSearch(
  query: string,
  options: { tavilyApiKey?: string; searxngUrl?: string; maxResults?: number } = {},
): Promise<{ engine: string; results: WebSearchHit[] }> {
  const maxResults = Math.max(1, Math.min(15, options.maxResults ?? 8))
  const tavilyKey = options.tavilyApiKey || process.env.TAVILY_API_KEY

  // 1. Tavily AI-optimized search if API key is configured
  if (tavilyKey) {
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKey,
          query,
          max_results: maxResults,
          include_answer: false,
        }),
        signal: AbortSignal.timeout(12_000),
      })
      if (res.ok) {
        const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] }
        if (Array.isArray(data.results) && data.results.length > 0) {
          return {
            engine: 'tavily',
            results: data.results.slice(0, maxResults).map(r => ({
              title: r.title ?? '',
              url: r.url ?? '',
              snippet: sanitizePromptInjectionInText((r.content ?? '').slice(0, 360)).sanitized,
              source: 'tavily',
            })),
          }
        }
      }
    } catch {}
  }

  // 2. Self-hosted SearXNG instance if configured
  const searxUrl = options.searxngUrl || process.env.SEARXNG_URL
  if (searxUrl) {
    try {
      const res = await fetch(
        `${searxUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`,
        { signal: AbortSignal.timeout(10_000) },
      )
      if (res.ok) {
        const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] }
        if (Array.isArray(data.results) && data.results.length > 0) {
          return {
            engine: 'searxng',
            results: data.results.slice(0, maxResults).map(r => ({
              title: r.title ?? '',
              url: r.url ?? '',
              snippet: sanitizePromptInjectionInText((r.content ?? '').slice(0, 360)).sanitized,
              source: 'searxng',
            })),
          }
        }
      }
    } catch {}
  }

  // 3. Zero-key DuckDuckGo HTML search fallback (`multi-search-engine` / `duckduckgo` pattern)
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const res = await fetch(ddgUrl, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(12_000),
  })
  const html = await res.text()
  const hits: WebSearchHit[] = []
  const blockRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)?/gi
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html)) !== null && hits.length < maxResults) {
    let rawHref = decodeHtmlEntities(m[1] ?? '')
    const uddgMatch = /[?&]uddg=([^&]+)/.exec(rawHref)
    if (uddgMatch?.[1]) {
      try { rawHref = decodeURIComponent(uddgMatch[1]) } catch {}
    }
    const title = decodeHtmlEntities((m[2] ?? '').replace(/<[^>]+>/g, '').trim())
    const snippet = decodeHtmlEntities(((m[3] ?? m[4]) ?? '').replace(/<[^>]+>/g, '').trim())
    if (title && /^https?:\/\//i.test(rawHref)) {
      hits.push({
        title,
        url: rawHref,
        snippet: sanitizePromptInjectionInText(snippet.slice(0, 360)).sanitized,
        source: 'duckduckgo',
      })
    }
  }
  return { engine: 'duckduckgo', results: hits }
}

export function buildWebResearchPluginTools(
  getConfig: () => Record<string, unknown>,
  isEnabled: () => boolean,
): RegisteredToolSpec[] {
  const searchSchema = z.object({
    query: z.string().min(1).max(300).describe('Search query keywords or question.'),
    max_results: z.number().int().min(1).max(15).optional().describe('Maximum search hits to return (default 8).'),
  })

  const readabilitySchema = z.object({
    url: z.string().url().describe('HTTP/HTTPS webpage URL to fetch and extract clean Markdown from.'),
    max_chars: z.number().int().min(1000).max(30000).optional().describe('Maximum extracted Markdown characters (default 16000).'),
  })

  return [
    {
      name: 'research_search',
      description: 'Search the live web using Tavily / SearXNG / DuckDuckGo (`tavily-search` + `searxng` community pattern) and return clean titles, URLs, and sanitized snippets.',
      parameters: z.toJSONSchema(searchSchema),
      execute: async (rawArgs: unknown) => {
        if (!isEnabled()) throw new Error('Web Research plugin (dsh-web-research) is disabled')
        const args = searchSchema.parse(rawArgs ?? {})
        const cfg = getConfig()
        return await runMultiSourceWebSearch(args.query, {
          ...(typeof cfg.tavilyApiKey === 'string' && cfg.tavilyApiKey.trim() ? { tavilyApiKey: cfg.tavilyApiKey.trim() } : {}),
          ...(typeof cfg.searxngUrl === 'string' && cfg.searxngUrl.trim() ? { searxngUrl: cfg.searxngUrl.trim() } : {}),
          ...(args.max_results ? { maxResults: args.max_results } : {}),
        })
      },
    },
    {
      name: 'web_readability',
      description: 'Fetch a webpage URL and extract clean, ad-free Markdown content (`@openclaw/web-readability` + `summarize` pattern) with built-in prompt-injection sanitization.',
      parameters: z.toJSONSchema(readabilitySchema),
      execute: async (rawArgs: unknown) => {
        if (!isEnabled()) throw new Error('Web Research plugin (dsh-web-research) is disabled')
        const args = readabilitySchema.parse(rawArgs ?? {})
        const res = await fetch(args.url, {
          headers: {
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) {
          return { ok: false, status: res.status, url: args.url, error: `HTTP ${res.status}` }
        }
        const rawText = await res.text()
        const ctype = res.headers.get('content-type') ?? ''
        if (ctype.includes('application/json') || ctype.includes('text/plain') || ctype.includes('text/markdown')) {
          const sanitized = sanitizePromptInjectionInText(rawText).sanitized
          return {
            ok: true,
            url: args.url,
            title: args.url,
            markdown: sanitized.slice(0, args.max_chars ?? 16_000),
          }
        }
        const extracted = extractReadableMarkdownFromHtml(rawText, args.url)
        return {
          ok: true,
          url: args.url,
          title: extracted.title,
          markdown: extracted.markdown.slice(0, args.max_chars ?? 16_000),
        }
      },
    },
  ]
}

// ============================================================================
// 2. Signed-In Chrome CDP / Extension Relay Bridge (`@rharness/plugin-browser-bridge`)
// ============================================================================

function loadBrowserRelayAuthHeader(): string | undefined {
  const packPaths = loadPrivatePack()?.manifest.personalPaths?.browserRelaySecretPaths ?? []
  const candidates = [
    ...(process.env.RHARNESS_BROWSER_RELAY_SECRET ? [process.env.RHARNESS_BROWSER_RELAY_SECRET] : []),
    join(homedir() || '.', '.rharness', 'credentials', 'browser-extension-relay.secret'),
    ...packPaths,
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const secret = readFileSync(p, 'utf8').trim()
        if (secret) return `Basic ${Buffer.from(`:${secret}`).toString('base64')}`
      } catch {}
    }
  }
  return undefined
}

export interface BrowserEndpointStatus {
  connected: boolean
  endpoint?: string
  tabCount: number
  tabs: { id: string; title: string; url: string; type?: string }[]
}

export async function inspectLocalBrowserBridge(customPort?: number): Promise<BrowserEndpointStatus> {
  const ports = customPort ? [customPort, 9222, 18799] : [9222, 18799]
  const authHeader = loadBrowserRelayAuthHeader()

  for (const port of [...new Set(ports)]) {
    const endpoint = `http://127.0.0.1:${port}`
    try {
      const headers: Record<string, string> = {}
      if (port === 18799 && authHeader) headers.authorization = authHeader
      const res = await fetch(`${endpoint}/json/list`, {
        headers,
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) {
        const list = (await res.json()) as { id?: string; title?: string; url?: string; type?: string }[]
        const tabs = (Array.isArray(list) ? list : [])
          .filter(t => !t.type || t.type === 'page')
          .map(t => ({
            id: String(t.id ?? ''),
            title: String(t.title ?? ''),
            url: String(t.url ?? ''),
            ...(t.type ? { type: t.type } : {}),
          }))
        return {
          connected: true,
          endpoint,
          tabCount: tabs.length,
          tabs: tabs.slice(0, 30),
        }
      }
    } catch {}
  }
  return { connected: false, tabCount: 0, tabs: [] }
}

export function buildBrowserBridgeTools(
  getNodes: () => readonly WorkerNodeRecord[],
  isEnabled: () => boolean,
): RegisteredToolSpec[] {
  const tabsSchema = z.object({
    node: z.enum(['auto', 'local', 'claw']).optional().describe('Target machine Chrome ("auto" checks local first then claw).'),
  })

  const openSchema = z.object({
    url: z.string().url().describe('URL to open in a new tab of the signed-in Chrome browser.'),
  })

  return [
    {
      name: 'browser_tabs',
      description: 'List open tabs in the signed-in Chrome browser via local CDP (`:9222`) or Chrome Extension Relay (`:18799`), automatically falling back to `claw` if local Chrome relay is offline.',
      parameters: z.toJSONSchema(tabsSchema),
      execute: async (rawArgs: unknown) => {
        if (!isEnabled()) throw new Error('Browser Bridge plugin (dsh-browser-bridge) is disabled')
        const args = tabsSchema.parse(rawArgs ?? {})
        if (args.node !== 'claw') {
          const local = await inspectLocalBrowserBridge()
          if (local.connected || args.node === 'local') {
            return { ok: local.connected, host: 'local', ...local }
          }
        }
        // Fallback to online peer nodes
        const remotePeers = getNodes()
          .filter(n => n.id !== 'local' && n.status === 'online' && n.url !== 'local')
          .flatMap(n => [...(n.endpoints ?? []), n.url])
        const fallbackPeers = loadPrivatePack()?.manifest.personalPaths?.peerFallbackEndpoints ?? []
        for (const ep of [...new Set([...remotePeers, ...fallbackPeers])]) {
          try {
            const r = await fetch(`${ep.replace(/\/+$/, '')}/orchestrator/standalone/browser/status`, {
              headers: { 'x-orchestrator-request': '1' },
              signal: AbortSignal.timeout(3500),
            })
            if (r.ok) {
              const data = (await r.json()) as BrowserEndpointStatus
              return { ok: data.connected, host: 'remote', ...data }
            }
          } catch {}
        }
        return {
          ok: false,
          connected: false,
          note: 'No active Chrome CDP (:9222) or Extension Relay (:18799) listener found on local or claw. Start Chrome with --remote-debugging-port=9222 or enable the extension relay.',
        }
      },
    },
    {
      name: 'browser_open_tab',
      description: 'Open a URL in a new signed-in Chrome tab via CDP / Extension Relay (`/json/new?<url>`).',
      parameters: z.toJSONSchema(openSchema),
      execute: async (rawArgs: unknown) => {
        if (!isEnabled()) throw new Error('Browser Bridge plugin (dsh-browser-bridge) is disabled')
        const args = openSchema.parse(rawArgs ?? {})
        const authHeader = loadBrowserRelayAuthHeader()
        for (const port of [9222, 18799]) {
          try {
            const headers: Record<string, string> = {}
            if (port === 18799 && authHeader) headers.authorization = authHeader
            const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(args.url)}`, {
              method: 'PUT',
              headers,
              signal: AbortSignal.timeout(4000),
            })
            if (res.ok) {
              const tab = await res.json()
              return { ok: true, endpoint: `http://127.0.0.1:${port}`, tab }
            }
          } catch {}
        }
        return {
          ok: false,
          error: 'Signed-in Chrome CDP/Relay is not listening on :9222 or :18799',
        }
      },
    },
  ]
}

// ============================================================================
// 3. Durable In-Place Progress Card (`@rharness/plugin-progress-card`)
// ============================================================================

export interface ProgressCardStep {
  step: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface SessionProgressCard {
  sessionId: string
  title: string
  markdown?: string
  steps: ProgressCardStep[]
  completedCount: number
  totalCount: number
  percent: number
  updatedAt: string
}

export function buildProgressCardTools(options: {
  sessionId: string
  readCards: () => Record<string, SessionProgressCard>
  writeCards: (next: Record<string, SessionProgressCard>) => void
  isEnabled: () => boolean
}): RegisteredToolSpec[] {
  const updateSchema = z.object({
    title: z.string().min(1).max(120).describe('Concise title of the multi-step task.'),
    markdown: z.string().max(1000).optional().describe('Optional glanceable status note or current blocker.'),
    steps: z
      .array(
        z.object({
          step: z.string().min(1).max(200),
          status: z.enum(['pending', 'in_progress', 'completed']),
        }),
      )
      .min(1)
      .max(30)
      .describe('Ordered step checklist; each call replaces the card in-place without spamming new chat messages.'),
  })

  return [
    {
      name: 'progress_card_update',
      description: 'Publish or update the single durable in-place Progress Card (`progress_card` pattern) for substantial multi-step work (2+ steps). Replaces the card in-place instead of spamming progress messages.',
      parameters: z.toJSONSchema(updateSchema),
      execute: async (rawArgs: unknown) => {
        if (!options.isEnabled()) throw new Error('Progress Card plugin (dsh-progress-card) is disabled')
        const args = updateSchema.parse(rawArgs ?? {})
        const completedCount = args.steps.filter(s => s.status === 'completed').length
        const totalCount = args.steps.length
        const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
        const card: SessionProgressCard = {
          sessionId: options.sessionId,
          title: args.title.trim(),
          ...(args.markdown?.trim() ? { markdown: args.markdown.trim() } : {}),
          steps: args.steps,
          completedCount,
          totalCount,
          percent,
          updatedAt: new Date().toISOString(),
        }
        const all = { ...options.readCards(), [options.sessionId]: card }
        options.writeCards(all)
        return { ok: true, card }
      },
    },
    {
      name: 'progress_card_clear',
      description: 'Clear the active in-place Progress Card for this session once the multi-step work is finished.',
      parameters: z.toJSONSchema(z.object({})),
      execute: async () => {
        const next = { ...options.readCards() }
        delete next[options.sessionId]
        options.writeCards(next)
        return { ok: true, cleared: true }
      },
    },
  ]
}

// ============================================================================
// 4. Local Data SQL Analytics (`@rharness/plugin-data-sql` · DuckDB-style SQL over CSV & SQLite)
// ============================================================================

function parseSimpleCsv(raw: string): { headers: string[]; rows: string[][] } {
  const clean = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
  if (!clean) return { headers: [], rows: [] }
  const parseLine = (line: string): string[] => {
    const out: string[] = []
    let cur = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"'
          i++
        } else if (ch === '"') {
          inQuotes = false
        } else {
          cur += ch
        }
      } else if (ch === '"') {
        inQuotes = true
      } else if (ch === ',') {
        out.push(cur.trim())
        cur = ''
      } else {
        cur += ch
      }
    }
    out.push(cur.trim())
    return out
  }
  const lines = clean.split('\n').filter(Boolean)
  const headers = parseLine(lines[0] ?? '').map((h, i) => h.replace(/[^\w\u4e00-\u9fa5]/g, '_') || `col_${i}`)
  const rows = lines.slice(1).map(parseLine)
  return { headers, rows }
}

export function executeReadonlyDataSql(input: {
  dataset: 'orders' | 'interests' | 'csv'
  sql: string
  csvPath?: string
}): { ok: boolean; columns?: string[]; rows?: unknown[]; rowCount?: number; error?: string } {
  const stmt = input.sql.trim()
  if (!/^(?:SELECT|WITH|PRAGMA\s+table_info)\b/i.test(stmt) || /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|ATTACH|DETACH|CREATE|REPLACE)\b/i.test(stmt)) {
    return { ok: false, error: 'Only read-only SELECT / WITH queries are permitted in data_sql_query' }
  }

  if (input.dataset === 'orders') {
    const p = loadPrivatePack()?.manifest.personalPaths
    const candidates = [
      ...(process.env.RHARNESS_ORDERS_DB ? [process.env.RHARNESS_ORDERS_DB] : []),
      ...(p?.standaloneOrdersDir ? [join(p.standaloneOrdersDir, 'orders.db')] : []),
      ...(p?.ordersDir ? [join(p.ordersDir, 'orders.db')] : []),
      join(homedir() || '.', '.rharness', 'orders', 'orders.db'),
    ]
    const dbFile = candidates.find(f => existsSync(f))
    if (!dbFile) return { ok: false, error: 'orders.db not found locally' }
    const db = new DatabaseSync(dbFile, { readOnly: true })
    try {
      const rows = db.prepare(stmt).all() as Record<string, unknown>[]
      const columns = rows[0] ? Object.keys(rows[0]) : []
      return { ok: true, columns, rows: rows.slice(0, 200), rowCount: rows.length }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      db.close()
    }
  }

  // Load CSV into an ephemeral in-memory SQLite table named `data` (or `interests`)
  const packCsv = loadPrivatePack()?.manifest.personalPaths?.interestsCsv
  const targetCsv =
    input.dataset === 'interests'
      ? [
          ...(process.env.RHARNESS_INTERESTS_CSV ? [process.env.RHARNESS_INTERESTS_CSV] : []),
          ...(packCsv ? [packCsv] : []),
          join(homedir() || '.', '.rharness', 'data', 'interests.csv'),
        ].find(f => existsSync(f))
      : input.csvPath && existsSync(input.csvPath)
        ? input.csvPath
        : undefined
  if (!targetCsv) {
    return { ok: false, error: `CSV file not found for dataset="${input.dataset}"` }
  }
  const { headers, rows } = parseSimpleCsv(readFileSync(targetCsv, 'utf8'))
  if (!headers.length) return { ok: false, error: 'CSV has no headers' }

  const memDb = new DatabaseSync(':memory:')
  try {
    const tableName = input.dataset === 'interests' ? 'interests' : 'data'
    const colDefs = headers.map(h => `"${h}" TEXT`).join(', ')
    memDb.exec(`CREATE TABLE "${tableName}" (${colDefs})`)
    const placeholders = headers.map(() => '?').join(', ')
    const insert = memDb.prepare(`INSERT INTO "${tableName}" VALUES (${placeholders})`)
    for (const r of rows) {
      insert.run(...headers.map((_h, idx) => r[idx] ?? ''))
    }
    const outRows = memDb.prepare(stmt).all() as Record<string, unknown>[]
    const columns = outRows[0] ? Object.keys(outRows[0]) : headers
    return { ok: true, columns, rows: outRows.slice(0, 200), rowCount: outRows.length }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    memDb.close()
  }
}

export function buildDataSqlPluginTools(isEnabled: () => boolean): RegisteredToolSpec[] {
  const schema = z.object({
    dataset: z
      .enum(['orders', 'interests', 'csv'])
      .describe('"orders" queries table `orders` (platform, order_no, order_time, total_amount, status, shop, product, qty, category); "interests" queries table `interests` from interests.csv; "csv" queries table `data` from `csv_path`.'),
    sql: z.string().min(1).max(2000).describe('Read-only SQL SELECT / aggregate query (e.g. "SELECT platform, SUM(total_amount) AS spend FROM orders WHERE order_time >= \'2026-01\' GROUP BY platform").'),
    csv_path: z.string().optional().describe('Required only when dataset="csv": local path to the CSV file.'),
  })

  return [
    {
      name: 'data_sql_query',
      description: 'Run fast, exact read-only SQL analytics (`SUM`, `GROUP BY`, `AVG`, date filtering) over `orders.db` (`orders`), `interests.csv` (`interests`), or any local CSV file (`duckdb` community skill pattern). Never do mental math—use SQL!',
      parameters: z.toJSONSchema(schema),
      execute: async (rawArgs: unknown) => {
        if (!isEnabled()) throw new Error('Data SQL Analytics plugin (dsh-data-sql) is disabled')
        const args = schema.parse(rawArgs ?? {})
        return executeReadonlyDataSql({
          dataset: args.dataset,
          sql: args.sql,
          ...(args.csv_path ? { csvPath: args.csv_path } : {}),
        })
      },
    },
  ]
}

// ============================================================================
// 5. Tool Catalog Search & Describe (`@rharness/plugin-tool-search`)
// ============================================================================

export function buildToolSearchPluginTools(
  getSessionTools: () => Map<string, RegisteredToolSpec>,
  isEnabled: () => boolean,
): RegisteredToolSpec[] {
  const searchSchema = z.object({
    query: z.string().optional().describe('Keyword to search across all available tool names and descriptions in this session.'),
  })

  const describeSchema = z.object({
    tool_name: z.string().min(1).describe('Exact name of the tool to inspect its full JSON Schema parameters.'),
  })

  return [
    {
      name: 'tool_catalog_search',
      description: 'Search across all registered tools in this session by keyword or capability (`OpenClaw Tool Search` + `find-skills` pattern).',
      parameters: z.toJSONSchema(searchSchema),
      execute: async (rawArgs: unknown) => {
        if (!isEnabled()) throw new Error('Tool Search plugin (dsh-tool-search) is disabled')
        const args = searchSchema.parse(rawArgs ?? {})
        const q = (args.query ?? '').trim().toLowerCase()
        const all = [...getSessionTools().values()]
        const matched = all
          .filter(t => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
          .map(t => ({
            name: t.name,
            description: t.description.slice(0, 220),
          }))
        return { totalTools: all.length, matchedCount: matched.length, tools: matched }
      },
    },
    {
      name: 'tool_catalog_describe',
      description: 'Inspect the complete parameter JSON Schema and description of a specific tool.',
      parameters: z.toJSONSchema(describeSchema),
      execute: async (rawArgs: unknown) => {
        if (!isEnabled()) throw new Error('Tool Search plugin (dsh-tool-search) is disabled')
        const args = describeSchema.parse(rawArgs ?? {})
        const found = getSessionTools().get(args.tool_name.trim())
        if (!found) return { found: false, error: `Tool not found: ${args.tool_name}` }
        return {
          found: true,
          name: found.name,
          description: found.description,
          parameters: found.parameters,
        }
      },
    },
  ]
}
