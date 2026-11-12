/**
 * Standalone HTTP server and process entry for `dsh-superagent`.
 * Hosts the full `Runtime`, registers built-in Sources (`panel`, `feishu`, and `github`), serves the bundled React Web Panel,
 * and exposes standalone endpoints (`/orchestrator/standalone/*`) for the Local Panel Source and Session Console.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Runtime } from '../app/runtime.ts'
import { createStandaloneHost } from '../app/standalone-host.ts'
import { SettingsSchema } from '../policy.ts'
import { Store } from '../app/store.ts'
import { feishuKind } from '../sources/feishu.ts'
import { githubKind } from '../sources/github.ts'
import { PANEL_SOURCE, panelKind, panelTrigger } from '../sources/panel.ts'
import { PANEL_MESSAGE_BODY_BYTES, panelContent, panelWireContent, storePanelContent } from '../sources/panel-images.ts'
import { health } from '../sources/host.ts'
import { packagePath } from '../infra/paths.ts'
import { sameOrigin } from '../app/http.ts'
import {
  ASSISTANT_SESSION_ID,
  ASSISTANT_SYSTEM_PROMPT,
  DEFAULT_ASSISTANT_CONTEXT_CONFIG,
  archiveAssistantMessagesToBackupDir,
  buildAssistantBridgeTools,
  buildAssistantSystemPrompt,
  collectPendingQuestions,
  forwardAssistantMessageToEngineering,
  listAndPurgeAssistantChatBackups,
  resolveHandoffStatus,
  restoreAssistantChatBackupFromDir,
  type AssistantContextConfig,
  type AssistantReplyMeta,
  type AssistantReplyToolCall,
  type AssistantStoredMessage,
} from '../app/claw-assistant.ts'
import {
  broadcastGroupPacketToPeers,
  buildNodeCandidateEndpoints,
  createDeviceGroup,
  createGroupInvitation,
  createJoinRequest,
  ensureDeviceIdentity,
  groupMembersToWorkerNodes,
  parseInvitationUri,
  redeemGroupInvitation,
  verifyAndExtractGroupMembers,
  type DeviceGroupPacket,
  type DeviceJoinRequest,
} from '../app/device-group.ts'
import {
  defaultModelProfilesConfig,
  normalizeProfileGroup,
  resolveEffectiveModelProfile,
  type DayModeOverride,
  type ModelProfilesConfig,
} from '../app/model-profiles.ts'
import {
  DEFAULT_MILESTONE_LEAD_DAYS,
  archiveMemoriesToBackupDir,
  buildMemoryPluginTools,
  buildPluginCatalog,
  consolidateMemories,
  defaultMemories,
  evaluateMilestoneCountdown,
  extractDurableMemoryFromUserMessage,
  formatPinnedMemoryPromptSection,
  getUpcomingMilestones,
  listAndPurgeMemoryBackups,
  restoreMemoryBackupFromDir,
  saveMemoryEntry,
  searchMemories,
  type MemoryCategory,
  type MemoryEntry,
  type MilestoneReminderRule,
} from '../app/memory-plugin.ts'
import { autoMergeTicketWorktree, inspectTicketWorktree, mergeTicketWorktree } from '../app/worktree-merge.ts'
import {
  buildLosslessContextTools,
  buildSelfImprovingTools,
  defaultLcmDagState,
  detectUserCorrectionFromMessage,
  formatLosslessDagPromptSection,
  ingestMessagesIntoLcmDag,
  parseBtwSideQuestion,
  recordLearningEvent,
  type LearningEntry,
} from '../app/lossless-and-learning.ts'
import {
  buildBrowserBridgeTools,
  buildDataSqlPluginTools,
  buildProgressCardTools,
  buildToolSearchPluginTools,
  buildWebResearchPluginTools,
  inspectLocalBrowserBridge,
} from '../app/research-and-ux-plugins.ts'
import {
  loadPrivatePack,
  loadRHToolkitDynamicModule,
  type PrivatePackRHToolkitSpec,
} from '../app/private-pack.ts'
import {
  SessionLoopDetector,
  buildModelUsageTools,
  defaultModelUsageState,
  defaultRuntimeGuardStats,
  processToolResultWithGuards,
  recordModelTurnUsage,
} from '../app/runtime-guard-plugin.ts'
import {
  addFeishuMessageReaction,
  buildClawFeedPluginTools,
  buildPersonalSkillsPluginTools,
  executePersonalSkillLocal,
  executePersonalSkillWithRemoteFallback,
  getClawFeedSinkEndpoints,
  getFeishuBridgeRuntimeStatus,
  inspectClawFeedPluginRepo,
  loadStandaloneFeishuCredentials,
  removeFeishuMessageReaction,
  sendFeishuDirectMessage,
  startNativeFeishuDmBridge,
} from '../app/personal-skills.ts'
import {
  defaultLocalNode,
  dispatchTurnToRemoteNode,
  handleIncomingRemoteTurn,
  selectWorkerNode,
  syncRemoteNodeGitBranch,
  type RemoteSyncedFile,
  type RemoteTurnRequestBody,
  type WorkerNodeRecord,
} from '../app/worker-nodes.ts'
import { KV } from '../kv.ts'
import { key, latestReport, threadKey, waitsForPerson, type Ticket } from '../core/index.ts'
import type { PanelMessageReceipt, PanelTopicSummary, PipelineRow } from '../client/standalone-api.ts'

export interface StandaloneServerOptions {
  port?: number
  httpsPort?: number
  tlsCertFile?: string
  tlsKeyFile?: string
  host?: string
  stateDir?: string
  liveAgents?: boolean
  /** Optional custom local driver for testing or custom worker runtimes. */
  driver?: Parameters<typeof createStandaloneHost>[0]['driver']
}

function discoverTailscaleTlsFiles(stateDir: string): { certFile: string; keyFile: string; domain: string } | undefined {
  const packDirs = loadPrivatePack()?.manifest.personalPaths?.tlsCertDirs ?? []
  const candidates = [
    join(stateDir, 'tls'),
    join(homedir() || '.', '.rharness', 'tls'),
    ...packDirs,
  ]
  for (const dir of candidates) {
    if (!existsSync(dir)) continue
    try {
      const files = readdirSync(dir)
      const crt = files.find(f => f.endsWith('.ts.net.crt'))
      if (!crt) continue
      const domain = crt.slice(0, -'.crt'.length)
      const key = `${domain}.key`
      const certFile = join(dir, crt)
      const keyFile = join(dir, key)
      if (existsSync(certFile) && existsSync(keyFile)) {
        return { certFile, keyFile, domain }
      }
    } catch {}
  }
  return undefined
}

async function readJsonBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buf = Buffer.from(chunk)
    size += buf.length
    if (size > maxBytes) throw new Error(`Request exceeds ${maxBytes} bytes`)
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function ticketStateOf(ticket: Ticket | undefined): PanelMessageReceipt['ticketState'] {
  if (!ticket) return 'waiting'
  const rep = latestReport(ticket)
  if (!ticket.ended) return rep?.state === 'waiting' || rep?.state === 'blocked' ? 'waiting' : 'running'
  if (ticket.ended.outcome === 'completed' || ticket.ended.outcome === 'merged') return 'completed'
  if (ticket.ended.outcome === 'stopped') return 'stopped'
  return 'failed'
}

function buildPanelReceiptsAndTopics(rt: Runtime, currentConversation: string): {
  receipts: Record<string, PanelMessageReceipt>
  topics: PanelTopicSummary[]
} {
  const receipts: Record<string, PanelMessageReceipt> = {}
  const currentKey = threadKey({ source: PANEL_SOURCE, id: currentConversation })
  const currentThread = rt.store.threads.get(currentKey)
  const currentDecisions = rt.store.decisions.byThread(currentKey)
  const currentMessages = rt.store.get(KV.panel.messages(currentConversation)) ?? []

  for (const msg of currentMessages) {
    if (msg.bot) continue
    const trigId = key(PANEL_SOURCE, msg.id)
    const disp = rt.store.triggers.disposition(trigId)
    const dec = disp?.decisionId
      ? rt.store.decisions.get(disp.decisionId)
      : currentDecisions.find(d => d.triggerIds.includes(trigId))
    let kind: PanelMessageReceipt['kind'] | undefined
    let ticketId: string | undefined
    if (dec?.ticketId) {
      kind = 'created'
      ticketId = dec.ticketId
    } else if (disp?.fanout.length) {
      kind = 'followup'
      ticketId = disp.fanout[0]
    } else if (currentThread?.evaluating?.triggerIds.includes(trigId)) {
      kind = 'evaluating'
    } else if (currentThread?.pending.includes(trigId)) {
      kind = 'queued'
    } else if (disp?.filtered) {
      kind = 'filtered'
    }
    if (!kind) continue
    const tk = ticketId ? rt.store.tickets.get(ticketId) : undefined
    const rep = tk ? latestReport(tk) : undefined
    const assignedNode = ticketId ? rt.store.get(KV.nodes.ticketNode(ticketId)) : undefined
    const attentionQuestion =
      tk?.attention?.question ??
      (tk && !tk.ended && (rep?.state === 'blocked' || rep?.state === 'failed') && waitsForPerson(tk) ? rep?.summary : undefined)
    receipts[msg.id] = {
      triggerId: trigId,
      kind,
      ...(ticketId ? { ticketId } : {}),
      ...(tk ? {
        ticketTitle: tk.title,
        ticketState: ticketStateOf(tk),
        sessionId: `worker-${tk.id}`,
        ...(tk.execution?.name ? { branch: `agent/${tk.execution.name}` } : {}),
      } : {}),
      ...(assignedNode ? { nodeId: assignedNode.nodeId, nodeName: assignedNode.nodeName } : {}),
      ...(ticketId && disp?.acked?.includes(ticketId) ? { acked: true } : {}),
      ...(rep?.state ? { reportState: rep.state } : {}),
      ...(rep?.summary ? { reportSummary: rep.summary.slice(0, 600) } : {}),
      ...(attentionQuestion ? { attentionQuestion } : {}),
      ...(disp?.handbacks?.[0]?.reason ? { handbackReason: disp.handbacks[0].reason } : {}),
    }
  }

  const convSet = new Set<string>(['main', currentConversation])
  for (const th of rt.store.threads.list()) {
    if (th.ref.source === PANEL_SOURCE && th.ref.id) convSet.add(th.ref.id)
  }
  const topics: PanelTopicSummary[] = []
  for (const conv of convSet) {
    const tKey = threadKey({ source: PANEL_SOURCE, id: conv })
    const th = rt.store.threads.get(tKey)
    const msgs = rt.store.get(KV.panel.messages(conv)) ?? []
    const decs = rt.store.decisions.byThread(tKey)
    const ticketIds = new Set<string>([...(th?.subscriptions ?? []), ...decs.flatMap(d => d.ticketId ? [d.ticketId] : [])])
    const tickets = [...ticketIds].map(id => rt.store.tickets.get(id)).filter((tk): tk is Ticket => !!tk)
    const latestTk = tickets.at(-1)
    const firstHuman = msgs.find(m => !m.bot && m.text.trim())
    const title = latestTk?.title || firstHuman?.text.split('\n')[0]?.slice(0, 38) || (conv === 'main' ? '主工作台对话' : conv)
    const status: PanelTopicSummary['status'] = tickets.some(tk => !tk.ended)
      ? 'running'
      : tickets.some(tk => tk.ended?.outcome === 'completed' || tk.ended?.outcome === 'merged')
        ? 'completed'
        : 'idle'
    const updatedAt = msgs.at(-1)?.at ?? th?.lastAt ?? th?.createdAt ?? ''
    topics.push({
      conversation: conv,
      title,
      messageCount: msgs.length,
      ticketCount: tickets.length,
      status,
      updatedAt,
    })
  }
  topics.sort((a, b) => (a.conversation === 'main' ? -1 : b.conversation === 'main' ? 1 : b.updatedAt.localeCompare(a.updatedAt)))
  return { receipts, topics }
}

