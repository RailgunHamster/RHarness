/**
 * Real local model discovery and turn execution for:
 * 1. Local DeepSeek Harness installation (`@deepseek-ai/dsh` + `~/.dsh/profiles/web/cordis.patch.yml`)
 * 2. Local OpenAI Codex App Server (`codex app-server` JSON-RPC over stdio)
 * 3. Human-in-the-loop Session Console (`human`)
 */
import { execFileSync, spawn } from 'node:child_process'
import { createDecipheriv } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { codexTurnContent, dshTurnContent, localMessageImages } from './local-images.ts'
import type { RegisteredToolSpec, SessionTurnMessage } from './standalone-host.ts'
import { assistantText, createCodexEventCollector, createCursorEventCollector, createDshEventCollector, projectLiveTrace, type LiveTraceStep, type SessionExecutionEvent } from './session-events.ts'
export type { LiveTraceStep } from './session-events.ts'

export interface CatalogEffort {
  id: string
  name: string
  description?: string
}

export interface CatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: {
    efforts: CatalogEffort[]
    defaultEffort?: string
  }
}

export interface CatalogGroup {
  id: string
  name: string
  models: CatalogModel[]
}

export interface DiscoveredCatalog {
  default: { provider: string; model: string; reasoningEffort?: string }
  routableProviders: string[]
  groups: CatalogGroup[]
  failures: { id: string; name: string; message: string }[]
}

/** Locate the local `@deepseek-ai/dsh` installation directory. */
export function findDshInstallation(): string | undefined {
  const candidates = [
    process.env.RHARNESS_DSH_INSTALLATION,
    process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh') : undefined,
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
  ]
  return candidates.find(dir => dir && existsSync(join(dir, 'package.json')))
}

/** Locate the local `codex` binary (from env, PATH, or `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`). */
export function findCodexExecutable(configured = process.env.RHARNESS_CODEX_COMMAND ?? 'codex'): string | undefined {
  const isFile = (p: string) => {
    try { return statSync(p).isFile() } catch { return false }
  }
  if (isAbsolute(configured) && isFile(configured)) return configured
  if (!isAbsolute(configured)) {
    const names = process.platform === 'win32' && !/\.exe$/i.test(configured) ? [`${configured}.exe`, configured] : [configured]
    for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
      if (!dir || !isAbsolute(dir)) continue
      for (const name of names) {
        const candidate = join(dir, name)
        if (isFile(candidate)) return candidate
      }
    }
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const root = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
    try {
      const resolvedRoot = realpathSync(root)
      const candidates: { command: string; mtime: number }[] = []
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9]+$/i.test(entry.name)) continue
        const target = join(root, entry.name, 'codex.exe')
        if (!isFile(target)) continue
        const real = realpathSync(target)
        const rel = relative(resolvedRoot, real)
        if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) continue
        candidates.push({ command: real, mtime: statSync(real).mtimeMs })
      }
      candidates.sort((a, b) => b.mtime - a.mtime)
      if (candidates[0]) return candidates[0].command
    } catch {
      /* No managed Codex desktop bin directory */
    }
  }
  return undefined
}

const EFFORT_LABELS: Record<string, string> = {
  off: 'Off (关闭思考)',
  minimal: 'Minimal (极简)',
  low: 'Low (低)',
  medium: 'Medium (中)',
  high: 'High (高)',
  xhigh: 'XHigh (超高)',
  max: 'Max (最大)',
  ultra: 'Ultra (极限)',
}

function formatEffort(id: string, name?: string): CatalogEffort {
  return { id, name: name && name !== id ? name : (EFFORT_LABELS[id] ?? id) }
}

/** Return the latest modification timestamp (`mtimeMs`) of local DSH profile patch files so catalog caches never go stale. */
export function getDshConfigMtimeMs(): number {
  const candidates = [
    join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml'),
    join(homedir(), '.dsh', 'profiles', 'web', 'cordis.yml'),
    'D:/backup/dsh-personal-models.json',
  ]
  let latest = 0
  for (const file of candidates) {
    try {
      if (existsSync(file)) {
        const mtime = statSync(file).mtimeMs
        if (mtime > latest) latest = mtime
      }
    } catch { /* ignore */ }
  }
  return latest
}

/**
 * Fast (< 5ms) live overlay of `~/.dsh/profiles/web/cordis.patch.yml` custom providers onto an existing catalog.
 * Ensures that any edits or `dsh-remote-models` syncs in DSH are reflected immediately on the very next UI read,
 * even while a full background Cordis re-probe is running.
 */
