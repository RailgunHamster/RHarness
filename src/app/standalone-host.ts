/**
 * Standalone multi-provider Agent Host implementing the Cordis Context and session services required by `Runtime`
 * (`agents`, `sessionController`, `sessionPersistence`, `workspaceRegistry`, `permissionPresets`, `subprocess`,
 * `webServer`, `llm`, `jobs`, `subagents`), backed by live local discovery and execution of:
 * - Local DeepSeek Harness (`@deepseek-ai/dsh` + `~/.dsh/profiles/web/cordis.patch.yml` providers & models)
 * - Local OpenAI Codex App Server (`codex app-server` JSON-RPC over stdio)
 * - Human Operator in Panel Session Console (`human`)
 */
import { Context } from '@deepseek-ai/cordis'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyLiveDshPatchOverlay,
  discoverFullLocalCatalog,
  getDshConfigMtimeMs,
  readLiveDshTrace,
  runCodexTurn,
  runCursorTurn,
  runDshTurn,
  type DiscoveredCatalog,
} from './local-drivers.ts'
import { assistantText, projectLiveTrace } from './session-events.ts'

export interface RegisteredToolSpec {
  name: string
  description: string
  parameters?: unknown
  output?: { render?: (args: unknown, value: unknown) => unknown }
  execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown>
}

export interface SessionTurnMessage {
  id: string
  role: 'user' | 'assistant'
  content: { type: string; text?: string; [key: string]: unknown }[]
  source?: Record<string, unknown>
}

export interface StandaloneSessionRecord {
  id: string
  title: string
  cwd: string
  agentPreset?: string
  model?: { provider: string; model: string; reasoningEffort?: string }
  events: { type: string; data: unknown; at: string }[]
}

export const FALLBACK_CATALOG: DiscoveredCatalog = {
  default: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
  routableProviders: ['deepseek-official', 'codex', 'human'],
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek (deepseek-official)',
      models: [
        { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } },
      ],
    },
    {
      id: 'codex',
      name: 'Codex App Server (本地 CLI)',
      models: [
        { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }, { id: 'xhigh', name: 'XHigh' }, { id: 'max', name: 'Max' }, { id: 'ultra', name: 'Ultra' }] } },
        { id: 'gpt-6-astra', name: 'GPT-6-Astra', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }, { id: 'xhigh', name: 'XHigh' }, { id: 'max', name: 'Max' }, { id: 'ultra', name: 'Ultra' }] } },
      ],
    },
    {
      id: 'human',
      name: 'Human Console (人工在面板操作)',
      models: [
        { id: 'human-operator', name: 'Human Operator (手动控制回合与工具)' },
      ],
    },
  ],
  failures: [],
}

export interface StandaloneHostOptions {
  stateDir: string
  port: number
  /** When true, automatically discovers local DSH + Codex models on startup and executes live agent turns. */
  liveAgents?: boolean
  /** Optional resolver returning the currently configured role model (`eval.model` or `executor.model`) for `sessionId`. */
  roleModel?: (sessionId: string) => { provider: string; model: string; reasoningEffort?: string } | null | undefined
  /** Optional filter to bound the active event window passed to a session's turn (e.g. sliding window + window reset cutoff). */
  eventWindowFilter?: (sessionId: string, events: StandaloneSessionRecord['events']) => StandaloneSessionRecord['events']
  /** Optional custom turn driver override. */
  driver?: (input: {
    sessionId: string
    provider: string
    model: string
    reasoningEffort?: string
    cwd: string
    systemPrompt: string
    messages: SessionTurnMessage[]
    tools: Map<string, RegisteredToolSpec>
    signal: AbortSignal
    /** Public execution facts only; assistant/step carries the complete visible text plus a stable messageId. */
    onEvent: (type: string, data: unknown) => void
    onToolResult: (toolName: string, result: unknown) => void
  }) => Promise<string | void>
}

/**
 * Builds a standalone Cordis Context providing all host services expected by `Runtime`, plus live local model discovery
 * (`@deepseek-ai/dsh` + `codex app-server`) and interactive session control methods.
 */
