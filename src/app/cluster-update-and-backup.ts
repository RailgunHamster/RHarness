/**
 * Cluster Auto-Update (Data-Center-authoritative release distribution + drain-before-restart)
 * and Data-Center Portable Backup / Rolling Snapshot / Import-Export (`@rharness/cluster-ops`).
 *
 * 1. Cluster Auto-Update:
 *    - Any dev workstation builds a compact gzipped JSON envelope containing `git bundle` + compiled
 *      `lib/` files + SHA-256 manifest, and uploads it to the `数据中心` node.
 *    - The `数据中心` node stores `latest.pkg.gz` + `latest.manifest.json` on disk (so offline nodes
 *      catch up automatically when they next boot/reconcile) and broadcasts an update notice to all
 *      online peers.
 *    - Each node downloads & stages the verified files in the background without interrupting active
 *      turns, waits until all Assistant/Eval/Worker/Feishu runs are idle, atomically swaps `lib/`
 *      (and fast-forwards Git when the working tree is clean), then exits with code `75` so its
 *      singleton supervisor (Windows) or `systemd` (`Restart=always`, Linux) respawns it in ~1s.
 *
 * 2. Data-Center Backup & Import/Export:
 *    - Packs all authoritative personal & cluster state (resident addresses, persona & learnings,
 *      memories & milestones, assistant chat + persistence audit trail, model schedules, plugin states,
 *      plus sticker image binaries) into a single `.rhbak.gz` portable archive with SHA-256 integrity.
 *    - Supports automatic rolling snapshots on `数据中心` (retaining the latest 14 snapshots + an
 *      automatic `pre-import` safety snapshot before any restore) and `merge` / `replace` restore modes.
 */
import { createHash, createPublicKey, sign, verify } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  ensureStickerStorageDir,
  mergeAmbientConfigForSync,
  mergePersonaLearningsForSync,
  normalizeAssistantAmbientConfig,
  normalizeAssistantPersonaConfig,
  readStickerFile,
  resolveStickerFilePath,
  type AssistantAmbientConfig,
  type AssistantPersonaConfig,
  type PersonaLearningEntry,
  type StickerRecord,
} from './assistant-persona-and-ambient.ts'
import type { AssistantContextConfig, AssistantStoredMessage } from './claw-assistant.ts'
import type { MemoryEntry, PluginRegistryState } from './memory-plugin.ts'
import type { ModelProfilesConfig } from './model-profiles.ts'

/** Dedicated worker exit code instructing the singleton supervisor (or systemd) to respawn immediately after an update. */
export const UPDATE_RESTART_EXIT_CODE = 75

export const MAX_ROLLING_BACKUPS = 14
export const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function collectFilesRecursive(rootDir: string, currentDir = rootDir): { relativePath: string; fullPath: string }[] {
  if (!existsSync(currentDir)) return []
  const out: { relativePath: string; fullPath: string }[] = []
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const full = join(currentDir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectFilesRecursive(rootDir, full))
    } else if (entry.isFile()) {
      out.push({ relativePath: relative(rootDir, full).replaceAll('\\', '/'), fullPath: full })
    }
  }
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

// ============================================================================
// 1. Cluster Auto-Update Package & Staging
// ============================================================================

export interface ClusterReleaseManifest {
  version: 1
  publisher?: string
  generation?: number
  rollbackOf?: string
  signature?: string
  /** Deterministic composite identifier `<shortCommit>-<libHash8>` — changes on every commit OR rebuild. */
  buildId: string
  commit: string
  shortCommit: string
  subject: string
  builtAt: string
  fileCount: number
  bundleSha256: string
  libHash: string
}

export interface ClusterReleaseEnvelope {
  manifest: ClusterReleaseManifest
  gitBundleB64: string
  libFiles: { relativePath: string; dataB64: string }[]
}

export interface LocalBuildFacts {
  buildId: string
  commit: string
  shortCommit: string
  subject: string
  libHash: string
}

