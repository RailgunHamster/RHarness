/**
 * External Private Pack Loader (`~/.rharness/private-pack/manifest.json` or `RHARNESS_PRIVATE_PACK_DIR`).
 *
 * Keeps the public `RHarness` repository 100% clean of any operator-specific IP addresses, Tailscale domains,
 * private server paths, Feishu user IDs, seed memories, or bespoke plugins (such as `rhtoolkit`), while allowing
 * an operator's own machines to mount private configuration and extensions seamlessly from outside the Git tree.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MemoryEntry, PluginDescriptor } from './memory-plugin.ts'
import type { RegisteredToolSpec } from './standalone-host.ts'

export interface PrivatePackPersonalPaths {
  feishuCred?: string
  openclawCfgFallback?: string
  todoListPs1?: string
  todoWritePs1?: string
  emailProjectDir?: string
  emailStatePy?: string
  feishuCalendarPy?: string
  marketWatchDir?: string
  marketReportUrl?: string
  marketMetalsUrl?: string
  marketAnalogsUrl?: string
  dedupPy?: string
  interestsCsv?: string
  standaloneOrdersDir?: string
  ordersDir?: string
  ordersAnalyzePs1?: string
  ordersSummaryPs1?: string
  pdfSkillDir?: string
  pdfProcessPy?: string
  pdfDedupIndex?: string
  transcribePs1?: string
  clawfeedPauseFile?: string
  clawfeedRepoDirs?: string[]
  clawfeedSinkEndpoints?: string[]
  siyuanCred?: string
  siyuanBlockedNotebookIds?: string[]
  tcSshKey?: string
  tcSshHost?: string
  tcSshUser?: string
  tcSshHostKeyAlias?: string
  tcKnownHostsUserRoot?: string
  ownerOpenId?: string
  ownerDmChatId?: string
  peerFallbackEndpoints?: string[]
  tlsCertDirs?: string[]
  browserRelaySecretPaths?: string[]
}

export interface PrivatePackRHToolkitSpec {
  enabled: boolean
  rootDir?: string
  remoteEndpoint?: string
  proxyUrl?: string
  compressionLevel?: number
}

export interface PrivatePackManifest {
  packId?: string
  packName?: string
  /** Optional module entry relative to the manifest directory exporting custom tools/routes. */
  rhtoolkitModule?: string
  rhtoolkit?: PrivatePackRHToolkitSpec
  personalPaths?: PrivatePackPersonalPaths
  siyuanPromptSummary?: string
  seedMemories?: Omit<MemoryEntry, 'createdAt' | 'updatedAt'>[]
  enablePersonalSkillsPlugin?: boolean
  enableClawFeedPlugin?: boolean
}

export interface RHToolkitDynamicModule {
  DEFAULT_RHTOOLKIT_CONFIG: {
    rootDir: string
    remoteEndpoint: string
    proxyUrl: string
    compressionLevel: number
  }
  isToolkitHostedLocally: (cfg?: Record<string, unknown>) => boolean
  getLocalToolkitOverview: (cfg?: Record<string, unknown>) => unknown
  startLocalToolkitDownload: (input: Record<string, unknown>, cfg?: Record<string, unknown>) => unknown
  cancelLocalToolkitDownload: () => { ok: boolean; message: string }
  fetchLocalBilibiliSpaceVideos: (spaceUrl: string, cfg?: Record<string, unknown>) => Promise<unknown>
  startLocalBilibiliSpaceBatchDownload: (input: { uid: string; username?: string; bvIds: string[] }, cfg?: Record<string, unknown>) => unknown
  prepareLocalZipJob: (input: { folder?: string; videosOnly?: boolean }, cfg?: Record<string, unknown>) => unknown
  startLocalFolderBackup: (input: { sourceFolder: string; backupName?: string }, cfg?: Record<string, unknown>) => unknown
  deleteLocalToolkitItem: (input: { kind: 'download' | 'backup'; relativePath: string }, cfg?: Record<string, unknown>) => unknown
  renameLocalToolkitFolder: (input: { oldFolder: string; newFolder: string }, cfg?: Record<string, unknown>) => unknown
  serveLocalToolkitStream: (
    req: IncomingMessage,
    res: ServerResponse,
    target: { kind: 'download' | 'backup' | 'zip'; relativePath: string; asAttachment?: boolean },
    cfg?: Record<string, unknown>,
  ) => void
  proxyToolkitJsonToRemote: <T = unknown>(
    remoteEndpoint: string,
    subpath: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ) => Promise<T>
  proxyToolkitStreamToRemote: (
    remoteEndpoint: string,
    upstreamPathAndQuery: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) => void
  buildRHToolkitPluginTools: (
    getConfig: () => Record<string, unknown>,
    isEnabled: () => boolean,
  ) => RegisteredToolSpec[]
  buildRHToolkitPluginDescriptor: (enabled: boolean) => PluginDescriptor
}

export interface LoadedPrivatePack {
  manifestPath: string
  packDir: string
  manifest: PrivatePackManifest
}

let cachedPack: { key: string; value: LoadedPrivatePack | undefined } | undefined
let cachedToolkitMod: { path: string; mod: RHToolkitDynamicModule } | undefined

export function candidatePrivatePackDirs(): string[] {
  const envDir = process.env.RHARNESS_PRIVATE_PACK_DIR?.trim()
  if (envDir === 'none' || envDir === '0' || envDir === 'false') {
    return []
  }
  const list: string[] = []
  if (envDir) {
    list.push(isAbsolute(envDir) ? envDir : resolve(process.cwd(), envDir))
  }
  const home = homedir()
  if (home) {
    list.push(join(home, '.rharness', 'private-pack'))
  }
  list.push(resolve(process.cwd(), '..', 'rharness-private-pack'))
  return list
}

export function loadPrivatePack(): LoadedPrivatePack | undefined {
  const dirs = candidatePrivatePackDirs()
  const cacheKey = dirs.join('|')
  if (cachedPack && cachedPack.key === cacheKey) {
    return cachedPack.value
  }
  for (const dir of dirs) {
    const manifestPath = join(dir, 'manifest.json')
    if (!existsSync(manifestPath)) continue
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as PrivatePackManifest
      if (raw && typeof raw === 'object') {
        const loaded: LoadedPrivatePack = {
          manifestPath,
          packDir: dirname(manifestPath),
          manifest: raw,
        }
        cachedPack = { key: cacheKey, value: loaded }
        return loaded
      }
    } catch {}
  }
  cachedPack = { key: cacheKey, value: undefined }
  return undefined
}

export function resetPrivatePackCache(): void {
  cachedPack = undefined
  cachedToolkitMod = undefined
}

export async function loadRHToolkitDynamicModule(): Promise<RHToolkitDynamicModule | undefined> {
  const pack = loadPrivatePack()
  if (!pack || !pack.manifest.rhtoolkit?.enabled) return undefined
  const relFile = pack.manifest.rhtoolkitModule || 'rhtoolkit-plugin.mjs'
  const modPath = isAbsolute(relFile) ? relFile : join(pack.packDir, relFile)
  if (!existsSync(modPath)) return undefined
  if (cachedToolkitMod && cachedToolkitMod.path === modPath) {
    return cachedToolkitMod.mod
  }
  try {
    const fileUrl = new URL(`file://${modPath.startsWith('/') ? '' : '/'}${modPath.replaceAll('\\', '/')}`).href
    const imported = (await import(fileUrl)) as RHToolkitDynamicModule
    cachedToolkitMod = { path: modPath, mod: imported }
    return imported
  } catch {
    return undefined
  }
}