export async function applyLiveDshPatchOverlay(base: DiscoveredCatalog): Promise<DiscoveredCatalog> {
  const installation = findDshInstallation()
  if (!installation) return base
  try {
    const req = createRequire(join(installation, 'package.json'))
    const boot = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href) as {
      loadOverlayPatches: (bin: string, path: string) => { id?: string; config?: Record<string, unknown> }[]
      resolveProfileDir: (name: string) => string
    }
    const webPatchPath = join(boot.resolveProfileDir('web'), 'cordis.patch.yml')
    if (!existsSync(webPatchPath)) return base

    const patches = boot.loadOverlayPatches('dsh', webPatchPath)
    const piAiPatch = patches.find(p => p.id === 'llm-pi-ai')
    const rawProviders = (piAiPatch?.config?.providers ?? {}) as Record<string, {
      displayName?: string
      api?: string
      baseURL?: string
      models?: {
        id?: string
        name?: string
        description?: string
        reasoningEfforts?: Record<string, string | null>
      }[]
    }>

    const nextGroups = base.groups.map(g => ({ ...g, models: [...g.models] }))

    for (const [providerId, spec] of Object.entries(rawProviders)) {
      if (!spec || !Array.isArray(spec.models) || spec.models.length === 0) continue
      // Only replace the full model list for custom API providers (those with baseURL or api specified)
      const isCustomProvider = Boolean(spec.baseURL || spec.api)
      if (!isCustomProvider) continue

      const mappedModels: CatalogModel[] = spec.models
        .filter(m => m && typeof m.id === 'string' && m.id.trim())
        .map(m => {
          const id = m.id!.trim()
          const effortKeys = m.reasoningEfforts ? Object.keys(m.reasoningEfforts) : []
          const efforts = effortKeys.map(k => formatEffort(k))
          return {
            id,
            name: m.name?.trim() || id,
            ...(m.description ? { description: m.description } : {}),
            ...(efforts.length ? { reasoning: { efforts } } : {}),
          }
        })
      if (!mappedModels.length) continue

      const displayName = spec.displayName?.trim() || providerId
      const groupName = displayName === providerId ? `${displayName} (DSH)` : `${displayName} (${providerId})`
      const existingIdx = nextGroups.findIndex(g => g.id === providerId)
      if (existingIdx >= 0) {
        nextGroups[existingIdx] = {
          id: providerId,
          name: groupName,
          models: mappedModels,
        }
      } else {
        nextGroups.push({
          id: providerId,
          name: groupName,
          models: mappedModels,
        })
      }
    }

    const defaultPatch = patches.find(p => p.id === 'agent-default-model')?.config as
      | { provider?: string; model?: string; reasoningEffort?: string }
      | undefined
    const nextDefault = defaultPatch?.provider && defaultPatch?.model
      ? {
          provider: defaultPatch.provider,
          model: defaultPatch.model,
          ...(defaultPatch.reasoningEffort ? { reasoningEffort: defaultPatch.reasoningEffort } : {}),
        }
      : base.default

    return {
      ...base,
      default: nextDefault,
      routableProviders: nextGroups.map(g => g.id),
      groups: nextGroups,
    }
  } catch {
    return base
  }
}

