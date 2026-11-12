/**
 * Personal Business Skills Plugin (`@rharness/plugin-personal-skills`) & Native Feishu Direct Message Bridge.
 *
 * Provides optional personal automation tools and zero-dependency Feishu `pbbp2` WebSocket DM integration.
 * Operator-specific paths, credentials, and peer addresses are loaded from `~/.rharness/private-pack/manifest.json`
 * (or environment variables), keeping the public codebase completely free of personal topology details.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Duplex } from 'node:stream'
import { promisify } from 'node:util'
import { z } from 'zod'
import { loadPrivatePack } from './private-pack.ts'
import type { RegisteredToolSpec } from './standalone-host.ts'
import type { WorkerNodeRecord } from './worker-nodes.ts'

const execFileAsync = promisify(execFile)

export interface ClawFeedNotificationRecord {
  id: string
  user: string
  tag: '验证码' | '重要' | '普通' | string
  message: string
  at: string
}

export interface ClawFeedPluginRepoInfo {
  found: boolean
  repoPath?: string
  branch?: string
  commit?: string
  remote?: string
  manifestVersion?: string
}

export function getClawFeedRepoCandidates(): string[] {
  const pack = loadPrivatePack()?.manifest.personalPaths
  const envDir = process.env.RHARNESS_CLAWFEED_DIR?.trim()
  return [
    ...(envDir ? [envDir] : []),
    ...(pack?.clawfeedRepoDirs ?? []),
  ]
}

export function getClawFeedSinkEndpoints(): string[] {
  const pack = loadPrivatePack()?.manifest.personalPaths
  const envUrl = process.env.RHARNESS_CLAWFEED_SINK_URL?.trim()
  return [
    ...(envUrl ? [envUrl] : []),
    ...(pack?.clawfeedSinkEndpoints ?? ['http://127.0.0.1:8090']),
  ]
}

export function inspectClawFeedPluginRepo(): ClawFeedPluginRepoInfo {
  for (const dir of getClawFeedRepoCandidates()) {
    if (!existsSync(dir)) continue
    try {
      const manifestPath = join(dir, 'rharness-plugin.json')
      let manifestVersion = '0.2.0'
      if (existsSync(manifestPath)) {
        const mf = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string }
        if (mf.version) manifestVersion = mf.version
      }
      const branch = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      const commit = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
        windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      let remote = 'origin'
      try {
        remote = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
          windowsHide: true,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
      } catch {}
      return {
        found: true,
        repoPath: dir,
        branch,
        commit,
        remote,
        manifestVersion,
      }
    } catch {
      return { found: true, repoPath: dir }
    }
  }
  return { found: false }
}

function defaultHomeFile(...parts: string[]): string {
  return join(homedir() || '.', '.rharness', ...parts).replaceAll('\\', '/')
}

export function getPersonalPaths() {
  const p = loadPrivatePack()?.manifest.personalPaths ?? {}
  return {
    feishuCred: process.env.RHARNESS_FEISHU_CRED || p.feishuCred || defaultHomeFile('credentials', 'feishu.json'),
    openclawCfgFallback: p.openclawCfgFallback || '',
    todoListPs1: p.todoListPs1 || defaultHomeFile('scripts', 'list-tasks.ps1'),
    todoWritePs1: p.todoWritePs1 || defaultHomeFile('scripts', 'task-write.ps1'),
    emailProjectDir: p.emailProjectDir || defaultHomeFile('scripts', 'email-processing'),
    emailStatePy: p.emailStatePy || defaultHomeFile('scripts', 'email-processing', 'email_state.py'),
    feishuCalendarPy: p.feishuCalendarPy || defaultHomeFile('scripts', 'email-processing', 'feishu_calendar.py'),
    marketWatchDir: p.marketWatchDir || defaultHomeFile('market-watch'),
    marketReportUrl: p.marketReportUrl || '',
    marketMetalsUrl: p.marketMetalsUrl || '',
    marketAnalogsUrl: p.marketAnalogsUrl || '',
    dedupPy: p.dedupPy || defaultHomeFile('scripts', 'dedup.py'),
    interestsCsv: p.interestsCsv || defaultHomeFile('data', 'interests.csv'),
    standaloneOrdersDir: p.standaloneOrdersDir || defaultHomeFile('orders'),
    ordersDir: p.ordersDir || defaultHomeFile('orders'),
    ordersAnalyzePs1: p.ordersAnalyzePs1 || defaultHomeFile('scripts', 'analyze.ps1'),
    ordersSummaryPs1: p.ordersSummaryPs1 || defaultHomeFile('scripts', 'summary.ps1'),
    pdfSkillDir: p.pdfSkillDir || defaultHomeFile('scripts', 'pdf-archive'),
    pdfProcessPy: p.pdfProcessPy || defaultHomeFile('scripts', 'pdf-archive', 'pdf_process.py'),
    pdfDedupIndex: p.pdfDedupIndex || defaultHomeFile('data', 'pdfs-index.json'),
    transcribePs1: p.transcribePs1 || defaultHomeFile('scripts', 'transcribe.ps1'),
    clawfeedPauseFile: p.clawfeedPauseFile || defaultHomeFile('state', 'sink-paused'),
    siyuanCred: process.env.RHARNESS_SIYUAN_CRED || p.siyuanCred || defaultHomeFile('credentials', 'siyuan.json'),
    tcSshKey: p.tcSshKey || join(homedir() || '.', '.ssh', 'id_ed25519').replaceAll('\\', '/'),
    tcSshHost: p.tcSshHost || '127.0.0.1',
    tcSshUser: p.tcSshUser || 'ubuntu',
    tcSshHostKeyAlias: p.tcSshHostKeyAlias || '',
    tcKnownHostsUserRoot: p.tcKnownHostsUserRoot || (homedir() || '.').replaceAll('\\', '/'),
    ownerOpenId: process.env.RHARNESS_FEISHU_OWNER_OPEN_ID || p.ownerOpenId || '',
    ownerDmChatId: process.env.RHARNESS_FEISHU_OWNER_CHAT_ID || p.ownerDmChatId || '',
    peerFallbackEndpoints: p.peerFallbackEndpoints ?? [],
  }
}

export const CLAW_PATHS = new Proxy({} as ReturnType<typeof getPersonalPaths>, {
  get(_target, prop: keyof ReturnType<typeof getPersonalPaths>) {
    return getPersonalPaths()[prop]
  },
})

export type SiyuanInstanceId = 'siyuan' | 'siyuan-rh'

export interface SiyuanInstanceMeta {
  id: SiyuanInstanceId
  label: string
  scope: 'family-shared' | 'owner-private'
  container: string
  token: string
}

interface SiyuanCredentialsFile {
  instances?: Record<
    string,
    {
      label?: string
      scope?: 'family-shared' | 'owner-private'
      container?: string
      token?: string
    }
  >
  sshHost?: string
}

export function loadSiyuanCredentials(): { instances: Record<SiyuanInstanceId, SiyuanInstanceMeta>; sshHost: string } | undefined {
  if (!existsSync(CLAW_PATHS.siyuanCred)) return undefined
  try {
    const raw = JSON.parse(readFileSync(CLAW_PATHS.siyuanCred, 'utf8')) as SiyuanCredentialsFile
    const s1 = raw.instances?.siyuan
    const s2 = raw.instances?.['siyuan-rh']
    if (!s1?.token || !s2?.token) return undefined
    return {
      sshHost: raw.sshHost || CLAW_PATHS.tcSshHost,
      instances: {
        siyuan: {
          id: 'siyuan',
          label: s1.label || '🏠 家庭共用思源库 (siyuan)',
          scope: 'family-shared',
          container: s1.container || 'siyuan',
          token: s1.token,
        },
        'siyuan-rh': {
          id: 'siyuan-rh',
          label: s2.label || '🔒 个人私有思源库 (siyuan_rh)',
          scope: 'owner-private',
          container: s2.container || 'siyuan-rh',
          token: s2.token,
        },
      },
    }
  } catch {
    return undefined
  }
}

const siyuanContainerIpCache = new Map<SiyuanInstanceId, { ip: string; expiresAt: number }>()

function buildTcSshBaseArgs(sshHost?: string): string[] {
  const paths = getPersonalPaths()
  const host = sshHost || paths.tcSshHost
  const userRoot = paths.tcKnownHostsUserRoot
  const base = [
    '-F',
    'none',
    '-4',
    '-T',
    '-i',
    paths.tcSshKey,
    '-o',
    `Hostname=${host}`,
    '-o',
    `User=${paths.tcSshUser}`,
    '-o',
    'Port=22',
    ...(paths.tcSshHostKeyAlias ? ['-o', `HostKeyAlias=${paths.tcSshHostKeyAlias}`] : []),
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${userRoot}/.ssh/known_hosts ${userRoot}/.ssh/known_hosts2`,
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'ConnectTimeout=8',
    '-o',
    'LogLevel=ERROR',
  ]
  return base
}

async function resolveSiyuanContainerIp(
  instance: SiyuanInstanceId,
  sshHost: string,
  forceRefresh = false,
): Promise<string> {
  const now = Date.now()
  const cached = siyuanContainerIpCache.get(instance)
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.ip
  }
  const args = [
    ...buildTcSshBaseArgs(sshHost),
    'tc',
    `docker inspect --format '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' ${instance}`,
  ]
  const res = await runCommandCapture('C:/Windows/System32/OpenSSH/ssh.exe', args, undefined, 12_000)
  const ip = res.stdout.split(/\r?\n/)[0]?.trim() ?? ''
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    throw new Error(`Failed to resolve Docker IP for ${instance} on tc: ${res.stderr || res.error || ip}`)
  }
  siyuanContainerIpCache.set(instance, { ip, expiresAt: now + 10 * 60 * 1000 })
  return ip
}

export const DEFAULT_SIYUAN_BLOCKED_NOTEBOOK_NAMES = new Set([
  'data',
  'secret',
  'secrets',
  'vault',
  '私密',
  '密码',
])

export function getBlockedSiyuanNotebookIds(): Set<string> {
  const extra = loadPrivatePack()?.manifest.personalPaths?.siyuanBlockedNotebookIds ?? []
  return new Set(extra)
}

export const DEFAULT_SIYUAN_BLOCKED_PATH_KEYWORDS = [
  '密码',
  '银行卡',
  '身份证',
  '密钥',
  '私钥',
  '助记词',
  '账密',
  '口令',
  'recovery',
  'two-factor',
  '2fa',
  'credential',
  'secret',
] as const

export function isSiyuanNotebookBlocked(notebookId: string, notebookName?: string): boolean {
  if (getBlockedSiyuanNotebookIds().has(notebookId)) return true
  if (notebookName && DEFAULT_SIYUAN_BLOCKED_NOTEBOOK_NAMES.has(notebookName.trim().toLowerCase())) return true
  return false
}

export function isSiyuanPathBlocked(hpathOrTitle: string, extraKeywords: readonly string[] = []): boolean {
  const lower = (hpathOrTitle ?? '').toLowerCase()
  if (!lower) return false
  for (const kw of [...DEFAULT_SIYUAN_BLOCKED_PATH_KEYWORDS, ...extraKeywords]) {
    const clean = kw.trim().toLowerCase()
    if (clean && lower.includes(clean)) return true
  }
  return false
}

/**
 * Deterministic DLP redaction filter applied to all SiYuan note snippets and Markdown bodies
 * BEFORE they leave the gateway or enter any LLM context.
 */
