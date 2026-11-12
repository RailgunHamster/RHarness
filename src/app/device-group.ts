/**
 * Decentralized Device Groups, Multi-Address Discovery (LAN IP + Invariant Hostname + Tailscale IP + MagicDNS FQDN),
 * and One-Use Invitation Handshake (modeled after `RHFiles` `groups.rs`/`invitations.rs` and `RHRemote` `network.rs`).
 *
 * Address Resilience (modeled after `D:\git\RHRemote\client\crates\rhremote-ui\src\network.rs`):
 * Every device and worker node records all 4 categories of addresses so DHCP LAN IP changes never break connectivity:
 * 1. `lanIps`: Local LAN IPv4 addresses (e.g. `192.168.1.50`)
 * 2. `hostname`: Invariant OS machine name (e.g. `dev-workstation`, `build-node`)
 * 3. `tailscaleDnsName`: Invariant Tailscale MagicDNS FQDN (`<name>.<tailnet>.ts.net`, e.g. `hub.example.ts.net`)
 * 4. `tailscaleIps`: Tailscale CGNAT IPv4 addresses (e.g. `100.64.0.10`)
 */
import { execFileSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'
import { existsSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { WorkerNodeRecord } from './worker-nodes.ts'

export const INVITATION_PREFIX = 'rharness-group-invite:v1:'
const DOMAIN_PREFIX = Buffer.from('RHarness-Group-v1\0', 'utf8')

export interface TailscalePeerFacts {
  hostName: string
  dnsName: string
  shortDnsName: string
  tailscaleIps: string[]
}

export interface TailscaleInventory {
  running: boolean
  self?: TailscalePeerFacts
  peers: TailscalePeerFacts[]
}

export interface DeviceIdentityRecord {
  deviceId: string
  deviceName: string
  hostname: string
  tailscaleDnsName?: string
  tailscaleIps: string[]
  lanIps: string[]
  publicKeyB64: string
  privateKeyPem: string
  endpoints: string[]
  tags: string[]
  gitUrl: string
}

export interface GroupClaim {
  v: 1
  kind: 'root' | 'member'
  groupId: string
  deviceId: string
  deviceName: string
  hostname?: string
  tailscaleDnsName?: string
  tailscaleIps?: string[]
  lanIps?: string[]
  groupName: string
  publicKeyB64: string
  issuerPublicKeyB64: string
  endpoints: string[]
  tags: string[]
  gitUrl?: string
  canInvite: boolean
  nonce: string
  issuedAt: string
}

export interface SignedGroupClaim {
  payload: string
  signature: string
}

export interface DeviceGroupPacket {
  groupId: string
  groupName: string
  root: SignedGroupClaim
  members: SignedGroupClaim[]
  updatedAt: string
}

export interface DeviceJoinRequest {
  deviceId: string
  deviceName: string
  hostname?: string
  tailscaleDnsName?: string
  tailscaleIps?: string[]
  lanIps?: string[]
  publicKeyB64: string
  endpoints: string[]
  tags: string[]
  gitUrl?: string
  nonce: string
  signature: string
}

export interface InvitationPayload {
  version: 1
  groupId: string
  groupName: string
  deviceId: string
  endpoints: string[]
  token: string
  expiresAt: number
}

const activeInvitations = new Map<string, { groupId: string; canInvite: boolean; expiresAt: number }>()
let cachedTailscale: { at: number; value: TailscaleInventory } | undefined

export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex')
}

function resolveTailscaleExecutable(): string {
  if (process.platform === 'win32') {
    const prog = process.env.ProgramFiles ?? 'C:\\Program Files'
    const candidate = join(prog, 'Tailscale', 'tailscale.exe')
    if (existsSync(candidate)) return candidate
  } else if (existsSync('/usr/bin/tailscale')) {
    return '/usr/bin/tailscale'
  }
  return 'tailscale'
}

function parsePeerFacts(raw: Record<string, unknown> | undefined): TailscalePeerFacts | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const hostName = typeof raw.HostName === 'string' ? raw.HostName.trim() : ''
  const dnsName = typeof raw.DNSName === 'string' ? raw.DNSName.trim().replace(/\.+$/, '') : ''
  const shortDnsName = dnsName.includes('.') ? dnsName.split('.')[0]! : dnsName
  const tailscaleIps = Array.isArray(raw.TailscaleIPs)
    ? raw.TailscaleIPs.map(ip => String(ip).trim()).filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip))
    : []
  if (!hostName && !dnsName && !tailscaleIps.length) return undefined
  return { hostName, dnsName, shortDnsName, tailscaleIps }
}