/** Discover all providers and models configured in the local `@deepseek-ai/dsh` installation and `~/.dsh/profiles/web`. */
export async function discoverDshCatalog(): Promise<{
  defaultSelection?: { provider: string; model: string; reasoningEffort?: string }
  groups: CatalogGroup[]
  failures: { id: string; name: string; message: string }[]
}> {
  const installation = findDshInstallation()
  if (!installation) return { groups: [], failures: [] }
  let ctx: { get: (k: string) => unknown; fiber: { dispose: () => Promise<void> } } | undefined
  try {
    const req = createRequire(join(installation, 'package.json'))
    const boot = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href) as {
      loadOverlayPatches: (bin: string, path: string) => { id?: string; insert?: unknown }[]
      resolveProfileDir: (name: string) => string
      boot: (bin: string, cfg: string, patches: unknown[], prepare: undefined, baseUrl: string) => Promise<typeof ctx>
    }
    const baseDir = dirname(req.resolve('@deepseek-ai/dsh-base/package.json'))
    const basePatches = boot.loadOverlayPatches('dsh', join(baseDir, 'cordis.patch.yml'))
    const webPatchPath = join(boot.resolveProfileDir('web'), 'cordis.patch.yml')
    const userPatches = (existsSync(webPatchPath)
      ? boot.loadOverlayPatches('dsh', webPatchPath).filter(p =>
          p.id && ['llm-pi-ai', 'agent-default-model', 'compaction-basic', 'permission'].includes(p.id))
      : []) as { id?: string; config?: { providers?: Record<string, unknown> } }[]

    // Ensure DSH's built-in `anthropic` (Claude) catalog in `@deepseek-ai/dsh-llm-pi-ai` is declared and routable
    const piAiPatch = userPatches.find(p => p.id === 'llm-pi-ai')
    if (piAiPatch) {
      piAiPatch.config ??= {}
      piAiPatch.config.providers = {
        anthropic: { displayName: 'Claude (Anthropic)' },
        ...(piAiPatch.config.providers ?? {}),
      }
    } else {
      userPatches.push({
        id: 'llm-pi-ai',
        config: { providers: { anthropic: { displayName: 'Claude (Anthropic)' } } },
      })
    }

    const temp = mkdtempSync(join(tmpdir(), 'dsh-catalog-'))
    const configPath = join(temp, 'cordis.json')
    writeFileSync(configPath, '[]')
    const overrides = [
      { id: 'hmr', disabled: true },
      { id: 'session-title-llm', disabled: true },
      { id: 'session-telemetry-otel', disabled: true },
      { id: 'agent-loop', config: { agents: [] } },
      { id: 'session-persistence-jsonl', config: { root: join(temp, 'sessions') } },
    ]
    ctx = await boot.boot('dsh', configPath, [...basePatches, ...userPatches, ...overrides], undefined, pathToFileURL(installation + '/').href)
    if (!ctx) return { groups: [], failures: [] }

    const llm = ctx.get('llm') as {
      listProviders: () => { id: string; name: string }[]
      listModels: (providerId: string) => Promise<{ id: string; name: string; description?: string }[]>
      resolveModelInfo: (providerId: string, modelId: string) => Promise<{
        reasoning?: { efforts?: { id: string; name: string }[]; defaultEffort?: string }
      }>
    }
    const defaultModelSvc = ctx.get('agentDefaultModel') as {
      currentSelection: () => { provider: string; model: string; reasoningEffort?: string }
    } | undefined
    const defaultSelection = defaultModelSvc?.currentSelection()

    const groups: CatalogGroup[] = []
    const failures: { id: string; name: string; message: string }[] = []

    for (const provider of llm.listProviders()) {
      try {
        const rawModels = await llm.listModels(provider.id)
        const models: CatalogModel[] = []
        for (const m of rawModels) {
          const info = await llm.resolveModelInfo(provider.id, m.id).catch(() => undefined)
          const efforts = (info?.reasoning?.efforts ?? []).map(e => formatEffort(e.id, e.name))
          models.push({
            id: m.id,
            name: m.name || m.id,
            ...(m.description ? { description: m.description } : {}),
            ...(efforts.length ? {
              reasoning: {
                efforts,
                ...(info?.reasoning?.defaultEffort ? { defaultEffort: info.reasoning.defaultEffort } : {}),
              },
            } : {}),
          })
        }
        if (models.length > 0) {
          groups.push({
            id: provider.id,
            name: provider.name === provider.id ? `${provider.name} (DSH)` : `${provider.name} (${provider.id})`,
            models,
          })
        }
      } catch (err) {
        failures.push({
          id: provider.id,
          name: provider.name,
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return { ...(defaultSelection ? { defaultSelection } : {}), groups, failures }
  } catch (err) {
    return {
      groups: [],
      failures: [{ id: 'dsh', name: 'DeepSeek Harness', message: err instanceof Error ? err.message : String(err) }],
    }
  } finally {
    await ctx?.fiber.dispose().catch(() => {})
  }
}

/** Query the local Codex App Server (`codex app-server`) for its live model list. */
export async function discoverCodexCatalog(): Promise<CatalogGroup | undefined> {
  const command = findCodexExecutable()
  if (!command) return undefined

  const child = spawn(command, ['app-server'], {
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let buffer = ''

  const cleanup = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('Codex discovery closed'))
    }
    pending.clear()
    try { child.stdin.end() } catch {}
    try { child.kill() } catch {}
  }

  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as { id?: number; method?: string; result?: unknown; error?: { message?: string } }
        if (msg.id !== undefined && !msg.method) {
          const entry = pending.get(msg.id)
          if (!entry) continue
          pending.delete(msg.id)
          clearTimeout(entry.timer)
          if (msg.error) entry.reject(new Error(msg.error.message ?? 'Codex RPC error'))
          else entry.resolve(msg.result)
        }
      } catch {
        /* ignore non-json diagnostic */
      }
    }
  })

  const request = <T>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> => {
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Codex ${method} timed out`))
      }, timeoutMs)
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  try {
    await request('initialize', {
      clientInfo: { name: 'dsh-superagent', title: 'dsh-superagent', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }, 20_000)
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')

    interface CodexModelEntry {
      id?: string
      model?: string
      displayName?: string
      description?: string
      supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[]
    }
    const rawModels: CodexModelEntry[] = []
    let cursor: string | null = null
    do {
      const page: { data: CodexModelEntry[]; nextCursor: string | null } = await request('model/list', {
        limit: 100,
        cursor,
        includeHidden: false,
      })
      rawModels.push(...(page.data ?? []))
      cursor = page.nextCursor ?? null
    } while (cursor && rawModels.length < 500)

    const models: CatalogModel[] = rawModels.map(m => {
      const id = m.model ?? m.id ?? ''
      const efforts = (m.supportedReasoningEfforts ?? []).map(e => formatEffort(e.reasoningEffort, e.description))
      return {
        id,
        name: m.displayName ?? id,
        ...(m.description ? { description: m.description } : {}),
        ...(efforts.length ? { reasoning: { efforts } } : {}),
      }
    }).filter(m => m.id)

    if (!models.length) return undefined
    return {
      id: 'codex',
      name: 'Codex App Server (本地 CLI)',
      models,
    }
  } catch {
    return undefined
  } finally {
    cleanup()
  }
}

/** Locate the local Cursor Agent CLI bundle (`node.exe` + `index.js`) managed by Cursor Desktop. */
export function findCursorAgentBundle(): { nodeExe: string; indexJs: string; version: string } | undefined {
  const roots = [
    process.env.RHARNESS_CURSOR_AGENT_DIR,
    process.env.APPDATA
      ? join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'anysphere.cursor-agent-worker', 'agent-cli', '.local', 'share', 'cursor-agent', 'versions')
      : undefined,
    join(homedir(), '.local', 'share', 'cursor-agent', 'versions'),
  ].filter((p): p is string => !!p && existsSync(p))

  for (const versionsDir of roots) {
    try {
      const entries = readdirSync(versionsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => ({ name: e.name, dir: join(versionsDir, e.name), mtime: statSync(join(versionsDir, e.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      for (const entry of entries) {
        const indexJs = join(entry.dir, 'index.js')
        const nodeExe = join(entry.dir, process.platform === 'win32' ? 'node.exe' : 'node')
        if (existsSync(indexJs)) {
          return {
            nodeExe: existsSync(nodeExe) ? nodeExe : process.execPath,
            indexJs,
            version: entry.name,
          }
        }
      }
    } catch { /* ignore unreadable dir */ }
  }
  return undefined
}

let cachedCursorToken: string | undefined

/** Resolve the local Cursor authentication token from env or Cursor Desktop's `state.vscdb` + `Local State` DPAPI key. */
export function resolveCursorAuthToken(): string | undefined {
  const envToken = process.env.CURSOR_API_KEY ?? process.env.CURSOR_AUTH_TOKEN
  if (envToken?.trim()) return envToken.trim()
  if (cachedCursorToken) return cachedCursorToken
  if (!process.env.APPDATA) return undefined

  const dbPath = join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  const localStatePath = join(process.env.APPDATA, 'Cursor', 'Local State')
  if (!existsSync(dbPath)) return undefined

  try {
    const db = new DatabaseSync(dbPath, { open: true, readOnly: true })
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('cursorAuth/accessToken') as { value?: string } | undefined
    db.close()
    const raw = String(row?.value ?? '').trim()
    if (!raw) return undefined
    const prefix = 'cursor-safe-storage:v1:'
    if (!raw.startsWith(prefix)) {
      cachedCursorToken = raw
      return raw
    }
    if (process.platform !== 'win32' || !existsSync(localStatePath)) return undefined
    const cipherBuf = Buffer.from(raw.slice(prefix.length), 'base64')
    const psCmd = [
      'Add-Type -AssemblyName System.Security',
      `$ls = Get-Content -LiteralPath '${localStatePath.replaceAll("'", "''")}' -Raw | ConvertFrom-Json`,
      '$b = [Convert]::FromBase64String($ls.os_crypt.encrypted_key)',
      '$u = [System.Security.Cryptography.ProtectedData]::Unprotect($b[5..($b.Length-1)], $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '[Convert]::ToBase64String($u)',
    ].join('; ')
    const keyB64 = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
    }).trim()
    const key = Buffer.from(keyB64, 'base64')
    const nonce = cipherBuf.subarray(3, 15)
    const tag = cipherBuf.subarray(cipherBuf.length - 16)
    const data = cipherBuf.subarray(15, cipherBuf.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8').trim()
    if (decrypted) cachedCursorToken = decrypted
    return cachedCursorToken
  } catch {
    return undefined
  }
}