/** Computes the deterministic hash over all compiled files in `<repoDir>/lib`. */
export function computeLibDirectoryHash(libDir: string): { libHash: string; fileCount: number } {
  const files = collectFilesRecursive(libDir)
  const h = createHash('sha256')
  for (const f of files) {
    h.update(f.relativePath)
    h.update('\0')
    h.update(sha256Hex(readFileSync(f.fullPath)))
    h.update('\n')
  }
  return { libHash: h.digest('hex'), fileCount: files.length }
}

/** Inspects `<repoDir>` (Git HEAD + `lib/` content hash) to produce this process's `buildId`. */
export function inspectLocalBuild(repoDir: string): LocalBuildFacts {
  const libDir = join(repoDir, 'lib')
  const { libHash } = computeLibDirectoryHash(libDir)
  let commit = 'unknown'
  let shortCommit = 'unknown'
  let subject = ''
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim()
    shortCommit = commit.slice(0, 7)
    subject = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim()
  } catch {}
  const buildId = `${shortCommit}-${libHash.slice(0, 8)}`
  return { buildId, commit, shortCommit, subject, libHash }
}

/** Packages `<repoDir>`'s Git `HEAD` bundle + `lib/` directory into a verified gzipped release buffer. */
export function createClusterReleasePackage(repoDir: string, now = new Date(), signer?: { privateKeyPem: string; publicKeyB64: string; generation: number; rollbackOf?: string }): {
  manifest: ClusterReleaseManifest
  packageGz: Buffer
  packageSha256: string
} {
  const libDir = join(repoDir, 'lib')
  if (!existsSync(libDir)) {
    throw new Error(`Compiled lib/ directory not found in ${repoDir}; run pnpm build first`)
  }
  const files = collectFilesRecursive(libDir)
  if (files.length === 0) {
    throw new Error(`lib/ directory is empty in ${repoDir}`)
  }
  const { libHash } = computeLibDirectoryHash(libDir)
  const facts = inspectLocalBuild(repoDir)
  if (facts.commit === 'unknown') {
    throw new Error(`Cannot read Git HEAD in ${repoDir}`)
  }

  const tmp = mkdtempSync(join(tmpdir(), 'rharness-rel-'))
  try {
    const bundlePath = join(tmp, 'rharness.bundle')
    execFileSync('git', ['bundle', 'create', bundlePath, 'HEAD'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] })
    const bundleBytes = readFileSync(bundlePath)
    const bundleSha256 = sha256Hex(bundleBytes)
    const libFiles = files.map(f => ({
      relativePath: f.relativePath,
      dataB64: readFileSync(f.fullPath).toString('base64'),
    }))
    const manifest: ClusterReleaseManifest = {
      version: 1,
      buildId: `${facts.shortCommit}-${libHash.slice(0, 8)}`,
      commit: facts.commit,
      shortCommit: facts.shortCommit,
      subject: facts.subject,
      builtAt: now.toISOString(),
      fileCount: libFiles.length,
      bundleSha256,
      libHash,
    }
    if (signer) {
      manifest.publisher = signer.publicKeyB64
      manifest.generation = signer.generation
      if (signer.rollbackOf) manifest.rollbackOf = signer.rollbackOf
      manifest.signature = sign('sha256', releaseSigningBytes(manifest), signer.privateKeyPem).toString('base64url')
    }
    const envelope: ClusterReleaseEnvelope = {
      manifest,
      gitBundleB64: bundleBytes.toString('base64'),
      libFiles,
    }
    const packageGz = gzipSync(Buffer.from(JSON.stringify(envelope), 'utf8'))
    return { manifest, packageGz, packageSha256: sha256Hex(packageGz) }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}

function releaseSigningBytes(manifest: ClusterReleaseManifest): Buffer {
  const { signature: _signature, ...fields } = manifest
  return Buffer.from('RHarness release v1\n' + JSON.stringify(fields))
}

