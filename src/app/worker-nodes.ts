/**
 * Distributed LAN Worker Nodes registry, remote turn driver, and P2P Git branch synchronization.
 *
 * Architecture:
 * - A central Hub (e.g., an always-on `claw` server) hosts the Orchestrator / Eval model, SQLite state, and Sources.
 * - Any LAN machine (including the Hub's own `local` node and remote workstations like `win-pc`) can register as a
 *   Worker Node with capability tags (`heavy-coding`, `windows`, `chrome-qa`, `always-on`, etc.).
 * - When `orchestrator_route` (or automatic capability matching) assigns a Ticket to a Worker Node:
 *   1. If assigned to `local`, the Hub runs the turn in its local worktree as usual.
 *   2. If assigned to a remote LAN node (`http://<lan-ip>:<port>`), the Hub dispatches the turn over HTTP
 *      (`POST /orchestrator/standalone/worker-node/execute`), which checks out `agent/<ticketName>` on the remote
 *      machine, runs the local provider/model (`dsh`, `codex`, `cursor`), streams events, commits changes, and returns
 *      the branch ref so the Hub can `git fetch <remoteRepoUrl> agent/<branch>` and fast-forward merge into `main`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runCodexTurn, runCursorTurn, runDshTurn } from './local-drivers.ts'
import { buildNodeCandidateEndpoints, detectLocalAddressFacts } from './device-group.ts'
import type { RegisteredToolSpec, SessionTurnMessage } from './standalone-host.ts'
import { inspectTicketWorktree } from './worktree-merge.ts'

export interface WorkerNodeRecord {
  id: string
  name: string
  /** Primary URL (`'local'` for the built-in Hub node; `http://<ip-or-host>:<port>` for a remote LAN worker). */
  url: string
  /** Ordered multi-address fallback list: LAN IP (`192.168.x.y`), invariant `hostname`, Tailscale MagicDNS (`<name>.<tailnet>.ts.net`), and Tailscale IP (`100.x.y.z`). */
  endpoints?: string[]
  /** Invariant OS machine name (e.g. `dev-workstation`, `build-node`). */
  hostname?: string
  /** Invariant Tailscale MagicDNS FQDN (`<name>.<tailnet>.ts.net`). */
  tailscaleDnsName?: string
  /** Tailscale CGNAT IPv4 addresses (`100.x.y.z`). */
  tailscaleIps?: string[]
  /** Local LAN IPv4 addresses (`192.168.x.y`). */
  lanIps?: string[]
  tags: string[]
  status: 'online' | 'offline'
  /** Optional Git URL or LAN path that the Hub can `git fetch` from (e.g. `ssh://user@ip/D:/git/RHarness` or local path). */
  gitUrl?: string
  defaultModel?: { provider: string; model: string; reasoningEffort?: string }
  lastSeenAt: string
  activeTickets?: number
}

export interface RemoteTurnRequestBody {
  sessionId: string
  ticketId?: string
  worktreeName?: string
  provider: string
  model: string
  reasoningEffort?: string
  systemPrompt: string
  messages: SessionTurnMessage[]
  toolDefs: { name: string; description: string; parameters?: unknown }[]
  hubUrl?: string
  hubEndpoints?: string[]
}

export interface RemoteSyncedFile {
  relPath: string
  contentB64: string
}