/** Query the local Cursor Agent CLI (`cursor-agent models`) for the account's live model list. */
export async function discoverCursorCatalog(): Promise<CatalogGroup | undefined> {
  const bundle = findCursorAgentBundle()
  const token = resolveCursorAuthToken()
  if (!bundle || !token) return undefined

  try {
    const out = execFileSync(bundle.nodeExe, [bundle.indexJs, 'models'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, CURSOR_AUTH_TOKEN: token },
    })
    const models: CatalogModel[] = []
    for (const rawLine of out.split(/\r?\n/)) {
      const line = rawLine.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
      const match = /^([a-z0-9._-]+)\s+-\s+(.+)$/i.exec(line)
      if (!match) continue
      const [, id, label] = match
      if (!id || !label) continue
      models.push({
        id,
        name: label.trim(),
      })
    }
    if (!models.length) return undefined
    return {
      id: 'cursor',
      name: `Cursor Agent (本地 CLI ${bundle.version})`,
      models,
    }
  } catch {
    return undefined
  }
}

/** Build the complete live catalog combining local DSH providers (including Claude), local Codex App Server, local Cursor Agent CLI, and Human Console. */
export async function discoverFullLocalCatalog(cacheFile?: string): Promise<DiscoveredCatalog> {
  const [dsh, codexGroup, cursorGroup] = await Promise.all([
    discoverDshCatalog(),
    discoverCodexCatalog(),
    discoverCursorCatalog(),
  ])

  const groups: CatalogGroup[] = [...dsh.groups]
  if (codexGroup) {
    groups.push(codexGroup)
  }
  if (cursorGroup) {
    groups.push(cursorGroup)
  }
  groups.push({
    id: 'human',
    name: 'Human Console (人工在面板操作)',
    models: [
      { id: 'human-operator', name: 'Human Operator (手动控制回合与工具)' },
    ],
  })

  const defaultSelection = dsh.defaultSelection
    ?? (groups[0]?.models[0]
      ? { provider: groups[0].id, model: groups[0].models[0].id }
      : { provider: 'human', model: 'human-operator' })

  const result: DiscoveredCatalog = {
    default: defaultSelection,
    routableProviders: groups.map(g => g.id),
    groups,
    failures: dsh.failures,
  }

  if (cacheFile) {
    try { writeFileSync(cacheFile, JSON.stringify(result, null, 2)) } catch {}
  }
  return result
}