export interface ReleaseCheckpoint { generation: number; buildId: string; signature: string }
export function verifyReleasePublisher(manifest: ClusterReleaseManifest, trusted: readonly string[], previous?: ReleaseCheckpoint): ReleaseCheckpoint {
  const { publisher, generation, signature } = manifest
  if (!publisher || !signature || !trusted.includes(publisher) || !Number.isSafeInteger(generation) || generation! <= 0) throw new Error('Untrusted release publisher or unsigned release')
  const key = createPublicKey({ key: Buffer.from(publisher, 'base64url'), format: 'der', type: 'spki' })
  if (!verify('sha256', releaseSigningBytes(manifest), key, Buffer.from(signature, 'base64url'))) throw new Error('Invalid release signature')
  if (previous && (generation! < previous.generation || (generation === previous.generation && signature !== previous.signature))) throw new Error('Stale or conflicting release generation')
  if (manifest.rollbackOf && previous && signature !== previous.signature && manifest.rollbackOf !== previous.buildId) throw new Error('Rollback target is no longer current')
  return { generation: generation!, buildId: manifest.buildId, signature }
}

/** Unpacks and cryptographically verifies a gzipped cluster release buffer (`bundleSha256` + `libHash`). */
export function unpackAndVerifyClusterRelease(packageGz: Buffer): ClusterReleaseEnvelope {
  const rawJson = gunzipSync(packageGz, { maxOutputLength: 256 * 1024 * 1024 }).toString('utf8')
  const parsed = JSON.parse(rawJson) as ClusterReleaseEnvelope
  if (!parsed?.manifest || parsed.manifest.version !== 1 || !Array.isArray(parsed.libFiles) || typeof parsed.gitBundleB64 !== 'string') {
    throw new Error('Invalid cluster release package format')
  }
  if (!/^[a-f0-9]{40,64}$/.test(parsed.manifest.commit) || parsed.manifest.shortCommit !== parsed.manifest.commit.slice(0, 7)
    || parsed.manifest.buildId !== parsed.manifest.shortCommit + '-' + parsed.manifest.libHash.slice(0, 8)
    || parsed.manifest.fileCount !== parsed.libFiles.length || new Set(parsed.libFiles.map(file => file.relativePath.toLowerCase())).size !== parsed.libFiles.length) throw new Error('Invalid release manifest metadata')
  const bundleBytes = Buffer.from(parsed.gitBundleB64, 'base64')
  if (sha256Hex(bundleBytes) !== parsed.manifest.bundleSha256) {
    throw new Error('Cluster release git bundle SHA-256 mismatch')
  }
  const h = createHash('sha256')
  const sorted = [...parsed.libFiles].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  for (const f of sorted) {
    if (typeof f.relativePath !== 'string' || /[\\:\x00-\x1f]/.test(f.relativePath) || f.relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`Unsafe relative path in release package: ${f.relativePath}`)
    }
    h.update(f.relativePath)
    h.update('\0')
    h.update(sha256Hex(Buffer.from(f.dataB64, 'base64')))
    h.update('\n')
  }
  if (h.digest('hex') !== parsed.manifest.libHash) {
    throw new Error('Cluster release lib/ hash mismatch')
  }
  return parsed
}

export function getDataCenterReleasePaths(stateDir: string): { dir: string; manifestPath: string; packagePath: string } {
  const dir = join(resolve(stateDir), 'cluster-releases')
  return {
    dir,
    manifestPath: join(dir, 'latest.manifest.json'),
    packagePath: join(dir, 'latest.pkg.gz'),
  }
}