export interface RemoteTurnResponseBody {
  replyText: string
  events: { type: string; data: unknown }[]
  branch?: string
  headSha?: string
  repoRoot?: string
  worktreeDir?: string
  gitBundleB64?: string
  syncedFiles?: RemoteSyncedFile[]
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

export function defaultLocalNode(port = 4318): WorkerNodeRecord {
  const facts = detectLocalAddressFacts(port)
  const host = facts.hostname || hostname() || 'local-host'
  const platformTag = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
  return {
    id: 'local',
    name: `本机节点 (${host})`,
    url: 'local',
    endpoints: facts.endpoints,
    hostname: host,
    ...(facts.tailscaleDnsName ? { tailscaleDnsName: facts.tailscaleDnsName } : {}),
    tailscaleIps: facts.tailscaleIps,
    lanIps: facts.lanIps,
    tags: ['local', platformTag, 'default', 'git-worktree'],
    status: 'online',
    gitUrl: process.cwd().replaceAll('\\', '/'),
    lastSeenAt: new Date().toISOString(),
  }
}

/**
 * Selects the best online Worker Node for a ticket based on an explicit `preferredNodeId`, node capability tags,
 * or text hints in the request.
 */
export function selectWorkerNode(
  nodes: readonly WorkerNodeRecord[],
  preferredNodeId?: string,
  requestText = '',
): WorkerNodeRecord {
  const all = nodes.length ? nodes : [defaultLocalNode()]
  if (preferredNodeId) {
    const pref = preferredNodeId.trim().toLowerCase()
    const exact = all.find(
      n =>
        n.id.toLowerCase() === pref ||
        n.name.toLowerCase() === pref ||
        (n.hostname && n.hostname.toLowerCase() === pref),
    )
    if (exact && exact.status === 'online') return exact
  }
  const lower = requestText.toLowerCase()
  const normalizedPathText = lower.replaceAll('\\', '/')
  const online = all.filter(n => n.status === 'online')
  const mentionsToken = (haystack: string, token: string): boolean => {
    const clean = token.trim().toLowerCase()
    if (!clean) return false
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(haystack)
  }
  // 1. Explicit mention of a node id, name, or OS hostname in the request/context (word-bounded so "OpenClaw" does not false-match node "claw")
  for (const node of online) {
    if (
      node.id !== 'local' &&
      (mentionsToken(lower, node.id) ||
        mentionsToken(lower, node.name) ||
        (node.hostname ? mentionsToken(lower, node.hostname) : false))
    ) {
      return node
    }
  }
  // 2. Match repository / workspace path knowledge in context against node `gitUrl` (e.g. `C:/AI/RHarness` on `claw`)
  for (const node of online) {
    if (node.id !== 'local' && node.gitUrl) {
      const normGit = node.gitUrl.replaceAll('\\', '/').toLowerCase()
      if (normGit.length > 3 && normalizedPathText.includes(normGit)) {
        return node
      }
    }
  }
  // 3. Match capability tags mentioned in the request/context (e.g. windows, gpu, chrome-qa, heavy-coding)
  for (const node of online) {
    if (node.id !== 'local' && node.tags.some(tag => tag.length > 2 && lower.includes(tag.toLowerCase()))) {
      return node
    }
  }
  // 4. If the local node itself is online and no remote machine/repo was indicated by Eval or context, run on local
  const localNode = online.find(n => n.id === 'local')
  if (localNode && (localNode.tags.includes('preferred') || localNode.tags.includes('heavy-coding') || localNode.tags.includes('default'))) {
    return localNode
  }
  // 5. Otherwise prefer a dedicated online remote coding workstation tagged `preferred` or `heavy-coding` when available
  const heavy = online.find(n => n.id !== 'local' && (n.tags.includes('preferred') || n.tags.includes('heavy-coding')))
  if (heavy) return heavy
  return online[0] ?? all[0]!
}

/**
 * Pulls commits from a remote Worker Node's repository/worktree into the Hub's main repository and fast-forward
 * merges them into the Hub's active branch (`main`).
 * Always uses `gitBundleB64` when present so identical directory paths across machines (e.g. `D:/git/RHarness` on both
 * matching local repository paths across two different machines (for example, both having `/srv/repo`)
 * never trick the Hub into fetching from its own local disk instead of the remote bundle.
 */
export function syncRemoteNodeGitBranch(input: {
  hubRepoRoot: string
  remoteGitSource: string
  branch: string
  title?: string
  gitBundleB64?: string
  localWorktreeDir?: string
  syncedFiles?: RemoteSyncedFile[]
}): { merged: boolean; output: string; error?: string } {
  const { hubRepoRoot, remoteGitSource, branch, gitBundleB64, localWorktreeDir, syncedFiles } = input

  // 1. Materialize any synced files (`.artifacts/*`, `docs/*.md`, etc.) onto the Hub's worktree and repo immediately
  if (syncedFiles && syncedFiles.length > 0) {
    for (const file of syncedFiles) {
      if (!file.relPath || file.relPath.includes('..')) continue
      try {
        const buf = Buffer.from(file.contentB64, 'base64')
        if (localWorktreeDir) {
          const wtTarget = resolve(localWorktreeDir, file.relPath)
          mkdirSync(dirname(wtTarget), { recursive: true })
          writeFileSync(wtTarget, buf)
        }
        const hubTarget = resolve(hubRepoRoot, file.relPath)
        mkdirSync(dirname(hubTarget), { recursive: true })
        writeFileSync(hubTarget, buf)
      } catch {}
    }
  }

  if (!existsSync(join(hubRepoRoot, '.git')) || !branch) {
    return { merged: Boolean(syncedFiles?.length), output: '' }
  }
  let tempBundle: string | undefined
  try {
    let fetchTarget = remoteGitSource
    if (gitBundleB64) {
      tempBundle = join(tmpdir(), `rharness-remote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bundle`)
      writeFileSync(tempBundle, Buffer.from(gitBundleB64, 'base64'))
      fetchTarget = tempBundle
    }
    if (!fetchTarget) return { merged: false, output: '' }
    const fetchOut = runGit(hubRepoRoot, ['fetch', fetchTarget, branch])
    if (localWorktreeDir && existsSync(join(localWorktreeDir, '.git'))) {
      try {
        runGit(localWorktreeDir, ['fetch', fetchTarget, branch])
        runGit(localWorktreeDir, ['reset', '--hard', 'FETCH_HEAD'])
      } catch {}
    }
    const baseHead = runGit(hubRepoRoot, ['rev-parse', 'HEAD'])
    const fetchedHead = runGit(hubRepoRoot, ['rev-parse', 'FETCH_HEAD'])
    const ahead = Number(runGit(hubRepoRoot, ['rev-list', '--count', `${baseHead}..${fetchedHead}`])) || 0
    if (ahead === 0) {
      return { merged: Boolean(syncedFiles?.length), output: 'Remote worker branch is already up to date with Hub HEAD.' }
    }
    const mergeOut = runGit(hubRepoRoot, ['merge', '--no-edit', 'FETCH_HEAD'])
    return {
      merged: true,
      output: [fetchOut, mergeOut].filter(Boolean).join('\n') || `Fetched and merged ${branch} from ${remoteGitSource}.`,
    }
  } catch (err) {
    try { runGit(hubRepoRoot, ['merge', '--abort']) } catch {}
    const msg = err instanceof Error ? err.message : String(err)
    return { merged: Boolean(syncedFiles?.length), output: '', error: msg }
  } finally {
    if (tempBundle) rmSync(tempBundle, { force: true })
  }
}

/**
 * Executes a Worker turn on a remote LAN Worker Node (`POST <node.url>/orchestrator/standalone/worker-node/execute`).
 * Tool calls for `orchestrator_*` are proxied back to the Hub so domain state stays single-writer on the Hub.
 */
export async function dispatchTurnToRemoteNode(input: {
  node: WorkerNodeRecord
  hubUrl: string
  hubEndpoints?: string[]
  sessionId: string
  ticketId?: string
  worktreeName?: string
  provider: string
  model: string
  reasoningEffort?: string
  systemPrompt: string
  messages: SessionTurnMessage[]
  tools: Map<string, RegisteredToolSpec>
  signal: AbortSignal
  onEvent: (type: string, data: unknown) => void
  onToolResult: (toolName: string, result: unknown) => void
}): Promise<{
  replyText: string
  branch?: string
  headSha?: string
  worktreeDir?: string
  repoRoot?: string
  gitBundleB64?: string
  syncedFiles?: RemoteSyncedFile[]
}> {
  const candidates = buildNodeCandidateEndpoints(input.node)
  if (!candidates.length) {
    throw new Error(`No reachable endpoints configured for worker node ${input.node.id}`)
  }
  const toolDefs = [...input.tools.values()].map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))
  const activeModel = input.node.defaultModel ?? {
    provider: input.provider,
    model: input.model,
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
  }

  input.onEvent('assistant/step', {
    messageId: `remote-dispatch-${Date.now()}`,
    text: `🌐 正在派发至分布式节点 **${input.node.name}** (\`${candidates.join(' / ')}\` · \`${activeModel.provider}/${activeModel.model}\`) 执行…`,
    streaming: true,
  })

  const body: RemoteTurnRequestBody = {
    sessionId: input.sessionId,
    ...(input.ticketId ? { ticketId: input.ticketId } : {}),
    ...(input.worktreeName ? { worktreeName: input.worktreeName } : {}),
    provider: activeModel.provider,
    model: activeModel.model,
    ...(activeModel.reasoningEffort ? { reasoningEffort: activeModel.reasoningEffort } : {}),
    systemPrompt: input.systemPrompt,
    messages: input.messages,
    toolDefs,
    hubUrl: input.hubUrl,
    ...(input.hubEndpoints?.length ? { hubEndpoints: input.hubEndpoints } : {}),
  }

  let payload: (RemoteTurnResponseBody & { error?: string }) | undefined
  let lastError: Error | undefined
  for (const candidateUrl of candidates) {
    const baseUrl = candidateUrl.replace(/\/+$/, '')
    try {
      const res = await fetch(`${baseUrl}/orchestrator/standalone/worker-node/execute`, {
        method: 'POST',
        signal: input.signal,
        headers: {
          'content-type': 'application/json',
          'x-orchestrator-request': '1',
        },
        body: JSON.stringify(body),
      })
      const data = await res.json() as RemoteTurnResponseBody & { error?: string }
      if (!res.ok) {
        throw new Error(data.error ?? `Remote worker node ${input.node.id} failed (${res.status})`)
      }
      payload = data
      break
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (input.signal.aborted) throw lastError
    }
  }
  if (!payload) {
    throw lastError ?? new Error(`All endpoints unreachable for worker node ${input.node.id}: ${candidates.join(', ')}`)
  }
  for (const ev of payload.events ?? []) {
    input.onEvent(ev.type, ev.data)
  }
  return {
    replyText: payload.replyText ?? '',
    ...(payload.branch ? { branch: payload.branch } : {}),
    ...(payload.headSha ? { headSha: payload.headSha } : {}),
    ...(payload.worktreeDir ? { worktreeDir: payload.worktreeDir } : {}),
    ...(payload.repoRoot ? { repoRoot: payload.repoRoot } : {}),
    ...(payload.gitBundleB64 ? { gitBundleB64: payload.gitBundleB64 } : {}),
    ...(payload.syncedFiles ? { syncedFiles: payload.syncedFiles } : {}),
  }
}