export function redactSensitiveNoteContent(text: string): string {
  if (!text) return text
  return (
    text
      // 1. Private key blocks (OpenSSH / RSA / EC / PEM)
      .replace(
        /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
        '[🔒 私钥块已自动脱敏]',
      )
      // 2. Common API keys & tokens (sk-..., ghp_..., xoxb-..., AKIA...)
      .replace(
        /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g,
        '[🔒 API密钥已脱敏]',
      )
      // 3. 18-digit Chinese Resident ID Card numbers
      .replace(
        /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g,
        '[🔒 身份证号已脱敏]',
      )
      // 4. 16~19-digit Bank Card numbers (UnionPay 62*, Visa 4*, MasterCard 51-55*)
      .replace(/(?<!\d)(?:62\d{14,17}|4\d{15}|5[1-5]\d{14})(?!\d)/g, '[🔒 银行卡号已脱敏]')
      // 5. Explicit password / secret / token key-value pairs in lines
      .replace(
        /((?:密码|口令|私钥|助记词|pass(?:word)?|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[:：=]\s*)([^\s,，;；\n]{4,80})/gi,
        '$1[🔒 已脱敏]',
      )
  )
}

export async function callSiyuanApi<T = unknown>(
  instance: SiyuanInstanceId,
  route: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const cfg = loadSiyuanCredentials()
  if (!cfg) {
    throw new Error('SiYuan credentials (siyuan.json) not found on this machine')
  }
  const inst = cfg.instances[instance]
  const attemptOnce = async (forceRefreshIp: boolean): Promise<T> => {
    const ip = await resolveSiyuanContainerIp(instance, cfg.sshHost, forceRefreshIp)
    const sshArgs = [...buildTcSshBaseArgs(cfg.sshHost), '-W', `${ip}:6806`, 'tc']
    const child = spawn('C:/Windows/System32/OpenSSH/ssh.exe', sshArgs, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const socket = Duplex.from({ readable: child.stdout, writable: child.stdin })
    const agent = new http.Agent({ keepAlive: false })
    ;(agent as unknown as { createConnection: () => Duplex }).createConnection = () => socket
    const bytes = Buffer.from(JSON.stringify(body), 'utf8')
    try {
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`SiYuan request timed out (${instance} ${route})`))
        }, 15_000)
        const req = http.request(
          {
            agent,
            host: 'localhost',
            port: 6806,
            path: route,
            method: 'POST',
            headers: {
              Authorization: `Token ${inst.token}`,
              'Content-Type': 'application/json',
              'Content-Length': bytes.length,
              Connection: 'close',
            },
          },
          res => {
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => {
              clearTimeout(timer)
              try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                  code?: number
                  msg?: string
                  data?: T
                }
                if (parsed.code !== 0) {
                  reject(new Error(`SiYuan API error (${instance}): code=${parsed.code} msg=${parsed.msg ?? ''}`))
                  return
                }
                resolve(parsed.data as T)
              } catch (err) {
                reject(err)
              }
            })
          },
        )
        req.on('error', err => {
          clearTimeout(timer)
          reject(err)
        })
        req.end(bytes)
      })
    } finally {
      agent.destroy()
      socket.destroy()
      if (child.exitCode === null) child.kill()
    }
  }

  try {
    return await attemptOnce(false)
  } catch {
    return await attemptOnce(true)
  }
}

export function hasLocalClawPersonalAssets(): boolean {
  return existsSync(CLAW_PATHS.todoListPs1) || existsSync(CLAW_PATHS.marketWatchDir)
}

export interface FeishuCredentials {
  appId: string
  appSecret: string
  ownerOpenId: string
  dmChatId: string
}

export function loadStandaloneFeishuCredentials(): FeishuCredentials | undefined {
  for (const candidate of [CLAW_PATHS.feishuCred, CLAW_PATHS.openclawCfgFallback]) {
    if (!existsSync(candidate)) continue
    try {
      const raw = readFileSync(candidate, 'utf8').replace(/^\uFEFF/, '')
      const parsed = JSON.parse(raw) as {
        appId?: string
        appSecret?: string
        ownerOpenId?: string
        dmChatId?: string
        channels?: { feishu?: { appId?: string; appSecret?: string } }
      }
      const appId = parsed.appId ?? parsed.channels?.feishu?.appId
      const appSecret = parsed.appSecret ?? parsed.channels?.feishu?.appSecret
      if (typeof appId === 'string' && appId && typeof appSecret === 'string' && appSecret) {
        return {
          appId,
          appSecret,
          ownerOpenId: parsed.ownerOpenId || CLAW_PATHS.ownerOpenId,
          dmChatId: parsed.dmChatId || CLAW_PATHS.ownerDmChatId,
        }
      }
    } catch {
      /* ignore unreadable config */
    }
  }
  return undefined
}

async function getFeishuTenantToken(cred: FeishuCredentials): Promise<string> {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: cred.appId, app_secret: cred.appSecret }),
    signal: AbortSignal.timeout(12_000),
  })
  const data = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string }
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Feishu token error: code=${data.code} msg=${data.msg ?? 'unknown'}`)
  }
  return data.tenant_access_token
}

export async function addFeishuMessageReaction(
  messageId: string,
  emojiType = 'Typing',
): Promise<string | undefined> {
  const cred = loadStandaloneFeishuCredentials()
  if (!cred || !messageId) return undefined
  try {
    const token = await getFeishuTenantToken(cred)
    const res = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          reaction_type: { emoji_type: emojiType },
        }),
        signal: AbortSignal.timeout(8000),
      },
    )
    const data = (await res.json()) as { code?: number; data?: { reaction_id?: string } }
    if (data.code === 0 && typeof data.data?.reaction_id === 'string') {
      return data.data.reaction_id
    }
  } catch {}
  return undefined
}

export async function removeFeishuMessageReaction(
  messageId: string,
  reactionId: string,
): Promise<boolean> {
  const cred = loadStandaloneFeishuCredentials()
  if (!cred || !messageId || !reactionId) return false
  try {
    const token = await getFeishuTenantToken(cred)
    const res = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
      {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(8000),
      },
    )
    const data = (await res.json()) as { code?: number }
    return data.code === 0
  } catch {
    return false
  }
}

export async function sendFeishuDirectMessage(
  text: string,
  receiveId?: string,
  receiveIdType: 'open_id' | 'chat_id' = 'open_id',
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const cred = loadStandaloneFeishuCredentials()
  if (!cred) {
    return { ok: false, error: 'Feishu credentials (feishu.json) not found on this machine' }
  }
  try {
    const token = await getFeishuTenantToken(cred)
    const target = receiveId || (receiveIdType === 'chat_id' ? cred.dmChatId : cred.ownerOpenId)
    const res = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          receive_id: target,
          msg_type: 'post',
          content: JSON.stringify({
            zh_cn: {
              title: '',
              content: [[{ tag: 'md', text }]],
            },
          }),
        }),
        signal: AbortSignal.timeout(15_000),
      },
    )
    const data = (await res.json()) as { code?: number; msg?: string; data?: { message_id?: string } }
    if (data.code === 0) {
      return {
        ok: true,
        ...(data.data?.message_id ? { messageId: data.data.message_id } : {}),
      }
    }
    return { ok: false, error: `code=${data.code} msg=${data.msg}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function runCommandCapture(
  cmd: string,
  args: string[],
  cwd?: string,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    })
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? '').trim(),
      error: e.message ?? String(err),
    }
  }
}