/** Execute a turn using the local Codex App Server (`codex app-server`) with dynamic tools bridged to the Session's tools. */
export async function runCodexTurn(input: {
  model: string
  reasoningEffort?: string
  cwd: string
  systemPrompt: string
  messages: SessionTurnMessage[]
  tools: Map<string, RegisteredToolSpec>
  signal: AbortSignal
  onToolResult?: (toolName: string, result: unknown) => void
  onEvent?: (type: string, data: unknown) => void
}): Promise<string> {
  input.signal.throwIfAborted()
  const command = findCodexExecutable()
  if (!command) throw new Error('Local codex executable not found')

  mkdirSync(input.cwd, { recursive: true })
  const child = spawn(command, ['app-server', '-c', 'project_root_markers=[]'], {
    windowsHide: true,
    shell: false,
    cwd: input.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let buffer = ''
  let threadId = ''
  let replyText = ''
  const events = createCodexEventCollector((type, data) => {
    if (type === 'assistant/step') replyText = String(data.text ?? '')
    input.onEvent?.(type, data)
  })
  let turnDone: { resolve: () => void; reject: (e: Error) => void } | undefined

  const cleanup = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('Codex connection closed'))
    }
    pending.clear()
    try { child.stdin.end() } catch {}
    try { child.kill() } catch {}
  }

  const respond = (id: number | string, result: unknown) => {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.write(JSON.stringify({ id, result }) + '\n')
    }
  }

  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as {
          id?: number | string
          method?: string
          params?: Record<string, unknown>
          result?: unknown
          error?: { message?: string }
        }
        if (msg.id !== undefined && !msg.method) {
          const entry = pending.get(Number(msg.id))
          if (!entry) continue
          pending.delete(Number(msg.id))
          clearTimeout(entry.timer)
          if (msg.error) entry.reject(new Error(msg.error.message ?? 'Codex RPC error'))
          else entry.resolve(msg.result)
        } else if (msg.id !== undefined && msg.method === 'item/tool/call') {
          const params = (msg.params ?? {}) as { tool?: string; arguments?: unknown; callId?: string }
          const toolCallId = `codex:${params.callId ?? msg.id}`
          events.toolCall(toolCallId, params.tool, params.arguments ?? {})
          const tool = params.tool ? input.tools.get(params.tool) : undefined
          if (!tool) {
            const text = `Unknown tool: ${String(params.tool)}`
            events.toolResult(toolCallId, params.tool, text, true)
            respond(msg.id, { success: false, contentItems: [{ type: 'inputText', text }] })
          } else {
            void Promise.resolve().then(() => tool.execute(params.arguments ?? {}, { signal: input.signal })).then(
              res => {
                input.onToolResult?.(tool.name, res)
                events.toolResult(toolCallId, tool.name, res)
                respond(msg.id!, { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(res) }] })
              },
              err => {
                const text = err instanceof Error ? err.message : String(err)
                events.toolResult(toolCallId, tool.name, text, true)
                respond(msg.id!, { success: false, contentItems: [{ type: 'inputText', text }] })
              },
            )
          }
        } else if (msg.method === 'turn/completed') {
          const turn = (msg.params as { turn?: { status?: string; error?: { message?: string } } } | undefined)?.turn
          if (turn?.status === 'completed') turnDone?.resolve()
          else turnDone?.reject(new Error(turn?.error?.message ?? `Codex turn ${turn?.status ?? 'failed'}`))
        } else if (msg.method) {
          events.notification(msg.method, msg.params ?? {})
        }
      } catch {
        /* ignore non-json line */
      }
    }
  })

  const request = <T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> => {
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Codex ${method} timed out`))
      }, timeoutMs)
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  child.on('error', error => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
    pending.clear()
    turnDone?.reject(error)
  })
  const onAbort = () => {
    turnDone?.reject(new Error('Codex turn aborted'))
    cleanup()
  }
  input.signal.addEventListener('abort', onAbort, { once: true })

  try {
    await request('initialize', {
      clientInfo: { name: 'dsh-superagent', title: 'dsh-superagent', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }, 30_000)
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')

    const dynamicTools = [...input.tools.values()].map(t => ({
      type: 'function',
      name: t.name,
      description: t.description,
      inputSchema: t.parameters ?? { type: 'object', additionalProperties: true },
    }))

    const started = await request<{ thread: { id: string } }>('thread/start', {
      model: input.model,
      allowProviderModelFallback: false,
      cwd: input.cwd,
      runtimeWorkspaceRoots: [input.cwd],
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      ephemeral: true,
      dynamicTools,
      config: { 'features.multi_agent': false, project_root_markers: [] },
      developerInstructions: input.systemPrompt,
    })
    threadId = started.thread.id

    const completion = new Promise<void>((resolve, reject) => {
      turnDone = { resolve, reject }
      child.once('close', code => reject(new Error(`Codex server exited (${code})`)))
    })

    await request('turn/start', {
      threadId,
      input: codexTurnContent(input.messages),
      ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
    })

    await completion
    events.flush()
    return replyText
  } finally {
    events.flush()
    events.close()
    input.signal.removeEventListener('abort', onAbort)
    cleanup()
  }
}

/** Execute a turn using the local `@deepseek-ai/dsh` agent runtime with registered session tools. */
export async function runDshTurn(input: {
  sessionId?: string
  provider: string
  model: string
  reasoningEffort?: string
  cwd: string
  systemPrompt: string
  messages: SessionTurnMessage[]
  tools: Map<string, RegisteredToolSpec>
  signal: AbortSignal
  onToolResult?: (toolName: string, result: unknown) => void
  onEvent?: (type: string, data: unknown) => void
}): Promise<string> {
  input.signal.throwIfAborted()
  const installation = findDshInstallation()
  if (!installation) throw new Error('Local @deepseek-ai/dsh installation not found')

  mkdirSync(input.cwd, { recursive: true })
  const req = createRequire(join(installation, 'package.json'))
  const load = (name: string) => import(pathToFileURL(req.resolve(name)).href)
  const boot = await load('@deepseek-ai/dsh-app-boot')
  const core = await load('@deepseek-ai/dsh-agent')
  const llm = await load('@deepseek-ai/dsh-llm')
  const systemPrompt = await load('@deepseek-ai/dsh-system-prompt')
  const personaField = systemPrompt.SystemPrompt?.Config?.shape?.personaPrefix ? 'personaPrefix' : 'persona'
  const baseDir = dirname(req.resolve('@deepseek-ai/dsh-base/package.json'))
  const basePatches = boot.loadOverlayPatches('dsh', join(baseDir, 'cordis.patch.yml'))
  const webPatchPath = join(boot.resolveProfileDir('web'), 'cordis.patch.yml')
  const userPatches = (existsSync(webPatchPath)
    ? boot.loadOverlayPatches('dsh', webPatchPath).filter((p: { id?: string }) =>
        p.id && ['llm-pi-ai', 'agent-default-model', 'compaction-basic', 'permission'].includes(p.id))
    : []) as { id?: string; config?: { providers?: Record<string, unknown> } }[]
  const piAiPatch = userPatches.find(p => p.id === 'llm-pi-ai')
  if (piAiPatch) {
    piAiPatch.config ??= {}
    piAiPatch.config.providers = {
      anthropic: { displayName: 'Claude (Anthropic)' },
      ...(piAiPatch.config.providers ?? {}),
    }
  } else {
    userPatches.push({
      id: 'llm-pi-ai',
      config: { providers: { anthropic: { displayName: 'Claude (Anthropic)' } } },
    })
  }

  const temp = join(tmpdir(), `dsh-turn-session-${encodeURIComponent(input.sessionId ?? String(Date.now()))}`)
  mkdirSync(temp, { recursive: true })
  const configPath = join(temp, 'cordis.json')
  writeFileSync(configPath, '[]')

  const isAssistantSession = input.sessionId === 'claw-assistant-main'
  const isOrchestratorSession = Boolean(input.sessionId?.startsWith('orchestrator-'))

  const roleOverrides = isAssistantSession
    ? [
        // Personal Assistant has NO local repo/filesystem/shell/subagent tools and does NOT load repo AGENTS.md
        { id: 'agent-instructions', disabled: true },
        { id: 'tool-fs', disabled: true },
        { id: 'tool-fs-search', disabled: true },
        { id: 'tool-working-directory', disabled: true },
        { id: 'tool-bash', disabled: true },
        { id: 'tool-pwsh', disabled: true },
        { id: 'tool-jobs', disabled: true },
        { id: 'tool-goal', disabled: true },
        { id: 'tool-subagent', disabled: true },
        { id: 'tool-subagent-fork', disabled: true },
        { id: 'tool-subagent-control', disabled: true },
        { id: 'tool-workflow', disabled: true },
        { id: 'tool-todo', disabled: true },
        { id: 'tool-skill', disabled: true },
        { id: 'tool-web', disabled: true },
      ]
    : isOrchestratorSession
      ? [
          // Engineering Eval (orchestrator) only routes and evaluates; no repo search/write/subagent/goal/todo tools
          { id: 'agent-instructions', disabled: true },
          { id: 'tool-fs', config: { write: false, edit: false, applyPatch: false } },
          { id: 'tool-fs-search', disabled: true },
          { id: 'tool-working-directory', disabled: true },
          { id: 'tool-goal', disabled: true },
          { id: 'tool-subagent', disabled: true },
          { id: 'tool-subagent-fork', disabled: true },
          { id: 'tool-subagent-control', disabled: true },
          { id: 'tool-workflow', disabled: true },
          { id: 'tool-todo', disabled: true },
          { id: 'tool-web', disabled: true },
        ]
      : []

  const overrides = [
    { id: 'hmr', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'plan-mode', disabled: true },
    { id: 'agent-loop', config: { agents: [] } },
    { id: 'session-persistence-jsonl', config: { root: join(temp, 'sessions') } },
    { id: 'approval', config: { policy: 'never' } },
    { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: input.cwd } },
    { id: 'system-prompt', config: { [personaField]: input.systemPrompt } },
    ...roleOverrides,
  ]

  let ctx: any
  let handle: any
  let onAbort: (() => void) | undefined
  const events = createDshEventCollector((type, data) => input.onEvent?.(type, data))
  try {
    ctx = await boot.boot('dsh', configPath, [...basePatches, ...userPatches, ...overrides], undefined, pathToFileURL(installation + '/').href)
    if (process.platform === 'win32') {
      const sub = ctx.get('subprocess') as { selectContainmentMode?: (kind: string) => string } | undefined
      if (sub && typeof sub.selectContainmentMode === 'function') {
        sub.selectContainmentMode = () => 'fallback'
      }
    }
    for (const tool of input.tools.values()) {
      ctx.get('tools').register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? { type: 'object', additionalProperties: true },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args: unknown, exec: { signal: AbortSignal }) => {
          const res = await tool.execute(args, { signal: AbortSignal.any([input.signal, exec.signal]) })
          input.onToolResult?.(tool.name, res)
          return res
        },
      })
    }

    const selection = {
      provider: input.provider,
      model: input.model,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    }

    handle = await ctx.get('agents').create({
      sessionId: `dsh-superagent-${Date.now()}`,
      meta: { cwd: input.cwd },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx: unknown) => {
        core.installModelSelection(agentCtx, { current: selection, assembled: undefined })
      },
    })

    const agent = handle.agent
    onAbort = () => agent.cancel({ kind: 'parent' })
    input.signal.addEventListener('abort', onAbort, { once: true })

    ctx.on('session/event', (sess: unknown, event: { type: string; data: unknown; seq?: number }) => {
      if (sess === agent.session) events.sessionEvent(event)
    })
    ctx.on('agent/assistant-stream', (payload: { agent: unknown; frame: unknown }) => {
      if (payload.agent === agent) events.streamFrame(payload.frame)
    })

    await agent.whenIdle()
    if (localMessageImages(input.messages).length) {
      const info = await ctx.get('llm').resolveModelInfo(input.provider, input.model, input.signal)
      if (!info.inputModalities?.includes('image')) throw new Error(`Model ${input.model} does not support image input; the image has not been inspected`)
    }
    agent.followup(llm.createUserMessage({
      content: await dshTurnContent(input.messages, agent.ctx.get('attachments'), input.signal),
      source: { kind: 'user' },
    }))

    await agent.whenIdle()
    const transcript = agent.session.snapshotEvents() as { type: string; data: unknown }[]
    const stepTexts: string[] = []
    for (const event of transcript) {
      if (event.type !== 'assistant/message') continue
      const text = assistantText(event.data).trim()
      if (text && stepTexts.at(-1) !== text) {
        stepTexts.push(text)
      }
    }
    return stepTexts.join('\n\n')
  } finally {
    if (onAbort) input.signal.removeEventListener('abort', onAbort)
    await handle?.dispose().catch(() => {})
    await ctx?.fiber.dispose().catch(() => {})
    events.flush()
    events.close()
  }
}

function zstdFrameEnd(input: Buffer, start: number): number {
  let offset = start
  const advance = (bytes: number) => {
    if (offset + bytes > input.length) return -1
    const p = offset
    offset += bytes
    return p
  }
  if (advance(4) < 0 || input.readUInt32LE(offset - 4) !== 0xfd2fb528) return -1
  const fPos = advance(1)
  if (fPos < 0) return -1
  const flags = input[fPos]!
  const single = !!(flags & 0x20)
  const sizeFlag = flags >>> 6
  const dictFlag = flags & 3
  if (advance((single ? 0 : 1) + (dictFlag === 3 ? 4 : dictFlag) + (sizeFlag ? 1 << sizeFlag : single ? 1 : 0)) < 0) return -1
  let last = false
  while (!last) {
    const hPos = advance(3)
    if (hPos < 0) return -1
    const header = input.readUIntLE(hPos, 3)
    const type = (header >>> 1) & 3
    if (advance(type === 1 ? 1 : header >>> 3) < 0) return -1
    last = !!(header & 1)
  }
  if ((flags & 4) && advance(4) < 0) return -1
  return offset
}

function decodeZstdLog(buf: Buffer): string {
  const chunks: Buffer[] = []
  let offset = 0
  while (offset < buf.length) {
    const end = zstdFrameEnd(buf, offset)
    if (end < 0) break
    try {
      chunks.push(zstdDecompressSync(buf.subarray(offset, end)))
    } catch {
      break
    }
    offset = end
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Historical fallback only. Active turns publish in-memory frames, since an unfinished zstd frame is not readable. */
export function readLiveDshTrace(sessionId: string, cwd: string): LiveTraceStep[] {
  if (!cwd) return []
  const slug = `--${cwd.replace(/[^A-Za-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')}--`
  // A cwd can host several sessions. Never scan unrelated dsh-turn-* directories by cwd alone.
  const root = join(tmpdir(), `dsh-turn-session-${encodeURIComponent(sessionId)}`, 'sessions', slug)
  const steps: LiveTraceStep[] = []
  try {
    for (const sub of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!sub.isDirectory()) continue
      const directory = join(root, sub.name)
      const file = ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl'].map(name => join(directory, name)).find(existsSync)
      if (!file) continue
      const events: SessionExecutionEvent[] = []
      let at = ''
      const collector = createDshEventCollector((type, data) => events.push({ type, data, at }))
      try {
        const buffer = readFileSync(file)
        const text = file.endsWith('.zstd') ? decodeZstdLog(buffer) : buffer.toString('utf8')
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line) as { type: string; data?: unknown; seq?: number; time?: number; at?: string }
            at = event.time ? new Date(event.time).toISOString() : event.at ?? ''
            collector.sessionEvent(event)
          } catch { /* The writer can leave an unfinished last JSON line. Keep all preceding complete events. */ }
        }
        collector.flush()
        const prefix = sub.name.startsWith('dsh-superagent-') ? '' : `[Subagent ${sub.name.slice(0, 6)}] `
        steps.push(...projectLiveTrace(events).map(step => ({ ...step, id: `${sub.name}:${step.id}`, title: `${prefix}${step.title}` })))
      } catch { /* The live writer may be rotating or finishing a compressed frame. */ }
      finally { collector.close() }
    }
  } catch { return [] }
  return steps.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq).map((step, seq) => ({ ...step, seq }))
}

