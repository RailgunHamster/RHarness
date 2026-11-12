import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPluginCatalog, defaultMemories } from '../src/app/memory-plugin.ts'
import { resetPrivatePackCache } from '../src/app/private-pack.ts'
import { getEnabledUIViewSlots } from '../src/client/ui-slots.tsx'
import { startStandaloneServer } from '../src/server/standalone.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function collectAllTrackedFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectAllTrackedFiles(full))
    } else if (entry.isFile() && /\.(ts|tsx|md|json|mjs)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

describe('clean-room public deployment & external private pack isolation', () => {
  const prevEnv = process.env.RHARNESS_PRIVATE_PACK_DIR

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.RHARNESS_PRIVATE_PACK_DIR
    else process.env.RHARNESS_PRIVATE_PACK_DIR = prevEnv
    resetPrivatePackCache()
  })

  it('contains zero hardcoded personal IPs, Tailscale domains, or private server paths anywhere in src/ and docs/', () => {
    // Construct patterns dynamically so even this test file does not spell literal private identifiers
    const forbiddenPatterns = [
      new RegExp(['100', '75', '187', '127'].join('\\.')),
      new RegExp(['101', '43', '203', '147'].join('\\.')),
      new RegExp(['100', '122', '230', '22'].join('\\.')),
      new RegExp(['192', '168', '0', '113'].join('\\.')),
      new RegExp(['taile', '71e4', '\\.ts\\.net'].join('')),
      new RegExp(['C:/Users/', 'Administrator/', 'claw'].join('')),
      new RegExp(['ou_', '0e5d', '91fc4f'].join('')),
      new RegExp(['20260108', '120628'].join('')),
      new RegExp(['\\u78a3\\u77f3', '\\u576a'].join('')),
      new RegExp(['\\u8001\\u5a46', '\\u68a6\\u8bdd'].join('')),
    ]

    const files = [
      ...collectAllTrackedFiles(join(ROOT, 'src')),
      ...collectAllTrackedFiles(join(ROOT, 'docs')),
      join(ROOT, 'README.md'),
      join(ROOT, 'SETUP.md'),
    ]

    const violations: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      for (const pat of forbiddenPatterns) {
        if (pat.test(content)) {
          violations.push(`${file.slice(ROOT.length + 1)} matched ${pat}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('starts completely clean (empty seed memories, no rhtoolkit/clawfeed tabs or plugins) when RHARNESS_PRIVATE_PACK_DIR=none', async () => {
    process.env.RHARNESS_PRIVATE_PACK_DIR = 'none'
    resetPrivatePackCache()

    expect(defaultMemories()).toEqual([])

    const plugins = buildPluginCatalog({
      disabledPlugins: [],
      memoryCount: 0,
      pinnedMemoryCount: 0,
      nodeCount: 1,
      profileCount: 3,
      sourcesEnabled: { panel: true, feishu: true, github: false },
    })
    const ids = plugins.map(p => p.id)
    expect(ids).not.toContain('dsh-rhtoolkit')
    expect(ids).not.toContain('dsh-personal-skills')

    const visibleSlots = getEnabledUIViewSlots(plugins).map(s => s.id)
    expect(visibleSlots).not.toContain('rhtoolkit')
    expect(visibleSlots).toEqual(['assistant', 'workbench', 'memory', 'pipeline', 'management'])

    const stateDir = mkdtempSync(join(tmpdir(), 'rharness-clean-room-'))
    const srv = await startStandaloneServer({
      port: 0,
      host: '127.0.0.1',
      stateDir,
      liveAgents: false,
    })
    try {
      const res = await fetch(`${srv.url}/orchestrator/standalone/rhtoolkit/state`, {
        headers: { 'x-orchestrator-request': '1' },
      })
      expect(res.status).toBe(404)
    } finally {
      await srv.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 25_000)

  it('dynamically mounts external private pack seed memories and custom ESM module when present', async () => {
    const packDir = mkdtempSync(join(tmpdir(), 'rharness-custom-pack-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'rharness-packed-state-'))
    try {
      writeFileSync(
        join(packDir, 'custom-toolkit.mjs'),
        `
export const DEFAULT_RHTOOLKIT_CONFIG = { rootDir: '/tmp/demo', remoteEndpoint: 'http://127.0.0.1:1', proxyUrl: '', compressionLevel: 5 };
export const isToolkitHostedLocally = () => true;
export const getLocalToolkitOverview = () => ({ hostedLocally: true, nodeHost: 'mock-node', rootDir: '/tmp/demo', diskFreeGb: 50, diskTotalGb: 100, memFreeMb: 1024, memTotalMb: 2048, toolsAvailable: { bbdown: true, ytdlp: true, sevenZip: true }, downloadTask: { running: false, progress: 0, command: '', error: null, outputTail: '', recentFiles: [] }, backupTask: { running: false, progress: 0, currentFolder: null, filename: null, sizeMb: null, error: null }, folders: [], totalDownloadFiles: 7, totalDownloadSizeMb: 42, backups: [], recentHistory: [], activeZipJob: null });
export const buildRHToolkitPluginDescriptor = (enabled) => ({ id: 'dsh-rhtoolkit', packageName: '@custom/rhtoolkit', title: { zh: '私有工具箱', en: 'Private Toolkit' }, description: { zh: '测试', en: 'Test' }, category: 'assistant', enabled, canToggle: true, roles: ['assistant', 'ui-slot'], tools: ['toolkit_status'] });
export const buildRHToolkitPluginTools = () => [{ name: 'toolkit_status', description: 'Mock toolkit status', parameters: { type: 'object', properties: {} }, execute: async () => ({ ok: true }) }];
`,
        'utf8',
      )
      writeFileSync(
        join(packDir, 'manifest.json'),
        JSON.stringify({
          packId: 'test-pack',
          rhtoolkitModule: 'custom-toolkit.mjs',
          rhtoolkit: { enabled: true },
          seedMemories: [
            {
              id: 'seed-1',
              title: 'Custom Seed',
              content: 'Mounted from external pack',
              category: 'fact',
              tags: ['pack'],
              pinned: true,
              source: 'user',
            },
          ],
        }),
        'utf8',
      )

      process.env.RHARNESS_PRIVATE_PACK_DIR = packDir
      resetPrivatePackCache()

      const seeds = defaultMemories()
      expect(seeds).toHaveLength(1)
      expect(seeds[0]?.title).toBe('Custom Seed')

      const srv = await startStandaloneServer({
        port: 0,
        host: '127.0.0.1',
        stateDir,
        liveAgents: false,
      })
      try {
        const res = await fetch(`${srv.url}/orchestrator/standalone/rhtoolkit/state`, {
          headers: { 'x-orchestrator-request': '1' },
        })
        expect(res.status).toBe(200)
        const body = (await res.json()) as { nodeHost: string; totalDownloadFiles: number }
        expect(body.nodeHost).toBe('mock-node')
        expect(body.totalDownloadFiles).toBe(7)
      } finally {
        await srv.stop()
      }
    } finally {
      mkdirSync(packDir, { recursive: true })
      rmSync(packDir, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 25_000)
})