/**
 * Executes a personal business skill locally on `claw`.
 */
export async function executePersonalSkillLocal(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (toolName) {
    case 'todo_list': {
      const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CLAW_PATHS.todoListPs1]
      if (args.include_completed === true) psArgs.push('-IncludeCompleted')
      const res = await runCommandCapture('powershell.exe', psArgs)
      return {
        ok: res.ok,
        output: res.stdout || res.stderr || res.error || 'NO_TASKS',
      }
    }

    case 'todo_write': {
      const action = String(args.action ?? 'add').trim()
      const psArgs = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        CLAW_PATHS.todoWritePs1,
        '-Action',
        action,
      ]
      const summaryText = typeof args.summary === 'string' ? args.summary.trim() : ''
      if (summaryText) {
        psArgs.push('-Summary', summaryText)
      }
      let normalizedDue = ''
      if (typeof args.due === 'string' && args.due.trim()) {
        let dueStr = args.due.trim()
        const curYear = new Date().getFullYear()
        const m = /^(\d{4})-(\d{2}-\d{2}\s+\d{2}:\d{2})$/.exec(dueStr)
        if (m && Number(m[1]) < curYear) {
          dueStr = `${curYear}-${m[2]}`
        }
        normalizedDue = dueStr
        psArgs.push('-Due', dueStr)
      }
      if (typeof args.guid === 'string' && args.guid.trim()) {
        psArgs.push('-Guid', args.guid.trim())
      }
      const res = await runCommandCapture('powershell.exe', psArgs)
      const outText = res.stdout || res.stderr || res.error || ''

      // Smart Dual-Write: When adding a todo with a specific clock time (e.g. "2026-11-09 12:00"),
      // automatically sync it to Feishu Calendar (`feishu_calendar.py add`) so Feishu Calendar Assistant sends a reminder!
      let calendarSync: unknown = undefined
      if (res.ok && action === 'add' && normalizedDue && args.sync_calendar !== false) {
        const timeMatch = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})$/.exec(normalizedDue)
        const clockPart = timeMatch ? `${timeMatch[2]}:${timeMatch[3]}` : ''
        if (timeMatch && clockPart !== '00:00' && clockPart !== '23:59') {
          const addedGuid = /guid=([0-9a-fA-F-]{32,36})/.exec(outText)?.[1] ?? `${summaryText}:${normalizedDue}`
          const startHour = Number(timeMatch[2])
          const endHour = Math.min(23, startHour + 1)
          const endStr = `${timeMatch[1]} ${String(endHour).padStart(2, '0')}:${timeMatch[3]}`
          const calRes = await runCommandCapture(
            'uv',
            [
              'run',
              '--offline',
              '--no-sync',
              '--project',
              CLAW_PATHS.emailProjectDir,
              CLAW_PATHS.feishuCalendarPy,
              'add',
              '--summary',
              summaryText || '待办日程',
              '--start',
              normalizedDue,
              '--end',
              endStr,
              '--reminder-minutes',
              String(typeof args.reminder_minutes === 'number' ? args.reminder_minutes : 60),
              '--msg-id',
              `todo:${addedGuid}`,
            ],
            CLAW_PATHS.emailProjectDir,
            25_000,
          )
          try {
            calendarSync = JSON.parse(calRes.stdout)
          } catch {
            calendarSync = { ok: calRes.ok, output: calRes.stdout }
          }
        }
      } else if (res.ok && action === 'delete') {
        const deletedGuid = /guid=([0-9a-fA-F-]{32,36})/.exec(outText)?.[1]
        if (deletedGuid) {
          await runCommandCapture(
            'uv',
            [
              'run',
              '--offline',
              '--no-sync',
              '--project',
              CLAW_PATHS.emailProjectDir,
              CLAW_PATHS.feishuCalendarPy,
              'delete',
              '--msg-id',
              `todo:${deletedGuid}`,
            ],
            CLAW_PATHS.emailProjectDir,
            15_000,
          ).catch(() => {})
        }
      }

      return {
        ok: res.ok,
        action,
        output: outText,
        ...(normalizedDue ? { due: normalizedDue } : {}),
        ...(calendarSync ? { calendarSync } : {}),
      }
    }

    case 'email_check': {
      const mode = args.mode === 'list' ? 'list' : 'new'
      const res = await runCommandCapture(
        'uv',
        ['run', '--offline', '--no-sync', '--project', CLAW_PATHS.emailProjectDir, CLAW_PATHS.emailStatePy, mode],
        CLAW_PATHS.emailProjectDir,
        45_000,
      )
      let parsed: unknown = res.stdout
      try {
        parsed = JSON.parse(res.stdout)
      } catch {}
      return {
        ok: res.ok,
        mode,
        result: parsed,
        ...(res.error ? { error: res.error } : {}),
      }
    }

    case 'email_read': {
      const action = args.action === 'mark' ? 'mark' : 'read'
      const messageId = String(args.message_id ?? '').trim()
      if (!messageId) throw new Error('message_id is required')
      const res = await runCommandCapture(
        'uv',
        ['run', '--offline', '--no-sync', '--project', CLAW_PATHS.emailProjectDir, CLAW_PATHS.emailStatePy, action, messageId],
        CLAW_PATHS.emailProjectDir,
        35_000,
      )
      let parsed: unknown = res.stdout
      try {
        parsed = JSON.parse(res.stdout)
      } catch {}
      return {
        ok: res.ok,
        action,
        message_id: messageId,
        result: parsed,
        ...(res.error ? { error: res.error } : {}),
      }
    }

    case 'calendar_add': {
      const action = args.action === 'status' ? 'status' : 'add'
      const uvArgs = [
        'run',
        '--offline',
        '--no-sync',
        '--project',
        CLAW_PATHS.emailProjectDir,
        CLAW_PATHS.feishuCalendarPy,
        action,
      ]
      if (action === 'add') {
        const summary = String(args.summary ?? '').trim()
        const start = String(args.start ?? '').trim()
        const end = String(args.end ?? '').trim()
        if (!summary || !start || !end) {
          throw new Error('summary, start ("YYYY-MM-DD HH:MM"), and end ("YYYY-MM-DD HH:MM") are required for calendar_add')
        }
        uvArgs.push('--summary', summary, '--start', start, '--end', end)
        if (typeof args.reminder_minutes === 'number') {
          uvArgs.push('--reminder-minutes', String(args.reminder_minutes))
        }
        if (typeof args.description === 'string' && args.description.trim()) {
          uvArgs.push('--description', args.description.trim())
        }
        if (typeof args.msg_id === 'string' && args.msg_id.trim()) {
          uvArgs.push('--msg-id', args.msg_id.trim())
        }
      }
      const res = await runCommandCapture('uv', uvArgs, CLAW_PATHS.emailProjectDir, 30_000)
      return {
        ok: res.ok,
        action,
        output: res.stdout || res.stderr || res.error,
      }
    }

    case 'market_summary': {
      const snapshotsPath = `${CLAW_PATHS.marketWatchDir}/data/snapshots.json`
      const hourlyStatePath = `${CLAW_PATHS.marketWatchDir}/data/kline-warehouse/hourly-state.json`
      const checkLogPath = `${CLAW_PATHS.marketWatchDir}/check.log`
      let snapshots: unknown = undefined
      let warehouse: unknown = undefined
      let recentLog = ''
      if (existsSync(snapshotsPath)) {
        try { snapshots = JSON.parse(readFileSync(snapshotsPath, 'utf8')) } catch {}
      }
      if (existsSync(hourlyStatePath)) {
        try { warehouse = JSON.parse(readFileSync(hourlyStatePath, 'utf8')) } catch {}
      }
      if (existsSync(checkLogPath)) {
        try {
          const lines = readFileSync(checkLogPath, 'utf8').trim().split('\n')
          recentLog = lines.slice(-15).join('\n')
        } catch {}
      }
      return {
        ok: true,
        ...(CLAW_PATHS.marketReportUrl ? { reportUrl: CLAW_PATHS.marketReportUrl } : {}),
        ...(CLAW_PATHS.marketMetalsUrl ? { metalsUrl: CLAW_PATHS.marketMetalsUrl } : {}),
        ...(CLAW_PATHS.marketAnalogsUrl ? { analogsUrl: CLAW_PATHS.marketAnalogsUrl } : {}),
        snapshots,
        warehouse,
        recentLog,
      }
    }

    case 'interest_dedup': {
      const url = String(args.url ?? '').trim()
      if (!url) throw new Error('url is required')
      const res = await runCommandCapture('python', [CLAW_PATHS.dedupPy, url], undefined, 25_000)
      let parsed: Record<string, unknown> = { raw: res.stdout }
      try {
        parsed = JSON.parse(res.stdout) as Record<string, unknown>
      } catch {}

      // If `append_title` is provided and not already matched, append to `interests.csv`
      if (
        typeof args.append_title === 'string' &&
        args.append_title.trim() &&
        parsed.matched === false &&
        existsSync(CLAW_PATHS.interestsCsv)
      ) {
        const dateStr = new Date().toISOString().slice(0, 10)
        const title = args.append_title.trim().replace(/"/g, '""')
        const platform = String(args.platform ?? parsed.platform ?? 'web').trim()
        const finalUrl = String(parsed.resolved_url ?? url).trim()
        const level = String(args.level ?? '全文提炼').trim()
        const keywords = String(args.keywords ?? '').trim().replace(/"/g, '""')
        const csvLine = `\r\n${dateStr},"${title}",${platform},${finalUrl},${level},"${keywords}"`
        const currentCsv = readFileSync(CLAW_PATHS.interestsCsv, 'utf8')
        writeFileSync(CLAW_PATHS.interestsCsv, currentCsv.trimEnd() + csvLine + '\r\n', 'utf8')
        parsed.appendedToCsv = true
      }

      return {
        ok: res.ok,
        ...parsed,
      }
    }

    case 'feishu_send_dm': {
      const text = String(args.text ?? '').trim()
      if (!text) throw new Error('text is required')
      return await sendFeishuDirectMessage(text)
    }

    case 'orders_report': {
      const activeOrdersDir = existsSync(CLAW_PATHS.standaloneOrdersDir)
        ? CLAW_PATHS.standaloneOrdersDir
        : CLAW_PATHS.ordersDir
      const dbPath = join(activeOrdersDir, 'orders.db')
      const allCsvPath = join(activeOrdersDir, 'orders-all.csv')

      if (args.action === 'add') {
        const plat = String(args.platform ?? 'taobao').trim().toLowerCase()
        const product = String(args.product ?? '').trim()
        if (!product) throw new Error('product name is required when action="add"')
        const orderNo = String(args.order_no ?? `MAN-${Date.now()}`).trim()
        const orderTime = String(args.order_time ?? new Date().toISOString().slice(0, 10)).trim()
        const totalAmount = Number(args.amount ?? 0)
        const qty = Number(args.qty ?? 1)
        const shop = String(args.shop ?? '').trim()
        const category = String(args.category ?? '').trim()
        const status = String(args.status ?? '交易成功').trim()
        const nowIso = new Date().toISOString()

        if (existsSync(dbPath)) {
          const db = new DatabaseSync(dbPath)
          try {
            db.prepare(
              'INSERT OR REPLACE INTO orders (platform, order_no, order_time, total_amount, status, shop, product, qty, category, raw, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            ).run(
              plat,
              orderNo,
              orderTime,
              totalAmount,
              status,
              shop,
              product,
              qty,
              category,
              JSON.stringify({ platform: plat, order_no: orderNo, order_time: orderTime, product, total_amount: totalAmount, shop, status }),
              nowIso,
              nowIso,
            )
          } finally {
            db.close()
          }
        }
        if (existsSync(allCsvPath)) {
          const esc = (s: string) => `"${s.replace(/"/g, '""')}"`
          const line = `\r\n${[plat, orderNo, orderTime.slice(0, 10), product, String(qty), totalAmount.toFixed(2), shop, status].map(esc).join(',')}`
          const currentCsv = readFileSync(allCsvPath, 'utf8')
          writeFileSync(allCsvPath, currentCsv.trimEnd() + line + '\r\n', 'utf8')
        }
        return {
          ok: true,
          action: 'add',
          ordersDir: activeOrdersDir,
          added: { platform: plat, order_no: orderNo, order_time: orderTime, product, total_amount: totalAmount, qty, shop, category, status },
        }
      }

      const month = typeof args.month === 'string' && /^\d{4}-\d{2}$/.test(args.month.trim())
        ? args.month.trim()
        : undefined
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const platform = typeof args.platform === 'string' && args.platform !== 'all' ? args.platform.trim().toLowerCase() : ''
      const limit = Math.max(1, Math.min(100, Number(args.limit ?? 25)))

      const availableMonths = existsSync(activeOrdersDir)
        ? readdirSync(activeOrdersDir).filter(name => /^\d{4}-\d{2}$/.test(name)).sort().reverse()
        : []
      const targetMonth = month ?? availableMonths[0]

      if (args.recompute === true && targetMonth && existsSync(CLAW_PATHS.ordersAnalyzePs1)) {
        await runCommandCapture('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          CLAW_PATHS.ordersAnalyzePs1,
          '-Month',
          targetMonth,
          '-OrdersDir',
          activeOrdersDir,
        ])
      }

      let platformSummary: unknown[] = []
      let matchedOrders: unknown[] = []
      let totalMatchedCount = 0

      if (existsSync(dbPath)) {
        const db = new DatabaseSync(dbPath, { readOnly: true })
        try {
          platformSummary = db
            .prepare(
              'SELECT platform, COUNT(*) as orderCount, MIN(order_time) as earliestOrder, MAX(order_time) as latestOrder, ROUND(SUM(total_amount), 2) as totalAmount FROM orders GROUP BY platform ORDER BY orderCount DESC',
            )
            .all()

          const clauses: string[] = []
          const params: (string | number)[] = []
          if (platform) {
            clauses.push('LOWER(platform) = ?')
            params.push(platform)
          }
          if (month) {
            clauses.push('order_time LIKE ?')
            params.push(`${month}%`)
          }
          if (query) {
            clauses.push('(product LIKE ? OR shop LIKE ? OR category LIKE ? OR order_no LIKE ?)')
            const likeQ = `%${query}%`
            params.push(likeQ, likeQ, likeQ, likeQ)
          }
          const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
          const countRow = db
            .prepare(`SELECT COUNT(*) as c FROM orders ${whereSql}`)
            .get(...params) as { c?: number } | undefined
          totalMatchedCount = Number(countRow?.c ?? 0)
          matchedOrders = db
            .prepare(
              `SELECT platform, order_no, order_time, total_amount, status, shop, product, qty, category FROM orders ${whereSql} ORDER BY order_time DESC LIMIT ?`,
            )
            .all(...params, limit)
        } finally {
          db.close()
        }
      }

      const statsPath = targetMonth ? join(activeOrdersDir, targetMonth, 'stats.json') : ''
      const reportPath = targetMonth ? join(activeOrdersDir, targetMonth, 'report.md') : ''
      const stats = statsPath && existsSync(statsPath) ? JSON.parse(readFileSync(statsPath, 'utf8')) : undefined
      const reportMd = reportPath && existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : undefined
      return {
        ok: true,
        ordersDir: activeOrdersDir,
        platformSummary,
        totalMatchedCount,
        matchedOrders,
        month: targetMonth,
        availableMonths,
        ...( !query && !platform ? { stats, reportMd } : {}),
      }
    }

    case 'pdf_archive': {
      const inputPath = String(args.path ?? '').trim()
      if (!inputPath) throw new Error('PDF file path is required')
      const res = await runCommandCapture(
        'uv',
        [
          'run',
          '--project',
          CLAW_PATHS.pdfSkillDir,
          'python',
          CLAW_PATHS.pdfProcessPy,
          '--input',
          inputPath,
          '--dedup-index',
          CLAW_PATHS.pdfDedupIndex,
        ],
        CLAW_PATHS.pdfSkillDir,
        120_000,
      )
      let parsed: unknown = res.stdout
      try { parsed = JSON.parse(res.stdout) } catch {}
      return {
        ok: res.ok,
        input: inputPath,
        result: parsed,
        ...(res.error ? { error: res.error } : {}),
      }
    }

    case 'audio_transcribe': {
      const audioPath = String(args.audio_path ?? '').trim()
      if (!audioPath) throw new Error('audio_path is required')
      const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CLAW_PATHS.transcribePs1, '-AudioPath', audioPath]
      if (typeof args.out_txt === 'string' && args.out_txt.trim()) {
        psArgs.push('-OutTxt', args.out_txt.trim())
      }
      const res = await runCommandCapture('powershell.exe', psArgs, undefined, 300_000)
      return {
        ok: res.ok,
        audio_path: audioPath,
        output: res.stdout || res.stderr || res.error,
      }
    }

    case 'clawfeed_pause': {
      const paused = args.paused === true
      if (paused) {
        mkdirSync(dirname(CLAW_PATHS.clawfeedPauseFile), { recursive: true })
        writeFileSync(CLAW_PATHS.clawfeedPauseFile, new Date().toISOString(), 'utf8')
      } else if (existsSync(CLAW_PATHS.clawfeedPauseFile)) {
        rmSync(CLAW_PATHS.clawfeedPauseFile, { force: true })
      }
      return {
        ok: true,
        paused: existsSync(CLAW_PATHS.clawfeedPauseFile),
      }
    }

    case 'siyuan_notebooks': {
      const targetInst = String(args.instance ?? 'all').trim()
      const instList: SiyuanInstanceId[] =
        targetInst === 'siyuan'
          ? ['siyuan']
          : targetInst === 'siyuan-rh'
            ? ['siyuan-rh']
            : ['siyuan', 'siyuan-rh']
      const results = await Promise.all(
        instList.map(async inst => {
          try {
            const nbData = await callSiyuanApi<{ notebooks?: { id: string; name: string; closed?: boolean }[] }>(
              inst,
              '/api/notebook/lsNotebooks',
              {},
            )
            const docs = await callSiyuanApi<
              { id: string; box: string; hpath: string; content: string; updated?: string }[]
            >(inst, '/api/query/sql', {
              stmt: "SELECT id, box, hpath, content, updated FROM blocks WHERE type='d' ORDER BY updated DESC LIMIT 35",
            })
            const rawNotebooks = nbData?.notebooks ?? []
            const allowedNotebooks = rawNotebooks.filter(n => !isSiyuanNotebookBlocked(n.id, n.name))
            const nbMap = new Map(allowedNotebooks.map(n => [n.id, n.name]))
            const allowedRecentDocs = (docs ?? []).filter(
              d =>
                nbMap.has(d.box) &&
                !isSiyuanNotebookBlocked(d.box, nbMap.get(d.box)) &&
                !isSiyuanPathBlocked(d.hpath) &&
                !isSiyuanPathBlocked(d.content),
            )
            return {
              instance: inst,
              label: inst === 'siyuan' ? '🏠 家庭共用思源库 (siyuan)' : '🔒 个人私有思源库 (siyuan_rh)',
              scope: inst === 'siyuan' ? 'family-shared' : 'owner-private',
              notebooks: allowedNotebooks.map(n => ({ id: n.id, name: n.name, closed: Boolean(n.closed) })),
              recentDocs: allowedRecentDocs.slice(0, 20).map(d => ({
                docId: d.id,
                notebookId: d.box,
                notebookName: nbMap.get(d.box) ?? d.box,
                title: d.content,
                hpath: d.hpath,
                updated: d.updated,
              })),
            }
          } catch (err) {
            return {
              instance: inst,
              label: inst === 'siyuan' ? '🏠 家庭共用思源库 (siyuan)' : '🔒 个人私有思源库 (siyuan_rh)',
              error: err instanceof Error ? err.message : String(err),
              notebooks: [],
              recentDocs: [],
            }
          }
        }),
      )
      return { ok: true, privacyGuard: 'active', instances: results }
    }

    case 'siyuan_search': {
      const query = String(args.query ?? '').trim()
      if (!query) throw new Error('query is required for siyuan_search')
      if (isSiyuanPathBlocked(query)) {
        return {
          ok: false,
          blockedByPrivacyGuard: true,
          query,
          count: 0,
          items: [],
          error:
            '🔒 安全围栏拦截：禁止通过 AI 检索密码、银行卡、身份证、密钥、助记词或两步验证恢复码等高危敏感信息。请在思源客户端中直接查看。',
        }
      }
      const limit = Math.max(1, Math.min(60, Number(args.limit ?? 20)))
      const targetInst = String(args.instance ?? 'all').trim()
      const instList: SiyuanInstanceId[] =
        targetInst === 'siyuan'
          ? ['siyuan']
          : targetInst === 'siyuan-rh'
            ? ['siyuan-rh']
            : ['siyuan', 'siyuan-rh']
      const safeQ = query.replace(/'/g, "''")
      const stmt = `SELECT id, root_id, box, hpath, type, content, markdown, updated FROM blocks WHERE (content LIKE '%${safeQ}%' OR hpath LIKE '%${safeQ}%' OR markdown LIKE '%${safeQ}%') ORDER BY CASE WHEN type='d' THEN 0 ELSE 1 END, updated DESC LIMIT ${limit}`

      const perInst = await Promise.all(
        instList.map(async inst => {
          try {
            const [nbData, rows] = await Promise.all([
              callSiyuanApi<{ notebooks?: { id: string; name: string }[] }>(inst, '/api/notebook/lsNotebooks', {}),
              callSiyuanApi<
                {
                  id: string
                  root_id: string
                  box: string
                  hpath: string
                  type: string
                  content: string
                  markdown: string
                  updated?: string
                }[]
              >(inst, '/api/query/sql', { stmt }),
            ])
            const allowedNotebooks = (nbData?.notebooks ?? []).filter(n => !isSiyuanNotebookBlocked(n.id, n.name))
            const nbMap = new Map(allowedNotebooks.map(n => [n.id, n.name]))
            return (rows ?? [])
              .filter(
                r =>
                  nbMap.has(r.box) &&
                  !isSiyuanNotebookBlocked(r.box, nbMap.get(r.box)) &&
                  !isSiyuanPathBlocked(r.hpath),
              )
              .map(r => ({
                instance: inst,
                instanceLabel: inst === 'siyuan' ? '🏠 家庭共用 (siyuan)' : '🔒 个人私有 (siyuan_rh)',
                docId: r.root_id || r.id,
                blockId: r.id,
                notebookId: r.box,
                notebookName: nbMap.get(r.box) ?? r.box,
                hpath: r.hpath,
                type: r.type,
                snippet: redactSensitiveNoteContent((r.markdown || r.content || '').slice(0, 360)),
                updated: r.updated,
              }))
          } catch {
            return []
          }
        }),
      )
      const combined = perInst.flat()
      return {
        ok: true,
        privacyGuard: 'active',
        query,
        count: combined.length,
        items: combined,
      }
    }

    case 'siyuan_read': {
      const rawId = typeof args.id === 'string' ? args.id.trim() : ''
      const rawHpath = typeof args.hpath === 'string' ? args.hpath.trim() : ''
      if (!rawId && !rawHpath) {
        throw new Error('Either id (document/block ID) or hpath (e.g. "/notes/weekly-plan") is required for siyuan_read')
      }
      if (rawHpath && isSiyuanPathBlocked(rawHpath)) {
        return {
          ok: false,
          blockedByPrivacyGuard: true,
          error:
            '🔒 安全围栏拦截：该笔记路径属于敏感私密禁区（密码/银行卡/身份证/密钥/2FA），已在网关层物理隔离，禁止读取或发送给模型。',
        }
      }
      const targetInst = String(args.instance ?? 'all').trim()
      const instList: SiyuanInstanceId[] =
        targetInst === 'siyuan'
          ? ['siyuan']
          : targetInst === 'siyuan-rh'
            ? ['siyuan-rh']
            : ['siyuan', 'siyuan-rh']

      for (const inst of instList) {
        try {
          let docId = rawId
          let resolvedBox = ''
          let resolvedHpath = rawHpath

          if (docId) {
            const safeId = docId.replace(/'/g, "''")
            const metaRows = await callSiyuanApi<{ id: string; root_id: string; box: string; hpath: string; content: string }[]>(
              inst,
              '/api/query/sql',
              {
                stmt: `SELECT id, root_id, box, hpath, content FROM blocks WHERE id = '${safeId}' OR root_id = '${safeId}' ORDER BY CASE WHEN type='d' THEN 0 ELSE 1 END LIMIT 1`,
              },
            )
            if (metaRows && metaRows[0]) {
              resolvedBox = metaRows[0].box
              resolvedHpath = metaRows[0].hpath
              docId = metaRows[0].root_id || metaRows[0].id
            }
          } else if (rawHpath) {
            const safeH = rawHpath.replace(/'/g, "''")
            const found = await callSiyuanApi<{ id: string; root_id: string; box: string; hpath: string }[]>(
              inst,
              '/api/query/sql',
              {
                stmt: `SELECT id, root_id, box, hpath FROM blocks WHERE type='d' AND (hpath = '${safeH}' OR hpath LIKE '%${safeH}%' OR content = '${safeH}') LIMIT 1`,
              },
            )
            if (found && found[0]) {
              docId = found[0].root_id || found[0].id
              resolvedBox = found[0].box
              resolvedHpath = found[0].hpath
            }
          }
          if (!docId) continue

          if (isSiyuanNotebookBlocked(resolvedBox) || isSiyuanPathBlocked(resolvedHpath)) {
            return {
              ok: false,
              blockedByPrivacyGuard: true,
              error:
                '🔒 安全围栏拦截：该笔记属于敏感私密禁区（data 私密库或含密码/银行卡/身份证/密钥/Recovery），已在网关层物理隔离，禁止读取或发送给模型。',
            }
          }

          const exported = await callSiyuanApi<{ hPath?: string; content?: string }>(
            inst,
            '/api/export/exportMdContent',
            { id: docId },
          )
          if (exported && typeof exported.content === 'string' && exported.content.trim()) {
            const finalHpath = exported.hPath || resolvedHpath
            if (isSiyuanPathBlocked(finalHpath)) {
              return {
                ok: false,
                blockedByPrivacyGuard: true,
                error: '🔒 安全围栏拦截：该笔记属于敏感私密禁区，已禁止读取。',
              }
            }
            return {
              ok: true,
              privacyGuard: 'active',
              instance: inst,
              instanceLabel: inst === 'siyuan' ? '🏠 家庭共用 (siyuan)' : '🔒 个人私有 (siyuan_rh)',
              id: docId,
              hpath: finalHpath,
              content: redactSensitiveNoteContent(exported.content),
            }
          }

          const kd = await callSiyuanApi<{ id?: string; kramdown?: string }>(
            inst,
            '/api/block/getBlockKramdown',
            { id: docId },
          )
          if (kd && typeof kd.kramdown === 'string' && kd.kramdown.trim()) {
            return {
              ok: true,
              privacyGuard: 'active',
              instance: inst,
              instanceLabel: inst === 'siyuan' ? '🏠 家庭共用 (siyuan)' : '🔒 个人私有 (siyuan_rh)',
              id: docId,
              hpath: resolvedHpath,
              content: redactSensitiveNoteContent(kd.kramdown),
            }
          }
        } catch {
          /* try next instance */
        }
      }
      return {
        ok: false,
        error: `Document not found in SiYuan (${instList.join(', ')}): ${rawId || rawHpath}`,
      }
    }

    default:
      throw new Error(`Unknown personal skill tool: ${toolName}`)
  }
}

/**
 * Executes a personal business skill locally if on `claw`, or transparently proxies over HTTP to `claw` node.
 */
export async function executePersonalSkillWithRemoteFallback(
  toolName: string,
  args: Record<string, unknown>,
  getNodes: () => readonly WorkerNodeRecord[],
): Promise<unknown> {
  if (hasLocalClawPersonalAssets()) {
    return await executePersonalSkillLocal(toolName, args)
  }

  // Find the online hub/personal node (by tag/name or fallback to any remote online node)
  const nodes = getNodes().filter(n => n.id !== 'local' && n.status === 'online' && n.url !== 'local')
  const hubNode =
    nodes.find(
      n =>
        n.id.toLowerCase().includes('claw') ||
        n.name.toLowerCase().includes('claw') ||
        n.tags.includes('always-on'),
    ) ?? nodes[0]

  const candidateUrls = [
    ...(hubNode?.endpoints ?? []),
    ...(hubNode?.url ? [hubNode.url] : []),
    ...CLAW_PATHS.peerFallbackEndpoints,
  ]

  let lastErr = 'Unable to reach claw node for personal skill execution'
  for (const base of [...new Set(candidateUrls)]) {
    try {
      const res = await fetch(`${base.replace(/\/+$/, '')}/orchestrator/standalone/personal-skills/execute`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-orchestrator-request': '1',
        },
        body: JSON.stringify({ name: toolName, args }),
        signal: AbortSignal.timeout(45_000),
      })
      const data = (await res.json()) as { ok?: boolean; result?: unknown; error?: string }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      return data.result
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
    }
  }
  throw new Error(lastErr)
}