export function createStandaloneHost(options: StandaloneHostOptions) {
  const ctx = new Context()
  const sessionsDir = join(options.stateDir, 'sessions')
  const catalogCacheFile = join(options.stateDir, 'model-catalog-cache.json')
  mkdirSync(sessionsDir, { recursive: true })

  let cachedCatalog: DiscoveredCatalog | undefined
  let lastSyncedDshMtimeMs = 0
  if (existsSync(catalogCacheFile)) {
    try {
      cachedCatalog = JSON.parse(readFileSync(catalogCacheFile, 'utf8')) as DiscoveredCatalog
      lastSyncedDshMtimeMs = statSync(catalogCacheFile).mtimeMs
    } catch { /* ignore corrupt cache */ }
  }
  let discoveringCatalog: Promise<DiscoveredCatalog> | undefined

  const refreshCatalog = async (): Promise<DiscoveredCatalog> => {
    if (!options.liveAgents) {
      return cachedCatalog ?? FALLBACK_CATALOG
    }
    discoveringCatalog ??= discoverFullLocalCatalog(catalogCacheFile)
      .then(cat => {
        cachedCatalog = cat.groups.length > 1 ? cat : (cachedCatalog ?? cat)
        lastSyncedDshMtimeMs = Math.max(Date.now(), getDshConfigMtimeMs())
        return cachedCatalog
      })
      .finally(() => { discoveringCatalog = undefined })
    return discoveringCatalog
  }

  const getCatalog = async (): Promise<DiscoveredCatalog> => {
    if (
      cachedCatalog &&
      cachedCatalog.groups.length > 1 &&
      (!options.liveAgents || (cachedCatalog.groups.some(g => g.id === 'anthropic') && cachedCatalog.groups.some(g => g.id === 'cursor')))
    ) {
      if (options.liveAgents) {
        const currentDshMtime = getDshConfigMtimeMs()
        if (currentDshMtime > lastSyncedDshMtimeMs) {
          cachedCatalog = await applyLiveDshPatchOverlay(cachedCatalog)
          lastSyncedDshMtimeMs = Math.max(Date.now(), currentDshMtime)
          try { writeFileSync(catalogCacheFile, JSON.stringify(cachedCatalog, null, 2)) } catch {}
          void refreshCatalog().catch(() => {})
        }
      }
      return cachedCatalog
    }
    return refreshCatalog()
  }

  const persisted = new Map<string, StandaloneSessionRecord>()
  const sessionFile = (id: string) => join(sessionsDir, `${encodeURIComponent(id)}.json`)
  const loadPersisted = (id: string): StandaloneSessionRecord | undefined => {
    if (persisted.has(id)) return persisted.get(id)
    const file = sessionFile(id)
    if (!existsSync(file)) return undefined
    try {
      const record = JSON.parse(readFileSync(file, 'utf8')) as StandaloneSessionRecord
      persisted.set(id, record)
      return record
    } catch { return undefined }
  }
  const savePersisted = (record: StandaloneSessionRecord) => {
    persisted.set(record.id, record)
    try { writeFileSync(sessionFile(record.id), JSON.stringify(record, null, 2)) } catch {}
  }

  type ManagedAgent = {
    id: string
    title: string
    cwd: string
    ctx: Context
    status: 'idle' | 'running'
    options: { provider: string; model: string }
    inbox: {
      nextTurn: SessionTurnMessage[]
      nextStep: SessionTurnMessage[]
      remove: (id: string) => boolean
    }
    session: {
      id: string
      header: { agentPreset?: string; parentSession?: string }
      snapshotEvents: () => { type: string; data: unknown; at: string }[]
      requestHeader: () => { config: { provider: string; model: string; reasoningEffort?: string } } | undefined
      append: (type: string, data: unknown) => void
    }
    followup: (message: SessionTurnMessage) => void
    steer: (message: SessionTurnMessage) => void
    inject: (message: SessionTurnMessage) => void
    cancel: (cause: unknown, opts?: { keepInbox?: boolean }) => void
    whenIdle: () => Promise<void>
    tools: Map<string, RegisteredToolSpec>
    sections: Map<string, { name: string; text: (context: { signal?: AbortSignal }) => string }>
    takeStep: () => void
  }

  const agents = new Map<string, ManagedAgent>()
  const routes: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }[] = []

  const subprocess = {
    spawn: ({ argv, cwd, env, signal }: { argv: readonly string[]; cwd: string; env?: Record<string, string>; signal?: AbortSignal }) => {
      const cmd = [...argv]
      while (cmd[0] === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd[0] ?? '')) {
        const token = cmd.shift()!
        if (token !== 'env' && token.includes('=')) {
          const idx = token.indexOf('=')
          env = { ...env, [token.slice(0, idx)]: token.slice(idx + 1) }
        }
      }
      const child = spawn(cmd[0] ?? 'echo', cmd.slice(1), {
        cwd,
        env: { ...process.env, ...env },
        signal,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const output = { stdout: '', stderr: '' }
      child.stdout?.on('data', chunk => { output.stdout += String(chunk) })
      child.stderr?.on('data', chunk => { output.stderr += String(chunk) })
      const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: output[name].length, lossy: false }) })
      const done = new Promise<{ exitCode: number | null; signal: string | null }>(resolve => {
        child.on('error', err => { output.stderr += String(err); resolve({ exitCode: 1, signal: null }) })
        child.on('close', (code, sig) => resolve({ exitCode: code, signal: sig }))
      })
      return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
    },
  }

  const jobs = {
    list: () => [],
    wait: async () => ({ status: 'completed' }),
    kill: () => 'requested',
    events: { subscribe: () => () => {} },
  }

  const subagents = {
    waitForChildren: async () => false,
    listChildren: async () => [],
    drainChildren: async () => {},
    drainDescendants: async () => {},
    interrupt: () => {},
  }

  const createAgent = (sessionId: string, cwd: string, agentPreset?: string): ManagedAgent => {
    const defaultSel = (cachedCatalog ?? FALLBACK_CATALOG).default
    const existingRecord = loadPersisted(sessionId) ?? {
      id: sessionId,
      title: sessionId,
      cwd,
      ...(agentPreset ? { agentPreset } : {}),
      events: [],
    }
    savePersisted(existingRecord)

    const agentCtx = new Context()
    const sessionTools = new Map<string, RegisteredToolSpec>()
    const sessionSections = new Map<string, { name: string; text: (context: { signal?: AbortSignal }) => string }>()

    agentCtx.reflect.provide('tools', {
      register: (tool: RegisteredToolSpec) => {
        sessionTools.set(tool.name, tool)
        return () => sessionTools.delete(tool.name)
      },
      get: (name: string) => sessionTools.get(name),
      restrict: () => () => {},
      guard: () => () => {},
    })
    agentCtx.reflect.provide('skills', { register: () => () => {} })
    agentCtx.reflect.provide('systemPrompt', {
      section: (spec: { name: string; text: (context: { signal?: AbortSignal }) => string }) => {
        sessionSections.set(spec.name, spec)
        return () => sessionSections.delete(spec.name)
      },
    })

    const inbox = {
      nextTurn: [] as SessionTurnMessage[],
      nextStep: [] as SessionTurnMessage[],
      remove: (id: string) => [inbox.nextTurn, inbox.nextStep].some(list => {
        const at = list.findIndex(m => m.id === id)
        if (at >= 0) list.splice(at, 1)
        return at >= 0
      }),
    }

    const taken = new Set<string>()
    let turn = existingRecord.events.reduce((latest, event) => Math.max(latest, Number((event.data as { turn?: number } | null)?.turn) || 0), 0)
    let status: 'idle' | 'running' = 'idle'
    const idleWaiters: (() => void)[] = []
    let turnAbort: AbortController | undefined

    const session = {
      id: sessionId,
      header: { ...(existingRecord.agentPreset ? { agentPreset: existingRecord.agentPreset } : {}) },
      snapshotEvents: () => existingRecord.events as never[],
      requestHeader: () => existingRecord.model ? { config: existingRecord.model } : undefined,
      append: (type: string, data: unknown) => {
        existingRecord.events.push({ type, data, at: new Date().toISOString() })
        if (type === 'model/selection' && data && typeof data === 'object') {
          existingRecord.model = data as { provider: string; model: string; reasoningEffort?: string }
        }
        savePersisted(existingRecord)
        ctx.emit('session/event', session as never, { type, data } as never)
      },
    }

    const take = (starts: boolean) => {
      const agent = agents.get(sessionId)!
      const queued = starts ? inbox.nextTurn.filter(m => !taken.has(m.id)).slice(0, 1) : []
      const claimedNow: SessionTurnMessage[] = []
      for (const message of [...inbox.nextStep.filter(m => !taken.has(m.id)), ...queued]) {
        taken.add(message.id)
        claimedNow.push(message)
        ctx.emit('agent/inbox/claimed', { agent, message, turn } as never)
        session.append('user/message', message)
      }
      return claimedNow
    }

    const finishTurn = () => {
      const agent = agents.get(sessionId)
      if (!agent || status === 'idle') return
      status = 'idle'
      ctx.emit('agent/status', { agent: agent as never, status: 'idle' } as never)
      for (const wake of idleWaiters.splice(0)) wake()
    }

    const executeDriver = options.driver ?? (options.liveAgents ? async (req: Parameters<NonNullable<StandaloneHostOptions['driver']>>[0]) => {
      // Native drivers already emit structured tool results. Do not also append the bridge callback's result.
      const { onToolResult: _onToolResult, ...nativeRequest } = req
      if (req.provider === 'codex') return await runCodexTurn(nativeRequest)
      if (req.provider === 'cursor') return await runCursorTurn(nativeRequest)
      return await runDshTurn(nativeRequest)
    } : undefined)

    const resolveActiveModel = () => {
      const configured = options.roleModel?.(sessionId)
      if (configured) {
        existingRecord.model = configured
        return configured
      }
      return existingRecord.model ?? {
        provider: agent.options.provider,
        model: agent.options.model,
      }
    }

    const runTurn = () => {
      if (status === 'running') return
      const activeModel = resolveActiveModel()
      const provider = activeModel.provider
      status = 'running'
      ctx.emit('agent/status', { agent: agent as never, status: 'running' } as never)
      turn++
      take(true)
      if (provider === 'human' || !executeDriver) {
        return
      }
      turnAbort = new AbortController()
      const driverAbort = turnAbort
      const sysPrompt = [...sessionSections.values()].map(s => s.text({ signal: driverAbort.signal })).join('\n\n')
      const windowedEvents = options.eventWindowFilter
        ? options.eventWindowFilter(sessionId, existingRecord.events)
        : existingRecord.events
      const msgs: SessionTurnMessage[] = windowedEvents.flatMap((e, idx): SessionTurnMessage[] => {
        if (e.type === 'user/message') return [e.data as SessionTurnMessage]
        if (e.type === 'assistant/message') {
          const text = assistantText(e.data)
          return text ? [{ id: `hist-assistant-${idx}`, role: 'assistant', content: [{ type: 'text', text }] }] : []
        }
        if (e.type === 'tool/result') {
          const data = (e.data ?? {}) as { tool?: string; output?: unknown }
          if (
            typeof data.tool === 'string' &&
            (data.tool.startsWith('orchestrator_') || data.tool.startsWith('memory_') || data.tool.startsWith('assistant_'))
          ) {
            return [{
              id: `hist-tool-${idx}`,
              role: 'assistant',
              content: [{ type: 'text', text: `[Tool ${data.tool}] ${typeof data.output === 'string' ? data.output : JSON.stringify(data.output ?? '')}` }],
            }]
          }
        }
        return []
      })
      const driverTurn = turn
      let lastReply: { messageId: string; text: string } | undefined
      let toolResultIndex = 0
      const onEvent = (type: string, data: unknown) => {
        if (turn !== driverTurn) return
        if (type === 'assistant/step' || type === 'assistant/message') {
          const value = data && typeof data === 'object' ? data as Record<string, unknown> : {}
          const text = assistantText(value)
          if (!text) return
          const messageId = `turn:${driverTurn}:${String(value.messageId ?? 'reply')}`
          lastReply = { messageId, text }
          // Never persist private reasoning or the raw model stream in the UI event log.
          session.append('assistant/step', { messageId, text, streaming: value.streaming === true,
            ...(typeof value.step === 'number' ? { step: value.step } : {}), turn: driverTurn })
        } else if ((type === 'tool/call' || type === 'tool/result') && data && typeof data === 'object') {
          const value = data as Record<string, unknown>
          const callId = value.toolCallId ?? value.callId
          const toolCallId = callId ? `turn:${driverTurn}:${String(callId)}` : undefined
          const message = type === 'tool/result' && !value.message
            ? { role: 'tool', ...(toolCallId ? { toolCallId } : {}), content: [{ type: 'text', text: typeof value.output === 'string' ? value.output : JSON.stringify(value.output ?? value.result ?? '') }] }
            : value.message
          session.append(type, { ...value, ...(message ? { message } : {}), turn: driverTurn, ...(toolCallId ? { toolCallId } : {}) })
        } else if (data && typeof data === 'object') {
          session.append(type, { ...(data as Record<string, unknown>), turn: driverTurn, model: activeModel })
        } else {
          session.append(type, data)
        }
      }
      void Promise.resolve().then(() => executeDriver({
        sessionId,
        provider,
        model: activeModel.model,
        ...(activeModel.reasoningEffort ? { reasoningEffort: activeModel.reasoningEffort } : {}),
        cwd: existingRecord.cwd,
        systemPrompt: sysPrompt,
        messages: msgs,
        tools: sessionTools,
        signal: driverAbort.signal,
        onEvent,
        onToolResult: (toolName, result) => onEvent('tool/result', { tool: toolName, toolCallId: `turn:${driverTurn}:bridge:${toolResultIndex++}`, output: result,
          message: { role: 'assistant', content: [{ type: 'text', text: `[Tool ${toolName}] ${JSON.stringify(result)}` }] } }),
      })).then(replyText => {
        if (turn !== driverTurn) return
        if (typeof replyText === 'string' && replyText.trim()) {
          session.append('assistant/message', {
            turn: driverTurn,
            model: activeModel,
            messageId: lastReply?.text === replyText ? lastReply.messageId : `turn:${driverTurn}:reply`,
            message: { role: 'assistant', content: [{ type: 'text', text: replyText }] },
          })
        }
        finishTurn()
        if (inbox.nextStep.some(m => !taken.has(m.id)) || inbox.nextTurn.some(m => !taken.has(m.id))) {
          queueMicrotask(runTurn)
        }
      }, err => {
        if (turn !== driverTurn) return
        if (!driverAbort.signal.aborted) session.append('turn/error', { turn: driverTurn, message: err instanceof Error ? err.message : String(err) })
        ctx.emit('agent/error', { agent: agent as never, error: err } as never)
        finishTurn()
      })
    }

    const deliver = (mode: 'queue' | 'steer') => (message: SessionTurnMessage) => {
      inbox[mode === 'queue' ? 'nextTurn' : 'nextStep'].push(message)
      if (status !== 'idle') {
        const provider = resolveActiveModel().provider
        if (provider === 'human') take(false)
        return
      }
      runTurn()
    }

    const cancel = (_cause: unknown, opts?: { keepInbox?: boolean }) => {
      if (!opts?.keepInbox) {
        inbox.nextTurn.length = 0
        inbox.nextStep.length = 0
      }
      turnAbort?.abort()
      if (status === 'idle') return
      const cancelledTurn = turn
      session.append('turn/cancelled', { turn: cancelledTurn })
      queueMicrotask(() => { if (turn === cancelledTurn) finishTurn() })
    }

    const agent: ManagedAgent = {
      id: sessionId,
      title: existingRecord.title,
      cwd: existingRecord.cwd,
      ctx: agentCtx,
      options: {
        provider: existingRecord.model?.provider ?? defaultSel.provider,
        model: existingRecord.model?.model ?? defaultSel.model,
      },
      inbox,
      session,
      followup: deliver('queue'),
      steer: deliver('steer'),
      inject: (message: SessionTurnMessage) => { session.append('user/message', message) },
      cancel,
      get status() { return status },
      set status(next: 'idle' | 'running') {
        status = next
        if (next === 'idle') for (const wake of idleWaiters.splice(0)) wake()
      },
      whenIdle: () => status === 'idle' ? Promise.resolve() : new Promise<void>(resolve => { idleWaiters.push(resolve) }),
      tools: sessionTools,
      sections: sessionSections,
      takeStep: () => { take(false) },
    }

    agents.set(sessionId, agent)
    return agent
  }

  const sessionController = {
    create: async ({ sessionId, workspaceId, agentPreset }: { sessionId: string; workspaceId: string; agentPreset?: string }) => {
      if (!agents.has(sessionId)) {
        const agent = createAgent(sessionId, workspaceId, agentPreset)
        await ctx.parallel('agent/created', { agent: agent as never, source: 'create' as never })
      }
    },
    resolveAgent: async (sessionId: string) => {
      let agent = agents.get(sessionId)
      if (!agent) {
        const saved = loadPersisted(sessionId)
        if (!saved) return { error: { code: 'session/not-found', message: `Session ${sessionId} not found` } }
        agent = createAgent(sessionId, saved.cwd, saved.agentPreset)
        await ctx.parallel('agent/created', { agent: agent as never, source: 'restore' as never })
      }
      return { agent: agent as never }
    },
    rename: async ({ sessionId, title }: { sessionId: string; title: string }) => {
      const agent = agents.get(sessionId)
      if (agent) agent.title = title
      const saved = loadPersisted(sessionId)
      if (saved) { saved.title = title; savePersisted(saved) }
    },
    selectModel: async () => {},
    modelCatalog: async () => getCatalog(),
    inspect: async (sessionId: string) => ({
      events: (loadPersisted(sessionId)?.events ?? []) as never[],
    }),
  }

  const sessionPersistence = {
    flush: async () => {},
    open: async (sessionId: string) => {
      const events = loadPersisted(sessionId)?.events ?? []
      return {
        read: async (offset: number, count: number) => ({
          events: events.slice(offset, offset + count),
        }),
        [Symbol.asyncDispose]: async () => {},
      }
    },
  }

  const webServer = {
    host: '127.0.0.1',
    port: options.port,
    register: (route: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => {
      routes.push(route)
      return () => {
        const idx = routes.indexOf(route)
        if (idx >= 0) routes.splice(idx, 1)
      }
    },
  }

  const llm = {
    resolveCallConfig: async (config: { provider: string; model: string; reasoningEffort?: string }) => {
      const catalog = await getCatalog()
      const known = catalog.groups.some(g => g.id === config.provider)
      if (!known && !config.provider.trim()) {
        throw new Error('Model provider is required')
      }
      return config
    },
    resolveModelInfo: async (_provider: string, model: string) => ({
      id: model,
      inputModalities: ['text', 'image'],
    }),
  }

  const services: Record<string, unknown> = {
    agents,
    llm,
    sessionController,
    sessionPersistence,
    workspaceRegistry: { create: async (cwd: string) => ({ id: cwd }) },
    permissionPresets: { set: () => {} },
    subprocess,
    webServer,
    jobs,
    subagents,
  }
  for (const [name, service] of Object.entries(services)) {
    ctx.reflect.provide(name, service)
  }

  const liveTrace = (sessionId: string, cwd: string, events: StandaloneSessionRecord['events']) => {
    const trace = projectLiveTrace(events)
    const captured = events.some(event => {
      const data = event.data as { messageId?: string; toolCallId?: string } | null
      return !!data?.messageId || data?.toolCallId?.startsWith('turn:')
    })
    const provider = loadPersisted(sessionId)?.model?.provider
    if (captured || provider === 'codex' || provider === 'cursor' || provider === 'human') return trace
    // Old hosts may already have a final reply, but no native live-event collector. Its presence must not hide newer disk facts.
    const nativeTrace = readLiveDshTrace(sessionId, cwd)
    return nativeTrace.length ? nativeTrace : trace
  }

  return {
    ctx,
    agents,
    routes,
    getCatalog,
    refreshCatalog,
    listSessions: () => [...agents.values()].map(a => {
      const rec = loadPersisted(a.id)
      const scheduledModel = options.roleModel?.(a.id)
      return {
        id: a.id,
        title: a.title,
        cwd: a.cwd,
        status: a.status,
        model: scheduledModel ?? rec?.model ?? a.options,
        tools: [...a.tools.keys()],
        eventCount: rec?.events.length ?? 0,
      }
    }),
    getSessionDetail: (sessionId: string) => {
      const agent = agents.get(sessionId)
      const rec = loadPersisted(sessionId)
      if (!agent && !rec) return undefined
      const cwd = agent?.cwd ?? rec?.cwd ?? ''
      const scheduledModel = options.roleModel?.(sessionId)
      return {
        id: sessionId,
        title: agent?.title ?? rec?.title ?? sessionId,
        cwd,
        status: agent?.status ?? 'idle',
        model: scheduledModel ?? rec?.model ?? agent?.options ?? (cachedCatalog ?? FALLBACK_CATALOG).default,
        ...(rec?.model ? { lastTurnModel: rec.model } : {}),
        systemPrompt: agent ? [...agent.sections.values()].map(s => s.text({})).join('\n\n') : '',
        tools: agent ? [...agent.tools.values()].map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) : [],
        events: [...(rec?.events ?? [])],
        liveTrace: liveTrace(sessionId, cwd, rec?.events ?? []),
      }
    },
    getSessionEvents: (sessionId: string, after = 0) => {
      const agent = agents.get(sessionId)
      const rec = loadPersisted(sessionId)
      if (!agent && !rec) return undefined
      const events = rec?.events ?? []
      // `after` is the next zero-based offset, not an exclusive event ID. Echo `next` on the following poll.
      const start = Number.isFinite(after) ? Math.max(0, Math.min(Math.floor(after), events.length)) : 0
      return {
        sessionId,
        status: agent?.status ?? 'idle',
        events: events.slice(start).map((event, index) => ({ ...event, seq: start + index })),
        next: events.length,
        liveTrace: liveTrace(sessionId, agent?.cwd ?? rec?.cwd ?? '', events),
      }
    },
    executeSessionTool: async (sessionId: string, toolName: string, args: unknown) => {
      const resolved = await sessionController.resolveAgent(sessionId)
      if ('error' in resolved) throw new Error(resolved.error?.message ?? 'Session not found')
      const agent = agents.get(sessionId)!
      agent.takeStep()
      const tool = agent.tools.get(toolName)
      if (!tool) throw new Error(`Tool ${toolName} is not registered on session ${sessionId}`)
      const toolCallId = `manual:${agent.session.snapshotEvents().length}`
      agent.session.append('tool/call', { tool: toolName, toolCallId, arguments: args })
      try {
        const result = await tool.execute(args, { signal: new AbortController().signal })
        agent.session.append('tool/result', {
          tool: toolName, toolCallId, output: result,
          message: { role: 'assistant', content: [{ type: 'text', text: `[Tool ${toolName}] ${JSON.stringify(result)}` }] },
        })
        return result
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        agent.session.append('tool/result', { tool: toolName, toolCallId, isError: true, output: text,
          message: { role: 'tool', toolCallId, content: [{ type: 'text', text }] } })
        throw err
      }
    },
    appendAssistantReply: async (sessionId: string, text: string, endTurn = true) => {
      const resolved = await sessionController.resolveAgent(sessionId)
      if ('error' in resolved) throw new Error(resolved.error?.message ?? 'Session not found')
      const agent = agents.get(sessionId)!
      agent.takeStep()
      if (text.trim()) {
        agent.session.append('assistant/message', {
          message: { role: 'assistant', content: [{ type: 'text', text }] },
        })
      }
      if (endTurn && agent.status !== 'idle') {
        agent.status = 'idle'
        ctx.emit('agent/status', { agent: agent as never, status: 'idle' } as never)
      }
    },
    clearSession: async (sessionId: string) => {
      const existingAgent = agents.get(sessionId)
      const saved = loadPersisted(sessionId)
      const cwd = existingAgent?.cwd ?? saved?.cwd ?? process.cwd()
      const title = existingAgent?.title ?? saved?.title ?? sessionId
      if (existingAgent) {
        existingAgent.cancel({ kind: 'clear' })
        agents.delete(sessionId)
      }
      persisted.delete(sessionId)
      try { rmSync(sessionFile(sessionId), { force: true }) } catch {}
      try { rmSync(join(tmpdir(), `dsh-turn-session-${encodeURIComponent(sessionId)}`), { recursive: true, force: true }) } catch {}
      await sessionController.create({ sessionId, workspaceId: cwd })
      await sessionController.rename({ sessionId, title })
    },
    pruneSessionEvents: (
      sessionId: string,
      predicate: (event: { type: string; data: unknown; at: string }) => boolean,
    ) => {
      const rec = loadPersisted(sessionId)
      if (!rec) return
      rec.events = rec.events.filter(ev => !predicate(ev))
      savePersisted(rec)
    },
  }
}