function buildPipelineRows(rt: Runtime): PipelineRow[] {
  const triggers = rt.store.read.recentTriggers(0, 40).filter(tr => tr.human).slice(0, 24)
  return triggers.map((tr): PipelineRow => {
    const tKey = threadKey(tr.threads[0]!)
    const th = rt.store.threads.get(tKey)
    const disp = rt.store.triggers.disposition(tr.id)
    const dec = disp?.decisionId
      ? rt.store.decisions.get(disp.decisionId)
      : rt.store.decisions.byThread(tKey).find(d => d.triggerIds.includes(tr.id))
    let intake: PipelineRow['intake']
    if (dec?.kind === 'accept') {
      intake = {
        kind: 'created',
        label: { zh: '明确请求接单', en: 'Accepted as Ticket' },
        detail: { zh: '通过准入策略并创建独立工单', en: 'Admitted and routed to a new Ticket' },
      }
    } else if (disp?.fanout.length) {
      const acked = !!disp.acked?.length
      intake = {
        kind: 'followup',
        label: { zh: '并入运行工单', en: 'Follow-up to Ticket' },
        detail: {
          zh: acked ? '执行器已确认接手 (orchestrator_ack)' : '直接扇出投递至同线程工单',
          en: acked ? 'Acknowledged by Executor (orchestrator_ack)' : 'Fanned out directly to subscribed Ticket',
        },
      }
    } else if (th?.evaluating?.triggerIds.includes(tr.id)) {
      intake = {
        kind: 'evaluating',
        label: { zh: '正在评估', en: 'Evaluating' },
        detail: { zh: '主会话正在研判触发', en: 'Main Session is evaluating this batch' },
      }
    } else if (th?.pending.includes(tr.id)) {
      intake = {
        kind: 'queued',
        label: { zh: '排队待评估', en: 'Queued for Eval' },
        detail: { zh: '等待进入评估批次', en: 'Waiting in thread queue' },
      }
    } else if (disp?.filtered) {
      intake = {
        kind: 'filtered',
        label: { zh: '来源已过滤', en: 'Filtered by Source' },
        detail: { zh: disp.filtered.code, en: disp.filtered.code },
      }
    } else {
      intake = {
        kind: 'ignored',
        label: { zh: dec?.kind ?? '未建单', en: dec?.kind ?? 'Ignored' },
        detail: { zh: dec?.reason[0]?.code ?? '无需建单', en: dec?.reason[0]?.code ?? 'No ticket needed' },
      }
    }

    const ticketId = dec?.ticketId ?? disp?.fanout[0]
    const tk = ticketId ? rt.store.tickets.get(ticketId) : undefined
    const rep = tk ? latestReport(tk) : undefined
    const assignedNode = ticketId ? rt.store.get(KV.nodes.ticketNode(ticketId)) : undefined
    const tState = ticketStateOf(tk)
    const deliveryState: PipelineRow['delivery']['state'] = !tk
      ? 'none'
      : !tk.ended
        ? 'running'
        : tk.ended.outcome === 'completed' || tk.ended.outcome === 'merged'
          ? 'merged'
          : 'completed'

    return {
      triggerId: tr.id,
      source: tr.source,
      threadKey: tKey,
      actor: tr.actor.id || tr.source,
      text: tr.text.replace(/\s+/g, ' ').trim().slice(0, 140),
      at: tr.at,
      intake,
      ...(tk ? {
        ticket: {
          id: tk.id,
          title: tk.title,
          state: tState ?? 'waiting',
          ...(tk.execution?.name ? { branch: `agent/${tk.execution.name}` } : {}),
          sessionId: `worker-${tk.id}`,
          ...(assignedNode ? { nodeId: assignedNode.nodeId, nodeName: assignedNode.nodeName } : {}),
          ...(ticketId && disp?.acked?.includes(ticketId) ? { acked: true } : {}),
        },
      } : {}),
      delivery: {
        state: deliveryState,
        ...(rep?.summary ? { summary: rep.summary.split('\n')[0]?.slice(0, 120) } : {}),
        ...(rep?.at ? { at: rep.at } : tk?.ended?.at ? { at: tk.ended.at } : {}),
      },
    }
  })
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * Cleans up an orphaned `<stateDir>.lock` directory left behind if a previous standalone
 * server process crashed abruptly (verified via dead PID in `standalone.pid`).
 */
export function recoverStaleStateLock(stateDir: string): boolean {
  const resolved = resolve(stateDir)
  const lockDir = `${resolved}.lock`
  const pidFile = join(resolved, 'standalone.pid')
  if (!existsSync(lockDir) || !existsSync(pidFile)) return false
  try {
    const recordedPid = Number(readFileSync(pidFile, 'utf8').trim())
    if (recordedPid && recordedPid !== process.pid && !isProcessAlive(recordedPid)) {
      rmSync(lockDir, { recursive: true, force: true })
      rmSync(pidFile, { force: true })
      return true
    }
  } catch {}
  return false
}

export async function startStandaloneServer(options: StandaloneServerOptions = {}) {
  const port = options.port ?? (Number(process.env.DSH_SUPERAGENT_PORT ?? process.env.PORT ?? 4318) || 4318)
  const stateDir = resolve(options.stateDir ?? process.env.DSH_SUPERAGENT_STATE_DIR ?? '.rharness-dev/superagent')
  const liveAgents = options.liveAgents ?? true
  const privateToolkitMod = await loadRHToolkitDynamicModule()
  mkdirSync(stateDir, { recursive: true })
  recoverStaleStateLock(stateDir)

  // Seed default sources on first run: Panel + Feishu enabled by default, GitHub disabled until configured.
  const dbPath = join(stateDir, 'orchestrator.sqlite')
  const repoRoot = process.cwd().replaceAll('\\', '/')
  const legacyDetachPrepare = `git -C "${repoRoot}" worktree add --detach "$DSH_SUPERAGENT_DIR" HEAD`
  const defaultPrepare = liveAgents && existsSync(join(process.cwd(), '.git'))
    ? `git -C "${repoRoot}" worktree add -B "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" HEAD`
    : ''
  if (!existsSync(dbPath)) {
    const seedStore = new Store(dbPath)
    const initial = seedStore.settings()
    seedStore.saveSettings(SettingsSchema.parse({
      ...initial,
      sources: {
        ...initial.sources,
        [PANEL_SOURCE]: { enabled: true, config: { operatorId: 'operator', operatorName: 'Operator', listenAll: true } },
        feishu: { enabled: true, config: {} },
        github: { enabled: false, config: {} },
      },
      policy: {
        ...initial.policy,
        sources: {
          ...initial.policy.sources,
          [PANEL_SOURCE]: { allowed: [{ id: 'operator', name: 'Operator' }], admission: {} },
        },
      },
      executor: {
        ...initial.executor,
        ...(defaultPrepare ? { prepare: defaultPrepare } : {}),
      },
    }))
    seedStore.close()
  } else if (defaultPrepare) {
    const checkStore = new Store(dbPath)
    const current = checkStore.settings()
    if (!current.executor.prepare.trim() || current.executor.prepare.trim() === legacyDetachPrepare) {
      checkStore.saveSettings(SettingsSchema.parse({
        ...current,
        executor: { ...current.executor, prepare: defaultPrepare },
      }))
    }
    checkStore.close()
  }

  let promptMaxChars = 100_000
  let admissionContextMaxPages = 10
  let admissionContextTimeoutMs = 15_000

  const machine = {
    stateDir,
    promptMaxChars: { get: () => promptMaxChars, set: (v: number) => { promptMaxChars = v } } as never,
    admissionContextMaxPages: { get: () => admissionContextMaxPages, set: (v: number) => { admissionContextMaxPages = v } } as never,
    admissionContextTimeoutMs: { get: () => admissionContextTimeoutMs, set: (v: number) => { admissionContextTimeoutMs = v } } as never,
  }

  let runtime: Runtime
  let actualPort = port
  let actualHttpsPort: number | undefined
  const getDisabledPlugins = (): string[] => {
    if (!runtime) return []
    return runtime.store.get(KV.plugins.state)?.disabledPlugins ?? []
  }

  const isPluginEnabled = (pluginId: string): boolean => !getDisabledPlugins().includes(pluginId)
  const loopDetector = new SessionLoopDetector()

  const getRuntimeGuardStats = () => {
    if (!runtime) return defaultRuntimeGuardStats()
    return runtime.store.get(KV.runtimeGuard.stats) ?? defaultRuntimeGuardStats()
  }

  const getModelUsageState = () => {
    if (!runtime) return defaultModelUsageState()
    return runtime.store.get(KV.modelUsage.state) ?? defaultModelUsageState()
  }

  const getLcmDag = () => {
    if (!runtime) return defaultLcmDagState()
    return runtime.store.get(KV.lossless.dag) ?? defaultLcmDagState()
  }

  const getLearnings = (): LearningEntry[] => {
    if (!runtime) return []
    return runtime.store.get(KV.learnings.items) ?? []
  }

  const setLearnings = (next: LearningEntry[]): void => {
    if (!runtime) return
    runtime.store.set(KV.learnings.items, next)
  }

  const getProgressCards = () => {
    if (!runtime) return {}
    return runtime.store.get(KV.progressCards.bySession) ?? {}
  }

  const setProgressCards = (next: ReturnType<typeof getProgressCards>): void => {
    if (!runtime) return
    runtime.store.set(KV.progressCards.bySession, next)
  }

  const getMemoryEntries = (): MemoryEntry[] => {
    if (!runtime) return defaultMemories()
    const existing = runtime.store.get(KV.memory.items)
    if (!existing) {
      const seeded = defaultMemories()
      runtime.store.set(KV.memory.items, seeded)
      return seeded
    }
    return existing
  }

  const broadcastMemoriesStateToPeers = async (mode: 'merge' | 'replace' = 'merge'): Promise<void> => {
    if (!runtime) return
    const memories = runtime.store.get(KV.memory.items) ?? defaultMemories()
    const peers = getRegisteredNodes().filter(n => n.id !== 'local' && n.status === 'online' && n.url !== 'local')
    await Promise.allSettled(
      peers.map(async peer => {
        const endpoints = [...new Set([...(peer.endpoints ?? []), peer.url])].filter(Boolean)
        for (const ep of endpoints) {
          try {
            const res = await fetch(`${ep.replace(/\/+$/, '')}/orchestrator/standalone/memories/sync`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-orchestrator-request': '1',
              },
              body: JSON.stringify({ mode, memories }),
              signal: AbortSignal.timeout(4000),
            })
            if (res.ok) break
          } catch {}
        }
      }),
    )
  }

  const setMemoryEntries = (next: MemoryEntry[], syncMode: 'merge' | 'replace' | 'none' = 'merge'): void => {
    if (!runtime) return
    runtime.store.set(KV.memory.items, next)
    if (syncMode !== 'none') {
      void broadcastMemoriesStateToPeers(syncMode)
    }
  }

  const getDeviceIdentity = () => {
    const existing = runtime?.store.get(KV.deviceGroup.identity)
    const identity = ensureDeviceIdentity(existing, actualPort)
    if (runtime && (!existing || existing.endpoints.join(',') !== identity.endpoints.join(','))) {
      runtime.store.set(KV.deviceGroup.identity, identity)
    }
    return identity
  }

  const getRegisteredNodes = (): WorkerNodeRecord[] => {
    const local = defaultLocalNode(actualPort)
    if (!runtime) return [local]
    const identity = getDeviceIdentity()
    local.tags = identity.tags
    const saved = runtime.store.get(KV.nodes.registry) ?? []
    const groupPacket = runtime.store.get(KV.deviceGroup.packet)
    const merged = groupMembersToWorkerNodes(identity.deviceId, groupPacket, saved)
    return [local, ...merged.filter(n => n.id !== 'local')]
  }

  const resolveActiveRoleModels = () => {
    const s = runtime.store.settings()
    const fallback = { eval: s.eval.model, executor: s.executor.model }
    const savedProfiles = runtime.store.get(KV.modelProfiles.config)
    const defaults = defaultModelProfilesConfig(fallback)
    if (!savedProfiles) {
      const resolved = resolveEffectiveModelProfile(defaults, fallback)
      return {
        assistant: resolved.assistantModel,
        eval: s.eval.model,
        executor: s.executor.model,
        profilesState: {
          config: defaults,
          ...resolved,
        },
      }
    }
    const normalizedConfig: ModelProfilesConfig = {
      activeProfileId: savedProfiles.activeProfileId || 'profile-1',
      ...(savedProfiles.dayModeOverride ? { dayModeOverride: savedProfiles.dayModeOverride } : {}),
      ...(savedProfiles.customHolidays ? { customHolidays: savedProfiles.customHolidays } : {}),
      ...(savedProfiles.customWorkdays ? { customWorkdays: savedProfiles.customWorkdays } : {}),
      profiles: (savedProfiles.profiles?.length ? savedProfiles.profiles : defaults.profiles).map(p =>
        normalizeProfileGroup(p, defaults.profiles[0]!.eval.defaultModel, defaults.profiles[0]!.executor.defaultModel),
      ),
    }
    const resolved = resolveEffectiveModelProfile(normalizedConfig, fallback)
    return {
      assistant: resolved.assistantModel,
      eval: resolved.evalModel,
      executor: resolved.executorModel,
      profilesState: {
        config: normalizedConfig,
        ...resolved,
      },
    }
  }

  const getAssistantContextConfig = (): AssistantContextConfig => {
    if (!runtime) return DEFAULT_ASSISTANT_CONTEXT_CONFIG
    return runtime.store.get(KV.assistant.contextConfig) ?? DEFAULT_ASSISTANT_CONTEXT_CONFIG
  }

  const host = createStandaloneHost({
    stateDir,
    port,
    liveAgents,
    roleModel: sessionId => {
      if (!runtime) return undefined
      const savedProfiles = runtime.store.get(KV.modelProfiles.config)
      if (!savedProfiles) {
        const s = runtime.store.settings()
        return sessionId === runtime.masterId || sessionId === ASSISTANT_SESSION_ID ? s.eval.model : s.executor.model
      }
      const active = resolveActiveRoleModels()
      if (sessionId === ASSISTANT_SESSION_ID) return active.assistant
      if (sessionId === runtime.masterId) return active.eval
      return active.executor
    },
    eventWindowFilter: (sessionId, events) => {
      if (sessionId !== ASSISTANT_SESSION_ID || !runtime || events.length <= 1) return events
      const cfg = getAssistantContextConfig()
      const lcmCfg = runtime.store.get(KV.plugins.config('dsh-lossless-context')) ?? {}
      const limit = Number.isFinite(Number(lcmCfg.freshTailCount))
        ? Math.max(0, Number(lcmCfg.freshTailCount))
        : cfg.recentMessagesLimit
      let sliceStart = 0
      if (cfg.contextResetAt) {
        const resetIdx = events.findIndex(e => e.at >= cfg.contextResetAt!)
        sliceStart = resetIdx >= 0 ? resetIdx : events.length - 1
      }
      if (limit > 0) {
        let msgCount = 0
        for (let i = events.length - 1; i >= sliceStart; i--) {
          const t = events[i]!.type
          if (t === 'user/message' || t === 'assistant/message') {
            msgCount++
            if (msgCount >= limit) {
              sliceStart = Math.max(sliceStart, i)
              break
            }
          }
        }
      }
      return events.slice(sliceStart)
    },
    driver: async req => {
      const turnStartMs = Date.now()
      const roleForUsage: 'assistant' | 'eval' | 'worker' =
        req.sessionId === ASSISTANT_SESSION_ID
          ? 'assistant'
          : req.sessionId.startsWith('worker-')
            ? 'worker'
            : 'eval'
      loopDetector.resetSession(req.sessionId)

      // Wrap tools for Assistant & Worker sessions with Runtime Guardrails (Loop Detection + Anti-Injection + Tokenjuice)
      const guardedTools = new Map(req.tools)
      if (roleForUsage !== 'eval' && isPluginEnabled('dsh-runtime-guard')) {
        const externalTools = new Set([
          'email_check',
          'email_read',
          'web_readability',
          'research_search',
          'siyuan_search',
          'siyuan_read',
          'clawfeed_recent',
        ])
        const guardCfg = runtime?.store.get(KV.plugins.config('dsh-runtime-guard')) ?? {}
        const maxRepeats = Math.max(2, Math.min(8, Number(guardCfg.maxIdenticalToolRepeats ?? 3)))
        const maxChars = Math.max(1500, Math.min(40000, Number(guardCfg.tokenjuiceMaxChars ?? 10000)))

        for (const [tName, spec] of req.tools.entries()) {
          guardedTools.set(tName, {
            ...spec,
            execute: async (args: unknown, execCtx: { signal: AbortSignal }) => {
              const check = loopDetector.checkBeforeCall(req.sessionId, tName, args, maxRepeats)
              if (check.blocked) {
                if (runtime) {
                  const st = getRuntimeGuardStats()
                  st.loopsBroken++
                  st.recentEvents.unshift({
                    id: `grd-${Date.now()}`,
                    kind: 'loop-breaker',
                    sessionId: req.sessionId,
                    toolName: tName,
                    detail: `拦截连续重复调用 (${tName})`,
                    at: new Date().toISOString(),
                  })
                  st.recentEvents = st.recentEvents.slice(0, 30)
                  runtime.store.set(KV.runtimeGuard.stats, st)
                }
                return { ok: false, blockedByLoopGuard: true, error: check.reason }
              }
              try {
                const rawOut = await spec.execute(args, execCtx)
                loopDetector.recordOutcome(req.sessionId, check.signature, rawOut)
                const processed = processToolResultWithGuards(rawOut, {
                  enableTokenjuice: guardCfg.enableTokenjuice !== false,
                  enableAntiInjection: guardCfg.enableAntiInjection !== false,
                  maxStringChars: maxChars,
                  isExternalSourceTool: externalTools.has(tName),
                })
                if (runtime && (processed.compacted || processed.injectionsDetected > 0)) {
                  const st = getRuntimeGuardStats()
                  if (processed.compacted) {
                    st.compactedCalls++
                    st.compactedCharsTotal += processed.savedChars
                    st.estimatedTokensSaved += Math.max(1, Math.ceil(processed.savedChars * 0.3))
                    st.recentEvents.unshift({
                      id: `grd-${Date.now()}-tj`,
                      kind: 'tokenjuice',
                      sessionId: req.sessionId,
                      toolName: tName,
                      detail: `脱水压缩节省 ${processed.savedChars} 字符`,
                      at: new Date().toISOString(),
                    })
                  }
                  if (processed.injectionsDetected > 0) {
                    st.injectionsNeutralized += processed.injectionsDetected
                    st.recentEvents.unshift({
                      id: `grd-${Date.now()}-ai`,
                      kind: 'anti-injection',
                      sessionId: req.sessionId,
                      toolName: tName,
                      detail: `净化 ${processed.injectionsDetected} 处可疑注入 (${processed.injectionLabels.join(',')})`,
                      at: new Date().toISOString(),
                    })
                  }
                  st.recentEvents = st.recentEvents.slice(0, 30)
                  runtime.store.set(KV.runtimeGuard.stats, st)
                }
                return processed.result
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err)
                loopDetector.recordOutcome(req.sessionId, check.signature, { error: errMsg })
                if (runtime && isPluginEnabled('dsh-self-improving')) {
                  const rec = recordLearningEvent(getLearnings(), {
                    kind: 'tool_error',
                    title: `工具异常 (${tName})`,
                    detail: errMsg.slice(0, 400),
                    suggestedRule: `调用 ${tName} 时注意参数与前置条件：${errMsg.slice(0, 120)}`,
                    sourceSessionId: req.sessionId,
                  })
                  setLearnings(rec.list)
                }
                throw err
              }
            },
          })
        }
      }

      const recordUsageAfterTurn = (replyText: string) => {
        if (!runtime || !isPluginEnabled('dsh-model-usage')) return
        const inputChars =
          req.systemPrompt.length +
          req.messages.reduce(
            (sum, m) => sum + m.content.reduce((s2, p) => s2 + (typeof p.text === 'string' ? p.text.length : 200), 0),
            0,
          )
        const nextUsage = recordModelTurnUsage(getModelUsageState(), {
          provider: req.provider,
          model: req.model,
          role: roleForUsage,
          inputChars,
          outputChars: replyText.length,
          durationMs: Date.now() - turnStartMs,
        })
        runtime.store.set(KV.modelUsage.state, nextUsage)
      }

      const effectiveReq = { ...req, tools: guardedTools }

      if (runtime && effectiveReq.sessionId.startsWith('worker-')) {
        const ticketId = effectiveReq.sessionId.slice('worker-'.length)
        const ticket = runtime.store.tickets.get(ticketId)
        const nodes = getRegisteredNodes()
        let assigned = runtime.store.get(KV.nodes.ticketNode(ticketId))
        if (!assigned) {
          const originText = ticket ? (runtime.store.triggers.get(ticket.origin.triggerId)?.text ?? ticket.title) : ''
          const chosen = selectWorkerNode(nodes, undefined, originText)
          assigned = {
            nodeId: chosen.id,
            nodeName: chosen.name,
            ...(chosen.gitUrl ? { gitSource: chosen.gitUrl } : {}),
          }
          runtime.store.set(KV.nodes.ticketNode(ticketId), assigned)
        }
        const targetNode = nodes.find(n => n.id === assigned.nodeId && n.status === 'online' && n.url !== 'local' && n.url !== '')
        if (targetNode) {
          const hubIdentity = getDeviceIdentity()
          const hubEndpoints = listenHost === '0.0.0.0'
            ? [...new Set([...(hubIdentity.endpoints ?? []), `http://127.0.0.1:${actualPort}`])]
            : [`http://127.0.0.1:${actualPort}`]
          const remoteRes = await dispatchTurnToRemoteNode({
            node: targetNode,
            hubUrl: hubEndpoints[0] ?? `http://127.0.0.1:${actualPort}`,
            hubEndpoints,
            sessionId: effectiveReq.sessionId,
            ticketId,
            ...(ticket?.execution?.name ? { worktreeName: ticket.execution.name } : {}),
            provider: effectiveReq.provider,
            model: effectiveReq.model,
            ...(effectiveReq.reasoningEffort ? { reasoningEffort: effectiveReq.reasoningEffort } : {}),
            systemPrompt: effectiveReq.systemPrompt,
            messages: effectiveReq.messages,
            tools: effectiveReq.tools,
            signal: effectiveReq.signal,
            onEvent: effectiveReq.onEvent,
            onToolResult: effectiveReq.onToolResult,
          })
            const gitSource = remoteRes.worktreeDir || remoteRes.repoRoot || targetNode.gitUrl || targetNode.url
            if (gitSource && remoteRes.branch) {
              const synced = syncRemoteNodeGitBranch({
                hubRepoRoot: process.cwd(),
                remoteGitSource: gitSource,
                branch: remoteRes.branch,
                ...(ticket?.title ? { title: ticket.title } : {}),
                ...(remoteRes.gitBundleB64 ? { gitBundleB64: remoteRes.gitBundleB64 } : {}),
                ...(ticket?.execution?.directory ? { localWorktreeDir: ticket.execution.directory } : {}),
                ...(remoteRes.syncedFiles ? { syncedFiles: remoteRes.syncedFiles } : {}),
              })
              runtime.store.set(KV.nodes.ticketNode(ticketId), {
                ...assigned,
                gitSource,
                branch: remoteRes.branch,
                synced: synced.merged,
              })
            }
          recordUsageAfterTurn(remoteRes.replyText)
          return remoteRes.replyText
        }
      }
      if (options.driver) {
        const out = (await options.driver(effectiveReq)) ?? ''
        recordUsageAfterTurn(out)
        return out
      }
      if (!liveAgents) {
        return await new Promise<string>(() => {})
      }
      const { onToolResult: _onToolResult, ...nativeRequest } = effectiveReq
      const { runCodexTurn, runCursorTurn, runDshTurn } = await import('../app/local-drivers.ts')
      const out =
        effectiveReq.provider === 'codex'
          ? await runCodexTurn(nativeRequest)
          : effectiveReq.provider === 'cursor'
            ? await runCursorTurn(nativeRequest)
            : await runDshTurn(nativeRequest)
      recordUsageAfterTurn(out)
      return out
    },
  })
  if (liveAgents) {
    void host.getCatalog().catch(() => {})
  }
  const tryAutoMergeTicket = (sessionId: string) => {
    try {
      if (!runtime || runtime.lifetime.aborted || !sessionId.startsWith('worker-')) return
      if (!isPluginEnabled('dsh-worktree-merge')) return
      const ticketId = sessionId.slice('worker-'.length)
      const ticket = runtime.store.tickets.get(ticketId)
      if (!ticket?.execution?.directory) return
      const reportState = ticket.assignments.at(-1)?.report?.state
      if (reportState === 'ready' || reportState === 'waiting') {
        autoMergeTicketWorktree(process.cwd(), ticket.execution.directory, { title: ticket.title })
      }
    } catch {}
  }
  const buildAssistantReplyMeta = (
    turnNumber?: number,
    explicitModel?: { provider: string; model: string; reasoningEffort?: string },
    replyTextMatch?: string,
  ): AssistantReplyMeta => {
    const active = resolveActiveRoleModels()
    const detail = host.getSessionDetail(ASSISTANT_SESSION_ID)
    const allEvents = detail?.events ?? []

    // Locate the exact `assistant/message` event ending this turn
    let endIdx = -1
    let targetTurn = turnNumber
    for (let i = allEvents.length - 1; i >= 0; i--) {
      const ev = allEvents[i]!
      if (ev.type !== 'assistant/message') continue
      const d = (ev.data ?? {}) as { turn?: number; message?: { content?: { type?: string; text?: string }[] } }
      const txt = (d.message?.content ?? []).map(p => p.text ?? '').join('').trim()
      if (targetTurn !== undefined && d.turn === targetTurn) {
        endIdx = i
        break
      }
      if (targetTurn === undefined && replyTextMatch && (txt === replyTextMatch || replyTextMatch.endsWith(txt))) {
        endIdx = i
        targetTurn = d.turn
        break
      }
    }

    // Walk backwards from `endIdx` to the `user/message` that started this turn so events from later turns never leak in
    let startIdx = Math.max(0, allEvents.length - 8)
    if (endIdx >= 0) {
      startIdx = 0
      for (let i = endIdx - 1; i >= 0; i--) {
        if (allEvents[i]!.type === 'user/message') {
          startIdx = i
          break
        }
        if (allEvents[i]!.type === 'assistant/message') {
          startIdx = i + 1
          break
        }
      }
    }
    const turnEvents = endIdx >= 0 ? allEvents.slice(startIdx, endIdx + 1) : allEvents.slice(-8)

    const toolCallsMap = new Map<string, AssistantReplyToolCall>()
    for (const ev of turnEvents) {
      const d = (ev.data ?? {}) as { tool?: string; name?: string; toolCallId?: string; arguments?: unknown; output?: unknown; isError?: boolean }
      if (ev.type === 'tool/call') {
        const keyId = d.toolCallId ?? `${d.tool ?? d.name ?? 'tool'}-${toolCallsMap.size}`
        toolCallsMap.set(keyId, {
          name: String(d.tool ?? d.name ?? 'tool'),
          args: d.arguments,
          at: ev.at,
        })
      } else if (ev.type === 'tool/result') {
        const keyId = d.toolCallId ?? ''
        const existing = toolCallsMap.get(keyId)
        if (existing) {
          existing.output = d.output
          if (d.isError) existing.isError = true
        } else {
          toolCallsMap.set(`res-${toolCallsMap.size}`, {
            name: String(d.tool ?? d.name ?? 'tool'),
            output: d.output,
            ...(d.isError ? { isError: true } : {}),
            at: ev.at,
          })
        }
      }
    }

    let durationMs: number | undefined
    if (turnEvents.length >= 2) {
      const t0 = Date.parse(turnEvents[0]!.at)
      const t1 = Date.parse(turnEvents.at(-1)!.at)
      if (Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) {
        durationMs = t1 - t0
      }
    }

    const matchedSlot = active.profilesState.matchedAssistantSlot
    const eventRecordedModel = [...turnEvents]
      .reverse()
      .map(ev => (ev.data as { model?: { provider: string; model: string; reasoningEffort?: string } } | undefined)?.model)
      .find(m => m && typeof m.provider === 'string' && typeof m.model === 'string')

    const resolvedModel = explicitModel ?? eventRecordedModel ?? active.assistant ?? {
      provider: 'default',
      model: 'default',
    }

    return {
      model: resolvedModel,
      ...(matchedSlot && explicitModel ? {
        matchedSlot: {
          label: matchedSlot.label,
          startTime: matchedSlot.startTime,
          endTime: matchedSlot.endTime,
          ...(matchedSlot.dayType ? { dayType: matchedSlot.dayType } : {}),
        },
      } : {}),
      ...(targetTurn !== undefined ? { turn: targetTurn } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(toolCallsMap.size > 0 ? { toolCalls: [...toolCallsMap.values()] } : {}),
      events: turnEvents,
    }
  }

  const enrichAssistantMessage = (m: AssistantStoredMessage): AssistantStoredMessage => {
    const withHandoff = m.handoff ? { ...m, handoff: resolveHandoffStatus(runtime, m.handoff) } : m
    if (withHandoff.bot && (!withHandoff.replyMeta || (withHandoff.replyMeta.durationMs ?? 0) > 300_000)) {
      const computed = buildAssistantReplyMeta(withHandoff.replyMeta?.turn, undefined, withHandoff.text)
      const updated = { ...withHandoff, replyMeta: computed }
      // Persist the backfilled replyMeta once so later turns never overwrite historical messages
      const storedList = runtime.store.get(KV.assistant.messages) ?? []
      const idx = storedList.findIndex(item => item.id === m.id)
      if (idx >= 0) {
        storedList[idx] = { ...storedList[idx]!, replyMeta: computed }
        runtime.store.set(KV.assistant.messages, storedList)
      }
      return updated
    }
    return withHandoff
  }

  const pendingFeishuDmQueue: { messageId: string; reactionId?: string }[] = []

  const broadcastAssistantStateToPeers = async (mode: 'merge' | 'replace' = 'merge'): Promise<void> => {
    if (!runtime) return
    const messages = runtime.store.get(KV.assistant.messages) ?? []
    const contextConfig = getAssistantContextConfig()
    const peers = getRegisteredNodes().filter(n => n.id !== 'local' && n.status === 'online' && n.url !== 'local')
    await Promise.allSettled(
      peers.map(async peer => {
        const endpoints = [...new Set([...(peer.endpoints ?? []), peer.url])].filter(Boolean)
        for (const ep of endpoints) {
          try {
            const res = await fetch(`${ep.replace(/\/+$/, '')}/orchestrator/standalone/assistant/sync`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-orchestrator-request': '1',
              },
              body: JSON.stringify({ mode, messages, contextConfig }),
              signal: AbortSignal.timeout(4000),
            })
            if (res.ok) break
          } catch {}
        }
      }),
    )
  }

  const broadcastClawFeedStateToPeers = async (mode: 'merge' | 'replace' = 'merge'): Promise<void> => {
    if (!runtime) return
    const items = runtime.store.get(KV.clawfeed.items) ?? []
    const peers = getRegisteredNodes().filter(n => n.id !== 'local' && n.status === 'online' && n.url !== 'local')
    await Promise.allSettled(
      peers.map(async peer => {
        const endpoints = [...new Set([...(peer.endpoints ?? []), peer.url])].filter(Boolean)
        for (const ep of endpoints) {
          try {
            const res = await fetch(`${ep.replace(/\/+$/, '')}/orchestrator/standalone/clawfeed/sync`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-orchestrator-request': '1',
              },
              body: JSON.stringify({ mode, items }),
              signal: AbortSignal.timeout(4000),
            })
            if (res.ok) break
          } catch {}
        }
      }),
    )
  }

  host.ctx.on('session/event' as never, ((session: { id: string }, event: { type: string; data?: { turn?: number; model?: { provider: string; model: string; reasoningEffort?: string }; tool?: string; name?: string; message?: { content?: { type: string; text?: string }[] } } }) => {
    if (event.type === 'tool/result' && (event.data?.tool === 'orchestrator_report' || event.data?.name === 'orchestrator_report')) {
      tryAutoMergeTicket(session.id)
    }
    if (session.id === ASSISTANT_SESSION_ID && event.type === 'assistant/message' && runtime) {
      const text = (event.data?.message?.content ?? [])
        .map(part => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
        .join('')
        .trim()
      if (text) {
        const list = runtime.store.get(KV.assistant.messages) ?? []
        const replyMeta = buildAssistantReplyMeta(event.data?.turn, event.data?.model, text)
        list.push({
          id: `asst-reply-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          sender: 'claw-assistant',
          bot: true,
          text,
          at: new Date().toISOString(),
          replyMeta,
        })
        runtime.store.set(KV.assistant.messages, list)
        void broadcastAssistantStateToPeers('merge')
        const pendingFeishu = pendingFeishuDmQueue.shift()
        if (pendingFeishu) {
          void (async () => {
            try {
              await sendFeishuDirectMessage(text)
            } finally {
              if (pendingFeishu.reactionId) {
                await removeFeishuMessageReaction(pendingFeishu.messageId, pendingFeishu.reactionId)
              }
            }
          })()
        }
      }
    }
  }) as never)
  host.ctx.on('agent/status' as never, (({ agent, status }: { agent: { id: string }; status: string }) => {
    if (status === 'idle' && agent.id.startsWith('worker-')) {
      setTimeout(() => tryAutoMergeTicket(agent.id), 120)
    }
    if (status === 'idle' && agent.id === ASSISTANT_SESSION_ID) {
      void broadcastAssistantStateToPeers('merge')
      void broadcastMemoriesStateToPeers('merge')
      setTimeout(() => {
        while (pendingFeishuDmQueue.length > 0) {
          const item = pendingFeishuDmQueue.shift()!
          if (item.reactionId) {
            void removeFeishuMessageReaction(item.messageId, item.reactionId)
          }
        }
      }, 400)
    }
  }) as never)

  // Mount first-class plugins onto Agent Sessions while keeping Engineering Eval (`orchestrator-*`) 100% pure
  host.ctx.on('agent/created' as never, (({ agent }: { agent: { id: string; ctx: { tools?: { register: (t: unknown) => void }; systemPrompt?: { section: (s: unknown) => void } } } }) => {
    const isAssistant = agent.id === ASSISTANT_SESSION_ID
    const isWorker = agent.id.startsWith('worker-')
    // Never pollute the Engineering Eval (`orchestrator-*`) session with personal assistant or memory tools
    if (!isAssistant && !isWorker) return

    if (isAssistant) {
      agent.ctx.systemPrompt?.section({
        name: 'rharness-claw-assistant-persona',
        text: () => buildAssistantSystemPrompt(),
      })
      for (const bridgeTool of buildAssistantBridgeTools(() => runtime)) {
        agent.ctx.tools?.register(bridgeTool)
      }
    }

    const role: 'assistant' | 'worker' = isAssistant ? 'assistant' : 'worker'
    const readChatArchive = () => {
      if (!runtime) return []
      const all = runtime.store.get(KV.assistant.messages) ?? []
      return all.map(m => ({
        id: m.id,
        sender: m.sender,
        ...(m.bot ? { bot: true } : {}),
        text: m.text,
        at: m.at,
        ...(m.content?.some(c => c.type === 'image') ? { hasImages: true } : {}),
      }))
    }
    const memTools = buildMemoryPluginTools(
      getMemoryEntries,
      setMemoryEntries,
      role,
      readChatArchive,
      removed => { archiveMemoriesToBackupDir(stateDir, removed, 'single-delete') },
    )
    for (const t of memTools) {
      agent.ctx.tools?.register({
        ...t,
        execute: async (args: unknown, exec: { signal: AbortSignal }) => {
          if (!isPluginEnabled('dsh-memory')) {
            throw new Error('The Long-Term Memory plugin (dsh-memory) is currently disabled')
          }
          return await t.execute(args, exec)
        },
      })
    }
    const personalSkillTools = buildPersonalSkillsPluginTools(
      getRegisteredNodes,
      () => isPluginEnabled('dsh-personal-skills'),
    )
    for (const pst of personalSkillTools) {
      agent.ctx.tools?.register(pst)
    }
    const clawFeedTools = buildClawFeedPluginTools({
      readItems: () => (runtime ? (runtime.store.get(KV.clawfeed.items) ?? []) : []),
      getNodes: getRegisteredNodes,
      isEnabled: () => isPluginEnabled('dsh-clawfeed'),
    })
    for (const cft of clawFeedTools) {
      agent.ctx.tools?.register(cft)
    }

    // Mount absorbed OpenClaw & Community Top Plugins (Model Usage, Lossless DAG, Self-Improving, Web Research, Browser Bridge, Progress Card, Data SQL, Tool Search)
    const sessionToolRegistry = new Map<string, ReturnType<typeof buildModelUsageTools>[0]>()
    const registerWithMirror = (spec: ReturnType<typeof buildModelUsageTools>[0]) => {
      sessionToolRegistry.set(spec.name, spec)
      agent.ctx.tools?.register(spec)
    }
    for (const mt of memTools) sessionToolRegistry.set(mt.name, mt)
    for (const pst of personalSkillTools) sessionToolRegistry.set(pst.name, pst)
    for (const cft of clawFeedTools) sessionToolRegistry.set(cft.name, cft)

    for (const ut of buildModelUsageTools(getModelUsageState, getRuntimeGuardStats, () => isPluginEnabled('dsh-model-usage'))) {
      registerWithMirror(ut)
    }
    for (const lt of buildLosslessContextTools(getLcmDag, readChatArchive, () => isPluginEnabled('dsh-lossless-context'))) {
      registerWithMirror(lt)
    }
    for (const sit of buildSelfImprovingTools({
      readLearnings: getLearnings,
      writeLearnings: setLearnings,
      promoteToMemory: learning => {
        const saved = saveMemoryEntry(getMemoryEntries(), {
          title: learning.title,
          content: learning.suggestedRule,
          category: 'preference',
          tags: ['self-improving', learning.kind],
          pinned: true,
          source: role,
        })
        setMemoryEntries(saved.list)
        return saved.entry
      },
      isEnabled: () => isPluginEnabled('dsh-self-improving'),
    })) {
      registerWithMirror(sit)
    }
    for (const wrt of buildWebResearchPluginTools(
      () => (runtime ? (runtime.store.get(KV.plugins.config('dsh-web-research')) ?? {}) : {}),
      () => isPluginEnabled('dsh-web-research'),
    )) {
      registerWithMirror(wrt)
    }
    for (const bbt of buildBrowserBridgeTools(getRegisteredNodes, () => isPluginEnabled('dsh-browser-bridge'))) {
      registerWithMirror(bbt)
    }
    for (const pct of buildProgressCardTools({
      sessionId: agent.id,
      readCards: getProgressCards,
      writeCards: setProgressCards,
      isEnabled: () => isPluginEnabled('dsh-progress-card'),
    })) {
      registerWithMirror(pct)
    }
    for (const dst of buildDataSqlPluginTools(() => isPluginEnabled('dsh-data-sql'))) {
      registerWithMirror(dst)
    }
    if (privateToolkitMod) {
      for (const rkt of privateToolkitMod.buildRHToolkitPluginTools(
        () => {
          const packDefaults = loadPrivatePack()?.manifest.rhtoolkit ?? {}
          const saved = runtime ? (runtime.store.get(KV.plugins.config('dsh-rhtoolkit')) ?? {}) : {}
          return { ...packDefaults, ...saved }
        },
        () => isPluginEnabled('dsh-rhtoolkit'),
      )) {
        registerWithMirror(rkt)
      }
    }
    for (const tst of buildToolSearchPluginTools(() => sessionToolRegistry, () => isPluginEnabled('dsh-tool-search'))) {
      registerWithMirror(tst)
    }

    agent.ctx.systemPrompt?.section({
      name: 'rharness-lossless-dag',
      text: () => {
        if (!isAssistant || !runtime || !isPluginEnabled('dsh-lossless-context')) return ''
        const allMsgs = runtime.store.get(KV.assistant.messages) ?? []
        const lcmCfg = runtime.store.get(KV.plugins.config('dsh-lossless-context')) ?? {}
        const freshTail = Number(lcmCfg.freshTailCount ?? getAssistantContextConfig().recentMessagesLimit ?? 6)
        const chunkSz = Math.max(2, Number(lcmCfg.chunkSize ?? 6))
        const updatedDag = ingestMessagesIntoLcmDag(getLcmDag(), allMsgs, freshTail, chunkSz)
        if (updatedDag.nodes.length !== getLcmDag().nodes.length) {
          runtime.store.set(KV.lossless.dag, updatedDag)
        }
        return formatLosslessDagPromptSection(updatedDag)
      },
    })
    agent.ctx.systemPrompt?.section({
      name: 'rharness-long-term-memory',
      text: () => {
        if (!isPluginEnabled('dsh-memory')) return ''
        if (!isAssistant || !runtime) {
          return formatPinnedMemoryPromptSection(getMemoryEntries())
        }
        const cfg = getAssistantContextConfig()
        const lcmCfg = runtime.store.get(KV.plugins.config('dsh-lossless-context')) ?? {}
        const effectiveTail = Number.isFinite(Number(lcmCfg.freshTailCount))
          ? Math.max(0, Number(lcmCfg.freshTailCount))
          : cfg.recentMessagesLimit
        const allMsgs = runtime.store.get(KV.assistant.messages) ?? []
        const latestUserMsg = [...allMsgs].reverse().find(m => !m.bot && m.text.trim())
        const afterReset = cfg.contextResetAt ? allMsgs.filter(m => m.at >= cfg.contextResetAt!) : allMsgs
        const activeCount = effectiveTail > 0 ? Math.min(afterReset.length, effectiveTail) : afterReset.length
        const archivedCount = Math.max(0, allMsgs.length - activeCount)
        return formatPinnedMemoryPromptSection(getMemoryEntries(), {
          archivedCount,
          totalCount: allMsgs.length,
          recentLimit: effectiveTail,
          ...(cfg.contextResetAt ? { contextResetAt: cfg.contextResetAt } : {}),
          ...(latestUserMsg?.text ? { latestUserQuery: latestUserMsg.text } : {}),
        })
      },
    })
  }) as never)

  runtime = new Runtime(host.ctx, machine, () => { void restartRuntime() })

  const runEphemeralBtwSideQuestion = async (question: string): Promise<string> => {
    const activeModels = resolveActiveRoleModels()
    const sel = activeModels.assistant ?? activeModels.eval
    const allMsgs = runtime?.store.get(KV.assistant.messages) ?? []
    const contextSnapshot = allMsgs
      .slice(-8)
      .map(m => `${m.bot ? 'Assistant' : 'User'}: ${m.text.slice(0, 500)}`)
      .join('\n\n')

    const sys = [
      buildAssistantSystemPrompt(),
      '## Ephemeral Side Question Mode (`/btw`)',
      'The user is asking a quick ephemeral side question (`/btw`). Answer ONLY this side question concisely based on the conversation snapshot below. This question and your answer are NOT added to the main conversation history.',
      contextSnapshot ? `### Recent Conversation Snapshot\n${contextSnapshot}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')

    const reqObj = {
      sessionId: `btw-${Date.now()}`,
      provider: sel.provider,
      model: sel.model,
      ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}),
      cwd: process.cwd(),
      systemPrompt: sys,
      messages: [
        {
          id: `btw-u-${Date.now()}`,
          role: 'user' as const,
          content: [{ type: 'text' as const, text: question }],
        },
      ],
      tools: new Map(),
      signal: AbortSignal.timeout(45_000),
      onEvent: () => {},
      onToolResult: () => {},
    }
    if (options.driver) return (await options.driver(reqObj)) ?? ''
    if (!liveAgents) return `[BTW Side Answer] ${question}`
    const { runCodexTurn, runCursorTurn, runDshTurn } = await import('../app/local-drivers.ts')
    if (sel.provider === 'codex') return await runCodexTurn(reqObj)
    if (sel.provider === 'cursor') return await runCursorTurn(reqObj)
    return await runDshTurn(reqObj)
  }

  const registerSources = (rt: Runtime) => {
    rt.sources.register(panelKind)
    rt.sources.register(feishuKind)
    rt.sources.register(githubKind)
    const panelCtx = rt.context(panelKind)
    panelCtx.report('panel', health('ready', 'panelReady'))
    if (loadStandaloneFeishuCredentials()) {
      const fCtx = rt.context(feishuKind)
      fCtx.report('feishu', { state: 'ready', detail: 'Native Feishu DM & REST Bridge ready (feishu.json)', at: new Date().toISOString() })
      startNativeFeishuDmBridge({
        signal: rt.lifetime,
        isEnabled: () => isPluginEnabled('dsh-personal-skills') && isPluginEnabled('dsh-claw-assistant'),
        onOwnerMessage: async ({ messageId, text, createTimeMs, reactionId }) => {
          const parsedBtw = parseBtwSideQuestion(text)
          if (parsedBtw.isBtw && isPluginEnabled('dsh-self-improving')) {
            const sideAnswer = await runEphemeralBtwSideQuestion(parsedBtw.question)
            return `💡 **[/btw 旁路快问 · 不计入对话历史]**\n\n${sideAnswer}`
          }

          const msgId = `asst-feishu-${messageId}`
          const at = new Date(createTimeMs).toISOString()
          const list = rt.store.get(KV.assistant.messages) ?? []
          if (list.some(m => m.id === msgId)) {
            if (reactionId) void removeFeishuMessageReaction(messageId, reactionId)
            return undefined
          }
          list.push({
            id: msgId,
            sender: 'operator',
            text: `📱 [飞书私聊] ${text}`,
            at,
          })
          rt.store.set(KV.assistant.messages, list)
          void broadcastAssistantStateToPeers('merge')

          if (isPluginEnabled('dsh-self-improving') && text.trim()) {
            const corr = detectUserCorrectionFromMessage(text, ASSISTANT_SESSION_ID)
            if (corr) {
              const rec = recordLearningEvent(getLearnings(), corr)
              setLearnings(rec.list)
            }
          }

          if (isPluginEnabled('dsh-memory') && text.trim()) {
            const candidate = extractDurableMemoryFromUserMessage(text)
            if (candidate) {
              const currentMems = getMemoryEntries()
              const already = currentMems.some(
                e =>
                  e.title.toLowerCase() === candidate.title.toLowerCase() ||
                  e.content.includes(candidate.content) ||
                  candidate.content.includes(e.content),
              )
              if (!already) {
                const saved = saveMemoryEntry(currentMems, { ...candidate, pinned: false, source: 'user' })
                setMemoryEntries(saved.list)
              }
            }
          }

          const sc = host.ctx.get('sessionController')
          if (sc) {
            await sc.create({ sessionId: ASSISTANT_SESSION_ID as never, workspaceId: process.cwd() as never })
            await sc.rename({ sessionId: ASSISTANT_SESSION_ID as never, title: 'Claw 个人助理' })
            const resolved = await sc.resolveAgent(ASSISTANT_SESSION_ID as never)
            if ('agent' in resolved && resolved.agent) {
              pendingFeishuDmQueue.push({
                messageId,
                ...(reactionId ? { reactionId } : {}),
              })
              resolved.agent.followup({
                id: msgId,
                role: 'user',
                content: [{ type: 'text', text: `[message_id: ${msgId}] (来自主人飞书私聊)\n${text}` }],
                source: { kind: 'user' },
              } as never)
            }
          }
          return undefined
        },
      })
    } else {
      rt.context(feishuKind).report('feishu', {
        state: 'ready',
        detail: 'Proxied via claw Native Feishu pbbp2 WebSocket Bridge',
        at: new Date().toISOString(),
      })
    }
    const ghCtx = rt.context(githubKind)
    if (!ghCtx.config('github')) ghCtx.report('github', health('paused', 'sourceOff'))
  }

  registerSources(runtime)
  await runtime.ready

  async function restartRuntime(): Promise<void> {
    await runtime.stop()
    host.routes.length = 0
    runtime = new Runtime(host.ctx, machine, () => { void restartRuntime() })
    registerSources(runtime)
    await runtime.ready
  }

  const handleHttpRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const forwardedHost = typeof req.headers['x-forwarded-host'] === 'string' ? req.headers['x-forwarded-host'].split(',')[0]!.trim() : undefined
    const rawHost = forwardedHost || req.headers.host
    const matchesAllowedPort =
      typeof rawHost === 'string' &&
      (rawHost.endsWith(`:${actualPort}`) ||
        (actualHttpsPort !== undefined && rawHost.endsWith(`:${actualHttpsPort}`)) ||
        (!rawHost.includes(':') &&
          (actualPort === 80 ||
            actualHttpsPort === 443 ||
            rawHost.endsWith('.ts.net') ||
            rawHost === 'localhost' ||
            rawHost === '127.0.0.1')))
    const matchesSameHostOrigin =
      typeof rawHost === 'string' &&
      (req.headers.origin === undefined ||
        req.headers.origin === `http://${rawHost}` ||
        req.headers.origin === `https://${rawHost}`)

    if (
      listenHost === '0.0.0.0' &&
      req.headers['x-orchestrator-request'] === '1' &&
      matchesAllowedPort &&
      matchesSameHostOrigin
    ) {
      req.headers.host = `127.0.0.1:${actualPort}`
      if (req.headers.origin !== undefined) {
        req.headers.origin = `http://127.0.0.1:${actualPort}`
      }
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `127.0.0.1:${port}`}`)

    // 1. Standard dsh-superagent management API (`/orchestrator/api/...`)
    if (url.pathname.startsWith('/orchestrator/api/')) {
      const handler = host.routes[0]?.handler
      if (!handler) { sendJson(res, 503, { error: 'Runtime is restarting' }); return }
      await handler(req, res)
      return
    }

    // 2. Standalone extensions (`/orchestrator/standalone/...`)
    if (url.pathname.startsWith('/orchestrator/standalone/')) {
      const sub = url.pathname.slice('/orchestrator/standalone/'.length)
      const isLanWorkerCall =
        sub === 'worker-node/execute' ||
        sub === 'personal-skills/execute' ||
        sub === 'browser/status' ||
        sub === 'clawfeed/ingest' ||
        sub === 'clawfeed/sync' ||
        sub === 'assistant/sync' ||
        sub === 'memories/sync' ||
        sub === 'memories/milestones' ||
        sub.startsWith('rhtoolkit/') ||
        sub === 'nodes' ||
        sub.startsWith('device-group') ||
        sub.startsWith('markdown/') ||
        sub === 'model-profiles' ||
        (sub.startsWith('sessions/') && sub.endsWith('/tool'))
      if (!isLanWorkerCall && !sameOrigin(req, actualPort)) {
        sendJson(res, 403, { error: 'Same-origin request required' })
        return
      }
      try {
        await runtime.ready

        // Post a message from the Local Panel Source
        if (req.method === 'POST' && sub === 'panel/messages') {
          const body = await readJsonBody(req, PANEL_MESSAGE_BODY_BYTES)
          const parsed = panelContent(body)
          const text = parsed.text
          const content = await storePanelContent(stateDir, parsed.content)

          const conversation = String(body.conversation ?? 'main').trim() || 'main'
          const panelSettings = runtime.sources.instance(PANEL_SOURCE)?.config as { operatorId?: string; operatorName?: string } | undefined
          const sender = String(body.sender ?? panelSettings?.operatorId ?? 'operator').trim() || 'operator'
          const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          const at = new Date().toISOString()
          const trigger = panelTrigger({
            id,
            conversation,
            sender,
            text,
            at,
            addressed: body.addressed === 'mention' ? 'mention' : 'direct',
            ...(typeof body.replyTo === 'string' && body.replyTo ? { replyTo: body.replyTo } : {}),
            content,
          })
          const tKey = threadKey(trigger.threads[0]!)
          // Detach already-ended tickets from the panel thread before intake unless the user explicitly clicked "Reply" on an
          // earlier message. Without an explicit replyTo, the message goes to the Eval / Orchestrator model (`eval.model`),
          // which sees all historical tickets on the thread and decides whether to `accept` (new Ticket), `attach` (resume an
          // existing Ticket), `stop`, or `ignore`.
          if (!body.replyTo) {
            const existingThread = runtime.store.threads.get(tKey)
            if (existingThread && existingThread.subscriptions.length > 0) {
              const liveSubs = existingThread.subscriptions.filter(subId => !runtime.store.tickets.get(subId)?.ended)
              if (liveSubs.length !== existingThread.subscriptions.length) {
                runtime.store.threads.save({ ...existingThread, subscriptions: liveSubs })
              }
            }
          }
          const result = runtime.receive(trigger)
          runtime.store.threads.describe(tKey, {
            label: `Panel: ${conversation}`,
            facts: { conversation: { label: { zh: '对话', en: 'Conversation' }, value: conversation } },
          })
          const listKey = KV.panel.messages(conversation)
          const existing = runtime.store.get(listKey) ?? []
          existing.push({ id, conversation, sender, text, content, at, ...(typeof body.replyTo === 'string' && body.replyTo ? { replyTo: body.replyTo } : {}) })
          runtime.store.set(listKey, existing)
          await runtime.pump()

          let ticketId: string | undefined
          if (body.autoAccept === true && runtime.engine.candidate(trigger.id)?.strength === 'explicit') {
            const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'panel-task'
            const worktreeName = /^[a-z]/.test(slug) ? slug : `task-${slug}`.slice(0, 28)
            const routed = await host.executeSessionTool(runtime.masterId, 'orchestrator_route', {
              decisions: [{
                kind: 'accept',
                trigger_id: trigger.id,
                title: text.slice(0, 120) || 'Panel image request',
                worktree_name: worktreeName,
                acknowledgement: `已接单：${text.slice(0, 40)}`,
              }],
            }) as { results?: { ticket?: { ticket_id?: string } }[] }
            ticketId = routed.results?.[0]?.ticket?.ticket_id
            await runtime.pump()
          }

          sendJson(res, 200, { id: trigger.id, messageId: id, threadKey: tKey, result, ...(ticketId ? { ticketId } : {}) })
          return
        }

        // Read the local panel conversation, including stored agent replies, message receipts, and topic summaries.
        if (req.method === 'GET' && sub === 'panel/messages') {
          const conversation = String(url.searchParams.get('conversation') ?? 'main').trim() || 'main'
          const after = Number(url.searchParams.get('after') ?? '0')
          if (!Number.isSafeInteger(after) || after < 0) throw new Error('after must be a non-negative message count')
          const all = runtime.store.get(KV.panel.messages(conversation)) ?? []
          const messages = await Promise.all(all.slice(after).map(async message => ({ ...message,
            ...(message.content ? { content: await panelWireContent(message.content) } : {}) })))
          const { receipts, topics } = buildPanelReceiptsAndTopics(runtime, conversation)
          sendJson(res, 200, { conversation, messages, next: all.length, receipts, topics })
          return
        }

        // List sessions, configured role models, model profiles, device group, worker load, worker nodes, and the 4-stage pipeline
        if (req.method === 'GET' && sub === 'sessions') {
          const currentSettings = runtime.store.settings()
          const activeModels = resolveActiveRoleModels()
          const identity = getDeviceIdentity()
          const packet = runtime.store.get(KV.deviceGroup.packet)
          let groupMembers: ReturnType<typeof verifyAndExtractGroupMembers> = []
          if (packet) {
            try { groupMembers = verifyAndExtractGroupMembers(packet) } catch {}
          }
          const nodesList = getRegisteredNodes()
          const memoriesList = getMemoryEntries()
          const rawAssistantMsgs = runtime.store.get(KV.assistant.messages) ?? []
          const assistantMessages = await Promise.all(
            rawAssistantMsgs.map(async m => {
              const enriched = enrichAssistantMessage(m)
              return {
                ...enriched,
                ...(enriched.content ? { content: await panelWireContent(enriched.content) } : {}),
              }
            }),
          )
          const pipelineList = buildPipelineRows(runtime)
          const runningTickets = runtime.executor.activeCount()
          const guardStats = getRuntimeGuardStats()
          const usageState = getModelUsageState()
          const totalCostCny = Object.values(usageState.byModelRole).reduce((s, m) => s + m.estimatedCostCny, 0)
          const lcmDag = getLcmDag()
          const learningsList = getLearnings()
          const progressCardsMap = getProgressCards()
          const pluginsList = buildPluginCatalog({
            disabledPlugins: getDisabledPlugins(),
            memoryCount: memoriesList.length,
            pinnedMemoryCount: memoriesList.filter(m => m.pinned).length,
            nodeCount: nodesList.filter(n => n.status === 'online').length,
            profileCount: activeModels.profilesState.config.profiles.length,
            assistantMessageCount: assistantMessages.length,
            pipelineCount: pipelineList.length,
            ticketCount: runningTickets,
            tokensSaved: guardStats.estimatedTokensSaved,
            totalCostCny,
            lcmNodeCount: lcmDag.nodes.length,
            learningCount: learningsList.length,
            progressCardCount: Object.keys(progressCardsMap).length,
            ...(privateToolkitMod
              ? { extraPrivatePlugins: [privateToolkitMod.buildRHToolkitPluginDescriptor(isPluginEnabled('dsh-rhtoolkit'))] }
              : {}),
            sourcesEnabled: {
              panel: currentSettings.sources[PANEL_SOURCE]?.enabled !== false,
              feishu: currentSettings.sources.feishu?.enabled === true,
              github: currentSettings.sources.github?.enabled === true,
            },
          })
          sendJson(res, 200, {
            sessions: host.listSessions(),
            roleModels: {
              assistant: activeModels.assistant,
              eval: activeModels.eval,
              executor: activeModels.executor,
            },
            modelProfiles: activeModels.profilesState,
            deviceGroup: {
              identity: {
                deviceId: identity.deviceId,
                deviceName: identity.deviceName,
                hostname: identity.hostname,
                ...(identity.tailscaleDnsName ? { tailscaleDnsName: identity.tailscaleDnsName } : {}),
                tailscaleIps: identity.tailscaleIps,
                lanIps: identity.lanIps,
                endpoints: identity.endpoints,
                tags: identity.tags,
              },
              ...(packet ? { groupId: packet.groupId, groupName: packet.groupName, members: groupMembers } : {}),
            },
            load: {
              running: runningTickets,
              maxWorkers: currentSettings.executor.maxWorkers,
            },
            nodes: nodesList,
            memories: memoriesList,
            memoryBackups: listAndPurgeMemoryBackups(stateDir),
            plugins: pluginsList,
            assistantMessages,
            assistantChatBackups: listAndPurgeAssistantChatBackups(stateDir),
            assistantContextConfig: getAssistantContextConfig(),
            clawfeedItems: runtime.store.get(KV.clawfeed.items) ?? [],
            progressCards: progressCardsMap,
            pendingQuestions: collectPendingQuestions(runtime),
            pipeline: pipelineList,
          })
          return
        }

        // Answer a pending question from `Claw` (Personal Assistant), `Eval` (Orchestrator), or `Worker` (Ticket)
        if (req.method === 'POST' && sub === 'questions/answer') {
          const body = await readJsonBody(req, 512 * 1024)
          const answer = String(body.answer ?? body.text ?? '').trim()
          if (!answer) throw new Error('Answer text is required')
          const questionId = typeof body.id === 'string' ? body.id.trim() : undefined
          const role = typeof body.role === 'string' ? body.role.trim() : undefined
          const ticketId = typeof body.ticketId === 'string' && body.ticketId.trim() ? body.ticketId.trim() : undefined
          const at = new Date().toISOString()

          // 1. If answering a Claw Personal Assistant question
          const storedClawQs = runtime.store.get(KV.assistant.questions) ?? []
          const matchedClawQ = questionId ? storedClawQs.find(q => q.id === questionId) : undefined
          if (role === 'claw' || matchedClawQ) {
            if (questionId) {
              runtime.store.set(
                KV.assistant.questions,
                storedClawQs.filter(q => q.id !== questionId),
              )
            } else {
              runtime.store.set(KV.assistant.questions, [])
            }
            const msgId = `asst-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
            const list = runtime.store.get(KV.assistant.messages) ?? []
            const userMsg: AssistantStoredMessage = {
              id: msgId,
              sender: 'operator',
              text: answer,
              content: [{ type: 'text', text: answer }],
              at,
            }
            list.push(userMsg)
            runtime.store.set(KV.assistant.messages, list)
            const sc = host.ctx.get('sessionController')
            if (sc) {
              await sc.create({ sessionId: ASSISTANT_SESSION_ID as never, workspaceId: process.cwd() as never })
              const resolved = await sc.resolveAgent(ASSISTANT_SESSION_ID as never)
              if ('agent' in resolved && resolved.agent) {
                resolved.agent.followup({
                  id: msgId,
                  role: 'user',
                  content: [{ type: 'text', text: `[message_id: ${msgId}]\n${answer}` }],
                  source: { kind: 'user' },
                } as never)
              }
            }
            sendJson(res, 200, {
              answered: true,
              pendingQuestions: collectPendingQuestions(runtime),
            })
            return
          }

          // 2. If answering an Engineering Ticket (`Worker`) or `Eval` on a panel thread
          const tk = ticketId ? runtime.store.tickets.get(ticketId) : undefined
          const panelFollow = tk?.follows?.find(f => f.thread.startsWith(`${PANEL_SOURCE}:`))
          const conversation =
            (typeof body.conversation === 'string' && body.conversation.trim()) ||
            (panelFollow ? panelFollow.thread.slice(`${PANEL_SOURCE}:`.length) : undefined) ||
            'main'
          const originTrigger = tk ? runtime.store.triggers.get(tk.origin.triggerId) : undefined
          const replyToMsgId =
            typeof originTrigger?.meta?.messageId === 'string' ? originTrigger.meta.messageId : undefined

          if (tk?.attention) {
            const copy = { ...tk }
            delete copy.attention
            runtime.store.tickets.save(copy)
          }

          const msgId = `ans-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          const content = await storePanelContent(stateDir, [{ type: 'text', text: answer }])
          const trigger = panelTrigger({
            id: msgId,
            conversation,
            sender: 'operator',
            text: answer,
            at,
            addressed: 'direct',
            ...(replyToMsgId ? { replyTo: replyToMsgId } : {}),
            content,
          })
          runtime.receive(trigger)
          const listKey = KV.panel.messages(conversation)
          const existing = runtime.store.get(listKey) ?? []
          existing.push({
            id: msgId,
            conversation,
            sender: 'operator',
            text: answer,
            content,
            at,
            ...(replyToMsgId ? { replyTo: replyToMsgId } : {}),
          })
          runtime.store.set(listKey, existing)
          await runtime.pump()

          sendJson(res, 200, {
            answered: true,
            triggerId: trigger.id,
            pendingQuestions: collectPendingQuestions(runtime),
          })
          return
        }

        // Cross-node synchronization so the Web UI Personal Assistant (`个人助理`) acts as the canonical Single Source of Truth (`真实消息源`)
        if (req.method === 'POST' && sub === 'assistant/sync') {
          const body = await readJsonBody(req, 10 * 1024 * 1024)
          const mode = body.mode === 'replace' ? 'replace' : 'merge'
          const incomingMsgs = Array.isArray(body.messages) ? (body.messages as AssistantStoredMessage[]) : []
          if (body.contextConfig && typeof body.contextConfig === 'object') {
            runtime.store.set(KV.assistant.contextConfig, body.contextConfig as AssistantContextConfig)
          }
          if (mode === 'replace') {
            runtime.store.set(KV.assistant.messages, incomingMsgs)
            if (incomingMsgs.length === 0) {
              await host.clearSession(ASSISTANT_SESSION_ID)
            }
          } else if (incomingMsgs.length > 0) {
            const existing = runtime.store.get(KV.assistant.messages) ?? []
            const byId = new Map<string, AssistantStoredMessage>()
            for (const m of existing) byId.set(m.id, m)
            for (const m of incomingMsgs) {
              const prev = byId.get(m.id)
              byId.set(m.id, prev ? { ...prev, ...m } : m)
            }
            const merged = [...byId.values()].sort((a, b) => a.at.localeCompare(b.at))
            runtime.store.set(KV.assistant.messages, merged)
          }
          sendJson(res, 200, { ok: true })
          return
        }

        // Personal Assistant (`@rharness/plugin-claw-assistant`) endpoints & one-way verbatim handoff to Engineering
        if (req.method === 'GET' && sub === 'assistant/messages') {
          const raw = runtime.store.get(KV.assistant.messages) ?? []
          const refreshed = await Promise.all(
            raw.map(async m => {
              const enriched = enrichAssistantMessage(m)
              return {
                ...enriched,
                ...(enriched.content ? { content: await panelWireContent(enriched.content) } : {}),
              }
            }),
          )
          sendJson(res, 200, {
            messages: refreshed,
            chatBackups: listAndPurgeAssistantChatBackups(stateDir),
            contextConfig: getAssistantContextConfig(),
          })
          return
        }

        if (req.method === 'POST' && sub === 'assistant/context') {
          const body = await readJsonBody(req, 128 * 1024)
          const current = getAssistantContextConfig()
          let next: AssistantContextConfig = { ...current }
          if (body.action === 'reset-window') {
            const nowIso = new Date().toISOString()
            const resets = [...(current.windowResets ?? []), nowIso]
            next = {
              ...current,
              contextResetAt: nowIso,
              windowResets: resets,
            }
          } else if (body.action === 'clear-reset') {
            const { contextResetAt: _removed, ...rest } = current
            next = rest
          } else {
            if (typeof body.recentMessagesLimit === 'number' && Number.isInteger(body.recentMessagesLimit) && body.recentMessagesLimit >= 0) {
              next.recentMessagesLimit = body.recentMessagesLimit
            }
            if (body.contextResetAt === null) {
              delete next.contextResetAt
            } else if (typeof body.contextResetAt === 'string' && body.contextResetAt.trim()) {
              next.contextResetAt = body.contextResetAt.trim()
            }
          }
          runtime.store.set(KV.assistant.contextConfig, next)
          void broadcastAssistantStateToPeers('replace')
          sendJson(res, 200, { contextConfig: next })
          return
        }

        if (req.method === 'POST' && sub === 'assistant/clear') {
          const currentCtx = getAssistantContextConfig()
          const nextCtx: AssistantContextConfig = {
            recentMessagesLimit: currentCtx.recentMessagesLimit,
          }
          const existing = runtime.store.get(KV.assistant.messages) ?? []
          const backup = archiveAssistantMessagesToBackupDir(stateDir, existing, 'clear-all')
          runtime.store.set(KV.assistant.messages, [])
          runtime.store.set(KV.assistant.contextConfig, nextCtx)
          await host.clearSession(ASSISTANT_SESSION_ID)
          void broadcastAssistantStateToPeers('replace')
          sendJson(res, 200, {
            cleared: true,
            backup,
            messages: [],
            chatBackups: listAndPurgeAssistantChatBackups(stateDir),
            contextConfig: nextCtx,
          })
          return
        }

        if (req.method === 'POST' && sub.startsWith('assistant/backups/') && sub.endsWith('/restore')) {
          const backupId = decodeURIComponent(sub.slice('assistant/backups/'.length, -'/restore'.length)).trim()
          const currentList = runtime.store.get(KV.assistant.messages) ?? []
          const restored = restoreAssistantChatBackupFromDir(stateDir, backupId, currentList)
          runtime.store.set(KV.assistant.messages, restored.list)
          void broadcastAssistantStateToPeers('replace')
          const refreshed = await Promise.all(
            restored.list.map(async m => {
              const enriched = enrichAssistantMessage(m)
              return {
                ...enriched,
                ...(enriched.content ? { content: await panelWireContent(enriched.content) } : {}),
              }
            }),
          )
          sendJson(res, 200, {
            restoredCount: restored.restoredCount,
            messages: refreshed,
            chatBackups: restored.backups,
          })
          return
        }

        if (req.method === 'DELETE' && sub.startsWith('assistant/backups/')) {
          sendJson(res, 403, {
            error: '30天反悔保护期内禁止手动彻底删除对话备份文件（系统将在满30天后自动清理，期间可随时恢复）',
          })
          return
        }

        if (req.method === 'DELETE' && sub.startsWith('assistant/messages/')) {
          const msgId = decodeURIComponent(sub.slice('assistant/messages/'.length)).trim()
          const existing = runtime.store.get(KV.assistant.messages) ?? []
          const target = existing.find(m => m.id === msgId)
          if (target) {
            archiveAssistantMessagesToBackupDir(stateDir, [target], 'single-delete')
          }
          const nextList = existing.filter(m => m.id !== msgId)
          runtime.store.set(KV.assistant.messages, nextList)
          void broadcastAssistantStateToPeers('replace')
          if (nextList.length === 0) {
            await host.clearSession(ASSISTANT_SESSION_ID)
          } else if (target) {
            const targetTurn = target.replyMeta?.turn
            host.pruneSessionEvents(ASSISTANT_SESSION_ID, ev => {
              const d = (ev.data ?? {}) as { id?: string; turn?: number; message?: { content?: { text?: string }[] } }
              if (ev.type === 'user/message' && d.id === msgId) return true
              if (targetTurn !== undefined && d.turn === targetTurn) return true
              if (target.bot && ev.type === 'assistant/message') {
                const txt = (d.message?.content ?? []).map(p => p.text ?? '').join('').trim()
                if (txt && (txt === target.text || target.text.endsWith(txt))) return true
              }
              return false
            })
          }
          const refreshed = await Promise.all(
            nextList.map(async m => {
              const enriched = enrichAssistantMessage(m)
              return {
                ...enriched,
                ...(enriched.content ? { content: await panelWireContent(enriched.content) } : {}),
              }
            }),
          )
          sendJson(res, 200, {
            deleted: Boolean(target),
            messages: refreshed,
            chatBackups: listAndPurgeAssistantChatBackups(stateDir),
          })
          return
        }

        if (req.method === 'POST' && sub === 'assistant/btw') {
          const body = await readJsonBody(req, 256 * 1024)
          const question = String(body.question ?? body.text ?? '').trim()
          if (!question) throw new Error('Side question is required')
          const answer = await runEphemeralBtwSideQuestion(question)
          sendJson(res, 200, { ok: true, question, answer, at: new Date().toISOString() })
          return
        }

        if (req.method === 'GET' && sub === 'browser/status') {
          const status = await inspectLocalBrowserBridge()
          sendJson(res, 200, status)
          return
        }

        if (req.method === 'POST' && sub === 'assistant/messages') {
          const body = await readJsonBody(req, PANEL_MESSAGE_BODY_BYTES)
          const parsed = panelContent(body)
          const text = parsed.text
          const parsedBtw = parseBtwSideQuestion(text)
          if (parsedBtw.isBtw && isPluginEnabled('dsh-self-improving')) {
            const answer = await runEphemeralBtwSideQuestion(parsedBtw.question)
            sendJson(res, 200, {
              ephemeralBtw: true,
              question: parsedBtw.question,
              answer,
              at: new Date().toISOString(),
            })
            return
          }
          const content = await storePanelContent(stateDir, parsed.content)
          const msgId = `asst-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
          const at = new Date().toISOString()
          const list = runtime.store.get(KV.assistant.messages) ?? []
          const userMsg: AssistantStoredMessage = {
            id: msgId,
            sender: 'operator',
            text,
            content,
            at,
          }
          list.push(userMsg)
          runtime.store.set(KV.assistant.messages, list)
          void broadcastAssistantStateToPeers('merge')

          if (isPluginEnabled('dsh-self-improving') && text.trim()) {
            const corr = detectUserCorrectionFromMessage(text, ASSISTANT_SESSION_ID)
            if (corr) {
              const rec = recordLearningEvent(getLearnings(), corr)
              setLearnings(rec.list)
            }
          }

          // High-SNR automatic extraction of explicit preferences, dated reminders, or asset facts from user speech
          if (isPluginEnabled('dsh-memory') && text.trim()) {
            const candidate = extractDurableMemoryFromUserMessage(text)
            if (candidate) {
              const currentMems = getMemoryEntries()
              const already = currentMems.some(
                e =>
                  e.title.toLowerCase() === candidate.title.toLowerCase() ||
                  e.content.includes(candidate.content) ||
                  candidate.content.includes(e.content),
              )
              if (!already) {
                const saved = saveMemoryEntry(currentMems, {
                  ...candidate,
                  pinned: false,
                  source: 'user',
                })
                setMemoryEntries(saved.list)
              }
            }
          }

          // Ensure the Personal Assistant session exists and deliver the user turn (including any attached images)
          const sc = host.ctx.get('sessionController')
          if (sc) {
            await sc.create({ sessionId: ASSISTANT_SESSION_ID as never, workspaceId: process.cwd() as never })
            await sc.rename({ sessionId: ASSISTANT_SESSION_ID as never, title: 'Claw 个人助理' })
          }

          if (body.forwardToEngineering === true) {
            const handoff = await forwardAssistantMessageToEngineering(runtime, {
              originalMessageId: msgId,
              originalText: text,
              ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
              ...(typeof body.contextNote === 'string' ? { contextNote: body.contextNote } : {}),
            })
            const wireContent = content ? await panelWireContent(content) : undefined
            sendJson(res, 200, {
              message: { ...userMsg, ...(wireContent ? { content: wireContent } : {}), handoff },
              handoff,
            })
            return
          }

          if (sc) {
            const resolved = await sc.resolveAgent(ASSISTANT_SESSION_ID as never)
            if ('agent' in resolved && resolved.agent) {
              const agentContent: unknown[] = [{ type: 'text', text: `[message_id: ${msgId}]\n${text}` }]
              for (const part of content) {
                if (part.type === 'image') {
                  agentContent.push({
                    type: 'image',
                    path: part.image.path,
                    mediaType: part.image.mediaType,
                    ...(part.image.name ? { name: part.image.name } : {}),
                  })
                }
              }
              resolved.agent.followup({
                id: msgId,
                role: 'user',
                content: agentContent,
                source: { kind: 'user' },
              } as never)
            }
          }
          const wireContent = content ? await panelWireContent(content) : undefined
          sendJson(res, 200, { message: { ...userMsg, ...(wireContent ? { content: wireContent } : {}) } })
          return
        }

        if (req.method === 'POST' && sub === 'assistant/forward') {
          const body = await readJsonBody(req, 1024 * 1024)
          const originalMessageId = typeof body.originalMessageId === 'string' ? body.originalMessageId.trim() : undefined
          const storedList = runtime.store.get(KV.assistant.messages) ?? []
          const foundMsg = originalMessageId ? storedList.find(m => m.id === originalMessageId) : undefined
          const originalText = String(body.originalText ?? foundMsg?.text ?? '').trim()
          const handoff = await forwardAssistantMessageToEngineering(runtime, {
            ...(originalMessageId ? { originalMessageId } : {}),
            ...(originalText ? { originalText } : {}),
            ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
            ...(typeof body.contextNote === 'string' ? { contextNote: body.contextNote } : {}),
          })
          const refreshed = await Promise.all(
            (runtime.store.get(KV.assistant.messages) ?? []).map(async m => ({
              ...m,
              ...(m.handoff ? { handoff: resolveHandoffStatus(runtime, m.handoff) } : {}),
              ...(m.content ? { content: await panelWireContent(m.content) } : {}),
            })),
          )
          sendJson(res, 200, { handoff, messages: refreshed })
          return
        }

        if (req.method === 'POST' && sub === 'assistant/eval-decision') {
          const body = await readJsonBody(req, 512 * 1024)
          const triggerId = String(body.triggerId ?? '').trim()
          const decision = String(body.decision ?? 'accept').trim()
          if (!triggerId) throw new Error('triggerId is required')
          if (decision === 'ignore') {
            const reason = String(body.reason ?? '不属于明确的工程实现需求，建议留在个人助理窗口处理').trim()
            await host.executeSessionTool(runtime.masterId, 'orchestrator_route', {
              decisions: [{
                kind: 'ignore',
                trigger_id: triggerId,
                reason,
              }],
            })
          } else {
            const title = String(body.title ?? '个人助理转交需求').trim().slice(0, 120)
            const words = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 3)
            const worktreeName = ['handoff', ...words].join('-').slice(0, 28).replace(/-+$/, '') || 'handoff-task'
            await host.executeSessionTool(runtime.masterId, 'orchestrator_route', {
              decisions: [{
                kind: 'accept',
                trigger_id: triggerId,
                title,
                worktree_name: worktreeName,
                acknowledgement: `工程已接单：${title.slice(0, 40)}`,
              }],
            })
          }
          await runtime.pump()
          const refreshed = await Promise.all(
            (runtime.store.get(KV.assistant.messages) ?? []).map(async m => ({
              ...m,
              ...(m.handoff ? { handoff: resolveHandoffStatus(runtime, m.handoff) } : {}),
              ...(m.content ? { content: await panelWireContent(m.content) } : {}),
            })),
          )
          sendJson(res, 200, { messages: refreshed })
          return
        }

        // First-Class Memory Plugin & Plugin Manager endpoints
        if (req.method === 'GET' && sub === 'memories') {
          const q = url.searchParams.get('q') ?? undefined
          const category = url.searchParams.get('category') ?? undefined
          const pinned = url.searchParams.get('pinned') === 'true'
          sendJson(res, 200, {
            memories: searchMemories(getMemoryEntries(), q, category, pinned),
            memoryBackups: listAndPurgeMemoryBackups(stateDir),
            upcomingMilestones: getUpcomingMilestones(getMemoryEntries(), { withinDays: 60 }),
          })
          return
        }

        if (req.method === 'POST' && sub === 'memories/sync') {
          const body = await readJsonBody(req, 5 * 1024 * 1024)
          const mode = body.mode === 'replace' ? 'replace' : 'merge'
          const incoming = Array.isArray(body.memories) ? (body.memories as MemoryEntry[]) : []
          if (mode === 'replace') {
            setMemoryEntries(incoming, 'none')
          } else if (incoming.length > 0) {
            const current = getMemoryEntries()
            const byKey = new Map<string, MemoryEntry>()
            for (const m of current) byKey.set(m.id, m)
            for (const m of incoming) {
              // Match either by id or by normalized title
              const dupTitleEntry = [...byKey.values()].find(
                e => e.id !== m.id && e.title.trim().toLowerCase() === m.title.trim().toLowerCase(),
              )
              if (dupTitleEntry) {
                const winner = m.updatedAt >= dupTitleEntry.updatedAt ? m : dupTitleEntry
                byKey.delete(dupTitleEntry.id)
                byKey.set(winner.id, winner)
              } else {
                const prev = byKey.get(m.id)
                byKey.set(m.id, prev && prev.updatedAt > m.updatedAt ? prev : m)
              }
            }
            const merged = [...byKey.values()].sort((a, b) => {
              if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
              return b.updatedAt.localeCompare(a.updatedAt)
            })
            setMemoryEntries(merged, 'none')
          }
          sendJson(res, 200, { ok: true })
          return
        }

        if (req.method === 'GET' && sub === 'memories/milestones') {
          const withinDays = Number(url.searchParams.get('withinDays') ?? '35')
          const onlyCheckpoints = url.searchParams.get('checkpointsOnly') === '1'
          const items = getUpcomingMilestones(getMemoryEntries(), {
            withinDays: Number.isFinite(withinDays) ? withinDays : 35,
            onlyCheckpointMatches: onlyCheckpoints,
          })
          sendJson(res, 200, {
            ok: true,
            items,
          })
          return
        }

        if (req.method === 'POST' && sub === 'memories/consolidate') {
          const allMsgs = (runtime.store.get(KV.assistant.messages) ?? []).map(m => ({
            id: m.id,
            sender: m.sender,
            ...(m.bot ? { bot: true } : {}),
            text: m.text,
            at: m.at,
          }))
          const result = consolidateMemories(
            getMemoryEntries(),
            allMsgs,
            removed => { archiveMemoriesToBackupDir(stateDir, removed, 'single-delete') },
          )
          setMemoryEntries(result.list)
          sendJson(res, 200, {
            consolidated: true,
            extractedCount: result.extractedCount,
            mergedCount: result.mergedCount,
            purgedNoiseCount: result.purgedNoiseCount,
            extractedEntries: result.extractedEntries,
            memories: result.list,
            memoryBackups: listAndPurgeMemoryBackups(stateDir),
          })
          return
        }

        // Dual-Instance SiYuan Knowledge Base endpoints (`siyuan` = family shared, `siyuan-rh` = owner private)
        if (req.method === 'GET' && sub === 'siyuan/notebooks') {
          const instance = url.searchParams.get('instance') ?? 'all'
          const out = await executePersonalSkillWithRemoteFallback(
            'siyuan_notebooks',
            { instance },
            getRegisteredNodes,
          )
          sendJson(res, 200, out)
          return
        }

        if (req.method === 'GET' && sub === 'siyuan/search') {
          const q = String(url.searchParams.get('q') ?? '').trim()
          const instance = url.searchParams.get('instance') ?? 'all'
          if (!q) {
            sendJson(res, 200, { ok: true, query: '', count: 0, items: [] })
            return
          }
          const out = await executePersonalSkillWithRemoteFallback(
            'siyuan_search',
            { query: q, instance, limit: 30 },
            getRegisteredNodes,
          )
          sendJson(res, 200, out)
          return
        }

        // Native ClawFeed notification ingress (`POST /orchestrator/standalone/clawfeed/ingest`), replacing `openclaw --profile <user> agent` CLI
        if (req.method === 'POST' && sub === 'clawfeed/ingest') {
          if (!isPluginEnabled('dsh-clawfeed')) {
            sendJson(res, 200, { ok: true, pausedByPlugin: true })
            return
          }
          const body = await readJsonBody(req, 512 * 1024)
          const tag = String(body.tag ?? '普通').trim()
          const text = String(body.message ?? body.text ?? '').trim()
          const sender = String(body.user ?? body.profile ?? 'clawfeed').trim()
          if (!text) throw new Error('Notification message is required')
          const at = new Date().toISOString()
          const feedId = `feed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
          const cfConfig = runtime.store.get(KV.plugins.config('dsh-clawfeed')) ?? {}
          const maxRetained = Math.max(20, Math.min(1000, Number(cfConfig.maxRetained ?? 200)))
          const storedFeed = runtime.store.get(KV.clawfeed.items) ?? []
          storedFeed.unshift({
            id: feedId,
            user: sender,
            tag,
            message: text,
            at,
          })
          runtime.store.set(KV.clawfeed.items, storedFeed.slice(0, maxRetained))
          void broadcastClawFeedStateToPeers('merge')

          // Keep mobile notifications in their own dedicated ClawFeed view; never mix them into Personal Assistant chat history
          if (cfConfig.forwardOtpToFeishuDm === true && tag === '验证码') {
            void sendFeishuDirectMessage(`📱 手机验证码通知：${text}`).catch(() => {})
          }
          sendJson(res, 200, { ok: true, id: feedId, tag, recorded: true })
          return
        }

        if (req.method === 'GET' && sub === 'clawfeed') {
          sendJson(res, 200, {
            items: runtime.store.get(KV.clawfeed.items) ?? [],
          })
          return
        }

        if (req.method === 'POST' && sub === 'clawfeed/sync') {
          const body = await readJsonBody(req, 5 * 1024 * 1024)
          const mode = body.mode === 'replace' ? 'replace' : 'merge'
          const incoming = Array.isArray(body.items) ? (body.items as { id: string; user: string; tag: string; message: string; at: string }[]) : []
          if (mode === 'replace') {
            runtime.store.set(KV.clawfeed.items, incoming)
          } else if (incoming.length > 0) {
            const existing = runtime.store.get(KV.clawfeed.items) ?? []
            const byId = new Map<string, typeof incoming[0]>()
            for (const item of existing) byId.set(item.id, item)
            for (const item of incoming) byId.set(item.id, item)
            const merged = [...byId.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 500)
            runtime.store.set(KV.clawfeed.items, merged)
          }
          sendJson(res, 200, { ok: true })
          return
        }

        if (req.method === 'POST' && sub === 'clawfeed/clear') {
          runtime.store.set(KV.clawfeed.items, [])
          void broadcastClawFeedStateToPeers('replace')
          sendJson(res, 200, { ok: true, items: [] })
          return
        }

        if (req.method === 'DELETE' && sub.startsWith('clawfeed/')) {
          const itemId = decodeURIComponent(sub.slice('clawfeed/'.length)).trim()
          const existing = runtime.store.get(KV.clawfeed.items) ?? []
          const next = existing.filter(i => i.id !== itemId)
          runtime.store.set(KV.clawfeed.items, next)
          void broadcastClawFeedStateToPeers('replace')
          sendJson(res, 200, { ok: true, items: next })
          return
        }

        if (req.method === 'POST' && sub === 'memories') {
          const body = await readJsonBody(req, 1024 * 1024)
          const title = String(body.title ?? '').trim()
          const content = String(body.content ?? '').trim()
          if (!title || !content) throw new Error('Memory title and content are required')
          const category = (['preference', 'device', 'project', 'fact', 'episodic', 'milestone'].includes(String(body.category))
            ? String(body.category)
            : 'fact') as MemoryCategory
          const tags = Array.isArray(body.tags)
            ? body.tags.map(t => String(t).trim()).filter(Boolean)
            : typeof body.tags === 'string'
              ? body.tags.split(/[\s,]+/).map(t => t.trim()).filter(Boolean)
              : []
          const pinned = body.pinned === true
          let milestone: MilestoneReminderRule | null | undefined = undefined
          if (body.milestone === null) {
            milestone = null
          } else if (typeof body.milestone === 'object' && body.milestone !== null) {
            const mObj = body.milestone as { targetDate?: string; recurrence?: string; leadDays?: unknown }
            if (typeof mObj.targetDate === 'string' && mObj.targetDate.trim()) {
              const td = mObj.targetDate.trim()
              const rec = mObj.recurrence === 'once' ? 'once' : mObj.recurrence === 'yearly' ? 'yearly' : (/^\d{4}-/.test(td) ? 'once' : 'yearly')
              const ld = Array.isArray(mObj.leadDays)
                ? mObj.leadDays.map(n => Number(n)).filter(n => Number.isFinite(n) && n >= 0 && n <= 365)
                : [...DEFAULT_MILESTONE_LEAD_DAYS]
              milestone = { targetDate: td, recurrence: rec, leadDays: ld.length ? ld : [...DEFAULT_MILESTONE_LEAD_DAYS] }
            }
          }
          const { entry, list } = saveMemoryEntry(getMemoryEntries(), {
            ...(typeof body.id === 'string' && body.id.trim() ? { id: body.id.trim() } : {}),
            title,
            content,
            category: milestone ? 'milestone' : category,
            tags,
            pinned,
            ...(milestone !== undefined ? { milestone } : {}),
            source: 'user',
          })
          setMemoryEntries(list)
          sendJson(res, 200, {
            memory: entry,
            ...(entry.milestone ? { countdown: evaluateMilestoneCountdown(entry) } : {}),
            memories: list,
            memoryBackups: listAndPurgeMemoryBackups(stateDir),
          })
          return
        }

        if (req.method === 'POST' && sub === 'memories/clear') {
          const body = await readJsonBody(req, 64 * 1024)
          if (body.confirmStep !== 2 || body.confirmed !== true) {
            sendJson(res, 400, { error: '清空长期记忆需要完成二次确认 (confirmStep: 2, confirmed: true)' })
            return
          }
          const current = getMemoryEntries()
          const backup = archiveMemoriesToBackupDir(stateDir, current, 'clear-all')
          setMemoryEntries([], 'replace')
          sendJson(res, 200, {
            cleared: true,
            backup,
            memories: [],
            memoryBackups: listAndPurgeMemoryBackups(stateDir),
          })
          return
        }

        if (req.method === 'POST' && sub.startsWith('memories/backups/') && sub.endsWith('/restore')) {
          const backupId = decodeURIComponent(sub.slice('memories/backups/'.length, -'/restore'.length)).trim()
          const restored = restoreMemoryBackupFromDir(stateDir, backupId, getMemoryEntries())
          setMemoryEntries(restored.list)
          sendJson(res, 200, {
            restoredCount: restored.restoredCount,
            memories: restored.list,
            memoryBackups: restored.backups,
          })
          return
        }

        if (req.method === 'DELETE' && sub.startsWith('memories/backups/')) {
          sendJson(res, 403, {
            error: '30天反悔保护期内禁止手动彻底删除记忆备份文件（系统将在满30天后自动清理，期间可随时恢复）',
          })
          return
        }

        if (req.method === 'DELETE' && sub.startsWith('memories/')) {
          const memId = decodeURIComponent(sub.slice('memories/'.length))
          const current = getMemoryEntries()
          const removed = current.filter(m => m.id === memId)
          if (removed.length > 0) {
            archiveMemoriesToBackupDir(stateDir, removed, 'single-delete')
          }
          const next = current.filter(m => m.id !== memId)
          setMemoryEntries(next, 'replace')
          sendJson(res, 200, {
            memories: next,
            memoryBackups: listAndPurgeMemoryBackups(stateDir),
          })
          return
        }

        if (req.method === 'POST' && sub.startsWith('plugins/') && sub.endsWith('/toggle')) {
          const pluginId = decodeURIComponent(sub.slice('plugins/'.length, -'/toggle'.length))
          const body = await readJsonBody(req, 64 * 1024)
          const disabled = new Set(getDisabledPlugins())
          const enabled = typeof body.enabled === 'boolean' ? body.enabled : disabled.has(pluginId)
          if (enabled) disabled.delete(pluginId)
          else disabled.add(pluginId)
          runtime.store.set(KV.plugins.state, { disabledPlugins: [...disabled] })
          const currentSettings = runtime.store.settings()
          const memoriesList = getMemoryEntries()
          const nodesList = getRegisteredNodes()
          const rawAssistantMsgs = runtime.store.get(KV.assistant.messages) ?? []
          const pipelineList = buildPipelineRows(runtime)
          const pluginsList = buildPluginCatalog({
            disabledPlugins: [...disabled],
            memoryCount: memoriesList.length,
            pinnedMemoryCount: memoriesList.filter(m => m.pinned).length,
            nodeCount: nodesList.filter(n => n.status === 'online').length,
            profileCount: resolveActiveRoleModels().profilesState.config.profiles.length,
            assistantMessageCount: rawAssistantMsgs.length,
            pipelineCount: pipelineList.length,
            ticketCount: runtime.executor.activeCount(),
            ...(privateToolkitMod
              ? { extraPrivatePlugins: [privateToolkitMod.buildRHToolkitPluginDescriptor(!disabled.has('dsh-rhtoolkit'))] }
              : {}),
            sourcesEnabled: {
              panel: currentSettings.sources[PANEL_SOURCE]?.enabled !== false,
              feishu: currentSettings.sources.feishu?.enabled === true,
              github: currentSettings.sources.github?.enabled === true,
            },
          })
          sendJson(res, 200, { plugins: pluginsList })
          return
        }

        // Plugin Self-Owned Unified "Status + Settings" Workbench (`GET/POST /orchestrator/standalone/plugins/:id/panel|config|action`)
        if (req.method === 'GET' && sub.startsWith('plugins/') && sub.endsWith('/panel')) {
          const pluginId = decodeURIComponent(sub.slice('plugins/'.length, -'/panel'.length))
          const savedCfg = runtime.store.get(KV.plugins.config(pluginId)) ?? {}
          const enabled = isPluginEnabled(pluginId)

          if (pluginId === 'dsh-rhtoolkit' && privateToolkitMod) {
            const packDefaults: Partial<PrivatePackRHToolkitSpec> = loadPrivatePack()?.manifest.rhtoolkit ?? {}
            const rawCfg: Record<string, unknown> = { ...packDefaults, ...savedCfg }
            const remoteEp = String(rawCfg.remoteEndpoint ?? privateToolkitMod.DEFAULT_RHTOOLKIT_CONFIG.remoteEndpoint)
            let overview: {
              nodeHost: string
              diskFreeGb: number | null
              totalDownloadFiles: number
              totalDownloadSizeMb: number
              backups: unknown[]
              toolsAvailable: { bbdown: boolean; ytdlp: boolean; sevenZip: boolean }
              downloadTask: { running: boolean }
              recentHistory: { timestamp: string; command: string; success: boolean; fileCount: number }[]
            } | undefined
            let remoteErr: string | undefined
            try {
              overview = (privateToolkitMod.isToolkitHostedLocally(rawCfg)
                ? privateToolkitMod.getLocalToolkitOverview(rawCfg)
                : await privateToolkitMod.proxyToolkitJsonToRemote(remoteEp, 'rhtoolkit/state', 'GET')) as typeof overview
            } catch (err) {
              remoteErr = err instanceof Error ? err.message : String(err)
            }
            const settingsSchema = [
              {
                key: 'remoteEndpoint',
                label: { zh: '云端工具箱节点地址 (Tailscale 直连)', en: 'RHToolkit Node Endpoint' },
                hint: { zh: '下载任务与视频 Range 流自动走此节点专线转发', en: 'Remote endpoint of the node hosting RHToolkit' },
                type: 'text',
                defaultValue: String(packDefaults.remoteEndpoint ?? privateToolkitMod.DEFAULT_RHTOOLKIT_CONFIG.remoteEndpoint),
              },
              {
                key: 'rootDir',
                label: { zh: 'RHToolkit 根目录', en: 'RHToolkit Root Directory' },
                type: 'text',
                defaultValue: String(packDefaults.rootDir ?? privateToolkitMod.DEFAULT_RHTOOLKIT_CONFIG.rootDir),
              },
              {
                key: 'proxyUrl',
                label: { zh: 'yt-dlp 出站代理地址', en: 'yt-dlp Outbound Proxy URL' },
                type: 'text',
                defaultValue: String(packDefaults.proxyUrl ?? privateToolkitMod.DEFAULT_RHTOOLKIT_CONFIG.proxyUrl),
              },
              {
                key: 'compressionLevel',
                label: { zh: '7z 归档压缩等级 (1-9)', en: '7z Compression Level (1-9)' },
                type: 'number',
                defaultValue: Number(packDefaults.compressionLevel ?? privateToolkitMod.DEFAULT_RHTOOLKIT_CONFIG.compressionLevel),
              },
            ]
            const settingsValues = Object.fromEntries(
              settingsSchema.map(f => [f.key, savedCfg[f.key] !== undefined ? savedCfg[f.key] : f.defaultValue]),
            )
            sendJson(res, 200, {
              pluginId,
              enabled,
              statusMetrics: [
                {
                  label: { zh: '宿主节点与引擎状态', en: 'Host Node & Tools' },
                  value: overview
                    ? `🟢 ${overview.nodeHost} (bbdown:${overview.toolsAvailable.bbdown ? '✓' : '×'} · yt-dlp:${overview.toolsAvailable.ytdlp ? '✓' : '×'} · 7z:${overview.toolsAvailable.sevenZip ? '✓' : '×'})`
                    : `⚪ 未连接 (${remoteErr ?? 'offline'})`,
                  tone: overview ? 'success' : 'warning',
                },
                {
                  label: { zh: '云端媒体库规模 (downloads/)', en: 'Media Library Size' },
                  value: overview
                    ? `${overview.totalDownloadFiles} 个文件 · ${(overview.totalDownloadSizeMb / 1024).toFixed(2)} GB`
                    : '—',
                  tone: 'info',
                },
                {
                  label: { zh: '磁盘剩余 / 备份归档', en: 'Disk Free & Backups' },
                  value: overview
                    ? `剩余 ${overview.diskFreeGb ?? '?'} GB · 备份 ${overview.backups.length} 份`
                    : '—',
                  tone: 'info',
                },
              ],
              statusItems: (overview?.recentHistory ?? []).slice(0, 10).map((h, i) => ({
                id: `hist-${i}`,
                badge: h.success ? '成功' : '失败',
                badgeTone: h.success ? 'success' : 'danger',
                title: h.command,
                subtitle: `${h.fileCount} 个文件`,
                time: h.timestamp,
              })),
              actions: overview?.downloadTask.running
                ? [
                    {
                      id: 'rhtoolkit-cancel-download',
                      label: { zh: '⏹ 取消当前正在运行的下载任务', en: '⏹ Cancel Active Download' },
                      variant: 'outline',
                    },
                  ]
                : [],
              settingsSchema,
              settingsValues,
            })
            return
          }

          if (pluginId === 'dsh-clawfeed') {
            const repo = inspectClawFeedPluginRepo()
            const items = runtime.store.get(KV.clawfeed.items) ?? []
            const sinkEndpoints = getClawFeedSinkEndpoints()
            let sinkHealth: { status?: string; backend?: string; queued?: number; paused?: boolean } | undefined
            for (const base of sinkEndpoints) {
              try {
                const hRes = await fetch(`${base.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(2000) })
                if (hRes.ok) {
                  sinkHealth = await hRes.json()
                  break
                }
              } catch {}
            }
            const settingsSchema = [
              {
                key: 'forwardOtpToFeishuDm',
                label: { zh: '收到手机验证码时同步转发至飞书私聊', en: 'Forward OTP to Feishu DM' },
                hint: { zh: '开启后，收到 [验证码] 短信时同时通过飞书机器人私聊推给操作员（网页通知统一在独立「📱 手机通知」页展示）', en: 'Also forward [验证码] SMS to operator Feishu DM' },
                type: 'boolean',
                defaultValue: false,
              },
              {
                key: 'maxRetained',
                label: { zh: '环形缓冲区最大保留条数', en: 'Max Retained Notifications' },
                type: 'number',
                defaultValue: 200,
              },
              {
                key: 'sinkEndpoint',
                label: { zh: 'ClawFeed Sink 服务地址', en: 'ClawFeed Sink Endpoint' },
                type: 'text',
                defaultValue: sinkEndpoints[0] ?? 'http://127.0.0.1:8090',
              },
            ]
            const settingsValues = Object.fromEntries(
              settingsSchema.map(f => [f.key, savedCfg[f.key] !== undefined ? savedCfg[f.key] : f.defaultValue]),
            )
            sendJson(res, 200, {
              pluginId,
              enabled,
              statusMetrics: [
                {
                  label: { zh: 'Sink 网关状态 (:8090)', en: 'Sink Status (:8090)' },
                  value: sinkHealth ? (sinkHealth.paused ? '⏸ 已暂停 (sink-paused)' : `🟢 运行中 (${sinkHealth.backend ?? 'rharness'})`) : '⚪ 离线或未响应',
                  tone: sinkHealth ? (sinkHealth.paused ? 'warning' : 'success') : 'neutral',
                },
                {
                  label: { zh: '独立 Git 仓库版本', en: 'Plugin Git Repo' },
                  value: repo.found ? `${repo.repoPath} (${repo.branch ?? 'main'} @ ${repo.commit ?? 'HEAD'})` : 'external-sink',
                  tone: 'info',
                },
                {
                  label: { zh: '已缓冲手机通知', en: 'Buffered Notifications' },
                  value: `共 ${items.length} 条（验证码 ${items.filter(i => i.tag === '验证码').length} · 重要 ${items.filter(i => i.tag === '重要').length} · 普通 ${items.filter(i => i.tag === '普通').length}）`,
                  tone: 'info',
                },
              ],
              statusItems: items.slice(0, 12).map(item => ({
                id: item.id,
                badge: item.tag,
                badgeTone: item.tag === '验证码' ? 'warning' : item.tag === '重要' ? 'success' : 'neutral',
                title: item.message,
                subtitle: `user: ${item.user}`,
                time: item.at,
              })),
              actions: [
                {
                  id: sinkHealth?.paused ? 'resume-sink' : 'pause-sink',
                  label: sinkHealth?.paused
                    ? { zh: '▶ 恢复接收手机通知 (解除 sink-paused)', en: '▶ Resume Sink' }
                    : { zh: '⏸ 暂停接收手机通知 (开启 sink-paused)', en: '⏸ Pause Sink' },
                  variant: 'outline',
                },
                {
                  id: 'test-otp',
                  label: { zh: '🧪 发送一条模拟验证码通知测试链路', en: '🧪 Send Test OTP Notification' },
                  variant: 'primary',
                },
              ],
              settingsSchema,
              settingsValues,
            })
            return
          }

          if (pluginId === 'dsh-personal-skills') {
            let feishuStatus = getFeishuBridgeRuntimeStatus()
            const fallbackPeers = loadPrivatePack()?.manifest.personalPaths?.peerFallbackEndpoints ?? []
            if (!feishuStatus.configured && url.searchParams.get('localOnly') !== '1') {
              for (const base of fallbackPeers) {
                try {
                  const remoteRes = await fetch(`${base.replace(/\/+$/, '')}/orchestrator/standalone/plugins/dsh-personal-skills/panel?localOnly=1`, {
                    headers: { 'x-orchestrator-request': '1' },
                    signal: AbortSignal.timeout(2500),
                  })
                  if (remoteRes.ok) {
                    const remoteData = await remoteRes.json() as { feishuBridgeStatus?: typeof feishuStatus }
                    if (remoteData.feishuBridgeStatus) {
                      feishuStatus = remoteData.feishuBridgeStatus
                      break
                    }
                  }
                } catch {}
              }
            }
            const settingsSchema = [
              {
                key: 'autoReplyFeishuDm',
                label: { zh: '飞书私聊消息自动接入个人助理并回推回复', en: 'Auto-Reply to Feishu DM via Personal Assistant' },
                type: 'boolean',
                defaultValue: true,
              },
              {
                key: 'ownerOpenId',
                label: { zh: '操作员飞书 Open ID (安全白名单)', en: 'Operator Feishu Open ID' },
                type: 'text',
                defaultValue: feishuStatus.ownerOpenId ?? '',
              },
              {
                key: 'preferNode',
                label: { zh: '个人业务脚本执行节点', en: 'Personal Skills Execution Node' },
                type: 'select',
                options: [
                  { value: 'hub', label: '常驻主控节点 (Always-On Hub)' },
                  { value: 'local', label: '仅限本机' },
                ],
                defaultValue: 'hub',
              },
            ]
            const settingsValues = Object.fromEntries(
              settingsSchema.map(f => [f.key, savedCfg[f.key] !== undefined ? savedCfg[f.key] : f.defaultValue]),
            )
            sendJson(res, 200, {
              pluginId,
              enabled,
              feishuBridgeStatus: feishuStatus,
              statusMetrics: [
                {
                  label: { zh: '飞书 WebSocket 长连接 (pbbp2)', en: 'Feishu WebSocket (pbbp2)' },
                  value: feishuStatus.wsConnected
                    ? `🟢 已连接 msg-frontier.feishu.cn (${feishuStatus.appId ?? ''})`
                    : feishuStatus.configured
                      ? '🟡 正在重连飞书 WebSocket…'
                      : '🟢 已通过 claw 节点桥接',
                  tone: feishuStatus.wsConnected ? 'success' : 'info',
                },
                {
                  label: { zh: '最近心跳 Pong / 收到消息数', en: 'Last Pong / Received DMs' },
                  value: `已收 ${feishuStatus.receivedCount} 条私聊${feishuStatus.lastPongAt ? ` · 心跳 ${feishuStatus.lastPongAt.slice(11, 19)}` : ''}`,
                  tone: 'info',
                },
                {
                  label: { zh: '已挂载确定性业务脚本', en: 'Mounted Deterministic Tools' },
                  value: '11 项 (待办 / 双邮箱 / 日历 / 行情 / 订单月报 / PDF OCR / StepFun 转写 / 兴趣查重 / 飞书私聊)',
                  tone: 'success',
                },
              ],
              statusItems: [],
              actions: [
                {
                  id: 'send-feishu-test',
                  label: { zh: '📨 向主人飞书发一条测试私聊消息', en: '📨 Send Test Feishu DM' },
                  variant: 'primary',
                },
              ],
              settingsSchema,
              settingsValues,
            })
            return
          }

          if (pluginId === 'dsh-runtime-guard') {
            const st = getRuntimeGuardStats()
            const settingsSchema = [
              {
                key: 'enableTokenjuice',
                label: { zh: '开启 Tokenjuice 工具输出智能脱水压缩', en: 'Enable Tokenjuice Output Compaction' },
                hint: { zh: '自动清除 ANSI 控制码、折叠连续重复日志，并对超长工具输出保留头尾与诊断信息', en: 'Strips ANSI codes and middle-truncates noisy outputs' },
                type: 'boolean',
                defaultValue: true,
              },
              {
                key: 'tokenjuiceMaxChars',
                label: { zh: '单次工具输出最大保留字符数阈值', en: 'Tokenjuice Max Characters per Output' },
                type: 'number',
                defaultValue: 10000,
              },
              {
                key: 'maxIdenticalToolRepeats',
                label: { zh: 'Loop Detection 连续相同参数调用熔断阈值', en: 'Max Identical Tool Repeats Before Break' },
                type: 'number',
                defaultValue: 3,
              },
              {
                key: 'enableAntiInjection',
                label: { zh: '开启外部内容 (邮件/网页/笔记) 提示注入防御清洗', en: 'Enable External Prompt-Injection Sanitizer' },
                type: 'boolean',
                defaultValue: true,
              },
            ]
            const settingsValues = Object.fromEntries(
              settingsSchema.map(f => [f.key, savedCfg[f.key] !== undefined ? savedCfg[f.key] : f.defaultValue]),
            )
            sendJson(res, 200, {
              pluginId,
              enabled,
              statusMetrics: [
                {
                  label: { zh: 'Tokenjuice 累计节省估算', en: 'Estimated Tokens Saved' },
                  value: `${st.estimatedTokensSaved} Tokens（压缩 ${st.compactedCalls} 次输出）`,
                  tone: 'success',
                },
                {
                  label: { zh: 'Loop Detection 死循环熔断', en: 'Infinite Loops Broken' },
                  value: `${st.loopsBroken} 次拦截`,
                  tone: st.loopsBroken > 0 ? 'warning' : 'info',
                },
                {
                  label: { zh: 'Anti-Injection 提示注入净化', en: 'Prompt Injections Neutralized' },
                  value: `${st.injectionsNeutralized} 处已净化`,
                  tone: 'success',
                },
              ],
              statusItems: st.recentEvents.slice(0, 12).map(ev => ({
                id: ev.id,
                badge: ev.kind,
                badgeTone: ev.kind === 'loop-breaker' ? 'warning' : ev.kind === 'anti-injection' ? 'info' : 'success',
                title: `[${ev.toolName}] ${ev.detail}`,
                subtitle: ev.sessionId,
                time: ev.at,
              })),
              actions: [],
              settingsSchema,
              settingsValues,
            })
            return
          }

          if (pluginId === 'dsh-model-usage') {
            const usage = getModelUsageState()
            const entries = Object.values(usage.byModelRole).sort((a, b) => b.estimatedCostCny - a.estimatedCostCny)
            const totalTurns = entries.reduce((s, e) => s + e.turns, 0)
            const totalCost = entries.reduce((s, e) => s + e.estimatedCostCny, 0)
            const totalTokens = entries.reduce((s, e) => s + e.estimatedInputTokens + e.estimatedOutputTokens, 0)
            sendJson(res, 200, {
              pluginId,
              enabled,
              statusMetrics: [
                {
                  label: { zh: '累计估算总费用 (CNY)', en: 'Total Estimated Cost' },
                  value: `¥${totalCost.toFixed(4)}`,
                  tone: 'success',
                },
                {
                  label: { zh: '累计推理回合数', en: 'Total Model Turns' },
                  value: `${totalTurns} 回合`,
                  tone: 'info',
                },
                {
                  label: { zh: '累计估算总 Token 量', en: 'Total Estimated Tokens' },
                  value: `${totalTokens.toLocaleString()} Tokens`,
                  tone: 'info',
                },
              ],
              statusItems: entries.map(e => ({
                id: e.key,
                badge: e.role.toUpperCase(),
                badgeTone: e.role === 'assistant' ? 'info' : e.role === 'worker' ? 'success' : 'neutral',
                title: `${e.provider} / ${e.model} · ¥${e.estimatedCostCny.toFixed(4)}`,
                subtitle: `${e.turns} turns · in:${e.estimatedInputTokens} / out:${e.estimatedOutputTokens} tok`,
                time: e.lastUsedAt,
              })),
              actions: [
                {
                  id: 'reset-model-usage',
                  label: { zh: '🧹 清零本地成本统计账单', en: '🧹 Reset Usage Counters' },
                  variant: 'outline',
                },
              ],
              settingsSchema: [],
              settingsValues: {},
            })
            return
          }

          if (pluginId === 'dsh-lossless-context') {
            const dag = getLcmDag()
            const settingsSchema = [
              {
                key: 'freshTailCount',
                label: { zh: '保留未压缩最新原始消息条数 (freshTailCount)', en: 'Fresh Uncompressed Tail Messages' },
                type: 'number',
                defaultValue: 6,
              },
              {
                key: 'chunkSize',
                label: { zh: 'L1 叶子节点归并步长 (chunkSize)', en: 'L1 Summary Chunk Size' },
                type: 'number',
                defaultValue: 6,
              },
            ]
            const settingsValues = Object.fromEntries(
              settingsSchema.map(f => [f.key, savedCfg[f.key] !== undefined ? savedCfg[f.key] : f.defaultValue]),
            )
            sendJson(res, 200, {
              pluginId,
              enabled,
              statusMetrics: [
                {
                  label: { zh: 'DAG 摘要树节点总数', en: 'Total DAG Summary Nodes' },
                  value: `${dag.nodes.length} 个节点 (L1: ${dag.nodes.filter(n => n.level === 1).length} · L2+: ${dag.nodes.filter(n => n.level >= 2).length})`,
                  tone: 'success',
                },
                {
                  label: { zh: '已无损覆盖历史消息数', en: 'Losslessly Indexed Messages' },
                  value: `${dag.coveredMessageIds.length} 条原始消息可随时展开`,
                  tone: 'info',
                },
              ],
              statusItems: [...dag.nodes].reverse().slice(0, 10).map(n => ({
                id: n.id,
                badge: `L${n.level}`,
                badgeTone: n.level >= 2 ? 'success' : 'info',
                title: `${n.title} — ${n.summary.slice(0, 120)}`,
                subtitle: `${n.sourceMessageIds.length} msgs`,
                time: n.createdAt,
              })),
              actions: [
                {
                  id: 'rebuild-lcm-dag',
                  label: { zh: '🌳 立即对历史对话执行无损 DAG 归并', en: '🌳 Build Lossless DAG Now' },
                  variant: 'primary',
                },
              ],
              settingsSchema,
              settingsValues,
            })
            return
          }

          if (pluginId === 'dsh-self-improving') {
            const learnings = getLearnings()
            const pendingCount = learnings.filter(l => l.status === 'pending').length
            const promotedCount = learnings.filter(l => l.status === 'promoted').length
            sendJson(res, 200, {
              pluginId,
              enabled,
              statusMetrics: [
                {
                  label: { zh: '待审阅纠偏与踩坑记录', en: 'Pending Learnings' },
                  value: `${pendingCount} 条待晋升`,
                  tone: pendingCount > 0 ? 'warning' : 'info',
                },
                {
                  label: { zh: '已晋升为常驻记忆规则', en: 'Promoted to Memory' },
                  value: `${promotedCount} 条复利规则`,
                  tone: 'success',
                },
                {
                  label: { zh: '/btw 零污染旁路快问', en: 'Ephemeral /btw Side Questions' },
                  value: '🟢 已启用（飞书或网页发 /btw 提问即刻生效）',
                  tone: 'success',
                },
              ],
              statusItems: learnings.slice(0, 15).map(l => ({
                id: l.id,
                badge: l.status === 'promoted' ? '✓ 已晋升' : l.kind,
                badgeTone: l.status === 'promoted' ? 'success' : l.kind === 'correction' ? 'warning' : 'info',
                title: `${l.title} — ${l.suggestedRule}`,
                subtitle: `出现 ${l.occurrences} 次`,
                time: l.updatedAt,
              })),
              actions:
                pendingCount > 0
                  ? [
                      {
                        id: 'promote-all-learnings',
                        label: { zh: `🚀 将 ${pendingCount} 条待审阅经验一键晋升为常驻记忆`, en: `🚀 Promote ${pendingCount} Learnings to Memory` },
                        variant: 'primary',
                      },
                    ]
                  : [],
              settingsSchema: [],
              settingsValues: {},
            })
            return
          }

          if (pluginId === 'dsh-web-research') {
            const settingsSchema = [
              {
                key: 'tavilyApiKey',
                label: { zh: 'Tavily Search API Key (可选 · 填后优先走 Tavily AI 搜索)', en: 'Tavily API Key (Optional)' },
                type: 'text',
                defaultValue: '',
              },
              {
                key: 'searxngUrl',
                label: { zh: '自建 SearXNG 实例地址 (可选 · 如 http://192.168.0.x:8080)', en: 'Self-Hosted SearXNG URL (Optional)' },
                type: 'text',
                defaultValue: '',
              },
            ]
            const settingsValues = Object.fromEntries(
              settingsSchema.map(f => [f.key, savedCfg[f.key] !== undefined ? savedCfg[f.key] : f.defaultValue]),
            )
            sendJson(res, 200, {
              pluginId,
              enabled,
              statusMetrics: [
                {
                  label: { zh: '当前活跃搜索引擎链', en: 'Active Search Fallback Chain' },
                  value: settingsValues.tavilyApiKey
                    ? '🟢 Tavily AI -> DuckDuckGo'
                    : settingsValues.searxngUrl
                      ? '🟢 SearXNG -> DuckDuckGo'
                      : '🟢 零配置 DuckDuckGo 实时联网',
                  tone: 'success',
                },
                {
                  label: { zh: '正文净化引擎 (Readability)', en: 'Web Readability Extractor' },
                  value: '🟢 自动剥离导航栏/脚本/广告 + 防注入清洗',
                  tone: 'success',
                },
              ],
              statusItems: [],
              actions: [],
              settingsSchema,
              settingsValues,
            })
            return
          }

          if (pluginId === 'dsh-browser-bridge') {
            const localBrowser = await inspectLocalBrowserBridge()
            sendJson(res, 200, {
              pluginId,
              enabled,
              statusMetrics: [
                {
                  label: { zh: '本机 Chrome CDP / 扩展中继状态', en: 'Local Chrome Bridge' },
                  value: localBrowser.connected
                    ? `🟢 已连接 (${localBrowser.endpoint} · ${localBrowser.tabCount} 个标签页)`
                    : '⚪ 未检测到 :9222 / :18799（调用时自动回退检测 claw 节点）',
                  tone: localBrowser.connected ? 'success' : 'neutral',
                },
              ],
              statusItems: localBrowser.tabs.slice(0, 10).map(t => ({
                id: t.id,
                badge: 'TAB',
                badgeTone: 'info',
                title: t.title || t.url,
                subtitle: t.url.slice(0, 80),
              })),
              actions: [],
              settingsSchema: [],
              settingsValues: {},
            })
            return
          }

          // Default generic self-owned panel for other plugins (Memory, Model Profiles, Device Group, etc.)
          const memoriesList = getMemoryEntries()
          const settingsSchema = [
            {
              key: 'autoRecallTopK',
              label: { zh: '每轮对话混合自动召回条数 (Auto-Recall Top-K)', en: 'Per-Turn Auto-Recall Top-K' },
              type: 'number',
              defaultValue: 4,
            },
            {
              key: 'autoExtractFromChat',
              label: { zh: '从用户对话自动高信噪比提炼偏好与周期提醒', en: 'High-SNR Auto-Extract from User Chat' },
              type: 'boolean',
              defaultValue: true,
            },
            {
              key: 'ollamaEmbeddingUrl',
              label: { zh: '局域网 Ollama 向量服务地址 (可选)', en: 'LAN Ollama Embedding URL' },
              type: 'text',
              defaultValue: 'http://127.0.0.1:11434',
            },
          ]
          const settingsValues = Object.fromEntries(
            settingsSchema.map(f => [f.key, savedCfg[f.key] !== undefined ? savedCfg[f.key] : f.defaultValue]),
          )
          sendJson(res, 200, {
            pluginId,
            enabled,
            statusMetrics: [
              {
                label: { zh: '插件运行状态', en: 'Plugin Status' },
                value: enabled ? '🟢 已启用并挂载' : '⚪ 已停用',
                tone: enabled ? 'success' : 'neutral',
              },
              {
                label: { zh: '长期记忆与常驻注入', en: 'Long-Term Memories' },
                value: `${memoriesList.length} 条记忆 (${memoriesList.filter(m => m.pinned).length} 条常驻 Prompt)`,
                tone: 'info',
              },
              {
                label: { zh: '外脑知识源 (SiYuan 双实例)', en: 'SiYuan Dual Instances' },
                value: '🏠 家庭共用 (siyuan) + 🔒 个人私有 (siyuan_rh)',
                tone: 'success',
              },
            ],
            statusItems: [],
            actions:
              pluginId === 'dsh-memory'
                ? [
                    {
                      id: 'consolidate-memory',
                      label: { zh: '✨ 立即运行记忆提炼与去重整理', en: '✨ Consolidate & Dedupe Memories' },
                      variant: 'primary',
                    },
                  ]
                : [],
            settingsSchema,
            settingsValues,
          })
          return
        }

        if (req.method === 'POST' && sub.startsWith('plugins/') && sub.endsWith('/config')) {
          const pluginId = decodeURIComponent(sub.slice('plugins/'.length, -'/config'.length))
          const body = await readJsonBody(req, 256 * 1024)
          const values = (typeof body.values === 'object' && body.values !== null ? body.values : body) as Record<string, unknown>
          const prev = runtime.store.get(KV.plugins.config(pluginId)) ?? {}
          const merged = { ...prev, ...values }
          runtime.store.set(KV.plugins.config(pluginId), merged)
          sendJson(res, 200, { ok: true, pluginId, settingsValues: merged })
          return
        }

        if (req.method === 'POST' && sub.startsWith('plugins/') && sub.endsWith('/action')) {
          const pluginId = decodeURIComponent(sub.slice('plugins/'.length, -'/action'.length))
          const body = await readJsonBody(req, 256 * 1024)
          const actionId = String(body.actionId ?? '').trim()

          if (actionId === 'pause-sink' || actionId === 'resume-sink') {
            const out = await executePersonalSkillWithRemoteFallback(
              'clawfeed_pause',
              { paused: actionId === 'pause-sink' },
              getRegisteredNodes,
            )
            sendJson(res, 200, { ok: true, message: actionId === 'pause-sink' ? '已暂停 ClawFeed 接收' : '已恢复 ClawFeed 接收', result: out })
            return
          }

          if (actionId === 'test-otp') {
            const at = new Date().toISOString()
            const feedId = `feed-${Date.now()}`
            const sampleMsg = `[验证码][SMS ${at.slice(0, 10)}] 【RHarness】您的链路测试验证码为 839201，5分钟内有效。`
            const stored = runtime.store.get(KV.clawfeed.items) ?? []
            stored.unshift({ id: feedId, user: 'me', tag: '验证码', message: sampleMsg, at })
            runtime.store.set(KV.clawfeed.items, stored.slice(0, 200))
            void broadcastClawFeedStateToPeers('merge')
            sendJson(res, 200, { ok: true, message: '已注入模拟验证码通知并同步至「📱 手机通知」独立窗口' })
            return
          }

          if (actionId === 'send-feishu-test') {
            const out = await executePersonalSkillWithRemoteFallback(
              'feishu_send_dm',
              { text: `✅ [RHarness 飞书直连测试] 来自 ${getDeviceIdentity().deviceName}：飞书 WebSocket 与私聊回复链路已就绪！您现在可以直接在飞书私聊向我发送任何问题或待办指令。` },
              getRegisteredNodes,
            )
            sendJson(res, 200, { ok: true, message: '已向您的飞书私聊发送测试消息', result: out })
            return
          }

          if (actionId === 'consolidate-memory') {
            const allMsgs = (runtime.store.get(KV.assistant.messages) ?? []).map(m => ({
              id: m.id,
              sender: m.sender,
              ...(m.bot ? { bot: true } : {}),
              text: m.text,
              at: m.at,
            }))
            const resCons = consolidateMemories(
              getMemoryEntries(),
              allMsgs,
              removed => { archiveMemoriesToBackupDir(stateDir, removed, 'single-delete') },
            )
            setMemoryEntries(resCons.list)
            sendJson(res, 200, {
              ok: true,
              message: `提炼完成：新增 ${resCons.extractedCount} 条，合并 ${resCons.mergedCount} 条，清理噪音 ${resCons.purgedNoiseCount} 条`,
            })
            return
          }

          if (actionId === 'reset-model-usage') {
            runtime.store.set(KV.modelUsage.state, defaultModelUsageState())
            sendJson(res, 200, { ok: true, message: '已重置本地模型 Token 与成本统计账单' })
            return
          }

          if (actionId === 'rebuild-lcm-dag') {
            const allMsgs = runtime.store.get(KV.assistant.messages) ?? []
            const lcmCfg = runtime.store.get(KV.plugins.config('dsh-lossless-context')) ?? {}
            const rebuilt = ingestMessagesIntoLcmDag(
              defaultLcmDagState(),
              allMsgs,
              Number(lcmCfg.freshTailCount ?? 4),
              Number(lcmCfg.chunkSize ?? 4),
            )
            runtime.store.set(KV.lossless.dag, rebuilt)
            sendJson(res, 200, {
              ok: true,
              message: `无损 DAG 构建完成：生成 ${rebuilt.nodes.length} 个摘要节点，覆盖 ${rebuilt.coveredMessageIds.length} 条历史消息`,
            })
            return
          }

          if (actionId === 'promote-all-learnings') {
            const learnings = getLearnings()
            let mems = getMemoryEntries()
            let count = 0
            const updatedLearnings = learnings.map(l => {
              if (l.status !== 'pending') return l
              const saved = saveMemoryEntry(mems, {
                title: l.title,
                content: l.suggestedRule,
                category: 'preference',
                tags: ['self-improving', l.kind],
                pinned: true,
                source: 'user',
              })
              mems = saved.list
              count++
              return { ...l, status: 'promoted' as const, promotedMemoryId: saved.entry.id, updatedAt: new Date().toISOString() }
            })
            setMemoryEntries(mems)
            setLearnings(updatedLearnings)
            sendJson(res, 200, {
              ok: true,
              message: `已将 ${count} 条经验记录晋升为常驻记忆规则`,
            })
            return
          }

          if (actionId === 'rhtoolkit-cancel-download' && privateToolkitMod) {
            const packDefaults: Partial<PrivatePackRHToolkitSpec> = loadPrivatePack()?.manifest.rhtoolkit ?? {}
            const rawCfg: Record<string, unknown> = { ...packDefaults, ...(runtime.store.get(KV.plugins.config('dsh-rhtoolkit')) ?? {}) }
            const out = privateToolkitMod.isToolkitHostedLocally(rawCfg)
              ? privateToolkitMod.cancelLocalToolkitDownload()
              : await privateToolkitMod.proxyToolkitJsonToRemote<{ ok: boolean; message: string }>(
                  String(rawCfg.remoteEndpoint || privateToolkitMod.DEFAULT_RHTOOLKIT_CONFIG.remoteEndpoint),
                  'rhtoolkit/cancel',
                  'POST',
                  {},
                )
            sendJson(res, 200, out)
            return
          }

          sendJson(res, 400, { error: `Unknown plugin action: ${actionId}` })
          return
        }

        // Optional Private Pack RHToolkit routes (active only when `~/.rharness/private-pack` mounts `rhtoolkit`)
        if (sub.startsWith('rhtoolkit/')) {
          if (!privateToolkitMod) {
            sendJson(res, 404, { error: 'Private pack extension (rhtoolkit) is not installed on this deployment' })
            return
          }
          if (!isPluginEnabled('dsh-rhtoolkit')) {
            sendJson(res, 403, { error: 'RHToolkit plugin (dsh-rhtoolkit) is disabled' })
            return
          }
          const packDefaults: Partial<PrivatePackRHToolkitSpec> = loadPrivatePack()?.manifest.rhtoolkit ?? {}
          const rawCfg: Record<string, unknown> = { ...packDefaults, ...(runtime.store.get(KV.plugins.config('dsh-rhtoolkit')) ?? {}) }
          const localHost = privateToolkitMod.isToolkitHostedLocally(rawCfg)
          const remoteEp = String(rawCfg.remoteEndpoint || privateToolkitMod.DEFAULT_RHTOOLKIT_CONFIG.remoteEndpoint)

          if ((req.method === 'GET' || req.method === 'HEAD') && sub === 'rhtoolkit/stream') {
            const kindParam = url.searchParams.get('kind')
            const kind: 'download' | 'backup' | 'zip' =
              kindParam === 'backup' ? 'backup' : kindParam === 'zip' ? 'zip' : 'download'
            const relPath = url.searchParams.get('path') ?? ''
            const asAttachment = url.searchParams.get('dl') === '1'
            if (localHost) {
              privateToolkitMod.serveLocalToolkitStream(req, res, { kind, relativePath: relPath, asAttachment }, rawCfg)
            } else {
              privateToolkitMod.proxyToolkitStreamToRemote(
                remoteEp,
                `/orchestrator/standalone/rhtoolkit/stream?${url.searchParams.toString()}`,
                req,
                res,
              )
            }
            return
          }

          if (req.method === 'GET' && sub === 'rhtoolkit/state') {
            const state = localHost
              ? privateToolkitMod.getLocalToolkitOverview(rawCfg)
              : await privateToolkitMod.proxyToolkitJsonToRemote(remoteEp, 'rhtoolkit/state', 'GET')
            sendJson(res, 200, state)
            return
          }

          if (req.method === 'POST' && sub === 'rhtoolkit/download') {
            const body = await readJsonBody(req, 64 * 1024)
            const out = localHost
              ? privateToolkitMod.startLocalToolkitDownload(
                  {
                    target: String(body.target ?? ''),
                    ...(typeof body.subfolder === 'string' ? { subfolder: body.subfolder } : {}),
                    ...(typeof body.quality === 'string' ? { quality: body.quality } : {}),
                  },
                  rawCfg,
                )
              : await privateToolkitMod.proxyToolkitJsonToRemote(remoteEp, 'rhtoolkit/download', 'POST', body)
            sendJson(res, 200, out)
            return
          }

          if (req.method === 'POST' && sub === 'rhtoolkit/cancel') {
            const out = localHost
              ? privateToolkitMod.cancelLocalToolkitDownload()
              : await privateToolkitMod.proxyToolkitJsonToRemote(remoteEp, 'rhtoolkit/cancel', 'POST', {})
            sendJson(res, 200, out)
            return
          }

          if (req.method === 'POST' && sub === 'rhtoolkit/space-fetch') {
            const body = await readJsonBody(req, 64 * 1024)
            const out = localHost
              ? await privateToolkitMod.fetchLocalBilibiliSpaceVideos(String(body.spaceUrl ?? ''), rawCfg)
              : await privateToolkitMod.proxyToolkitJsonToRemote(remoteEp, 'rhtoolkit/space-fetch', 'POST', body)
            sendJson(res, 200, out)
            return
          }

          if (req.method === 'POST' && sub === 'rhtoolkit/space-download') {
            const body = await readJsonBody(req, 256 * 1024)
            const out = localHost
              ? privateToolkitMod.startLocalBilibiliSpaceBatchDownload(
                  {
                    uid: String(body.uid ?? ''),
                    ...(typeof body.username === 'string' ? { username: body.username } : {}),
                    bvIds: Array.isArray(body.bvIds) ? body.bvIds.map(String) : [],
                  },
                  rawCfg,
                )
              : await privateToolkitMod.proxyToolkitJsonToRemote(remoteEp, 'rhtoolkit/space-download', 'POST', body)
            sendJson(res, 200, out)
            return
          }

          if (req.method === 'POST' && sub === 'rhtoolkit/zip') {
            const body = await readJsonBody(req, 64 * 1024)
            const out = localHost
              ? privateToolkitMod.prepareLocalZipJob(
                  {
                    ...(typeof body.folder === 'string' ? { folder: body.folder } : {}),
                    videosOnly: Boolean(body.videosOnly),
                  },
                  rawCfg,
                )
              : await privateToolkitMod.proxyToolkitJsonToRemote(remoteEp, 'rhtoolkit/zip', 'POST', body)
            sendJson(res, 200, out)
            return
          }

          if (req.method === 'POST' && sub === 'rhtoolkit/backup') {
            const body = await readJsonBody(req, 64 * 1024)
            const out = localHost
              ? privateToolkitMod.startLocalFolderBackup(
                  {
                    sourceFolder: String(body.sourceFolder ?? ''),
                    ...(typeof body.backupName === 'string' ? { backupName: body.backupName } : {}),
                  },
                  rawCfg,
                )
              : await privateToolkitMod.proxyToolkitJsonToRemote(remoteEp, 'rhtoolkit/backup', 'POST', body)
            sendJson(res, 200, out)
            return
          }

          if (req.method === 'POST' && sub === 'rhtoolkit/delete') {
            const body = await readJsonBody(req, 64 * 1024)
            const out = localHost
              ? privateToolkitMod.deleteLocalToolkitItem(
                  {
                    kind: body.kind === 'backup' ? 'backup' : 'download',
                    relativePath: String(body.relativePath ?? ''),
                  },
                  rawCfg,
                )
              : await privateToolkitMod.proxyToolkitJsonToRemote(remoteEp, 'rhtoolkit/delete', 'POST', body)
            sendJson(res, 200, out)
            return
          }

          if (req.method === 'POST' && sub === 'rhtoolkit/rename-folder') {
            const body = await readJsonBody(req, 64 * 1024)
            const out = localHost
              ? privateToolkitMod.renameLocalToolkitFolder(
                  {
                    oldFolder: String(body.oldFolder ?? ''),
                    newFolder: String(body.newFolder ?? ''),
                  },
                  rawCfg,
                )
              : await privateToolkitMod.proxyToolkitJsonToRemote(remoteEp, 'rhtoolkit/rename-folder', 'POST', body)
            sendJson(res, 200, out)
            return
          }
        }

        // Model Configuration Profiles (Preset 1, 2, 3) & Peak/Off-Peak Time-Slot Scheduler endpoints
        if (req.method === 'GET' && sub === 'model-profiles') {
          sendJson(res, 200, resolveActiveRoleModels().profilesState)
          return
        }

        if (req.method === 'PUT' && sub === 'model-profiles') {
          const body = await readJsonBody(req, 1024 * 1024)
          const currentSettings = runtime.store.settings()
          const fallback = { eval: currentSettings.eval.model, executor: currentSettings.executor.model }
          const defaults = defaultModelProfilesConfig(fallback)
          const existing = runtime.store.get(KV.modelProfiles.config) ?? defaults
          const rawProfiles = Array.isArray(body.profiles) ? body.profiles as ModelProfilesConfig['profiles'] : existing.profiles
          const dayModeOverride = (
            body.dayModeOverride === 'auto' || body.dayModeOverride === 'force-workday' || body.dayModeOverride === 'force-holiday'
              ? body.dayModeOverride
              : (existing.dayModeOverride ?? 'auto')
          ) as DayModeOverride
          const customHolidays = Array.isArray(body.customHolidays)
            ? body.customHolidays.map(s => String(s).trim()).filter(Boolean)
            : (existing.customHolidays ?? [])
          const customWorkdays = Array.isArray(body.customWorkdays)
            ? body.customWorkdays.map(s => String(s).trim()).filter(Boolean)
            : (existing.customWorkdays ?? [])
          const nextConfig: ModelProfilesConfig = {
            activeProfileId: typeof body.activeProfileId === 'string' ? body.activeProfileId : existing.activeProfileId,
            dayModeOverride,
            customHolidays,
            customWorkdays,
            profiles: rawProfiles.map(p =>
              normalizeProfileGroup(p, defaults.profiles[0]!.eval.defaultModel, defaults.profiles[0]!.executor.defaultModel),
            ),
          }
          runtime.store.set(KV.modelProfiles.config, nextConfig)
          const resolved = resolveEffectiveModelProfile(nextConfig, fallback)
          runtime.store.saveSettings(SettingsSchema.parse({
            ...currentSettings,
            eval: { ...currentSettings.eval, model: resolved.evalModel },
            executor: { ...currentSettings.executor, model: resolved.executorModel },
          }))
          sendJson(res, 200, { config: nextConfig, ...resolved })
          return
        }

        // Decentralized Device Group endpoints (modeled after RHFiles `groups.rs` & `invitations.rs`)
        if (req.method === 'GET' && sub === 'device-group') {
          const identity = getDeviceIdentity()
          const packet = runtime.store.get(KV.deviceGroup.packet)
          const members = packet ? verifyAndExtractGroupMembers(packet) : []
          sendJson(res, 200, {
            identity: {
              deviceId: identity.deviceId,
              deviceName: identity.deviceName,
              hostname: identity.hostname,
              ...(identity.tailscaleDnsName ? { tailscaleDnsName: identity.tailscaleDnsName } : {}),
              tailscaleIps: identity.tailscaleIps,
              lanIps: identity.lanIps,
              endpoints: identity.endpoints,
              tags: identity.tags,
              gitUrl: identity.gitUrl,
            },
            packet,
            members,
          })
          return
        }

        if (req.method === 'POST' && sub === 'device-group/create') {
          const body = await readJsonBody(req, 1024 * 1024)
          const identity = getDeviceIdentity()
          if (typeof body.deviceName === 'string' && body.deviceName.trim()) {
            identity.deviceName = body.deviceName.trim()
          }
          if (Array.isArray(body.tags)) {
            identity.tags = body.tags.map(t => String(t).trim()).filter(Boolean)
          }
          runtime.store.set(KV.deviceGroup.identity, identity)
          const groupName = typeof body.groupName === 'string' && body.groupName.trim() ? body.groupName.trim() : 'RHarness 内网设备组'
          const packet = createDeviceGroup(identity, groupName)
          runtime.store.set(KV.deviceGroup.packet, packet)
          sendJson(res, 200, { packet, members: verifyAndExtractGroupMembers(packet), nodes: getRegisteredNodes() })
          return
        }

        if (req.method === 'POST' && sub === 'device-group/invite') {
          const body = await readJsonBody(req, 1024 * 1024)
          const identity = getDeviceIdentity()
          let packet = runtime.store.get(KV.deviceGroup.packet)
          if (!packet) {
            packet = createDeviceGroup(identity, 'RHarness 内网设备组')
            runtime.store.set(KV.deviceGroup.packet, packet)
          }
          const invitation = createGroupInvitation(identity, packet, body.canInvite !== false)
          sendJson(res, 200, { ...invitation, groupId: packet.groupId, groupName: packet.groupName })
          return
        }

        if (req.method === 'POST' && sub === 'device-group/redeem') {
          const body = await readJsonBody(req, 1024 * 1024)
          const identity = getDeviceIdentity()
          const packet = runtime.store.get(KV.deviceGroup.packet)
          if (!packet) throw new Error('本机尚未创建设备组')
          const updated = redeemGroupInvitation(
            identity,
            packet,
            String(body.token ?? ''),
            body.request as DeviceJoinRequest,
          )
          runtime.store.set(KV.deviceGroup.packet, updated)
          const updatedNodes = groupMembersToWorkerNodes(identity.deviceId, updated, runtime.store.get(KV.nodes.registry) ?? [])
          runtime.store.set(KV.nodes.registry, updatedNodes)
          void broadcastGroupPacketToPeers(identity.deviceId, updated)
          sendJson(res, 200, { packet: updated, members: verifyAndExtractGroupMembers(updated) })
          return
        }

        if (req.method === 'POST' && sub === 'device-group/join') {
          const body = await readJsonBody(req, 1024 * 1024)
          const uri = String(body.uri ?? '').trim()
          const identity = getDeviceIdentity()
          if (typeof body.deviceName === 'string' && body.deviceName.trim()) {
            identity.deviceName = body.deviceName.trim()
          }
          if (Array.isArray(body.tags)) {
            identity.tags = body.tags.map(t => String(t).trim()).filter(Boolean)
          } else if (typeof body.tags === 'string' && body.tags.trim()) {
            identity.tags = body.tags.split(/[\s,]+/).map(t => t.trim()).filter(Boolean)
          }
          runtime.store.set(KV.deviceGroup.identity, identity)
          const invitation = parseInvitationUri(uri)
          const joinReq = createJoinRequest(identity)
          let joinedPacket: DeviceGroupPacket | undefined
          let lastError = '无法连接邀请设备'
          for (const ep of invitation.endpoints) {
            try {
              const targetUrl = `${ep.replace(/\/+$/, '')}/orchestrator/standalone/device-group/redeem`
              const resp = await fetch(targetUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' },
                body: JSON.stringify({ token: invitation.token, request: joinReq }),
                signal: AbortSignal.timeout(8000),
              })
              const data = await resp.json() as { packet?: DeviceGroupPacket; error?: string }
              if (!resp.ok) throw new Error(data.error ?? `HTTP ${resp.status}`)
              if (data.packet) {
                verifyAndExtractGroupMembers(data.packet)
                joinedPacket = data.packet
                break
              }
            } catch (err) {
              lastError = err instanceof Error ? err.message : String(err)
            }
          }
          if (!joinedPacket) throw new Error(lastError)
          runtime.store.set(KV.deviceGroup.packet, joinedPacket)
          const updatedNodes = groupMembersToWorkerNodes(identity.deviceId, joinedPacket, runtime.store.get(KV.nodes.registry) ?? [])
          runtime.store.set(KV.nodes.registry, updatedNodes)
          sendJson(res, 200, {
            packet: joinedPacket,
            members: verifyAndExtractGroupMembers(joinedPacket),
            nodes: getRegisteredNodes(),
          })
          return
        }

        if (req.method === 'POST' && sub === 'device-group/sync') {
          const body = await readJsonBody(req, 1024 * 1024)
          const incoming = body.packet as DeviceGroupPacket
          const members = verifyAndExtractGroupMembers(incoming)
          const identity = getDeviceIdentity()
          if (!members.some(m => m.deviceId === identity.deviceId)) {
            throw new Error('同步的设备组证明不包含本机身份')
          }
          runtime.store.set(KV.deviceGroup.packet, incoming)
          const updatedNodes = groupMembersToWorkerNodes(identity.deviceId, incoming, runtime.store.get(KV.nodes.registry) ?? [])
          runtime.store.set(KV.nodes.registry, updatedNodes)
          sendJson(res, 200, { ok: true, members, nodes: getRegisteredNodes() })
          return
        }

        // Distributed LAN Worker Nodes registry endpoints
        if (req.method === 'GET' && sub === 'nodes') {
          sendJson(res, 200, { nodes: getRegisteredNodes() })
          return
        }

        if (req.method === 'POST' && sub === 'nodes') {
          const body = await readJsonBody(req, 1024 * 1024)
          const id = String(body.id ?? '').trim()
          const name = String(body.name ?? id).trim()
          const nodeUrl = String(body.url ?? '').trim()
          if (!id || id === 'local') throw new Error('Node ID is required and cannot be "local"')
          if (!nodeUrl) throw new Error('Node URL is required (e.g. http://192.168.1.20:4318)')
          const tags = Array.isArray(body.tags)
            ? body.tags.map(t => String(t).trim()).filter(Boolean)
            : typeof body.tags === 'string'
              ? body.tags.split(/[\s,]+/).map(t => t.trim()).filter(Boolean)
              : []
          const gitUrl = typeof body.gitUrl === 'string' && body.gitUrl.trim() ? body.gitUrl.trim() : undefined
          const nodeHostname = typeof body.hostname === 'string' && body.hostname.trim() ? body.hostname.trim() : undefined
          const tailscaleDnsName = typeof body.tailscaleDnsName === 'string' && body.tailscaleDnsName.trim() ? body.tailscaleDnsName.trim() : undefined
          const tailscaleIps = Array.isArray(body.tailscaleIps)
            ? body.tailscaleIps.map(ip => String(ip).trim()).filter(Boolean)
            : typeof body.tailscaleIps === 'string'
              ? body.tailscaleIps.split(/[\s,]+/).map(ip => ip.trim()).filter(Boolean)
              : []
          const lanIps = Array.isArray(body.lanIps)
            ? body.lanIps.map(ip => String(ip).trim()).filter(Boolean)
            : typeof body.lanIps === 'string'
              ? body.lanIps.split(/[\s,]+/).map(ip => ip.trim()).filter(Boolean)
              : []
          const candidateEndpoints = buildNodeCandidateEndpoints({
            url: nodeUrl,
            hostname: nodeHostname || id,
            tailscaleDnsName,
            tailscaleIps,
            lanIps,
          })
          const status: 'online' | 'offline' = body.status === 'offline' ? 'offline' : 'online'
          const existing = (runtime.store.get(KV.nodes.registry) ?? []).filter(n => n.id !== 'local' && n.id !== id)
          const record: WorkerNodeRecord = {
            id,
            name: name || id,
            url: candidateEndpoints[0] ?? nodeUrl,
            endpoints: candidateEndpoints,
            ...(nodeHostname ? { hostname: nodeHostname } : {}),
            ...(tailscaleDnsName ? { tailscaleDnsName } : {}),
            ...(tailscaleIps.length ? { tailscaleIps } : {}),
            ...(lanIps.length ? { lanIps } : {}),
            tags,
            status,
            ...(gitUrl ? { gitUrl } : {}),
            lastSeenAt: new Date().toISOString(),
          }
          existing.push(record)
          runtime.store.set(KV.nodes.registry, existing)
          sendJson(res, 200, { node: record, nodes: getRegisteredNodes() })
          return
        }

        if (req.method === 'DELETE' && sub.startsWith('nodes/')) {
          const nodeId = decodeURIComponent(sub.slice('nodes/'.length))
          if (nodeId === 'local') throw new Error('Cannot remove the built-in local node')
          const existing = (runtime.store.get(KV.nodes.registry) ?? []).filter(n => n.id !== nodeId)
          runtime.store.set(KV.nodes.registry, existing)
          sendJson(res, 200, { nodes: getRegisteredNodes() })
          return
        }

        // Execute a personal business skill locally on this node (`claw`) or proxy to `claw`
        if (req.method === 'POST' && sub === 'personal-skills/execute') {
          const body = await readJsonBody(req, 512 * 1024)
          const toolName = String(body.name ?? '').trim()
          const toolArgs = (typeof body.args === 'object' && body.args !== null ? body.args : {}) as Record<string, unknown>
          if (!toolName) throw new Error('Personal skill tool name is required')
          const result = await executePersonalSkillLocal(toolName, toolArgs)
          sendJson(res, 200, { ok: true, result })
          return
        }

        // Execute a distributed Worker turn on this machine when dispatched by a Hub node
        if (req.method === 'POST' && sub === 'worker-node/execute') {
          const body = await readJsonBody(req, 14 * 1024 * 1024) as unknown as RemoteTurnRequestBody
          const outcome = await handleIncomingRemoteTurn(body, {
            stateDir,
            repoRoot: process.cwd(),
            ...(options.driver ? { customDriver: reqItem => options.driver!({ ...reqItem, onToolResult: () => {} }) } : {}),
          })
          sendJson(res, 200, outcome)
          return
        }

        // Get only Session events added after a client cursor; this is polled by the live console.
         if (req.method === 'GET' && sub.startsWith('sessions/') && sub.endsWith('/events')) {
           const sessionId = decodeURIComponent(sub.slice('sessions/'.length, -'/events'.length))
           const after = Number(url.searchParams.get('after') ?? '0')
           const events = host.getSessionEvents(sessionId, Number.isFinite(after) ? after : 0)
           if (!events) { sendJson(res, 404, { error: 'Session not found' }); return }
           sendJson(res, 200, events)
           return
         }

         // Get session detail (events, tools, system prompt)
        if (req.method === 'GET' && sub.startsWith('sessions/')) {
          const sessionId = decodeURIComponent(sub.slice('sessions/'.length))
          const detail = host.getSessionDetail(sessionId)
          if (!detail) { sendJson(res, 404, { error: 'Session not found' }); return }
          sendJson(res, 200, detail)
          return
        }

        // Execute a tool inside a session (Human-as-Orchestrator / Human-as-Worker or manual debugging)
        if (req.method === 'POST' && sub.endsWith('/tool') && sub.startsWith('sessions/')) {
          const sessionId = decodeURIComponent(sub.slice('sessions/'.length, -'/tool'.length))
          const body = await readJsonBody(req, 20 * 1024 * 1024)
          const toolName = String(body.name ?? '')

          // If a remote worker node attached its git bundle and/or synced files with `orchestrator_report`,
          // sync them into the Hub's repository and local ticket worktree BEFORE running `orchestrator_report`
          // so that when `Eval` wakes up immediately on `ready`, the commits and files are already on the Hub!
          if (
            sessionId.startsWith('worker-') &&
            (typeof body.gitBundleB64 === 'string' || Array.isArray(body.syncedFiles))
          ) {
            const ticketId = sessionId.slice('worker-'.length)
            const ticket = runtime.store.tickets.get(ticketId)
            const branch = typeof body.branch === 'string' ? body.branch : ''
            const gitSource = String(body.worktreeDir ?? body.repoRoot ?? 'remote')
            const synced = syncRemoteNodeGitBranch({
              hubRepoRoot: process.cwd(),
              remoteGitSource: gitSource,
              branch,
              ...(ticket?.title ? { title: ticket.title } : {}),
              ...(typeof body.gitBundleB64 === 'string' ? { gitBundleB64: body.gitBundleB64 } : {}),
              ...(ticket?.execution?.directory ? { localWorktreeDir: ticket.execution.directory } : {}),
              ...(Array.isArray(body.syncedFiles) ? { syncedFiles: body.syncedFiles as RemoteSyncedFile[] } : {}),
            })
            const existingAssigned = runtime.store.get(KV.nodes.ticketNode(ticketId))
            if (existingAssigned) {
              runtime.store.set(KV.nodes.ticketNode(ticketId), {
                ...existingAssigned,
                gitSource,
                ...(branch ? { branch } : {}),
                synced: synced.merged,
              })
            }
          }

          const result = await host.executeSessionTool(sessionId, toolName, body.args ?? {})
          await runtime.pump()
          if (toolName === 'orchestrator_report') tryAutoMergeTicket(sessionId)
          sendJson(res, 200, { result })
          return
        }

        // Append an assistant reply / finish turn for a session
        if (req.method === 'POST' && sub.endsWith('/reply') && sub.startsWith('sessions/')) {
          const sessionId = decodeURIComponent(sub.slice('sessions/'.length, -'/reply'.length))
          const body = await readJsonBody(req, 14 * 1024 * 1024)
          await host.appendAssistantReply(sessionId, String(body.text ?? ''), body.endTurn !== false)
          await runtime.pump()
          sendJson(res, 200, { ok: true })
          return
        }

        // Inspect or merge a Ticket's Git worktree back into the main repository branch
        if (req.method === 'GET' && sub.startsWith('tickets/') && sub.endsWith('/worktree')) {
          const ticketId = decodeURIComponent(sub.slice('tickets/'.length, -'/worktree'.length))
          const ticket = runtime.store.tickets.get(ticketId)
          if (!ticket) { sendJson(res, 404, { error: 'Ticket not found' }); return }
          sendJson(res, 200, inspectTicketWorktree(process.cwd(), ticket.execution?.directory))
          return
        }

        if (req.method === 'POST' && sub.startsWith('tickets/') && sub.endsWith('/worktree/merge')) {
          const ticketId = decodeURIComponent(sub.slice('tickets/'.length, -'/worktree/merge'.length))
          const ticket = runtime.store.tickets.get(ticketId)
          if (!ticket) { sendJson(res, 404, { error: 'Ticket not found' }); return }
          const body = await readJsonBody(req, 14 * 1024 * 1024)
          const result = mergeTicketWorktree(process.cwd(), ticket.execution?.directory, {
            title: ticket.title,
            commitDirty: body.commitDirty !== false,
            push: body.push === true,
          })
          sendJson(res, 200, result)
          return
        }

        // Refresh local DSH + Codex model catalog on demand
        if (req.method === 'POST' && sub === 'models/refresh') {
          const catalog = await host.refreshCatalog()
          sendJson(res, 200, catalog)
          return
        }

        // Markdown Document Catalog & Cross-Node Reader (`/orchestrator/standalone/markdown/list` & `markdown/read`)
        if (req.method === 'GET' && sub === 'markdown/list') {
          const repoRoot = process.cwd()
          const localHostname = getDeviceIdentity().deviceName
          const items: {
            path: string
            title: string
            group: 'artifacts' | 'worktree' | 'docs'
            size: number
            updatedAt: string
            nodeName: string
          }[] = []
          const seenPaths = new Set<string>()

          const extractMdTitle = (fullPath: string, fallback: string): string => {
            try {
              const head = readFileSync(fullPath, 'utf8').slice(0, 1500)
              const m = /^#\s+(.+)$/m.exec(head)
              return m?.[1]?.trim() || fallback
            } catch {
              return fallback
            }
          }

          const addMdFile = (fullPath: string, group: 'artifacts' | 'worktree' | 'docs', displayPath?: string) => {
            try {
              if (!existsSync(fullPath)) return
              const st = statSync(fullPath)
              if (!st.isFile()) return
              const rel = (displayPath ?? relative(repoRoot, fullPath)).replaceAll('\\', '/')
              if (seenPaths.has(rel)) return
              seenPaths.add(rel)
              items.push({
                path: rel,
                title: extractMdTitle(fullPath, basename(fullPath)),
                group,
                size: st.size,
                updatedAt: st.mtime.toISOString(),
                nodeName: localHostname,
              })
            } catch {}
          }

          // 1. `.artifacts/*.md`
          const artifactsDir = join(repoRoot, '.artifacts')
          if (existsSync(artifactsDir)) {
            for (const name of readdirSync(artifactsDir)) {
              if (name.toLowerCase().endsWith('.md')) {
                addMdFile(join(artifactsDir, name), 'artifacts', `.artifacts/${name}`)
              }
            }
          }

          // 2. Ticket worktree `.artifacts/*.md` (under `stateDir/work` and `stateDir/remote-work`)
          for (const wtRootName of ['work', 'remote-work']) {
            const wtRoot = join(stateDir, wtRootName)
            if (!existsSync(wtRoot)) continue
            try {
              for (const slug of readdirSync(wtRoot)) {
                const subArt = join(wtRoot, slug, '.artifacts')
                if (!existsSync(subArt)) continue
                for (const name of readdirSync(subArt)) {
                  if (name.toLowerCase().endsWith('.md')) {
                    addMdFile(join(subArt, name), 'worktree')
                  }
                }
              }
            } catch {}
          }

          // 3. Root `README.md`, `SETUP.md`, `AGENTS.md` and `docs/*.md`
          for (const rootDoc of ['README.md', 'SETUP.md', 'AGENTS.md']) {
            addMdFile(join(repoRoot, rootDoc), 'docs', rootDoc)
          }
          const docsDir = join(repoRoot, 'docs')
          if (existsSync(docsDir)) {
            for (const name of readdirSync(docsDir).sort()) {
              if (name.toLowerCase().endsWith('.md')) {
                addMdFile(join(docsDir, name), 'docs', `docs/${name}`)
              }
            }
          }

          sendJson(res, 200, { items })
          return
        }

        if (req.method === 'GET' && sub === 'markdown/read') {
          const rawPath = String(url.searchParams.get('path') ?? '').trim()
          const localOnly = url.searchParams.get('localOnly') === '1'
          if (!rawPath) {
            sendJson(res, 400, { error: 'Markdown path is required' })
            return
          }
          // Strip optional `#anchor` and `:line` suffixes
          let cleanPath = rawPath.split('#')[0]!.trim()
          let focusLine: number | undefined
          const lineMatch = /^(.*\.md):(\d+)(?:-\d+)?$/i.exec(cleanPath)
          if (lineMatch) {
            cleanPath = lineMatch[1]!
            focusLine = Number(lineMatch[2])
          }
          if (!/\.md$/i.test(cleanPath) || cleanPath.includes('..')) {
            sendJson(res, 400, { error: 'Only safe .md document paths are allowed' })
            return
          }

          // Direct SiYuan document virtual path: `siyuan/<instance>/<docId>.md`
          const siyuanMatch = /^siyuan\/(siyuan|siyuan-rh)\/([0-9a-z-]+)\.md$/i.exec(cleanPath.replaceAll('\\', '/'))
          if (siyuanMatch) {
            const inst = siyuanMatch[1]!.toLowerCase()
            const docId = siyuanMatch[2]!
            const syOut = (await executePersonalSkillWithRemoteFallback(
              'siyuan_read',
              { instance: inst, id: docId },
              getRegisteredNodes,
            )) as { ok?: boolean; content?: string; hpath?: string; instanceLabel?: string; error?: string }
            if (syOut?.ok && typeof syOut.content === 'string') {
              const cleanContent = syOut.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '')
              sendJson(res, 200, {
                path: cleanPath,
                resolvedPath: `${syOut.instanceLabel ?? inst}: ${syOut.hpath ?? docId}`,
                title: syOut.hpath ? syOut.hpath.replace(/^\/+/, '') : docId,
                content: cleanContent,
                size: Buffer.byteLength(cleanContent, 'utf8'),
                updatedAt: new Date().toISOString(),
                sourceNode: syOut.instanceLabel ?? `tc:${inst}`,
              })
              return
            }
            sendJson(res, 404, { error: syOut?.error ?? `未找到思源文档：${docId}` })
            return
          }

          const repoRoot = process.cwd()
          const normalized = cleanPath.replaceAll('\\', '/')
          const baseName = basename(normalized)

          // Candidate local file locations in priority order
          const localCandidates: string[] = [
            cleanPath,
            resolve(repoRoot, cleanPath),
            resolve(stateDir, cleanPath),
            join(repoRoot, '.artifacts', baseName),
            join(repoRoot, 'docs', baseName),
          ]
          const rharnessIdx = normalized.toLowerCase().indexOf('/rharness/')
          if (rharnessIdx >= 0) {
            const afterRharness = normalized.slice(rharnessIdx + '/rharness/'.length)
            localCandidates.unshift(resolve(repoRoot, afterRharness))
            // Also map `remote-work/<slug>/.artifacts/<file>` <-> `work/<slug>/.artifacts/<file>`
            if (afterRharness.includes('/remote-work/')) {
              localCandidates.push(resolve(repoRoot, afterRharness.replace('/remote-work/', '/work/')))
            } else if (afterRharness.includes('/work/')) {
              localCandidates.push(resolve(repoRoot, afterRharness.replace('/work/', '/remote-work/')))
            }
          }

          for (const candidate of localCandidates) {
            try {
              if (existsSync(candidate) && statSync(candidate).isFile()) {
                const content = readFileSync(candidate, 'utf8')
                const st = statSync(candidate)
                const rel = relative(repoRoot, candidate).replaceAll('\\', '/')
                sendJson(res, 200, {
                  path: rel.startsWith('..') ? normalized : rel,
                  resolvedPath: candidate.replaceAll('\\', '/'),
                  title: (/^#\s+(.+)$/m.exec(content.slice(0, 1500))?.[1]?.trim()) || baseName,
                  content,
                  size: st.size,
                  updatedAt: st.mtime.toISOString(),
                  sourceNode: getDeviceIdentity().deviceName,
                  ...(focusLine !== undefined ? { focusLine } : {}),
                })
                return
              }
            } catch {}
          }

          // Not found locally: if allowed, query online remote Worker Nodes
          if (!localOnly) {
            const remoteNodes = getRegisteredNodes().filter(
              n => n.id !== 'local' && n.status === 'online' && n.url !== 'local' && n.url !== '',
            )
            for (const node of remoteNodes) {
              for (const ep of buildNodeCandidateEndpoints(node)) {
                try {
                  const baseUrl = ep.replace(/\/+$/, '')
                  const remoteRes = await fetch(
                    `${baseUrl}/orchestrator/standalone/markdown/read?path=${encodeURIComponent(cleanPath)}&localOnly=1`,
                    {
                      headers: { 'x-orchestrator-request': '1' },
                      signal: AbortSignal.timeout(4500),
                    },
                  )
                  if (remoteRes.ok) {
                    const data = await remoteRes.json() as {
                      path: string
                      resolvedPath: string
                      title: string
                      content: string
                      size: number
                      updatedAt: string
                      sourceNode?: string
                    }
                    // Cache a copy into local `.artifacts/` so future opens are local and instant
                    try {
                      const localArtDir = join(repoRoot, '.artifacts')
                      mkdirSync(localArtDir, { recursive: true })
                      writeFileSync(join(localArtDir, baseName), data.content, 'utf8')
                    } catch {}
                    sendJson(res, 200, {
                      ...data,
                      sourceNode: data.sourceNode ?? node.name,
                      ...(focusLine !== undefined ? { focusLine } : {}),
                    })
                    return
                  }
                } catch {}
              }
            }
          }

          sendJson(res, 404, { error: `未找到 Markdown 文档：${cleanPath}` })
          return
        }

        // Update machine limits in standalone mode
        if (req.method === 'PUT' && sub === 'machine') {
          const body = await readJsonBody(req, 14 * 1024 * 1024)
          if (typeof body.promptMaxChars === 'number') promptMaxChars = body.promptMaxChars
          if (typeof body.admissionContextMaxPages === 'number') admissionContextMaxPages = body.admissionContextMaxPages
          if (typeof body.admissionContextTimeoutMs === 'number') admissionContextTimeoutMs = body.admissionContextTimeoutMs
          sendJson(res, 200, { promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs })
          return
        }

        sendJson(res, 404, { error: 'Unknown standalone endpoint' })
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    const isGetOrHead = req.method === 'GET' || req.method === 'HEAD'
    // 3. Static web assets & Mobile PWA (`lib/standalone-web.js`, `/manifest.webmanifest`, `/sw.js`, `/favicon.svg`, or `index.html`)
    if (isGetOrHead && url.pathname === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'public, max-age=3600' })
      res.end(
        JSON.stringify(
          {
            name: 'RHarness 智能体工作台',
            short_name: 'RHarness',
            description: '个人助理 · 手机通知 · 思源知识库 · 分布式工程工作台',
            start_url: '/',
            scope: '/',
            display: 'standalone',
            orientation: 'portrait-primary',
            background_color: '#f8fafc',
            theme_color: '#2563eb',
            icons: [
              {
                src: '/favicon.svg',
                sizes: 'any',
                type: 'image/svg+xml',
                purpose: 'any maskable',
              },
            ],
          },
          null,
          2,
        ),
      )
      return
    }

    if (isGetOrHead && url.pathname === '/sw.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(
        `self.addEventListener('install', () => self.skipWaiting());\nself.addEventListener('activate', event => event.waitUntil(self.clients.claim()));\nself.addEventListener('fetch', () => {});\n`,
      )
      return
    }

    if (isGetOrHead && (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico')) {
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' })
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 32 32" fill="none">
  <rect width="32" height="32" rx="8" fill="#2563EB"/>
  <path d="M9.5 23V9H16.2C18.85 9 20.6 10.55 20.6 13.05C20.6 14.95 19.45 16.35 17.6 16.85L21.2 23H18.05L14.85 17.15H12.3V23H9.5ZM12.3 14.8H15.85C17.15 14.8 17.9 14.1 17.9 13.05C17.9 12 17.15 11.35 15.85 11.35H12.3V14.8Z" fill="#FFFFFF"/>
  <circle cx="23.5" cy="9.5" r="2.5" fill="#60A5FA"/>
  <circle cx="23.5" cy="22.5" r="2.2" fill="#93C5FD"/>
  <path d="M20.2 12.2L22.2 10.5M19.8 19.5L22.1 21.4" stroke="#93C5FD" stroke-width="1.6" stroke-linecap="round"/>
</svg>`)
      return
    }

    if (isGetOrHead && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="theme-color" content="#2563eb" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="default" />
  <meta name="apple-mobile-web-app-title" content="RHarness" />
  <meta name="mobile-web-app-capable" content="yes" />
  <title>RHarness · 智能体工作台</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="apple-touch-icon" href="/favicon.svg" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <style>
    :root {
      color-scheme: light;
      --dsw-alias-bg-base: #f8fafc;
      --dsw-alias-bg-layer-1: #ffffff;
      --dsw-alias-bg-layer-2: #ffffff;
      --dsw-alias-bg-layer-3: #f1f5f9;
      --dsw-alias-bg-module-platform: #f1f5f9;
      --dsw-alias-bg-mask-1: rgba(15, 23, 42, 0.35);
      --dsw-mask-blur: blur(4px);
      --dsw-alias-label-primary: #0f172a;
      --dsw-alias-label-primary-foreground: #ffffff;
      --dsw-alias-label-secondary: #334155;
      --dsw-alias-label-tertiary: #64748b;
      --dsw-alias-label-caption: #64748b;
      --dsw-alias-label-dimmed: #94a3b8;
      --dsw-alias-border-l2: #e2e8f0;
      --dsw-alias-border-l3: #cbd5e1;
      --dsw-alias-border-l4: #94a3b8;
      --dsw-alias-brand-primary: #2563eb;
      --dsw-alias-link: #2563eb;
      --dsw-alias-button-primary-fill: #2563eb;
      --dsw-alias-button-primary-hover: #1d4ed8;
      --dsw-alias-button-ghost-active-fill: #eff6ff;
      --dsw-alias-button-ghost-active-border: #93c5fd;
      --dsw-alias-interactive-bg-hover: #f1f5f9;
      --dsw-alias-interactive-bg-active: #e2e8f0;
      --dsw-alias-state-success-primary: #16a34a;
      --dsw-alias-state-warn-primary: #d97706;
      --dsw-alias-state-error-primary: #dc2626;
      --dsw-alias-state-business-primary: #2563eb;
      --dsw-alias-state-idle-primary: #94a3b8;
      --dsw-alias-tooltip-bg: #1e293b;
      --dsw-alias-toast-bg: #1e293b;
      --dsw-static-neutral-bluish-00: #ffffff;
      --dsw-elevation-soft: 0 1px 2px rgba(15, 23, 42, 0.06);
      --dsw-elevation-prominent: 0 12px 32px rgba(15, 23, 42, 0.14);
      --dsw-shadow-lv3: 0 8px 24px rgba(15, 23, 42, 0.12);
    }
    body {
      margin: 0;
      background: var(--dsw-alias-bg-base);
      color: var(--dsw-alias-label-primary);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .dt-card, .dt-form.dt-block {
      background: #ffffff;
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04);
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/standalone-web.js"></script>
  <script>if ('serviceWorker' in navigator) { window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {})); }</script>
</body>
</html>`)
      return
    }

    if (req.method === 'GET' && url.pathname === '/standalone-web.js') {
      const builtPath = packagePath('lib', 'standalone-web.js')
      if (existsSync(builtPath)) {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
        res.end(readFileSync(builtPath))
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Run `pnpm build` to generate lib/standalone-web.js')
      return
    }

    const ext = extname(url.pathname)
    if (req.method === 'GET' && ext === '.js') {
      const candidate = packagePath('lib', url.pathname.slice(1))
      if (existsSync(candidate)) {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
        res.end(readFileSync(candidate))
        return
      }
    }

    res.writeHead(404).end('Not found')
  }

  const httpServer = createServer(handleHttpRequest)
  const listenHost = options.host ?? process.env.DSH_SUPERAGENT_HOST ?? '0.0.0.0'
  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once('error', rejectListen)
    httpServer.listen(port, listenHost, () => resolveListen())
  })

  const address = httpServer.address()
  actualPort = typeof address === 'object' && address ? address.port : port
  ;(host.ctx.webServer as { port: number }).port = actualPort

  // Optional Direct Tailscale HTTPS Server(s) (`https://<node>.<tailnet>.ts.net` on `:443` + `:8443`) for zero-port LAN + Tailscale PWA
  const httpsServers: HttpsServer[] = []
  let httpsUrl: string | undefined
  const autoTls = options.liveAgents !== false ? discoverTailscaleTlsFiles(stateDir) : undefined
  const certPath = options.tlsCertFile ?? process.env.RHARNESS_TLS_CERT ?? autoTls?.certFile
  const keyPath = options.tlsKeyFile ?? process.env.RHARNESS_TLS_KEY ?? autoTls?.keyFile
  if (certPath && keyPath && existsSync(certPath) && existsSync(keyPath)) {
    const tlsOptions = {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
    }
    const candidateHttpsPorts =
      options.httpsPort !== undefined
        ? [options.httpsPort]
        : process.env.RHARNESS_HTTPS_PORT
          ? process.env.RHARNESS_HTTPS_PORT.split(',')
              .map(s => Number(s.trim()))
              .filter(n => Number.isFinite(n) && n > 0)
          : [443, 8443]
    const domainName = autoTls?.domain ?? getDeviceIdentity().tailscaleDnsName ?? 'localhost'

    for (const candidatePort of candidateHttpsPorts) {
      try {
        const srv = createHttpsServer(tlsOptions, handleHttpRequest)
        await new Promise<void>((resolveTls, rejectTls) => {
          srv.once('error', rejectTls)
          srv.listen(candidatePort, listenHost, () => resolveTls())
        })
        httpsServers.push(srv)
        const tlsAddr = srv.address()
        const boundPort = typeof tlsAddr === 'object' && tlsAddr ? tlsAddr.port : candidatePort
        if (actualHttpsPort === undefined || boundPort === 443) {
          actualHttpsPort = boundPort
          httpsUrl = `https://${domainName}${boundPort === 443 ? '' : `:${boundPort}`}`
        }
      } catch {}
    }
  }

  return {
    port: actualPort,
    ...(actualHttpsPort !== undefined ? { httpsPort: actualHttpsPort } : {}),
    url: `http://127.0.0.1:${actualPort}`,
    ...(httpsUrl ? { httpsUrl } : {}),
    stateDir,
    get runtime() { return runtime },
    host,
    stop: async () => {
      for (const srv of httpsServers) {
        await new Promise<void>(r => srv.close(() => r()))
      }
      await new Promise<void>(r => httpServer.close(() => r()))
      await runtime.stop()
    },
  }
}