export function buildPersonalSkillsPluginTools(
  getNodes: () => readonly WorkerNodeRecord[],
  isEnabled: () => boolean,
): RegisteredToolSpec[] {
  const guard = async (name: string, rawArgs: unknown, schema: z.ZodType) => {
    if (!isEnabled()) {
      throw new Error('The Personal Business Skills plugin (dsh-personal-skills) is currently disabled')
    }
    const parsed = schema.parse(rawArgs ?? {}) as Record<string, unknown>
    return await executePersonalSkillWithRemoteFallback(name, parsed, getNodes)
  }

  const todoListSchema = z.object({
    include_completed: z.boolean().optional().describe('Set true to include completed tasks ([DONE]) in addition to open tasks.'),
  })

  const todoWriteSchema = z.object({
    action: z.enum(['add', 'complete', 'delete']).describe('Action to perform on Feishu Todo.'),
    summary: z.string().optional().describe('Required for action=add: task summary text.'),
    due: z.string().optional().describe('Optional due time for action=add in local format "yyyy-MM-dd HH:mm".'),
    guid: z.string().optional().describe('Required for action=complete or action=delete: task guid.'),
  })

  const emailCheckSchema = z.object({
    mode: z.enum(['new', 'list']).optional().describe('"new" checks unread unprocessed emails across QQ + Gmail; "list" shows processed history.'),
  })

  const emailReadSchema = z.object({
    action: z.enum(['read', 'mark']).optional().describe('"read" reads the email body in readonly mode; "mark" marks the message_id as processed.'),
    message_id: z.string().min(1).describe('Email message_id from email_check (e.g. "qq:123" or "gmail:456").'),
  })

  const calendarAddSchema = z.object({
    action: z.enum(['add', 'status']).optional().describe('"add" creates a Feishu calendar event and invites the owner; "status" lists created reminders.'),
    summary: z.string().optional().describe('Event title (required for add).'),
    start: z.string().optional().describe('Start time "YYYY-MM-DD HH:MM" (required for add).'),
    end: z.string().optional().describe('End time "YYYY-MM-DD HH:MM" (required for add).'),
    reminder_minutes: z.number().int().min(1).max(20160).optional().describe('Reminder lead time in minutes (e.g. 120 for trains, 4320 for bills).'),
    description: z.string().optional().describe('Optional event description/notes.'),
    msg_id: z.string().optional().describe('Optional source email message_id for deduplication.'),
  })

  const marketSummarySchema = z.object({})

  const interestDedupSchema = z.object({
    url: z.string().min(1).describe('Article/video URL (Bilibili, Zhihu, Xiaohongshu, etc.) to resolve and check for duplicates in interests.csv and Wiki Vault.'),
    append_title: z.string().optional().describe('Optional: if provided and matched=false, appends this entry to interests.csv.'),
    platform: z.string().optional().describe('Optional platform name when appending to interests.csv (e.g. B站, 知乎, 小红书).'),
    level: z.string().optional().describe('Optional extraction level (e.g. 全文提炼, 视频转写).'),
    keywords: z.string().optional().describe('Optional comma-separated keywords when appending to interests.csv.'),
  })

  const feishuSendDmSchema = z.object({
    text: z.string().min(1).max(8000).describe('Text message to send directly to the owner on Feishu DM.'),
  })

  const ordersReportSchema = z.object({
    action: z.enum(['query', 'add']).optional().describe('"query" (default) searches orders.db; "add" records a new order into orders.db and orders-all.csv.'),
    query: z.string().optional().describe('Optional keyword to search in orders.db across product name, shop name, category, or order number (e.g. "手机", "猫粮", "显卡").'),
    platform: z.enum(['all', 'taobao', 'jd', '1688', 'goofish', 'pdd']).optional().describe('Shopping platform filter or target platform when adding ("taobao", "jd", "1688", "goofish" 闲鱼, "pdd" 拼多多, or "all").'),
    month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('Optional target month "YYYY-MM" (e.g. "2026-08").'),
    limit: z.number().int().min(1).max(100).optional().describe('Max matching order rows to return from orders.db (default 25).'),
    recompute: z.boolean().optional().describe('Set true to re-run deterministic analyze.ps1 before reading stats.json and report.md.'),
    product: z.string().optional().describe('For action="add": product name.'),
    amount: z.number().optional().describe('For action="add": order total amount in CNY.'),
    order_time: z.string().optional().describe('For action="add": order date/time (defaults to today YYYY-MM-DD).'),
    order_no: z.string().optional().describe('For action="add": optional platform order number.'),
    shop: z.string().optional().describe('For action="add": optional shop/merchant name.'),
    qty: z.number().int().min(1).optional().describe('For action="add": quantity (default 1).'),
    category: z.string().optional().describe('For action="add": optional category.'),
    status: z.string().optional().describe('For action="add": order status (default "交易成功").'),
  })

  const pdfArchiveSchema = z.object({
    path: z.string().min(1).describe('Local path to the PDF file to deduplicate, extract text/OCR, and archive.'),
  })

  const audioTranscribeSchema = z.object({
    audio_path: z.string().min(1).describe('Path to the audio or video file to transcribe via ASR.'),
    out_txt: z.string().optional().describe('Optional output transcript .txt path.'),
  })

  const siyuanNotebooksSchema = z.object({
    instance: z.enum(['all', 'siyuan', 'siyuan-rh']).optional().describe('"siyuan" = shared workspace, "siyuan-rh" = private workspace, "all" = both instances (default).'),
  })

  const siyuanSearchSchema = z.object({
    query: z.string().min(1).max(200).describe('Keyword or phrase to search across SiYuan note titles (hpath) and block Markdown content.'),
    instance: z.enum(['all', 'siyuan', 'siyuan-rh']).optional().describe('"siyuan" = shared workspace, "siyuan-rh" = private workspace, "all" = search both (default).'),
    limit: z.number().int().min(1).max(60).optional().describe('Max matching blocks/documents to return (default 20).'),
  })

  const siyuanReadSchema = z.object({
    id: z.string().optional().describe('SiYuan document/block ID (e.g. "20260101120000-abcdefg") from siyuan_search or siyuan_notebooks.'),
    hpath: z.string().optional().describe('Human-readable document path (e.g. "/notes/weekly-plan") if ID is not known.'),
    instance: z.enum(['all', 'siyuan', 'siyuan-rh']).optional().describe('Target instance ("siyuan", "siyuan-rh", or "all").'),
  })

  return [
    {
      name: 'siyuan_notebooks',
      description: 'List all notebooks and recent documents across configured SiYuan instances (`siyuan` shared workspace and `siyuan-rh` private workspace).',
      parameters: z.toJSONSchema(siyuanNotebooksSchema),
      execute: raw => guard('siyuan_notebooks', raw, siyuanNotebooksSchema),
    },
    {
      name: 'siyuan_search',
      description: 'Full-text search across SiYuan notes (`siyuan` and/or `siyuan-rh`) by keyword. Returns matching document IDs (`docId`), human-readable paths (`hpath`), notebook names, and content snippets.',
      parameters: z.toJSONSchema(siyuanSearchSchema),
      execute: raw => guard('siyuan_search', raw, siyuanSearchSchema),
    },
    {
      name: 'siyuan_read',
      description: 'Read the full Markdown content of a SiYuan document by `id` (`docId`) or `hpath` (e.g. "/notes/weekly-plan") from `siyuan` or `siyuan-rh`.',
      parameters: z.toJSONSchema(siyuanReadSchema),
      execute: raw => guard('siyuan_read', raw, siyuanReadSchema),
    },
    {
      name: 'todo_list',
      description: 'List the owner\'s personal Feishu Todo items via Tasks API v2 (deterministic script `list-tasks.ps1`). Always trust script output.',
      parameters: z.toJSONSchema(todoListSchema),
      execute: raw => guard('todo_list', raw, todoListSchema),
    },
    {
      name: 'todo_write',
      description: 'Create, complete, or delete a personal Feishu Todo item via Tasks API v2 (`task-write.ps1`).',
      parameters: z.toJSONSchema(todoWriteSchema),
      execute: raw => guard('todo_write', raw, todoWriteSchema),
    },
    {
      name: 'email_check',
      description: 'Check for new unread emails across the owner\'s QQ and Gmail accounts (`email_state.py new` or `list`).',
      parameters: z.toJSONSchema(emailCheckSchema),
      execute: raw => guard('email_check', raw, emailCheckSchema),
    },
    {
      name: 'email_read',
      description: 'Read a specific email by `message_id` in read-only mode (`email_state.py read`) or mark it as processed (`email_state.py mark`).',
      parameters: z.toJSONSchema(emailReadSchema),
      execute: raw => guard('email_read', raw, emailReadSchema),
    },
    {
      name: 'calendar_add',
      description: 'Create a Feishu calendar event with reminder for the owner (`feishu_calendar.py add`) or check reminder status (`status`).',
      parameters: z.toJSONSchema(calendarAddSchema),
      execute: raw => guard('calendar_add', raw, calendarAddSchema),
    },
    {
      name: 'market_summary',
      description: 'Read the latest Gold/Silver/A-share `market-watch` snapshots, K-line warehouse collection progress, and Tailnet dashboard links.',
      parameters: z.toJSONSchema(marketSummarySchema),
      execute: raw => guard('market_summary', raw, marketSummarySchema),
    },
    {
      name: 'interest_dedup',
      description: 'Deterministically resolve short URLs and check if a link is already recorded in `interests.csv` or the Wiki Vault (`dedup.py`), optionally appending a new row to `interests.csv`.',
      parameters: z.toJSONSchema(interestDedupSchema),
      execute: raw => guard('interest_dedup', raw, interestDedupSchema),
    },
    {
      name: 'feishu_send_dm',
      description: 'Send a direct message to the operator on Feishu via Feishu Open Platform API.',
      parameters: z.toJSONSchema(feishuSendDmSchema),
      execute: raw => guard('feishu_send_dm', raw, feishuSendDmSchema),
    },
    {
      name: 'orders_report',
      description: 'Search and inspect the local shopping order database (`orders.db`, across Taobao, JD, 1688, Goofish, and PDD) by keyword (`query`), `platform`, or `month`, and read monthly order reports (`stats.json` / `report.md`).',
      parameters: z.toJSONSchema(ordersReportSchema),
      execute: raw => guard('orders_report', raw, ordersReportSchema),
    },
    {
      name: 'pdf_archive',
      description: 'Process a PDF file (`pdf_process.py`): MD5 deduplication, PyMuPDF text extraction, and Ollama `qwen2.5vl` OCR for scanned pages.',
      parameters: z.toJSONSchema(pdfArchiveSchema),
      execute: raw => guard('pdf_archive', raw, pdfArchiveSchema),
    },
    {
      name: 'audio_transcribe',
      description: 'Transcribe an audio or video file into Chinese text via StepFun StepAudio 2.5 ASR (`transcribe.ps1`, using standalone `stepfun.json`).',
      parameters: z.toJSONSchema(audioTranscribeSchema),
      execute: raw => guard('audio_transcribe', raw, audioTranscribeSchema),
    },
  ]
}

