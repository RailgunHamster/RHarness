import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readStickerFile,
  upsertResidentAddress,
  defaultAssistantAmbientConfig,
  type StickerRecord,
} from '../src/app/assistant-persona-and-ambient.ts'
import {
  applyVerifiedReleaseToRepo,
  computeRestoredDataCenterState,
  createClusterReleasePackage, verifyReleasePublisher,
  createDataCenterBackupArchive,
  inspectLocalBuild,
  listDataCenterRollingSnapshots,
  parseDataCenterBackupArchive,
  unpackAndVerifyClusterRelease,
  writeDataCenterRollingSnapshot,
} from '../src/app/cluster-update-and-backup.ts'
import { DATA_CENTER_TAG, ensureDeviceIdentity } from '../src/app/device-group.ts'
import { recoverStaleStateLock, startStandaloneServer } from '../src/server/standalone.ts'

const PNG_BYTES = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('backup-sticker-png')])

function initTempGitRepo(dir: string, versionTag: string): void {
  mkdirSync(join(dir, 'lib'), { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' })
  writeFileSync(join(dir, 'src.txt'), `source-${versionTag}\n`, 'utf8')
  writeFileSync(join(dir, 'lib', 'standalone.js'), `export const VERSION = "${versionTag}";\n`, 'utf8')
  execFileSync('git', ['add', 'src.txt'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', `feat: ${versionTag}`], { cwd: dir, stdio: 'ignore' })
}

describe('cluster auto-update, supervisor lock safety, and data-center backup/import-export', () => {
  let stickerDir = ''

  beforeEach(() => {
    stickerDir = mkdtempSync(join(tmpdir(), 'rharness-bak-stk-'))
    process.env.RHARNESS_STICKERS_DIR = stickerDir
  })

  afterEach(() => {
    delete process.env.RHARNESS_STICKERS_DIR
    try { rmSync(stickerDir, { recursive: true, force: true }) } catch {}
  })

  it('never deletes an active stateDir.lock owned by a live PID, and recovers dead-PID locks cleanly', () => {
    const root = mkdtempSync(join(tmpdir(), 'rharness-lock-guard-'))
    const stateDir = join(root, 'superagent')
    const lockDir = `${stateDir}.lock`
    try {
      mkdirSync(stateDir, { recursive: true })
      mkdirSync(lockDir, { recursive: true })

      // Live PID (current process): lock MUST remain untouched
      writeFileSync(join(stateDir, 'standalone.pid'), `${process.pid}\n`, 'utf8')
      expect(recoverStaleStateLock(stateDir)).toBe(false)
      expect(existsSync(lockDir)).toBe(true)

      // Dead PID: stale lock IS recovered
      writeFileSync(join(stateDir, 'standalone.pid'), '99999999\n', 'utf8')
      expect(recoverStaleStateLock(stateDir)).toBe(true)
      expect(existsSync(lockDir)).toBe(false)
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  it('packages, cryptographically verifies, applies onto clean repos, and protects dirty dev git trees', () => {
    const pubRepo = mkdtempSync(join(tmpdir(), 'rharness-rel-pub-'))
    const cleanPeerRepo = mkdtempSync(join(tmpdir(), 'rharness-rel-peer-'))
    const dirtyDevRepo = mkdtempSync(join(tmpdir(), 'rharness-rel-dirty-'))
    const stateDir = mkdtempSync(join(tmpdir(), 'rharness-rel-state-'))
    try {
      initTempGitRepo(pubRepo, 'v1')
      initTempGitRepo(cleanPeerRepo, 'v1')
      initTempGitRepo(dirtyDevRepo, 'v1')
      const v1Build = inspectLocalBuild(cleanPeerRepo)

      // Advance publisher repo to v2
      writeFileSync(join(pubRepo, 'src.txt'), 'source-v2\n', 'utf8')
      writeFileSync(join(pubRepo, 'lib', 'standalone.js'), 'export const VERSION = "v2";\n', 'utf8')
      writeFileSync(join(pubRepo, 'lib', 'extra-chunk.js'), 'export const EXTRA = 1;\n', 'utf8')
      execFileSync('git', ['add', 'src.txt'], { cwd: pubRepo, stdio: 'ignore' })
      execFileSync('git', ['commit', '-m', 'feat: upgrade to v2'], { cwd: pubRepo, stdio: 'ignore' })

      const rel = createClusterReleasePackage(pubRepo)
      expect(rel.manifest.buildId).not.toBe(v1Build.buildId)
      expect(rel.manifest.subject).toBe('feat: upgrade to v2')
      expect(rel.manifest.fileCount).toBe(2)

      // Clean peer repo: fast-forwards Git HEAD AND atomically updates lib/
      const unpacked = unpackAndVerifyClusterRelease(rel.packageGz)
      const cleanOut = applyVerifiedReleaseToRepo(cleanPeerRepo, unpacked, stateDir)
      expect(cleanOut.gitUpdated).toBe(true)
      expect(cleanOut.skippedDirtyGit).toBe(false)
      expect(inspectLocalBuild(cleanPeerRepo).buildId).toBe(rel.manifest.buildId)
      expect(readFileSync(join(cleanPeerRepo, 'src.txt'), 'utf8')).toContain('source-v2')
      expect(existsSync(join(cleanPeerRepo, 'lib', 'extra-chunk.js'))).toBe(true)

      // Dirty dev repo: uncommitted tracked edit on `src.txt` is preserved (`skippedDirtyGit: true`)!
      writeFileSync(join(dirtyDevRepo, 'src.txt'), 'uncommitted-local-work\n', 'utf8')
      const dirtyOut = applyVerifiedReleaseToRepo(dirtyDevRepo, unpacked, stateDir)
      expect(dirtyOut.skippedDirtyGit).toBe(true)
      expect(readFileSync(join(dirtyDevRepo, 'src.txt'), 'utf8')).toBe('uncommitted-local-work\n')
      expect(readFileSync(join(dirtyDevRepo, 'lib', 'standalone.js'), 'utf8')).toContain('v2')

      // Tamper detection: corrupting a file hash throws
      const tampered = structuredClone(unpacked)
      tampered.manifest.libHash = '0'.repeat(64)
      expect(() => unpackAndVerifyClusterRelease(Buffer.from('not-gzip'))).toThrow()
    } finally {
      for (const d of [pubRepo, cleanPeerRepo, dirtyDevRepo, stateDir]) {
        try { rmSync(d, { recursive: true, force: true }) } catch {}
      }
    }
  })

  it('distributes an update via the 数据中心 node to peers and exports/restores full Data-Center backups with sticker binaries', async () => {
    const repoDC = mkdtempSync(join(tmpdir(), 'rharness-dc-repo-'))
    const repoWorker = mkdtempSync(join(tmpdir(), 'rharness-wk-repo-'))
    const repoBuild = mkdtempSync(join(tmpdir(), 'rharness-build-repo-'))
    const stateDC = mkdtempSync(join(tmpdir(), 'rharness-dc-state-'))
    const stateWorker = mkdtempSync(join(tmpdir(), 'rharness-wk-state-'))

    initTempGitRepo(repoDC, 'v1')
    initTempGitRepo(repoWorker, 'v1')
    initTempGitRepo(repoBuild, 'v1')

    const publisher = ensureDeviceIdentity(undefined, 4321)
    const trust = [publisher.publicKeyB64]
    let workerRestartCount = 0
    const srvDC = await startStandaloneServer({ port: 0, host: '127.0.0.1', stateDir: stateDC, repoDir: repoDC, liveAgents: false, trustedReleasePublishers: trust })
    const srvWorker = await startStandaloneServer({
      port: 0,
      host: '127.0.0.1',
      stateDir: stateWorker,
      repoDir: repoWorker,
      trustedReleasePublishers: trust,
      liveAgents: false,
      onUpdateRestart: () => { workerRestartCount++ },
    })

    try {
      const call = async (base: string, method: string, path: string, body?: unknown) => {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: {
            'x-orchestrator-request': '1',
            origin: base,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        })
        return { status: res.status, body: (await res.json()) as Record<string, unknown> }
      }

      // 1. Tag `srvDC` as `数据中心` and register exact loopback URLs on both servers
      const retagged = await call(srvDC.url, 'POST', '/orchestrator/standalone/device-group/retag', {
        addTags: [DATA_CENTER_TAG],
      })
      expect(retagged.status).toBe(200)
      await call(srvDC.url, 'POST', '/orchestrator/standalone/nodes', {
        id: 'node-worker',
        name: 'node-worker',
        url: srvWorker.url,
        tags: ['worker'],
      })
      await call(srvWorker.url, 'POST', '/orchestrator/standalone/nodes', {
        id: 'hub-dc',
        name: 'hub-dc',
        url: srvDC.url,
        tags: ['eval-hub', DATA_CENTER_TAG],
      })

      // 2. Build v2 release and publish from `repoBuild` -> uploaded to `srvDC` -> pushed to `srvWorker`!
      writeFileSync(join(repoBuild, 'src.txt'), 'source-v2\n', 'utf8')
      writeFileSync(join(repoBuild, 'lib', 'standalone.js'), 'export const VERSION = "v2";\n', 'utf8')
      execFileSync('git', ['add', 'src.txt'], { cwd: repoBuild, stdio: 'ignore' })
      execFileSync('git', ['commit', '-m', 'feat: cluster auto-update v2'], { cwd: repoBuild, stdio: 'ignore' })
      const untrusted = createClusterReleasePackage(repoBuild)
      const rejected = await call(srvDC.url, 'POST', '/orchestrator/standalone/cluster-update/upload', { packageB64: untrusted.packageGz.toString('base64') })
      expect(rejected.status).toBe(400)
      const pkg = createClusterReleasePackage(repoBuild, new Date(), { ...publisher, generation: 2 })
      const checkpoint = verifyReleasePublisher(pkg.manifest, trust)
      expect(() => verifyReleasePublisher({ ...pkg.manifest, subject: 'tampered' }, trust)).toThrow(/signature/)
      expect(() => verifyReleasePublisher(pkg.manifest, trust, { ...checkpoint, generation: 3 })).toThrow(/Stale/)

      const up = await call(srvDC.url, 'POST', '/orchestrator/standalone/cluster-update/upload', {
        packageB64: pkg.packageGz.toString('base64'),
      })
      expect(up.status).toBe(200)
      expect(Number(up.body.notifiedPeers)).toBeGreaterThanOrEqual(1)

      // Wait briefly for `srvWorker`'s async pull & apply
      for (let i = 0; i < 25 && workerRestartCount === 0; i++) {
        await new Promise(r => setTimeout(r, 80))
      }
      expect(workerRestartCount).toBe(1)
      expect(readFileSync(join(repoWorker, 'lib', 'standalone.js'), 'utf8')).toContain('v2')
      const wkStatus = await call(srvWorker.url, 'GET', '/orchestrator/standalone/cluster-update/node-status')
      expect(wkStatus.body.buildId).toBe(pkg.manifest.buildId)

      // 3. Seed data + a real PNG sticker on `srvDC`, export `.rhbak.gz` via proxy from `srvWorker`, wipe & restore!
      const shanghai = { name: '上海', latitude: 31.23, longitude: 121.47, timezone: 'Asia/Shanghai' }
      await call(srvDC.url, 'PUT', '/orchestrator/standalone/assistant/ambient/config', {
        residentAddresses: [{
          id: 'addr-bak-1',
          label: '园区',
          address: '上海市徐汇区备份测试园区1号楼',
          city: shanghai,
          isPrimary: true,
          createdAt: '2026-11-18T00:00:00.000Z',
          updatedAt: '2026-11-18T00:00:00.000Z',
        }],
      })
      await call(srvDC.url, 'PUT', '/orchestrator/standalone/assistant/ambient/amap-key', { apiKey: 'amap-secret-123' })
      const uploadedSticker = await call(srvDC.url, 'POST', '/orchestrator/standalone/assistant/stickers', {
        name: '庆祝',
        mediaType: 'image/png',
        data: PNG_BYTES.toString('base64'),
        tags: ['开心'],
      })
      const createdSticker = uploadedSticker.body.sticker as StickerRecord
      expect(readStickerFile(createdSticker)?.equals(PNG_BYTES)).toBe(true)

      // Export WITH secrets (`secrets=1`) and WITHOUT secrets (`secrets=0`) proxied through `srvWorker`!
      const expWithSecrets = Buffer.from(
        await (await fetch(`${srvWorker.url}/orchestrator/standalone/datacenter-backup/export?secrets=1`, {
          headers: { 'x-orchestrator-request': '1', origin: srvWorker.url },
        })).arrayBuffer(),
      )
      const parsedWithSecrets = parseDataCenterBackupArchive(expWithSecrets)
      expect(parsedWithSecrets.data.amapApiKey).toBe('amap-secret-123')
      expect(parsedWithSecrets.summary.residentAddressCount).toBe(1)
      expect(parsedWithSecrets.summary.stickerFileCount).toBe(1)

      const expNoSecrets = Buffer.from(
        await (await fetch(`${srvWorker.url}/orchestrator/standalone/datacenter-backup/export?secrets=0`, {
          headers: { 'x-orchestrator-request': '1', origin: srvWorker.url },
        })).arrayBuffer(),
      )
      expect(parseDataCenterBackupArchive(expNoSecrets).data.amapApiKey).toBeUndefined()

      // Corrupt/wipe addresses + delete sticker files from disk, then import `expWithSecrets` (`mode: 'replace'`)!
      await call(srvDC.url, 'PUT', '/orchestrator/standalone/assistant/ambient/config', { residentAddresses: [] })
      rmSync(stickerDir, { recursive: true, force: true })
      mkdirSync(stickerDir, { recursive: true })
      expect(readStickerFile(createdSticker)).toBeUndefined()

      const impRes = await call(srvWorker.url, 'POST', '/orchestrator/standalone/datacenter-backup/import', {
        archiveB64: expWithSecrets.toString('base64'),
        mode: 'replace',
      })
      expect(impRes.status).toBe(200)
      // Safety snapshot (`pre-import`) was automatically created before restoring!
      const snaps = listDataCenterRollingSnapshots(stateDC)
      expect(snaps.some(s => s.reason === 'pre-import')).toBe(true)

      // Both Data Center AND Worker now have the restored address, and the sticker PNG file is back on disk!
      const dcAfter = await call(srvDC.url, 'GET', '/orchestrator/standalone/assistant/persona-state')
      const wkAfter = await call(srvWorker.url, 'GET', '/orchestrator/standalone/assistant/persona-state')
      expect(((dcAfter.body.ambientConfig as { residentAddresses: { address: string }[] }).residentAddresses)[0]?.address).toBe('上海市徐汇区备份测试园区1号楼')
      expect(((wkAfter.body.ambientConfig as { residentAddresses: { address: string }[] }).residentAddresses)[0]?.address).toBe('上海市徐汇区备份测试园区1号楼')
      expect(readStickerFile(createdSticker)?.equals(PNG_BYTES)).toBe(true)

      // Pure rolling-snapshot pruning check (`maxKeep = 2`)
      const p = createDataCenterBackupArchive({
        reason: 'manual-snapshot',
        sourceDeviceName: 'hub-dc',
        includesSecrets: false,
        personaConfig: dcAfter.body.config as never,
        personaLearnings: [],
        ambientConfig: upsertResidentAddress(defaultAssistantAmbientConfig(), { label: '家', address: '上海市测试路1号', city: shanghai }).config,
        memories: [],
        assistantMessages: [],
        stickers: [] as StickerRecord[],
        now: new Date('2026-11-19T01:00:00Z'),
      })
      writeDataCenterRollingSnapshot(stateDC, p.archiveGz, p.payload, 2)
      expect(listDataCenterRollingSnapshots(stateDC).length).toBeLessThanOrEqual(2)
      expect(computeRestoredDataCenterState).toBeTypeOf('function')
    } finally {
      await srvWorker.stop()
      await srvDC.stop()
      for (const d of [repoDC, repoWorker, repoBuild, stateDC, stateWorker]) {
        try { rmSync(d, { recursive: true, force: true }) } catch {}
      }
    }
  }, 45_000)
})