export function saveReleaseOnDataCenter(stateDir: string, packageGz: Buffer): ClusterReleaseManifest {
  const verified = unpackAndVerifyClusterRelease(packageGz)
  const paths = getDataCenterReleasePaths(stateDir)
  mkdirSync(paths.dir, { recursive: true })
  const digest = sha256Hex(packageGz)
  const packagePath = join(paths.dir, digest + '.pkg.gz')
  const tmpPkg = `${packagePath}.tmp-${process.pid}`
  const tmpManifest = `${paths.manifestPath}.tmp-${process.pid}`
  writeFileSync(tmpPkg, packageGz)
  renameSync(tmpPkg, packagePath)
  writeFileSync(tmpManifest, JSON.stringify({ manifest: verified.manifest, digest }), 'utf8')
  renameSync(tmpManifest, paths.manifestPath)
  // The manifest pointer is committed before retiring obsolete packages. Keep one fallback for an in-flight reader.
  const old = readdirSync(paths.dir).filter(name => /^[a-f0-9]{64}\.pkg\.gz$/.test(name) && name !== digest + '.pkg.gz')
    .sort((a,b) => statSync(join(paths.dir,b)).mtimeMs - statSync(join(paths.dir,a)).mtimeMs)
  for (const name of old.slice(1)) {
    try { rmSync(join(paths.dir,name)) } catch { /* An existing reader may still hold the file on Windows. */ }
  }
  return verified.manifest
}

export function readLatestReleaseOnDataCenter(stateDir: string): { manifest: ClusterReleaseManifest; packagePath: string } | undefined {
  const paths = getDataCenterReleasePaths(stateDir)
  if (!existsSync(paths.manifestPath)) return undefined
  try {
    const saved = JSON.parse(readFileSync(paths.manifestPath, 'utf8')) as ClusterReleaseManifest | { manifest: ClusterReleaseManifest; digest: string }
    if ('manifest' in saved) {
      if (!/^[a-f0-9]{64}$/.test(saved.digest)) return undefined
      const packagePath = join(paths.dir, saved.digest + '.pkg.gz')
      return existsSync(packagePath) ? { manifest: saved.manifest, packagePath } : undefined
    }
    return existsSync(paths.packagePath) ? { manifest: saved, packagePath: paths.packagePath } : undefined
  } catch {
    return undefined
  }
}

/** Returns true when `<repoDir>` has uncommitted tracked file changes (never clobber active dev work!). */
export function hasDirtyTrackedGitTree(repoDir: string): boolean {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('utf8').trim()
    return out.length > 0
  } catch {
    return false
  }
}

/**
 * Applies a verified `ClusterReleaseEnvelope` onto `<repoDir>`:
 * 1. If `<repoDir>` is a clean Git repository, fetches the bundle and updates `main` to `FETCH_HEAD`
 *    (if `<repoDir>` has dirty tracked edits on a dev machine, skips `git checkout` to protect work!).
 * 2. Atomically writes all compiled `lib/` files via `.tmp` + `renameSync` and removes stale `lib/` files.
 */