/** Execute a turn using the local Cursor Agent CLI (`cursor-agent --print --force --trust --model <model>`). */
export async function runCursorTurn(input: {
  model: string
  cwd: string
  systemPrompt: string
  messages: SessionTurnMessage[]
  signal: AbortSignal
  onEvent?: (type: string, data: unknown) => void
}): Promise<string> {
  input.signal.throwIfAborted()
  if (localMessageImages(input.messages).length) throw new Error('This Cursor CLI adapter does not support image input; select Codex or an image-capable DSH model')
  const bundle = findCursorAgentBundle()
  const token = resolveCursorAuthToken()
  if (!bundle) throw new Error('Local Cursor Agent CLI bundle not found')
  if (!token) throw new Error('Cursor authentication token not found; sign in to Cursor Desktop or set CURSOR_API_KEY')

  mkdirSync(input.cwd, { recursive: true })
  const promptText = [
    input.systemPrompt,
    ...input.messages.map(m => m.content.map(c => c.text ?? '').join('\n')).filter(Boolean),
  ].join('\n\n')

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(
      bundle.nodeExe,
      [
        bundle.indexJs,
        '--print',
        '--output-format', 'stream-json',
        '--stream-partial-output',
        '--force',
        '--trust',
        '--workspace', input.cwd,
        '--model', input.model || 'auto',
        promptText,
      ],
      {
        cwd: input.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: input.signal,
        env: { ...process.env, CURSOR_AUTH_TOKEN: token },
      },
    )
    let buffer = ''
    let stderr = ''
    const events = createCursorEventCollector((type, data) => input.onEvent?.(type, data))
    const line = (text: string) => {
      if (!text.trim()) return
      try { events.event(JSON.parse(text)) } catch { /* Ignore non-JSON CLI diagnostics, not assistant speech. */ }
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
      }
    })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', error => { events.close(); reject(error) })
    child.once('close', code => {
      line(buffer)
      events.flush()
      events.close()
      if (code === 0 && !events.failure) resolve(events.text)
      else reject(new Error(events.failure ?? (stderr.trim() || `Cursor agent exited with code ${code}`)))
    })
  })
}