// Run directly when executed from CLI (`node lib/standalone.js` or `tsx src/server/standalone.ts`)
const isMain = process.argv[1] && (process.argv[1].endsWith('standalone.ts') || process.argv[1].endsWith('standalone.js'))
if (isMain) {
  const { values } = parseArgs({
    options: {
      host: { type: 'string', short: 'h' },
      port: { type: 'string', short: 'p' },
      'state-dir': { type: 'string', short: 'd' },
      daemon: { type: 'boolean' },
      supervisor: { type: 'boolean' },
      stop: { type: 'boolean' },
    },
    strict: false,
  })
  const host = typeof values.host === 'string' ? values.host : (process.env.DSH_SUPERAGENT_HOST ?? '0.0.0.0')
  const port = typeof values.port === 'string' ? Number(values.port) : 4318
  const stateDir = resolve(typeof values['state-dir'] === 'string' ? values['state-dir'] : '.rharness-dev/superagent')
  mkdirSync(stateDir, { recursive: true })
  const pidFile = join(stateDir, 'standalone.pid')
  const supervisorPidFile = join(stateDir, 'standalone.supervisor.pid')
  const logFile = join(stateDir, 'standalone.log')
  const lockDir = `${stateDir}.lock`

  const killRecordedPid = (file: string) => {
    if (!existsSync(file)) return
    const pid = Number(readFileSync(file, 'utf8').trim())
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 'SIGTERM') } catch {}
    }
    rmSync(file, { force: true })
  }

  const cleanStopped = () => {
    // Stop supervisor first so it does not respawn the worker
    killRecordedPid(supervisorPidFile)
    killRecordedPid(pidFile)
    rmSync(lockDir, { recursive: true, force: true })
  }

  if (values.stop) {
    cleanStopped()
    console.log('Stopped standalone server')
    process.exit(0)
  }

  if (values.daemon) {
    cleanStopped()
    const child = spawn(process.execPath, [
      process.argv[1]!,
      '--supervisor',
      '--host', host,
      '--port', String(port),
      '--state-dir', stateDir,
    ], {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    })
    child.unref()
    writeFileSync(supervisorPidFile, `${child.pid}\n`)
    console.log(`Started self-healing background supervisor (PID ${child.pid}) at http://127.0.0.1:${port}`)
    console.log(`Log file: ${logFile}`)
    process.exit(0)
  }

  if (values.supervisor) {
    writeFileSync(supervisorPidFile, `${process.pid}\n`)
    let stopping = false
    let activeChild: ReturnType<typeof spawn> | undefined
    let backoffMs = 2000

    const writeSupervisorLog = (line: string) => {
      const entry = `[${new Date().toISOString()}] [SUPERVISOR:${process.pid}] ${line}\n`
      try {
        if (existsSync(logFile) && statSync(logFile).size > 10 * 1024 * 1024) {
          rmSync(`${logFile}.1`, { force: true })
          renameSync(logFile, `${logFile}.1`)
        }
        appendFileSync(logFile, entry, 'utf8')
      } catch {}
    }

    const stopAll = () => {
      if (stopping) return
      stopping = true
      writeSupervisorLog('Received shutdown signal; stopping worker...')
      rmSync(supervisorPidFile, { force: true })
      if (activeChild?.pid) {
        try { activeChild.kill('SIGTERM') } catch {}
      }
      setTimeout(() => process.exit(0), 1500).unref()
    }
    process.on('SIGINT', stopAll)
    process.on('SIGTERM', stopAll)

    const launchWorker = () => {
      if (stopping) return
      rmSync(lockDir, { recursive: true, force: true })
      writeSupervisorLog(`Launching worker (host=${host}, port=${port}, stateDir=${stateDir})`)
      const startedAt = Date.now()
      let logFd: number | undefined
      try {
        logFd = openSync(logFile, 'a')
      } catch {}
      const worker = spawn(process.execPath, [
        process.argv[1]!,
        '--host', host,
        '--port', String(port),
        '--state-dir', stateDir,
      ], {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: logFd !== undefined ? ['ignore', logFd, logFd] : 'ignore',
      })
      if (logFd !== undefined) {
        try { closeSync(logFd) } catch {}
      }
      activeChild = worker
      if (worker.pid) writeFileSync(pidFile, `${worker.pid}\n`)

      worker.on('exit', (code, signal) => {
        activeChild = undefined
        if (stopping || code === 0) {
          writeSupervisorLog(`Worker PID ${worker.pid ?? '?'} exited cleanly (code=${code ?? 0}).`)
          rmSync(supervisorPidFile, { force: true })
          process.exit(0)
        }
        const uptimeMs = Date.now() - startedAt
        backoffMs = uptimeMs > 30_000 ? 2000 : Math.min(30_000, backoffMs * 2)
        writeSupervisorLog(
          `Worker PID ${worker.pid ?? '?'} exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'}, uptime=${Math.round(uptimeMs / 1000)}s); cleaning stale lock and restarting in ${backoffMs}ms...`,
        )
        rmSync(lockDir, { recursive: true, force: true })
        setTimeout(launchWorker, backoffMs)
      })
    }

    launchWorker()
  } else {
    const TRANSIENT_NET_CODES = new Set([
      'ECONNRESET',
      'EPIPE',
      'ECANCELED',
      'ETIMEDOUT',
      'ECONNABORTED',
      'ERR_STREAM_WRITE_AFTER_END',
      'ERR_STREAM_PREMATURE_CLOSE',
    ])

    process.on('unhandledRejection', reason => {
      console.error(`[${new Date().toISOString()}] [CRASH-GUARD] Unhandled promise rejection (server kept alive):`, reason)
    })

    process.on('uncaughtException', err => {
      const code = (err as NodeJS.ErrnoException)?.code ?? ''
      if (TRANSIENT_NET_CODES.has(code)) {
        console.error(`[${new Date().toISOString()}] [CRASH-GUARD] Ignored transient socket exception (${code}):`, err.message)
        return
      }
      console.error(`[${new Date().toISOString()}] [CRASH-GUARD] Fatal uncaught exception:`, err)
      rmSync(pidFile, { force: true })
      rmSync(lockDir, { recursive: true, force: true })
      process.exit(1)
    })

    startStandaloneServer({ host, port, stateDir }).then(srv => {
      writeFileSync(pidFile, `${process.pid}\n`)
      console.log(
        `[${new Date().toISOString()}] dsh-superagent standalone server listening on ${srv.url}${srv.httpsUrl ? ` and ${srv.httpsUrl}` : ''} (PID: ${process.pid}, stateDir: ${srv.stateDir})`,
      )
      const shutdown = () => {
        rmSync(pidFile, { force: true })
        srv.stop().then(() => process.exit(0), () => process.exit(1))
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    }).catch(err => {
      console.error(`[${new Date().toISOString()}] Failed to start dsh-superagent standalone server:`, err)
      process.exit(1)
    })
  }
}