export function buildClawFeedPluginTools(options: {
  readItems: () => ClawFeedNotificationRecord[]
  getNodes: () => readonly WorkerNodeRecord[]
  isEnabled: () => boolean
}): RegisteredToolSpec[] {
  const recentSchema = z.object({
    tag: z.enum(['all', '验证码', '重要', '普通']).optional().describe('Filter by notification importance tag.'),
    query: z.string().optional().describe('Optional keyword to search in recent phone notifications.'),
    limit: z.number().int().min(1).max(50).optional().describe('Max items to return (default 15).'),
  })

  const pauseSchema = z.object({
    paused: z.boolean().describe('Set true to pause ClawFeed sink ingestion, or false to resume.'),
  })

  return [
    {
      name: 'clawfeed_status',
      description: 'Inspect the standalone `@rharness/plugin-clawfeed` Git repository status (`D:/git/clawfeed` / `claw/clawfeed`), live `:8090/health` sink status, and notification counts.',
      parameters: z.toJSONSchema(z.object({})),
      execute: async () => {
        const repo = inspectClawFeedPluginRepo()
        const items = options.readItems()
        let sinkHealth: unknown = undefined
        for (const base of getClawFeedSinkEndpoints()) {
          try {
            const res = await fetch(`${base.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(2500) })
            if (res.ok) {
              sinkHealth = await res.json()
              break
            }
          } catch {}
        }
        return {
          pluginEnabled: options.isEnabled(),
          gitRepository: repo,
          sinkHealth,
          storedCount: items.length,
          byTag: {
            otp: items.filter(i => i.tag === '验证码').length,
            important: items.filter(i => i.tag === '重要').length,
            normal: items.filter(i => i.tag === '普通').length,
          },
        }
      },
    },
    {
      name: 'clawfeed_recent',
      description: 'List or search recent phone SMS and app notifications received by `@rharness/plugin-clawfeed` (`[验证码]`, `[重要]`, `[普通]`).',
      parameters: z.toJSONSchema(recentSchema),
      execute: async (rawArgs: unknown) => {
        if (!options.isEnabled()) {
          throw new Error('The ClawFeed plugin (dsh-clawfeed) is currently disabled')
        }
        const args = recentSchema.parse(rawArgs ?? {})
        const q = (args.query ?? '').trim().toLowerCase()
        const filtered = options.readItems().filter(item => {
          if (args.tag && args.tag !== 'all' && item.tag !== args.tag) return false
          if (q && !item.message.toLowerCase().includes(q)) return false
          return true
        })
        return {
          total: filtered.length,
          items: filtered.slice(0, args.limit ?? 15),
        }
      },
    },
    {
      name: 'clawfeed_pause',
      description: 'Pause or resume the ClawFeed mobile notification sink (`sink-paused` on `claw`).',
      parameters: z.toJSONSchema(pauseSchema),
      execute: async (rawArgs: unknown) => {
        const args = pauseSchema.parse(rawArgs ?? {})
        return await executePersonalSkillWithRemoteFallback('clawfeed_pause', { paused: args.paused }, options.getNodes)
      },
    },
  ]
}

interface FeishuWsHeader {
  key: string
  value: string
}

interface FeishuWsFrame {
  seqId: bigint
  logId: bigint
  service: number
  method: number
  headers: FeishuWsHeader[]
  payloadEncoding?: string
  payloadType?: string
  payload?: Buffer
  logIdNew?: string
}

function writeProtobufVarint(val: bigint | number): Buffer {
  let v = BigInt(val)
  const out: number[] = []
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n))
    v >>= 7n
  }
  out.push(Number(v))
  return Buffer.from(out)
}

function readProtobufVarint(buf: Buffer, offset: number): { value: bigint; nextOffset: number } {
  let result = 0n
  let shift = 0n
  let pos = offset
  while (pos < buf.length) {
    const b = buf[pos++]!
    result |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7n
  }
  return { value: result, nextOffset: pos }
}

function encodeProtobufBytesField(fieldNo: number, bytes: Buffer): Buffer {
  return Buffer.concat([writeProtobufVarint((fieldNo << 3) | 2), writeProtobufVarint(bytes.length), bytes])
}

function encodeProtobufVarintField(fieldNo: number, val: bigint | number): Buffer {
  return Buffer.concat([writeProtobufVarint((fieldNo << 3) | 0), writeProtobufVarint(val)])
}

export function encodeFeishuWsFrame(frame: FeishuWsFrame): Buffer {
  const parts: Buffer[] = [
    encodeProtobufVarintField(1, frame.seqId ?? 0n),
    encodeProtobufVarintField(2, frame.logId ?? 0n),
    encodeProtobufVarintField(3, frame.service ?? 0),
    encodeProtobufVarintField(4, frame.method ?? 0),
  ]
  for (const h of frame.headers ?? []) {
    const hb = Buffer.concat([
      encodeProtobufBytesField(1, Buffer.from(h.key, 'utf8')),
      encodeProtobufBytesField(2, Buffer.from(h.value, 'utf8')),
    ])
    parts.push(encodeProtobufBytesField(5, hb))
  }
  if (frame.payloadEncoding) parts.push(encodeProtobufBytesField(6, Buffer.from(frame.payloadEncoding, 'utf8')))
  if (frame.payloadType) parts.push(encodeProtobufBytesField(7, Buffer.from(frame.payloadType, 'utf8')))
  if (frame.payload && frame.payload.length > 0) parts.push(encodeProtobufBytesField(8, frame.payload))
  if (frame.logIdNew) parts.push(encodeProtobufBytesField(9, Buffer.from(frame.logIdNew, 'utf8')))
  return Buffer.concat(parts)
}

function decodeFeishuWsHeader(buf: Buffer): FeishuWsHeader {
  let pos = 0
  let key = ''
  let value = ''
  while (pos < buf.length) {
    const tag = readProtobufVarint(buf, pos)
    pos = tag.nextOffset
    const fieldNo = Number(tag.value >> 3n)
    const wireType = Number(tag.value & 7n)
    if (wireType === 2) {
      const len = readProtobufVarint(buf, pos)
      pos = len.nextOffset
      const slice = buf.subarray(pos, pos + Number(len.value))
      pos += Number(len.value)
      if (fieldNo === 1) key = slice.toString('utf8')
      else if (fieldNo === 2) value = slice.toString('utf8')
    } else if (wireType === 0) {
      pos = readProtobufVarint(buf, pos).nextOffset
    } else {
      break
    }
  }
  return { key, value }
}

export function decodeFeishuWsFrame(rawBuf: ArrayBuffer | Buffer): FeishuWsFrame {
  const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf)
  let pos = 0
  const frame: FeishuWsFrame = {
    seqId: 0n,
    logId: 0n,
    service: 0,
    method: 0,
    headers: [],
    payload: Buffer.alloc(0),
  }
  while (pos < buf.length) {
    const tag = readProtobufVarint(buf, pos)
    pos = tag.nextOffset
    const fieldNo = Number(tag.value >> 3n)
    const wireType = Number(tag.value & 7n)
    if (wireType === 0) {
      const v = readProtobufVarint(buf, pos)
      pos = v.nextOffset
      if (fieldNo === 1) frame.seqId = v.value
      else if (fieldNo === 2) frame.logId = v.value
      else if (fieldNo === 3) frame.service = Number(v.value)
      else if (fieldNo === 4) frame.method = Number(v.value)
    } else if (wireType === 2) {
      const len = readProtobufVarint(buf, pos)
      pos = len.nextOffset
      const slice = buf.subarray(pos, pos + Number(len.value))
      pos += Number(len.value)
      if (fieldNo === 5) frame.headers.push(decodeFeishuWsHeader(slice))
      else if (fieldNo === 6) frame.payloadEncoding = slice.toString('utf8')
      else if (fieldNo === 7) frame.payloadType = slice.toString('utf8')
      else if (fieldNo === 8) frame.payload = slice
      else if (fieldNo === 9) frame.logIdNew = slice.toString('utf8')
    } else {
      break
    }
  }
  return frame
}

export interface FeishuBridgeRuntimeStatus {
  configured: boolean
  appId?: string
  ownerOpenId?: string
  wsConnected: boolean
  lastConnectedAt?: string
  lastPongAt?: string
  lastEventAt?: string
  receivedCount: number
  lastError?: string
}

const feishuBridgeState: FeishuBridgeRuntimeStatus = {
  configured: false,
  wsConnected: false,
  receivedCount: 0,
}

export function getFeishuBridgeRuntimeStatus(): FeishuBridgeRuntimeStatus {
  const cred = loadStandaloneFeishuCredentials()
  return {
    ...feishuBridgeState,
    configured: Boolean(cred),
    ...(cred ? { appId: cred.appId, ownerOpenId: cred.ownerOpenId } : {}),
  }
}

/**
 * Starts a native, zero-`lark-cli` Feishu WebSocket (`pbbp2` over `wss://msg-frontier.feishu.cn/ws/v2`)
 * and REST bridge when `feishu.json` is present on this machine.
 * Receives `im.message.receive_v1` events in real time, ACKs frames immediately, routes owner messages
 * into `claw-assistant-main`, and replies back to the owner's Feishu DM.
 */
export function startNativeFeishuDmBridge(options: {
  signal: AbortSignal
  isEnabled: () => boolean
  onOwnerMessage: (msg: {
    messageId: string
    text: string
    createTimeMs: number
    reactionId?: string
  }) => Promise<string | undefined>
}): void {
  const cred = loadStandaloneFeishuCredentials()
  if (!cred) return

  feishuBridgeState.configured = true
  feishuBridgeState.appId = cred.appId
  feishuBridgeState.ownerOpenId = cred.ownerOpenId

  const seenIds = new Set<string>()
  let activeWs: WebSocket | undefined
  let pingTimer: ReturnType<typeof setInterval> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let seqCounter = 1n

  const cleanupWs = () => {
    if (pingTimer) {
      clearInterval(pingTimer)
      pingTimer = undefined
    }
    if (activeWs) {
      try { activeWs.close() } catch {}
      activeWs = undefined
    }
    feishuBridgeState.wsConnected = false
  }

  const scheduleReconnect = (delayMs = 5000) => {
    cleanupWs()
    if (options.signal.aborted) return
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => {
      void connectWs().catch(() => scheduleReconnect(8000))
    }, delayMs)
  }

  const handleEventPayload = async (jsonStr: string) => {
    let evt: {
      header?: { event_id?: string; event_type?: string }
      event?: {
        sender?: { sender_id?: { open_id?: string }; sender_type?: string }
        message?: {
          message_id?: string
          chat_id?: string
          chat_type?: string
          message_type?: string
          create_time?: string
          content?: string
        }
      }
    }
    try {
      evt = JSON.parse(jsonStr)
    } catch {
      return
    }
    if (evt.header?.event_type !== 'im.message.receive_v1') return
    if (!options.isEnabled()) return

    const currentCred = loadStandaloneFeishuCredentials()
    if (!currentCred) return
    const senderOpenId = evt.event?.sender?.sender_id?.open_id
    const senderType = evt.event?.sender?.sender_type
    const msg = evt.event?.message
    const msgId = msg?.message_id
    if (!msgId || seenIds.has(msgId)) return
    if (senderType !== 'user' || (currentCred.ownerOpenId && senderOpenId !== currentCred.ownerOpenId)) return

    seenIds.add(msgId)
    feishuBridgeState.lastEventAt = new Date().toISOString()
    feishuBridgeState.receivedCount++

    let text = ''
    try {
      const parsedContent = JSON.parse(msg?.content ?? '{}') as { text?: string }
      text = (parsedContent.text ?? '').replace(/@_user_\d+\s*/g, '').trim()
    } catch {
      text = (msg?.content ?? '').trim()
    }
    if (!text) return

    const ts = Number(msg?.create_time ?? Date.now())
    // Immediately add the "Typing" (敲键盘) emoji reaction on the user's Feishu message so the owner knows it was received
    const reactionId = await addFeishuMessageReaction(msgId, 'Typing')
    try {
      const replyText = await options.onOwnerMessage({
        messageId: msgId,
        text,
        createTimeMs: Number.isFinite(ts) ? ts : Date.now(),
        ...(reactionId ? { reactionId } : {}),
      })
      if (replyText && replyText.trim()) {
        await sendFeishuDirectMessage(replyText.trim(), currentCred.ownerOpenId, 'open_id')
        if (reactionId) {
          await removeFeishuMessageReaction(msgId, reactionId)
        }
      }
    } catch {
      if (reactionId) {
        await removeFeishuMessageReaction(msgId, reactionId)
      }
    }
  }

  const connectWs = async () => {
    if (options.signal.aborted) return
    const currentCred = loadStandaloneFeishuCredentials()
    if (!currentCred) return

    const epRes = await fetch('https://open.feishu.cn/callback/ws/endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ AppID: currentCred.appId, AppSecret: currentCred.appSecret }),
      signal: AbortSignal.timeout(12_000),
    })
    const epData = (await epRes.json()) as {
      code?: number
      msg?: string
      data?: { URL?: string; ClientConfig?: { PingInterval?: number } }
    }
    if (epData.code !== 0 || !epData.data?.URL) {
      feishuBridgeState.lastError = `WS endpoint error: code=${epData.code} msg=${epData.msg ?? ''}`
      scheduleReconnect(10_000)
      return
    }

    const wsUrl = epData.data.URL
    const serviceId = Number(new URL(wsUrl).searchParams.get('service_id') || '0')
    const pingIntervalSec = Math.max(20, Math.min(90, epData.data.ClientConfig?.PingInterval ?? 60))

    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    activeWs = ws

    ws.addEventListener('open', () => {
      feishuBridgeState.wsConnected = true
      feishuBridgeState.lastConnectedAt = new Date().toISOString()
      delete feishuBridgeState.lastError

      // Send an initial ping and schedule periodic pings
      const sendPing = () => {
        if (ws.readyState !== WebSocket.OPEN) return
        try {
          ws.send(
            new Uint8Array(
              encodeFeishuWsFrame({
                seqId: seqCounter++,
                logId: 0n,
                service: serviceId,
                method: 0,
                headers: [{ key: 'type', value: 'ping' }],
              }),
            ),
          )
        } catch {}
      }
      sendPing()
      pingTimer = setInterval(sendPing, pingIntervalSec * 1000)
    })

    ws.addEventListener('message', ev => {
      try {
        const frame = decodeFeishuWsFrame(ev.data as ArrayBuffer)
        const hMap = new Map(frame.headers.map(h => [h.key, h.value]))
        const msgType = hMap.get('type')
        if (frame.method === 0 && msgType === 'pong') {
          feishuBridgeState.lastPongAt = new Date().toISOString()
          return
        }
        if (frame.method === 1) {
          // Immediately ACK the data frame so Feishu msg-frontier knows it was received
          const ackPayload = Buffer.from(JSON.stringify({ code: 200 }), 'utf8')
          ws.send(
            new Uint8Array(
              encodeFeishuWsFrame({
                ...frame,
                headers: [...frame.headers, { key: 'biz_rt', value: '1' }],
                payload: ackPayload,
              }),
            ),
          )
          if (msgType === 'event' && frame.payload && frame.payload.length > 0) {
            const jsonStr = frame.payload.toString('utf8')
            void handleEventPayload(jsonStr).catch(() => {})
          }
        }
      } catch {}
    })

    ws.addEventListener('close', () => {
      if (!options.signal.aborted) scheduleReconnect(4000)
    })

    ws.addEventListener('error', () => {
      feishuBridgeState.lastError = 'Feishu WebSocket connection error'
    })
  }

  void connectWs().catch(() => scheduleReconnect(5000))

  options.signal.addEventListener(
    'abort',
    () => {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      cleanupWs()
    },
    { once: true },
  )
}