export function applyVerifiedReleaseToRepo(repoDir: string, envelope: ClusterReleaseEnvelope, stateDir: string): {
  gitUpdated: boolean
  skippedDirtyGit: boolean
  filesWritten: number
} {
  let gitUpdated = false
  let skippedDirtyGit = false
  const dirty = hasDirtyTrackedGitTree(repoDir)
  if (dirty) {
    skippedDirtyGit = true
  } else if (existsSync(join(repoDir, '.git'))) {
    const stageDir = join(resolve(stateDir), 'staged-update')
    mkdirSync(stageDir, { recursive: true })
    const bundlePath = join(stageDir, `release-${envelope.manifest.shortCommit}.bundle`)
    writeFileSync(bundlePath, Buffer.from(envelope.gitBundleB64, 'base64'))
    try {
      execFileSync('git', ['fetch', bundlePath, 'HEAD'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] })
      const git = (args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      if (git(['rev-parse', 'FETCH_HEAD']) !== envelope.manifest.commit) throw new Error('Bundle HEAD differs from the release manifest')
      const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
      if (branch === 'main' || branch === 'HEAD') {
        if (envelope.manifest.rollbackOf) git(['checkout', '--detach', 'FETCH_HEAD'])
        else {
          let fastForward = true
          try { git(['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD']) } catch { fastForward = false }
          // Preserve local branch tips when updating an independently provisioned, clean deployment.
          if (fastForward) git(['merge', '--ff-only', 'FETCH_HEAD'])
          else git(['checkout', '--detach', 'FETCH_HEAD'])
        }
        gitUpdated = true
      }
    } catch {
      // Non-fatal: `lib/` swap below is what the running Node runtime actually executes.
    } finally {
      try { rmSync(bundlePath, { force: true }) } catch {}
    }
  }

  const libDir = join(repoDir, 'lib')
  mkdirSync(libDir, { recursive: true })
  const expectedRel = new Set<string>()
  for (const f of envelope.libFiles) {
    expectedRel.add(f.relativePath)
    const target = join(libDir, ...f.relativePath.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    const tmp = `${target}.upd-${process.pid}`
    writeFileSync(tmp, Buffer.from(f.dataB64, 'base64'))
    renameSync(tmp, target)
  }
  for (const existing of collectFilesRecursive(libDir)) {
    if (!expectedRel.has(existing.relativePath)) {
      try { rmSync(existing.fullPath, { force: true }) } catch {}
    }
  }
  return { gitUpdated, skippedDirtyGit, filesWritten: envelope.libFiles.length }
}

// ============================================================================
// 2. Data-Center Full Backup, Rolling Snapshots & Portable Import/Export
// ============================================================================

export interface DataCenterBackupSummary {
  residentAddressCount: number
  memoryCount: number
  assistantMessageCount: number
  personaLearningCount: number
  stickerCount: number
  stickerFileCount: number
  includesSecrets: boolean
}

import type { WorkspaceArchive } from './workspace-records.ts'

export interface DataCenterBackupPayload {
  version: 1
  createdAt: string
  reason: 'manual-export' | 'auto-daily' | 'pre-import' | 'manual-snapshot'
  sourceDeviceName: string
  includesSecrets: boolean
  summary: DataCenterBackupSummary
  data: {
    personaConfig: AssistantPersonaConfig
    personaLearnings: PersonaLearningEntry[]
    ambientConfig: AssistantAmbientConfig
    amapApiKey?: string
    memories: MemoryEntry[]
    assistantMessages: AssistantStoredMessage[]
    assistantContextConfig?: AssistantContextConfig
    modelProfiles?: ModelProfilesConfig
    pluginState?: PluginRegistryState
    clawfeedItems?: unknown[]
    workspace?: WorkspaceArchive
    losslessDag?: unknown
    selfImprovingLearnings?: unknown[]
    stickers: StickerRecord[]
    /** Actual image binaries (`fileName -> base64`) from `~/.rharness/stickers` so stickers survive machine migration. */
    stickerFiles: { fileName: string; dataB64: string }[]
  }
}

export interface DataCenterSnapshotMeta {
  fileName: string
  createdAt: string
  reason: DataCenterBackupPayload['reason']
  sizeBytes: number
  sha256: string
  summary: DataCenterBackupSummary
}

export function getDataCenterBackupDir(stateDir: string): string {
  return join(resolve(stateDir), 'datacenter-backups')
}

/** Builds a gzipped `.rhbak.gz` portable backup archive from the live Data Center stores + sticker files. */
export function createDataCenterBackupArchive(input: {
  reason: DataCenterBackupPayload['reason']
  sourceDeviceName: string
  includesSecrets: boolean
  personaConfig: AssistantPersonaConfig
  personaLearnings: PersonaLearningEntry[]
  ambientConfig: AssistantAmbientConfig
  amapApiKey?: string
  memories: MemoryEntry[]
  assistantMessages: AssistantStoredMessage[]
  assistantContextConfig?: AssistantContextConfig
  modelProfiles?: ModelProfilesConfig
  pluginState?: PluginRegistryState
  clawfeedItems?: unknown[]
  losslessDag?: unknown
  selfImprovingLearnings?: unknown[]
  workspace?: WorkspaceArchive
  stickers: StickerRecord[]
  now?: Date
}): { payload: DataCenterBackupPayload; archiveGz: Buffer; sha256: string } {
  const now = input.now ?? new Date()
  const stickerFiles: { fileName: string; dataB64: string }[] = []
  const seenFiles = new Set<string>()
  for (const s of input.stickers) {
    if (!s.fileName || seenFiles.has(s.fileName)) continue
    const bytes = readStickerFile(s)
    if (bytes) {
      seenFiles.add(s.fileName)
      stickerFiles.push({ fileName: s.fileName, dataB64: bytes.toString('base64') })
    }
  }
  const summary: DataCenterBackupSummary = {
    residentAddressCount: input.ambientConfig.residentAddresses.length,
    memoryCount: input.memories.length,
    assistantMessageCount: input.assistantMessages.length,
    personaLearningCount: input.personaLearnings.length,
    stickerCount: input.stickers.length,
    stickerFileCount: stickerFiles.length,
    includesSecrets: input.includesSecrets,
  }
  const payload: DataCenterBackupPayload = {
    version: 1,
    createdAt: now.toISOString(),
    reason: input.reason,
    sourceDeviceName: input.sourceDeviceName,
    includesSecrets: input.includesSecrets,
    summary,
    data: {
      personaConfig: input.personaConfig,
      personaLearnings: input.personaLearnings,
      ambientConfig: input.ambientConfig,
      ...(input.includesSecrets && input.amapApiKey ? { amapApiKey: input.amapApiKey } : {}),
      memories: input.memories,
      ...(input.workspace ? { workspace: input.workspace } : {}),
      assistantMessages: input.assistantMessages,
      ...(input.assistantContextConfig ? { assistantContextConfig: input.assistantContextConfig } : {}),
      ...(input.modelProfiles ? { modelProfiles: input.modelProfiles } : {}),
      ...(input.pluginState ? { pluginState: input.pluginState } : {}),
      ...(input.clawfeedItems ? { clawfeedItems: input.clawfeedItems } : {}),
      ...(input.losslessDag !== undefined ? { losslessDag: input.losslessDag } : {}),
      ...(input.selfImprovingLearnings ? { selfImprovingLearnings: input.selfImprovingLearnings } : {}),
      stickers: input.stickers,
      stickerFiles,
    },
  }
  const archiveGz = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'))
  return { payload, archiveGz, sha256: sha256Hex(archiveGz) }
}

/** Parses and validates a `.rhbak.gz` (or plain JSON) backup archive buffer. */
export function parseDataCenterBackupArchive(raw: Buffer): DataCenterBackupPayload {
  const isGzip = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b
  const jsonText = (isGzip ? gunzipSync(raw) : raw).toString('utf8')
  const parsed = JSON.parse(jsonText) as DataCenterBackupPayload
  if (!parsed || parsed.version !== 1 || !parsed.data || typeof parsed.data !== 'object') {
    throw new Error('无效的备份包格式（需要 RHarness v1 备份包）')
  }
  return parsed
}

/** Writes a rolling snapshot into `<stateDir>/datacenter-backups/` and prunes snapshots beyond `MAX_ROLLING_BACKUPS`. */
export function writeDataCenterRollingSnapshot(
  stateDir: string,
  archiveGz: Buffer,
  payload: DataCenterBackupPayload,
  maxKeep = MAX_ROLLING_BACKUPS,
): DataCenterSnapshotMeta {
  const dir = getDataCenterBackupDir(stateDir)
  mkdirSync(dir, { recursive: true })
  const safeTs = payload.createdAt.replace(/[:.]/g, '-')
  const baseName = `rharness-${payload.reason}-${safeTs}`
  const gzName = `${baseName}.rhbak.gz`
  const metaName = `${baseName}.meta.json`
  const sha256 = sha256Hex(archiveGz)
  const meta: DataCenterSnapshotMeta = {
    fileName: gzName,
    createdAt: payload.createdAt,
    reason: payload.reason,
    sizeBytes: archiveGz.length,
    sha256,
    summary: payload.summary,
  }
  writeFileSync(join(dir, gzName), archiveGz)
  writeFileSync(join(dir, metaName), JSON.stringify(meta, null, 2), 'utf8')

  // Prune oldest snapshots beyond `maxKeep`
  const all = listDataCenterRollingSnapshots(stateDir)
  for (const old of all.slice(maxKeep)) {
    const prefix = old.fileName.replace(/\.rhbak\.gz$/, '')
    try { rmSync(join(dir, old.fileName), { force: true }) } catch {}
    try { rmSync(join(dir, `${prefix}.meta.json`), { force: true }) } catch {}
  }
  return meta
}

export function listDataCenterRollingSnapshots(stateDir: string): DataCenterSnapshotMeta[] {
  const dir = getDataCenterBackupDir(stateDir)
  if (!existsSync(dir)) return []
  const out: DataCenterSnapshotMeta[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.meta.json')) continue
    try {
      const meta = JSON.parse(readFileSync(join(dir, name), 'utf8')) as DataCenterSnapshotMeta
      const gzPath = join(dir, meta.fileName)
      if (!existsSync(gzPath)) continue
      out.push({ ...meta, sizeBytes: statSync(gzPath).size })
    } catch {}
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function readDataCenterRollingSnapshotBytes(stateDir: string, fileName: string): Buffer | undefined {
  const clean = fileName.trim()
  if (!clean || clean.includes('..') || clean.includes('/') || clean.includes('\\') || !clean.endsWith('.rhbak.gz')) {
    return undefined
  }
  const full = join(getDataCenterBackupDir(stateDir), clean)
  return existsSync(full) ? readFileSync(full) : undefined
}

/**
 * Computes the restored stores for either `merge` (non-destructive union by id / newer `updatedAt`)
 * or `replace` (authoritative full restore) and writes restored sticker image binaries back to disk.
 */
export function computeRestoredDataCenterState(
  current: {
    personaConfig: AssistantPersonaConfig
    personaLearnings: PersonaLearningEntry[]
    ambientConfig: AssistantAmbientConfig
    amapApiKey?: string
    memories: MemoryEntry[]
    assistantMessages: AssistantStoredMessage[]
    assistantContextConfig: AssistantContextConfig
    stickers: StickerRecord[]
  },
  incoming: DataCenterBackupPayload,
  mode: 'merge' | 'replace',
): {
  personaConfig: AssistantPersonaConfig
  personaLearnings: PersonaLearningEntry[]
  ambientConfig: AssistantAmbientConfig
  amapApiKey?: string
  memories: MemoryEntry[]
  assistantMessages: AssistantStoredMessage[]
  assistantContextConfig: AssistantContextConfig
  modelProfiles?: ModelProfilesConfig
  pluginState?: PluginRegistryState
  clawfeedItems?: unknown[]
  losslessDag?: unknown
  selfImprovingLearnings?: unknown[]
  stickers: StickerRecord[]
  restoredStickerFiles: number
} {
  const d = incoming.data
  const nextPersona = normalizeAssistantPersonaConfig(d.personaConfig ?? current.personaConfig)
  const incAmbient = normalizeAssistantAmbientConfig(d.ambientConfig ?? current.ambientConfig)
  const incLearnings = Array.isArray(d.personaLearnings) ? d.personaLearnings : []
  const incMemories = Array.isArray(d.memories) ? d.memories : []
  const incMessages = Array.isArray(d.assistantMessages) ? d.assistantMessages : []
  const incStickers = Array.isArray(d.stickers) ? d.stickers : []

  // Write sticker image files back to `~/.rharness/stickers/` (safe: content-addressed filenames)
  let restoredStickerFiles = 0
  if (Array.isArray(d.stickerFiles) && d.stickerFiles.length > 0) {
    ensureStickerStorageDir()
    for (const sf of d.stickerFiles) {
      if (!sf.fileName || sf.fileName.includes('..') || sf.fileName.includes('/') || sf.fileName.includes('\\')) continue
      const target = resolveStickerFilePath({ fileName: sf.fileName })
      if (mode === 'replace' || !existsSync(target)) {
        writeFileSync(target, Buffer.from(sf.dataB64, 'base64'))
        restoredStickerFiles++
      }
    }
  }

  if (mode === 'replace') {
    return {
      personaConfig: nextPersona,
      personaLearnings: incLearnings,
      ambientConfig: incAmbient,
      ...(d.amapApiKey !== undefined ? { amapApiKey: d.amapApiKey } : current.amapApiKey ? { amapApiKey: current.amapApiKey } : {}),
      memories: incMemories,
      assistantMessages: incMessages,
      assistantContextConfig: d.assistantContextConfig ?? current.assistantContextConfig,
      ...(d.modelProfiles ? { modelProfiles: d.modelProfiles } : {}),
      ...(d.pluginState ? { pluginState: d.pluginState } : {}),
      ...(d.clawfeedItems ? { clawfeedItems: d.clawfeedItems } : {}),
      ...(d.losslessDag !== undefined ? { losslessDag: d.losslessDag } : {}),
      ...(d.selfImprovingLearnings ? { selfImprovingLearnings: d.selfImprovingLearnings } : {}),
      stickers: incStickers,
      restoredStickerFiles,
    }
  }

  // `merge` mode: union every collection by id / newer `updatedAt`
  const mergedAmbient = mergeAmbientConfigForSync(current.ambientConfig, incAmbient)
  const mergedLearnings = mergePersonaLearningsForSync(current.personaLearnings, incLearnings)

  const memById = new Map<string, MemoryEntry>()
  for (const m of current.memories) memById.set(m.id, m)
  for (const m of incMemories) {
    const dupTitle = [...memById.values()].find(e => e.id !== m.id && e.title.trim().toLowerCase() === m.title.trim().toLowerCase())
    if (dupTitle) {
      const winner = m.updatedAt >= dupTitle.updatedAt ? m : dupTitle
      memById.delete(dupTitle.id)
      memById.set(winner.id, winner)
    } else {
      const prev = memById.get(m.id)
      memById.set(m.id, prev && prev.updatedAt > m.updatedAt ? prev : m)
    }
  }
  const mergedMemories = [...memById.values()].sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.updatedAt.localeCompare(a.updatedAt)))

  const msgById = new Map<string, AssistantStoredMessage>()
  for (const m of current.assistantMessages) msgById.set(m.id, m)
  for (const m of incMessages) {
    if (!msgById.has(m.id)) msgById.set(m.id, m)
  }
  const mergedMessages = [...msgById.values()].sort((a, b) => a.at.localeCompare(b.at))

  const stickerBySha = new Map<string, StickerRecord>()
  for (const s of current.stickers) stickerBySha.set(s.sha256 || s.id, s)
  for (const s of incStickers) {
    const k = s.sha256 || s.id
    const prev = stickerBySha.get(k)
    if (!prev || s.updatedAt > prev.updatedAt) stickerBySha.set(k, s)
  }

  return {
    personaConfig: nextPersona,
    personaLearnings: mergedLearnings,
    ambientConfig: mergedAmbient,
    ...(current.amapApiKey ? { amapApiKey: current.amapApiKey } : d.amapApiKey ? { amapApiKey: d.amapApiKey } : {}),
    memories: mergedMemories,
    assistantMessages: mergedMessages,
    assistantContextConfig: current.assistantContextConfig,
    ...(d.modelProfiles ? { modelProfiles: d.modelProfiles } : {}),
    ...(d.pluginState ? { pluginState: d.pluginState } : {}),
    stickers: [...stickerBySha.values()],
    restoredStickerFiles,
  }
}