/**
 * Handler invoked on a Worker Node when the Hub sends a `POST /orchestrator/standalone/worker-node/execute` request.
 * Prepares an isolated Git worktree on this machine, proxies `orchestrator_*` tool executions back to the Hub,
 * commits any dirty worktree changes on completion, and returns the branch + commit SHA for P2P Git merge.
 */
export async function handleIncomingRemoteTurn(
  body: RemoteTurnRequestBody,
  options: {
    stateDir: string
    repoRoot: string
    localExecuteTool?: (sessionId: string, name: string, args: unknown) => Promise<unknown>
    customDriver?: (req: {
      sessionId: string
      provider: string
      model: string
      reasoningEffort?: string
      cwd: string
      systemPrompt: string
      messages: SessionTurnMessage[]
      tools: Map<string, RegisteredToolSpec>
      signal: AbortSignal
      onEvent: (type: string, data: unknown) => void
    }) => Promise<string | void>
  },
): Promise<RemoteTurnResponseBody> {
  const slug = body.worktreeName || (body.ticketId ? `ticket-${body.ticketId.slice(0, 12)}` : body.sessionId.replace(/[^a-zA-Z0-9_-]/g, '-'))
  const branchName = `agent/${slug}`
  const worktreeDir = resolve(options.stateDir, 'remote-work', slug)
  mkdirSync(resolve(options.stateDir, 'remote-work'), { recursive: true })

  if (existsSync(join(options.repoRoot, '.git')) && !existsSync(join(worktreeDir, '.git'))) {
    try {
      runGit(options.repoRoot, ['worktree', 'add', '-B', branchName, worktreeDir, 'HEAD'])
    } catch {
      mkdirSync(worktreeDir, { recursive: true })
    }
  } else {
    mkdirSync(worktreeDir, { recursive: true })
  }

  // Snapshot helper: commits any dirty worktree files, builds a git bundle of `branchName`, and collects `.artifacts/*` & changed docs
  const snapshotRemoteWorktree = (): {
    headSha: string
    gitBundleB64?: string
    syncedFiles: RemoteSyncedFile[]
  } => {
    let headSha = ''
    let gitBundleB64: string | undefined
    const syncedFiles: RemoteSyncedFile[] = []
    const seenRel = new Set<string>()

    const addFileIfSmall = (fullPath: string, relPath: string) => {
      const normRel = relPath.replaceAll('\\', '/')
      if (seenRel.has(normRel) || normRel.includes('..')) return
      try {
        if (!existsSync(fullPath)) return
        const st = statSync(fullPath)
        if (!st.isFile() || st.size > 2 * 1024 * 1024) return
        seenRel.add(normRel)
        syncedFiles.push({
          relPath: normRel,
          contentB64: readFileSync(fullPath).toString('base64'),
        })
      } catch {}
    }

    // Collect any `.artifacts/*` files in the remote worktree (which are git-ignored so not in the git bundle)
    const artDir = join(worktreeDir, '.artifacts')
    if (existsSync(artDir)) {
      try {
        for (const name of readdirSync(artDir)) {
          addFileIfSmall(join(artDir, name), `.artifacts/${name}`)
        }
      } catch {}
    }

    const wtStatus = inspectTicketWorktree(options.repoRoot, worktreeDir)
    if (wtStatus.available) {
      if (wtStatus.dirtyFiles.length > 0) {
        try {
          runGit(worktreeDir, ['add', '-A'])
          runGit(worktreeDir, ['commit', '-m', `feat(${slug}): commit worker node changes`])
        } catch {}
      }
      try {
        headSha = runGit(worktreeDir, ['rev-parse', '--short', 'HEAD'])
        // Only bundle & collect changed files when the remote worktree branch actually has commits ahead of baseBranch
        if (wtStatus.aheadCommits.length > 0 || wtStatus.dirtyFiles.length > 0) {
          const changedList = runGit(worktreeDir, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])
            .split(/\r?\n/)
            .map(s => s.trim())
            .filter(Boolean)
          for (const rel of changedList) {
            addFileIfSmall(join(worktreeDir, rel), rel)
          }
          const tmpBundle = join(tmpdir(), `rharness-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bundle`)
          try {
            runGit(worktreeDir, ['bundle', 'create', tmpBundle, branchName])
            gitBundleB64 = readFileSync(tmpBundle).toString('base64')
          } finally {
            rmSync(tmpBundle, { force: true })
          }
        }
      } catch {}
    }
    return { headSha, ...(gitBundleB64 ? { gitBundleB64 } : {}), syncedFiles }
  }

  const events: { type: string; data: unknown }[] = []
  const proxyTools = new Map<string, RegisteredToolSpec>()
  for (const def of body.toolDefs ?? []) {
    proxyTools.set(def.name, {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      execute: async (args: unknown, exec: { signal: AbortSignal }) => {
        if (options.localExecuteTool) {
          return await options.localExecuteTool(body.sessionId, def.name, args)
        }
        const hubCandidates = [
          ...new Set([
            ...(body.hubEndpoints ?? []),
            ...(body.hubUrl ? [body.hubUrl] : []),
          ]),
        ]
        if (!hubCandidates.length) throw new Error('No hubUrl provided for remote tool callback')

        // CRITICAL: When the remote worker calls `orchestrator_report`, snapshot and bundle the remote worktree
        // BEFORE sending the report to the Hub, so the Hub merges the branch and writes artifacts BEFORE waking Eval!
        const preReportSnap = def.name === 'orchestrator_report' ? snapshotRemoteWorktree() : undefined

        let lastHubErr: Error | undefined
        for (const candidate of hubCandidates) {
          const hubBase = candidate.replace(/\/+$/, '')
          try {
            const res = await fetch(`${hubBase}/orchestrator/standalone/sessions/${encodeURIComponent(body.sessionId)}/tool`, {
              method: 'POST',
              signal: exec.signal,
              headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' },
              body: JSON.stringify({
                name: def.name,
                args,
                ...(preReportSnap
                  ? {
                      branch: branchName,
                      worktreeDir: worktreeDir.replaceAll('\\', '/'),
                      repoRoot: options.repoRoot.replaceAll('\\', '/'),
                      ...(preReportSnap.gitBundleB64 ? { gitBundleB64: preReportSnap.gitBundleB64 } : {}),
                      ...(preReportSnap.syncedFiles.length ? { syncedFiles: preReportSnap.syncedFiles } : {}),
                    }
                  : {}),
              }),
            })
            const data = await res.json() as { result?: unknown; error?: string }
            if (!res.ok) {
              throw new Error(data.error ?? `Hub tool ${def.name} failed (${res.status})`)
            }
            return data.result
          } catch (err) {
            lastHubErr = err instanceof Error ? err : new Error(String(err))
            if (exec.signal.aborted) throw lastHubErr
          }
        }
        throw lastHubErr ?? new Error(`All Hub endpoints failed for tool ${def.name}`)
      },
    })
  }

  const abort = new AbortController()
  const onEvent = (type: string, data: unknown) => {
    events.push({ type, data })
  }

  const req = {
    sessionId: body.sessionId,
    provider: body.provider,
    model: body.model,
    ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
    cwd: worktreeDir,
    systemPrompt: body.systemPrompt,
    messages: body.messages,
    tools: proxyTools,
    signal: abort.signal,
    onEvent,
  }

  let replyText = ''
  if (options.customDriver) {
    replyText = (await options.customDriver(req)) ?? ''
  } else if (body.provider === 'codex') {
    replyText = await runCodexTurn(req)
  } else if (body.provider === 'cursor') {
    replyText = await runCursorTurn(req)
  } else {
    replyText = await runDshTurn(req)
  }

  const finalSnap = snapshotRemoteWorktree()

  return {
    replyText,
    events,
    branch: branchName,
    headSha: finalSnap.headSha,
    repoRoot: options.repoRoot.replaceAll('\\', '/'),
    worktreeDir: worktreeDir.replaceAll('\\', '/'),
    ...(finalSnap.gitBundleB64 ? { gitBundleB64: finalSnap.gitBundleB64 } : {}),
    ...(finalSnap.syncedFiles.length ? { syncedFiles: finalSnap.syncedFiles } : {}),
  }
}