/**
 * Queries `tailscale status --json` (cached for 30s, modeled after `RHRemote` `inventory_cancelable`)
 * to obtain invariant MagicDNS names (`<machine>.<tailnet>.ts.net`), OS hostnames, and Tailscale IPv4s.
 */
export function queryTailscaleInventory(force = false): TailscaleInventory {
  const now = Date.now()
  if (!force && cachedTailscale && now - cachedTailscale.at < 30_000) {
    return cachedTailscale.value
  }
  try {
    const out = execFileSync(resolveTailscaleExecutable(), ['status', '--json'], {
      encoding: 'utf8',
      timeout: 2600,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const parsed = JSON.parse(out) as Record<string, unknown>
    const self = parsePeerFacts(parsed.Self as Record<string, unknown> | undefined)
    const peerMap = (parsed.Peer && typeof parsed.Peer === 'object') ? parsed.Peer as Record<string, Record<string, unknown>> : {}
    const peers: TailscalePeerFacts[] = []
    for (const p of Object.values(peerMap)) {
      const facts = parsePeerFacts(p)
      if (facts) peers.push(facts)
    }
    const value: TailscaleInventory = {
      running: parsed.BackendState === 'Running',
      ...(self ? { self } : {}),
      peers,
    }
    cachedTailscale = { at: now, value }
    return value
  } catch {
    const empty: TailscaleInventory = { running: false, peers: [] }
    cachedTailscale = { at: now, value: empty }
    return empty
  }
}

/**
 * Looks up a peer in the local Tailscale inventory by its hostname, deviceName, or MagicDNS name
 * (modeled after `RHRemote` `discovered_cancelable`).
 */
export function findTailscalePeer(nameOrHost: string | undefined): TailscalePeerFacts | undefined {
  if (!nameOrHost) return undefined
  const needle = nameOrHost.trim().toLowerCase().replace(/\.+$/, '')
  if (!needle) return undefined
  const inv = queryTailscaleInventory()
  if (
    inv.self &&
    (inv.self.hostName.toLowerCase() === needle ||
      inv.self.dnsName.toLowerCase() === needle ||
      inv.self.shortDnsName.toLowerCase() === needle)
  ) {
    return inv.self
  }
  return inv.peers.find(
    p =>
      p.hostName.toLowerCase() === needle ||
      p.dnsName.toLowerCase() === needle ||
      p.shortDnsName.toLowerCase() === needle,
  )
}

export function isPrivateOrTailscaleIp(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === 'localhost') return true
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a = 0, b = 0] = parts
  if (a === 10 || a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/**
 * Collects all address forms for the local machine:
 * - `lanIps` (`192.168.0.x`, etc.)
 * - `hostname` (invariant OS machine name)
 * - `tailscaleDnsName` (invariant `<machine>.<tailnet>.ts.net` MagicDNS FQDN)
 * - `tailscaleIps` (`100.x.y.z`)
 * - `endpoints`: deduplicated ordered list of `http://<host>:<port>` candidate URLs.
 */
export function detectLocalAddressFacts(port: number): {
  hostname: string
  tailscaleDnsName?: string
  tailscaleIps: string[]
  lanIps: string[]
  endpoints: string[]
} {
  const osHost = hostname() || 'rharness-node'
  const ts = queryTailscaleInventory().self
  const lanIps: string[] = []
  const nets = networkInterfaces()
  for (const list of Object.values(nets)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      const addr = info.address
      if (/^192\.168\.(?:56|176|186|200|18)\.1$/.test(addr) || /^172\.25\./.test(addr)) continue
      if (addr.startsWith('100.')) continue // Tailscale handled separately
      if (isPrivateOrTailscaleIp(addr)) lanIps.push(addr)
    }
  }
  lanIps.sort((a, b) => (a.startsWith('192.168.0.') ? -1 : b.startsWith('192.168.0.') ? 1 : a.localeCompare(b)))

  const tailscaleIps = ts?.tailscaleIps ? [...ts.tailscaleIps] : []
  if (!tailscaleIps.length) {
    for (const list of Object.values(nets)) {
      for (const info of list ?? []) {
        if (info.family === 'IPv4' && !info.internal && info.address.startsWith('100.')) {
          tailscaleIps.push(info.address)
        }
      }
    }
  }

  const tailscaleDnsName = ts?.dnsName || undefined
  const shortDns = ts?.shortDnsName || undefined
  const hosts: string[] = [
    ...lanIps,
    osHost,
    ...(shortDns && shortDns.toLowerCase() !== osHost.toLowerCase() ? [shortDns] : []),
    ...(tailscaleDnsName ? [tailscaleDnsName] : []),
    ...tailscaleIps,
  ]
  const seen = new Set<string>()
  const endpoints: string[] = []
  for (const h of hosts) {
    const key = h.toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    endpoints.push(`http://${h}:${port}`)
  }
  if (endpoints.length === 0) endpoints.push(`http://127.0.0.1:${port}`)

  return {
    hostname: osHost,
    ...(tailscaleDnsName ? { tailscaleDnsName } : {}),
    tailscaleIps,
    lanIps,
    endpoints,
  }
}

export function detectLocalEndpoints(port: number): string[] {
  return detectLocalAddressFacts(port).endpoints
}

/**
 * Builds the complete ordered list of candidate `http://<address>:<port>` URLs for any node,
 * combining its stored `endpoints`, `lanIps`, `hostname`, `tailscaleDnsName`, `tailscaleIps`,
 * and any live Tailscale peer discovery matching its hostname or DNS name.
 */
export function buildNodeCandidateEndpoints(node: {
  url?: string
  endpoints?: string[]
  hostname?: string
  name?: string
  tailscaleDnsName?: string
  tailscaleIps?: string[]
  lanIps?: string[]
}, defaultPort = 4318): string[] {
  const candidates: string[] = []
  const addUrl = (u: string | undefined) => {
    if (!u || u === 'local') return
    const clean = u.trim().replace(/\/+$/, '')
    if (!clean) return
    const withProto = /^https?:\/\//i.test(clean) ? clean : `http://${clean}`
    const finalUrl = /:\d+$/.test(withProto) ? withProto : `${withProto}:${defaultPort}`
    if (!candidates.some(c => c.toLowerCase() === finalUrl.toLowerCase())) {
      candidates.push(finalUrl)
    }
  }

  addUrl(node.url)
  for (const ep of node.endpoints ?? []) addUrl(ep)
  for (const ip of node.lanIps ?? []) addUrl(`http://${ip}:${defaultPort}`)
  if (node.hostname) addUrl(`http://${node.hostname}:${defaultPort}`)
  if (node.tailscaleDnsName) {
    addUrl(`http://${node.tailscaleDnsName}:${defaultPort}`)
    const shortName = node.tailscaleDnsName.split('.')[0]
    if (shortName) addUrl(`http://${shortName}:${defaultPort}`)
  }
  for (const ip of node.tailscaleIps ?? []) addUrl(`http://${ip}:${defaultPort}`)

  // Also check live Tailscale peer table in case IPs or DNS names were updated
  const peer = findTailscalePeer(node.tailscaleDnsName || node.hostname || node.name)
  if (peer) {
    if (peer.dnsName) addUrl(`http://${peer.dnsName}:${defaultPort}`)
    if (peer.shortDnsName) addUrl(`http://${peer.shortDnsName}:${defaultPort}`)
    if (peer.hostName) addUrl(`http://${peer.hostName}:${defaultPort}`)
    for (const ip of peer.tailscaleIps) addUrl(`http://${ip}:${defaultPort}`)
  }

  return candidates
}

export function ensureDeviceIdentity(
  existing: DeviceIdentityRecord | undefined,
  port: number,
  defaultTags?: string[],
): DeviceIdentityRecord {
  const facts = detectLocalAddressFacts(port)
  const gitUrl = process.cwd().replaceAll('\\', '/')
  const platformTag = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'

  if (existing && existing.privateKeyPem && existing.publicKeyB64) {
    return {
      ...existing,
      hostname: facts.hostname,
      ...(facts.tailscaleDnsName ? { tailscaleDnsName: facts.tailscaleDnsName } : {}),
      tailscaleIps: facts.tailscaleIps,
      lanIps: facts.lanIps,
      endpoints: facts.endpoints,
      gitUrl: existing.gitUrl || gitUrl,
    }
  }
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pubDer = publicKey.export({ type: 'spki', format: 'der' })
  const publicKeyB64 = Buffer.from(pubDer).toString('base64url')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const deviceId = sha256Hex(pubDer)
  const lowerHost = facts.hostname.toLowerCase()
  const inferredTags = defaultTags ?? (
    lowerHost.includes('hub') || lowerHost.includes('claw')
      ? ['eval-hub', 'always-on', 'lightweight', platformTag]
      : lowerHost.includes('server')
        ? ['worker', 'heavy-coding', platformTag]
        : ['worker', 'workstation', 'heavy-coding', 'chrome-qa', 'preferred', platformTag]
  )

  return {
    deviceId,
    deviceName: facts.hostname,
    hostname: facts.hostname,
    ...(facts.tailscaleDnsName ? { tailscaleDnsName: facts.tailscaleDnsName } : {}),
    tailscaleIps: facts.tailscaleIps,
    lanIps: facts.lanIps,
    publicKeyB64,
    privateKeyPem,
    endpoints: facts.endpoints,
    tags: inferredTags,
    gitUrl,
  }
}

export function signClaim(claim: GroupClaim, privateKeyPem: string): SignedGroupClaim {
  const payloadBytes = Buffer.from(JSON.stringify(claim), 'utf8')
  const payload = payloadBytes.toString('base64url')
  const message = Buffer.concat([DOMAIN_PREFIX, payloadBytes])
  const keyObj = createPrivateKey(privateKeyPem)
  const sig = sign('sha256', message, keyObj)
  return {
    payload,
    signature: sig.toString('base64url'),
  }
}

export function verifySignedClaim(signed: SignedGroupClaim): GroupClaim {
  const payloadBytes = Buffer.from(signed.payload, 'base64url')
  const claim = JSON.parse(payloadBytes.toString('utf8')) as GroupClaim
  const pubDer = Buffer.from(claim.issuerPublicKeyB64, 'base64url')
  const pubKey = createPublicKey({ key: pubDer, format: 'der', type: 'spki' })
  const message = Buffer.concat([DOMAIN_PREFIX, payloadBytes])
  const ok = verify('sha256', message, pubKey, Buffer.from(signed.signature, 'base64url'))
  if (!ok) throw new Error('设备组签名校验失败 (Invalid group claim signature)')
  return claim
}

export function createDeviceGroup(identity: DeviceIdentityRecord, groupName = 'RHarness 内网设备组'): DeviceGroupPacket {
  const nonce = randomBytes(24).toString('base64url')
  const groupId = sha256Hex(`${identity.deviceId}:${nonce}`).slice(0, 32)
  const now = new Date().toISOString()
  const rootClaim: GroupClaim = {
    v: 1,
    kind: 'root',
    groupId,
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    hostname: identity.hostname,
    ...(identity.tailscaleDnsName ? { tailscaleDnsName: identity.tailscaleDnsName } : {}),
    tailscaleIps: identity.tailscaleIps,
    lanIps: identity.lanIps,
    groupName,
    publicKeyB64: identity.publicKeyB64,
    issuerPublicKeyB64: identity.publicKeyB64,
    endpoints: identity.endpoints,
    tags: identity.tags,
    gitUrl: identity.gitUrl,
    canInvite: true,
    nonce,
    issuedAt: now,
  }
  const signedRoot = signClaim(rootClaim, identity.privateKeyPem)
  const memberClaim: GroupClaim = {
    ...rootClaim,
    kind: 'member',
  }
  const signedMember = signClaim(memberClaim, identity.privateKeyPem)
  return {
    groupId,
    groupName,
    root: signedRoot,
    members: [signedMember],
    updatedAt: now,
  }
}

export function createGroupInvitation(
  identity: DeviceIdentityRecord,
  group: DeviceGroupPacket,
  canInvite = true,
): { uri: string; token: string; expiresAt: number } {
  const now = Date.now()
  for (const [k, v] of activeInvitations) {
    if (v.expiresAt <= now) activeInvitations.delete(k)
  }
  const token = randomBytes(24).toString('base64url')
  const expiresAt = now + 5 * 60_000
  activeInvitations.set(token, { groupId: group.groupId, canInvite, expiresAt })
  const payload: InvitationPayload = {
    version: 1,
    groupId: group.groupId,
    groupName: group.groupName,
    deviceId: identity.deviceId,
    endpoints: identity.endpoints,
    token,
    expiresAt,
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return {
    uri: `${INVITATION_PREFIX}${encoded}`,
    token,
    expiresAt,
  }
}

export function parseInvitationUri(uri: string): InvitationPayload {
  const trimmed = uri.trim()
  if (!trimmed.startsWith(INVITATION_PREFIX)) {
    throw new Error('请粘贴有效的设备组邀请码 (rharness-group-invite:v1:...)')
  }
  const raw = Buffer.from(trimmed.slice(INVITATION_PREFIX.length), 'base64url').toString('utf8')
  const parsed = JSON.parse(raw) as InvitationPayload
  if (parsed.version !== 1 || !parsed.groupId || !parsed.token || !Array.isArray(parsed.endpoints) || !parsed.endpoints.length) {
    throw new Error('设备组邀请结构无效')
  }
  return parsed
}

export function createJoinRequest(identity: DeviceIdentityRecord): DeviceJoinRequest {
  const nonce = randomBytes(16).toString('base64url')
  const body = JSON.stringify({
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    hostname: identity.hostname,
    tailscaleDnsName: identity.tailscaleDnsName,
    tailscaleIps: identity.tailscaleIps,
    lanIps: identity.lanIps,
    publicKeyB64: identity.publicKeyB64,
    endpoints: identity.endpoints,
    tags: identity.tags,
    gitUrl: identity.gitUrl,
    nonce,
  })
  const keyObj = createPrivateKey(identity.privateKeyPem)
  const signature = sign('sha256', Buffer.concat([DOMAIN_PREFIX, Buffer.from(body, 'utf8')]), keyObj).toString('base64url')
  return {
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    hostname: identity.hostname,
    ...(identity.tailscaleDnsName ? { tailscaleDnsName: identity.tailscaleDnsName } : {}),
    tailscaleIps: identity.tailscaleIps,
    lanIps: identity.lanIps,
    publicKeyB64: identity.publicKeyB64,
    endpoints: identity.endpoints,
    tags: identity.tags,
    gitUrl: identity.gitUrl,
    nonce,
    signature,
  }
}

export function redeemGroupInvitation(
  inviterIdentity: DeviceIdentityRecord,
  group: DeviceGroupPacket,
  token: string,
  request: DeviceJoinRequest,
): DeviceGroupPacket {
  const now = Date.now()
  for (const [k, v] of activeInvitations) {
    if (v.expiresAt <= now) activeInvitations.delete(k)
  }
  const entry = activeInvitations.get(token)
  if (!entry || entry.groupId !== group.groupId) {
    throw new Error('设备组邀请已使用或已过期，请重新生成邀请码')
  }
  const pubDer = Buffer.from(request.publicKeyB64, 'base64url')
  if (sha256Hex(pubDer) !== request.deviceId) {
    throw new Error('请求设备的公钥指纹与 deviceId 不匹配')
  }
  const body = JSON.stringify({
    deviceId: request.deviceId,
    deviceName: request.deviceName,
    hostname: request.hostname,
    tailscaleDnsName: request.tailscaleDnsName,
    tailscaleIps: request.tailscaleIps,
    lanIps: request.lanIps,
    publicKeyB64: request.publicKeyB64,
    endpoints: request.endpoints,
    tags: request.tags,
    gitUrl: request.gitUrl,
    nonce: request.nonce,
  })
  const pubKey = createPublicKey({ key: pubDer, format: 'der', type: 'spki' })
  const ok = verify('sha256', Buffer.concat([DOMAIN_PREFIX, Buffer.from(body, 'utf8')]), pubKey, Buffer.from(request.signature, 'base64url'))
  if (!ok) {
    throw new Error('入组请求签名验证失败')
  }
  activeInvitations.delete(token)

  // Enrich with local Tailscale peer table if the joiner's Tailscale DNS was not yet populated
  const peerFacts = findTailscalePeer(request.tailscaleDnsName || request.hostname || request.deviceName)
  const tailscaleDnsName = request.tailscaleDnsName || peerFacts?.dnsName
  const tailscaleIps = request.tailscaleIps?.length ? request.tailscaleIps : (peerFacts?.tailscaleIps ?? [])
  const allEndpoints = buildNodeCandidateEndpoints({
    endpoints: request.endpoints,
    hostname: request.hostname || request.deviceName,
    tailscaleDnsName,
    tailscaleIps,
    lanIps: request.lanIps,
  })

  const newClaim: GroupClaim = {
    v: 1,
    kind: 'member',
    groupId: group.groupId,
    deviceId: request.deviceId,
    deviceName: request.deviceName,
    ...(request.hostname ? { hostname: request.hostname } : {}),
    ...(tailscaleDnsName ? { tailscaleDnsName } : {}),
    ...(tailscaleIps.length ? { tailscaleIps } : {}),
    ...(request.lanIps?.length ? { lanIps: request.lanIps } : {}),
    groupName: group.groupName,
    publicKeyB64: request.publicKeyB64,
    issuerPublicKeyB64: inviterIdentity.publicKeyB64,
    endpoints: allEndpoints,
    tags: request.tags,
    ...(request.gitUrl ? { gitUrl: request.gitUrl } : {}),
    canInvite: entry.canInvite,
    nonce: request.nonce,
    issuedAt: new Date().toISOString(),
  }
  const signedMember = signClaim(newClaim, inviterIdentity.privateKeyPem)
  const kept = group.members.filter(m => {
    try { return verifySignedClaim(m).deviceId !== request.deviceId } catch { return false }
  })
  return {
    ...group,
    members: [...kept, signedMember],
    updatedAt: new Date().toISOString(),
  }
}

export function verifyAndExtractGroupMembers(packet: DeviceGroupPacket): GroupClaim[] {
  const root = verifySignedClaim(packet.root)
  if (root.kind !== 'root' || root.groupId !== packet.groupId) {
    throw new Error('设备组根证明无效')
  }
  const claims: GroupClaim[] = []
  for (const signed of packet.members) {
    const claim = verifySignedClaim(signed)
    if (claim.groupId !== packet.groupId) throw new Error('成员不属于该设备组')
    claims.push(claim)
  }
  return claims
}

/** Converts verified Device Group members into `WorkerNodeRecord[]` entries with full multi-address failover lists. */
export function groupMembersToWorkerNodes(
  selfDeviceId: string,
  packet: DeviceGroupPacket | undefined,
  existingNodes: readonly WorkerNodeRecord[],
): WorkerNodeRecord[] {
  if (!packet) return [...existingNodes]
  const claims = verifyAndExtractGroupMembers(packet)
  const byId = new Map<string, WorkerNodeRecord>()
  for (const node of existingNodes) {
    if (node.id !== 'local') byId.set(node.id, node)
  }
  for (const member of claims) {
    if (member.deviceId === selfDeviceId) continue
    const slug = member.deviceName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || member.deviceId.slice(0, 8)
    const peerFacts = findTailscalePeer(member.tailscaleDnsName || member.hostname || member.deviceName)
    const tailscaleDnsName = member.tailscaleDnsName || peerFacts?.dnsName
    const tailscaleIps = member.tailscaleIps?.length ? member.tailscaleIps : (peerFacts?.tailscaleIps ?? [])
    const candidateEndpoints = buildNodeCandidateEndpoints({
      endpoints: member.endpoints,
      hostname: member.hostname || member.deviceName,
      tailscaleDnsName,
      tailscaleIps,
      lanIps: member.lanIps,
    })
    const primaryUrl = candidateEndpoints[0] ?? ''
    if (!primaryUrl) continue
    byId.set(slug, {
      id: slug,
      name: `${member.deviceName} (设备组已认证)`,
      url: primaryUrl,
      endpoints: candidateEndpoints,
      hostname: member.hostname || member.deviceName,
      ...(tailscaleDnsName ? { tailscaleDnsName } : {}),
      ...(tailscaleIps.length ? { tailscaleIps } : {}),
      ...(member.lanIps?.length ? { lanIps: member.lanIps } : {}),
      tags: member.tags,
      status: 'online',
      ...(member.gitUrl ? { gitUrl: member.gitUrl } : {}),
      lastSeenAt: packet.updatedAt,
    })
  }
  return [...byId.values()]
}

/** Broadcasts the updated `DeviceGroupPacket` to all other members in the group, trying every candidate endpoint on each peer. */
export async function broadcastGroupPacketToPeers(selfDeviceId: string, packet: DeviceGroupPacket): Promise<void> {
  let claims: GroupClaim[] = []
  try { claims = verifyAndExtractGroupMembers(packet) } catch { return }
  await Promise.allSettled(
    claims
      .filter(m => m.deviceId !== selfDeviceId)
      .map(async member => {
        const candidates = buildNodeCandidateEndpoints({
          endpoints: member.endpoints,
          hostname: member.hostname || member.deviceName,
          tailscaleDnsName: member.tailscaleDnsName,
          tailscaleIps: member.tailscaleIps,
          lanIps: member.lanIps,
        })
        for (const ep of candidates) {
          try {
            const res = await fetch(`${ep.replace(/\/+$/, '')}/orchestrator/standalone/device-group/sync`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' },
              body: JSON.stringify({ packet }),
              signal: AbortSignal.timeout(3500),
            })
            if (res.ok) break
          } catch {
            // Try next candidate endpoint (e.g. hostname -> Tailscale MagicDNS -> Tailscale IP)
          }
        }
      }),
  )
}
