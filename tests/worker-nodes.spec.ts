import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { startStandaloneServer } from '../src/server/standalone.ts'
import { defaultModelProfilesConfig, resolveEffectiveModelProfile } from '../src/app/model-profiles.ts'
import { selectWorkerNode, syncRemoteNodeGitBranch, type WorkerNodeRecord } from '../src/app/worker-nodes.ts'

function git(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe', windowsHide: true })
}

describe('distributed LAN worker nodes and P2P Git fast-forward merge', () => {
  it('selects the best online worker node by explicit ID, message hint, or capability tags', () => {
    const nodes: WorkerNodeRecord[] = [
      { id: 'local', name: 'claw-hub', url: 'local', tags: ['linux', 'always-on'], status: 'online', lastSeenAt: '' },
      { id: 'win-pc', name: '主力开发机', url: 'http://192.168.1.20:4318', tags: ['windows', 'heavy-coding', 'chrome-qa', 'preferred'], status: 'online', lastSeenAt: '' },
      { id: 'gpu-box', name: 'GPU服务器', url: 'http://192.168.1.30:4318', tags: ['cuda', 'training'], status: 'online', lastSeenAt: '' },
    ]
    expect(selectWorkerNode(nodes, 'gpu-box', 'run anything').id).toBe('gpu-box')
    expect(selectWorkerNode(nodes, undefined, '请用 cuda 跑一下训练').id).toBe('gpu-box')
    expect(selectWorkerNode(nodes, undefined, '帮我写一个新模块').id).toBe('win-pc')

    const repoNodes: WorkerNodeRecord[] = [
      { id: 'local', name: '本机 (dev-box)', hostname: 'dev-box', url: 'local', gitUrl: '/srv/repo-a', tags: ['local', 'windows', 'default', 'heavy-coding'], status: 'online', lastSeenAt: '' },
      { id: 'hub', name: 'hub', hostname: 'SRV-HUB-01', url: 'http://192.168.1.50:4318', gitUrl: '/opt/hub-repo', tags: ['windows', 'always-on'], status: 'online', lastSeenAt: '' },
    ]
    // Context mentions repository path or hostname on another machine -> selects that machine
    expect(selectWorkerNode(repoNodes, undefined, '任务仓库在 /opt/hub-repo，请去排查').id).toBe('hub')
    expect(selectWorkerNode(repoNodes, undefined, '目标机器是 SRV-HUB-01').id).toBe('hub')
    // Substring inside a compound word ("GitHub") does not false-match node id "hub"
    expect(selectWorkerNode(repoNodes, undefined, '查看 GitHub Actions 状态').id).toBe('local')
  })

  it('fetches a remote worker node Git branch directly and fast-forward merges it into the Hub main branch', () => {
    const root = mkdtempSync(join(tmpdir(), 'rharness-dist-git-'))
    const hubRepo = join(root, 'hub-repo')
    const workerRepo = join(root, 'worker-repo')
    try {
      git(root, ['init', '-b', 'main', hubRepo])
      git(hubRepo, ['config', 'user.name', 'Hub'])
      git(hubRepo, ['config', 'user.email', 'hub@example.com'])
      writeFileSync(join(hubRepo, 'app.txt'), 'v1\n', 'utf8')
      git(hubRepo, ['add', 'app.txt'])
      git(hubRepo, ['commit', '-m', 'init'])

      // Clone hubRepo to simulate a second LAN machine's repository
      git(root, ['clone', hubRepo, workerRepo])
      git(workerRepo, ['config', 'user.name', 'WorkerNode'])
      git(workerRepo, ['config', 'user.email', 'worker@example.com'])
      git(workerRepo, ['checkout', '-b', 'agent/distributed-task'])
      writeFileSync(join(workerRepo, 'app.txt'), 'v2-from-remote-worker\n', 'utf8')
      git(workerRepo, ['add', 'app.txt'])
      git(workerRepo, ['commit', '-m', 'feat: update from remote LAN worker'])

      // Hub directly fetches from workerRepo and fast-forward merges into main
      const syncResult = syncRemoteNodeGitBranch({
        hubRepoRoot: hubRepo,
        remoteGitSource: workerRepo.replaceAll('\\', '/'),
        branch: 'agent/distributed-task',
        title: 'Distributed task',
      })
      expect(syncResult.merged).toBe(true)
      expect(readFileSync(join(hubRepo, 'app.txt'), 'utf8').trim()).toBe('v2-from-remote-worker')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 45_000)

  it('dispatches a routed Ticket from the Hub server to a remote LAN Worker Node server and proxies orchestrator_report back', async () => {
    const hubDir = mkdtempSync(join(tmpdir(), 'rharness-hub-'))
    const workerDir = mkdtempSync(join(tmpdir(), 'rharness-worker-'))
    let remoteExecuted = false

    const workerServer = await startStandaloneServer({
      port: 0,
      host: '127.0.0.1',
      stateDir: workerDir,
      liveAgents: false,
      driver: async req => {
        remoteExecuted = true
        const reportTool = req.tools.get('orchestrator_report')
        if (reportTool) {
          await reportTool.execute(
            { state: 'ready', summary: 'Completed on remote LAN worker node win-pc.' },
            { signal: req.signal },
          )
        }
        return 'Remote worker finished.'
      },
    })

    const hubServer = await startStandaloneServer({
      port: 0,
      host: '127.0.0.1',
      stateDir: hubDir,
      liveAgents: false,
    })

    try {
      const api = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(`${hubServer.url}${path}`, {
          method,
          headers: {
            host: `127.0.0.1:${hubServer.port}`,
            'x-orchestrator-request': '1',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        })
        return { status: res.status, body: await res.json() as Record<string, unknown> }
      }

      // 1. Register the remote worker node on the Hub
      const reg = await api('POST', '/orchestrator/standalone/nodes', {
        id: 'win-pc',
        name: '主力开发台式机',
        url: workerServer.url,
        tags: ['heavy-coding', 'windows', 'preferred'],
      })
      expect(reg.status).toBe(200)

      // 2. Post a panel message and route it to `win-pc` via `orchestrator_route`
      const msg = await api('POST', '/orchestrator/standalone/panel/messages', {
        conversation: 'main',
        sender: 'operator',
        text: '在主力机上实现分布式节点功能',
      })
      const triggerId = String(msg.body.id)

      const state = await api('GET', '/orchestrator/api/state')
      const masterId = String(state.body.masterId)
      const routed = await api('POST', `/orchestrator/standalone/sessions/${encodeURIComponent(masterId)}/tool`, {
        name: 'orchestrator_route',
        args: {
          decisions: [{
            kind: 'accept',
            trigger_id: triggerId,
            title: '实现分布式节点功能',
            worktree_name: 'dist-node-test',
            acknowledgement: '已派发给主力开发台式机执行。',
            worker_node: 'win-pc',
          }],
        },
      })
      expect(routed.status).toBe(200)

      await hubServer.runtime.idle()
      await vi.waitFor(() => expect(remoteExecuted).toBe(true), { timeout: 10_000 })
      await hubServer.runtime.idle()

      await vi.waitFor(
        async () => {
          const ended = await api('GET', '/orchestrator/api/tickets?state=ended')
          const items = ended.body.items as { id: string; summary: string }[]
          expect(items).toHaveLength(1)
          expect(items[0]?.summary).toContain('Completed on remote LAN worker node win-pc.')
        },
        { timeout: 10_000 },
      )
    } finally {
      await hubServer.stop()
      await workerServer.stop()
      rmSync(hubDir, { recursive: true, force: true })
      rmSync(workerDir, { recursive: true, force: true })
    }
  }, 45_000)

  it('pairs machines via RHFiles-style ECDSA P-256 one-use invitation URI, resolves per-role N-slot time schedules, and operates the first-class Memory plugin', async () => {
    const cfg = defaultModelProfilesConfig()
    // Enable the 3 time slots on profile-1's executor role
    cfg.profiles[0]!.executor.timeSlots = cfg.profiles[0]!.executor.timeSlots.map(s => ({ ...s, enabled: true }))
    // Monday 2026-11-09 10:30 is a workday morning peak slot (09:30 - 12:00 -> deepseek-v4-pro)
    const mondayMorning = new Date('2026-11-09T10:30:00')
    expect(resolveEffectiveModelProfile(cfg, {}, mondayMorning).executorModel.model).toBe('deepseek-v4-pro')
    // Monday 2026-11-09 15:00 is a workday afternoon peak slot (14:00 - 18:30 -> deepseek-v4-pro)
    const mondayAfternoon = new Date('2026-11-09T15:00:00')
    expect(resolveEffectiveModelProfile(cfg, {}, mondayAfternoon).executorModel.model).toBe('deepseek-v4-pro')
    // Sunday 2026-11-08 15:00 is a weekend/holiday, so workday-only peak slots are skipped and default model is used
    const sundayAfternoon = new Date('2026-11-08T15:00:00')
    expect(resolveEffectiveModelProfile(cfg, {}, sundayAfternoon).executorModel.model).toBe('gpt-6.1-sol')
    // When dayModeOverride is 'force-workday', Sunday 15:00 matches the workday peak slot
    expect(resolveEffectiveModelProfile({ ...cfg, dayModeOverride: 'force-workday' }, {}, sundayAfternoon).executorModel.model).toBe('deepseek-v4-pro')
    // 23:30 is night off-peak slot (18:30 - 09:30 -> gpt-6.1-sol)
    const night = new Date('2026-11-09T23:30:00')
    expect(resolveEffectiveModelProfile(cfg, {}, night).executorModel.model).toBe('gpt-6.1-sol')

    const dirA = mkdtempSync(join(tmpdir(), 'rharness-dg-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'rharness-dg-b-'))
    const srvA = await startStandaloneServer({ port: 0, host: '127.0.0.1', stateDir: dirA, liveAgents: false })
    const srvB = await startStandaloneServer({ port: 0, host: '127.0.0.1', stateDir: dirB, liveAgents: false })
    try {
      const call = async (base: string, method: string, path: string, body?: unknown) => {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { 'x-orchestrator-request': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        })
        return { status: res.status, body: await res.json() as Record<string, unknown> }
      }

      // Create group on A (`claw`) and generate a one-use invitation URI
      await call(srvA.url, 'POST', '/orchestrator/standalone/device-group/create', {
        deviceName: 'claw',
        groupName: 'RHarness 内网设备组',
        tags: ['eval-hub', 'always-on'],
      })
      const invite = await call(srvA.url, 'POST', '/orchestrator/standalone/device-group/invite', { canInvite: true })
      expect(invite.status).toBe(200)
      const rawUri = String(invite.body.uri)
      const decoded = JSON.parse(Buffer.from(rawUri.slice('rharness-group-invite:v1:'.length), 'base64url').toString('utf8')) as Record<string, unknown>
      decoded.endpoints = [srvA.url]
      const testUri = `rharness-group-invite:v1:${Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')}`

      // Redeem on B (`worker-b`)
      const joined = await call(srvB.url, 'POST', '/orchestrator/standalone/device-group/join', {
        uri: testUri,
        deviceName: 'worker-b',
        tags: ['worker', 'heavy-coding'],
      })
      expect(joined.status).toBe(200)
      const nodesOnB = joined.body.nodes as { id: string; endpoints?: string[] }[]
      expect(nodesOnB.map(n => n.id)).toContain('claw')

      const nodesOnA = await call(srvA.url, 'GET', '/orchestrator/standalone/nodes')
      expect((nodesOnA.body.nodes as { id: string }[]).map(n => n.id)).toContain('worker-b')

      // Switch model profile on A
      const profSwitch = await call(srvA.url, 'PUT', '/orchestrator/standalone/model-profiles', {
        activeProfileId: 'profile-2',
      })
      expect(profSwitch.status).toBe(200)
      expect((profSwitch.body.activeProfile as { id: string }).id).toBe('profile-2')

      // Exercise the First-Class Memory Plugin via HTTP and via Agent Session tools
      const memAdd = await call(srvA.url, 'POST', '/orchestrator/standalone/memories', {
        title: '代码语言偏好',
        content: '始终使用中文汇报总结，TypeScript 严格模式。',
        category: 'preference',
        tags: ['style', 'ts'],
        pinned: true,
      })
      expect(memAdd.status).toBe(200)

      // Verify that Engineering Eval (`masterId`) is 100% pure (no `memory_*` tools polluting dsh-superagent Eval)
      const stateA = await call(srvA.url, 'GET', '/orchestrator/api/state')
      const masterId = String(stateA.body.masterId)
      const masterSession = await call(srvA.url, 'GET', `/orchestrator/standalone/sessions/${encodeURIComponent(masterId)}`)
      const masterToolNames = ((masterSession.body.tools as { name: string }[]) ?? []).map(t => t.name)
      expect(masterToolNames).not.toContain('memory_search')
      expect(masterToolNames).toContain('orchestrator_route')

      // Post a message to the Claw Personal Assistant (`claw-assistant-main`), which mounts `memory_*` and `assistant_forward_to_engineering`
      const casualMsg = await call(srvA.url, 'POST', '/orchestrator/standalone/assistant/messages', {
        text: '帮我记一下明天下午三点开周会，顺便看看工程引擎收不收日常会议备忘',
        forwardToEngineering: true,
        contextNote: '用户尝试把会议备忘递交工程引擎',
      })
      expect(casualMsg.status).toBe(200)
      const casualHandoff = (casualMsg.body.handoff as { triggerId: string; originalText: string; state: string })
      expect(casualHandoff.originalText).toBe('帮我记一下明天下午三点开周会，顺便看看工程引擎收不收日常会议备忘')
      expect(casualHandoff.state).toBe('evaluating')

      // Verify `memory_search` and `memory_chat_search` work on `claw-assistant-main`
      const toolSearch = await call(srvA.url, 'POST', '/orchestrator/standalone/sessions/claw-assistant-main/tool', {
        name: 'memory_search',
        args: { query: 'TypeScript' },
      })
      expect(toolSearch.status).toBe(200)
      expect((toolSearch.body.result as { count: number }).count).toBeGreaterThanOrEqual(1)

      // Start a new context window (`reset-window`) and verify earlier chat messages remain searchable via `lcm_grep` (which superseded `memory_chat_search`)
      const ctxReset = await call(srvA.url, 'POST', '/orchestrator/standalone/assistant/context', {
        action: 'reset-window',
      })
      expect(ctxReset.status).toBe(200)
      expect((ctxReset.body.contextConfig as { contextResetAt?: string }).contextResetAt).toBeTruthy()

      const chatArchiveSearch = await call(srvA.url, 'POST', '/orchestrator/standalone/sessions/claw-assistant-main/tool', {
        name: 'lcm_grep',
        args: { query: '周会' },
      })
      expect(chatArchiveSearch.status).toBe(200)
      expect((chatArchiveSearch.body.result as { matchedRawCount: number }).matchedRawCount).toBe(1)

      // Engineering Eval exercises its independent refusal right (`ignore`) on the non-engineering handoff
      const refuseRes = await call(srvA.url, 'POST', '/orchestrator/standalone/assistant/eval-decision', {
        triggerId: casualHandoff.triggerId,
        decision: 'ignore',
        reason: '日常周会备忘不属于代码工程改动，工程引擎拒收并退回个人助理处理',
      })
      expect(refuseRes.status).toBe(200)
      const msgsAfterRefuse = refuseRes.body.messages as { id: string; handoff?: { state: string; refusalReason?: string } }[]
      expect(msgsAfterRefuse[0]?.handoff?.state).toBe('rejected')
      expect(msgsAfterRefuse[0]?.handoff?.refusalReason).toContain('工程引擎拒收')

      // Now send a user message WITH A SCREENSHOT IMAGE to the Personal Assistant, and let the Assistant forward it with a brief summary
      const imageBuf = Buffer.alloc(33)
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(imageBuf)
      imageBuf.write('IHDR', 12, 'ascii')
      imageBuf.writeUInt32BE(1, 16)
      imageBuf.writeUInt32BE(1, 20)
      const tinyPng = imageBuf.toString('base64')
      const engMsg = await call(srvA.url, 'POST', '/orchestrator/standalone/assistant/messages', {
        text: '请看这张截图，修复 src/app/device-group.ts 在 IPv6 链路本地地址下的过滤逻辑并补齐单测',
        content: [
          { type: 'text', text: '请看这张截图，修复 src/app/device-group.ts 在 IPv6 链路本地地址下的过滤逻辑并补齐单测' },
          { type: 'image', mediaType: 'image/png', data: tinyPng, name: 'ipv6-bug.png' },
        ],
      })
      expect(engMsg.status).toBe(200)
      const savedEngMsg = engMsg.body.message as { id: string }

      // Assistant calls `assistant_forward_to_engineering` with its brief summary; bridge automatically attaches verbatim text + image
      const forwardToolRes = await call(srvA.url, 'POST', '/orchestrator/standalone/sessions/claw-assistant-main/tool', {
        name: 'assistant_forward_to_engineering',
        args: {
          summary: '修复 device-group.ts 的 IPv6 链路本地地址过滤逻辑并补测试',
          message_ids: [savedEngMsg.id],
        },
      })
      expect(forwardToolRes.status).toBe(200)
      const engHandoff = (forwardToolRes.body.result as { handoff: { triggerId: string; summary: string; originalText: string; imageCount: number } }).handoff
      expect(engHandoff.summary).toBe('修复 device-group.ts 的 IPv6 链路本地地址过滤逻辑并补测试')
      expect(engHandoff.originalText).toBe('请看这张截图，修复 src/app/device-group.ts 在 IPv6 链路本地地址下的过滤逻辑并补齐单测')
      expect(engHandoff.imageCount).toBe(1)

      // Verify Engineering Chat (`工程对话`, conversation = 'main') received the summary, verbatim text, AND original image
      const panelMain = await call(srvA.url, 'GET', '/orchestrator/standalone/panel/messages?conversation=main')
      expect(panelMain.status).toBe(200)
      const panelMsgs = panelMain.body.messages as { text: string; content?: { type: string; data?: string; name?: string }[] }[]
      const deliveredToEng = panelMsgs.at(-1)!
      expect(deliveredToEng.text).toContain('【个人助理转交总结】')
      expect(deliveredToEng.text).toContain('修复 device-group.ts 的 IPv6 链路本地地址过滤逻辑并补测试')
      expect(deliveredToEng.text).toContain('请看这张截图，修复 src/app/device-group.ts 在 IPv6 链路本地地址下的过滤逻辑并补齐单测')
      expect(deliveredToEng.content?.some(c => c.type === 'image' && c.name === 'ipv6-bug.png')).toBe(true)

      const acceptRes = await call(srvA.url, 'POST', '/orchestrator/standalone/assistant/eval-decision', {
        triggerId: engHandoff.triggerId,
        decision: 'accept',
        title: '修复 IPv6 链路本地地址过滤逻辑',
      })
      expect(acceptRes.status).toBe(200)
      const msgsAfterAccept = acceptRes.body.messages as { id: string; handoff?: { triggerId?: string; state: string; ticketId?: string; originalText: string; imageCount?: number } }[]
      const acceptedItem = msgsAfterAccept.find(m => m.handoff?.triggerId === engHandoff.triggerId)
      expect(acceptedItem?.handoff?.state).toBe('accepted')
      expect(acceptedItem?.handoff?.ticketId).toBeTruthy()
      expect(acceptedItem?.handoff?.imageCount).toBe(1)
      expect(acceptedItem?.handoff?.originalText).toBe('请看这张截图，修复 src/app/device-group.ts 在 IPv6 链路本地地址下的过滤逻辑并补齐单测')

      // Delete a single assistant message, then clear the remaining chat history (both archived to 30-day protected assistant-chat-backups/)
      const delOne = await call(srvA.url, 'DELETE', `/orchestrator/standalone/assistant/messages/${encodeURIComponent(savedEngMsg.id)}`)
      expect(delOne.status).toBe(200)
      expect(delOne.body.deleted).toBe(true)
      expect((delOne.body.chatBackups as { id: string }[]).length).toBe(1)

      const clearChatRes = await call(srvA.url, 'POST', '/orchestrator/standalone/assistant/clear', {})
      expect(clearChatRes.status).toBe(200)
      expect(clearChatRes.body.messages).toEqual([])
      const chatBackups = clearChatRes.body.chatBackups as { id: string; count: number }[]
      expect(chatBackups.length).toBe(2)
      const clearedDetail = await call(srvA.url, 'GET', '/orchestrator/standalone/sessions/claw-assistant-main')
      expect(clearedDetail.body.events).toEqual([])

      // Attempting to manually delete a chat backup within 30 days is forbidden (403)
      const forbiddenChatDel = await call(srvA.url, 'DELETE', `/orchestrator/standalone/assistant/backups/${encodeURIComponent(chatBackups[0]!.id)}`)
      expect(forbiddenChatDel.status).toBe(403)

      // Restoring a chat backup within 30 days recovers the messages immediately
      const restoredChat = await call(srvA.url, 'POST', `/orchestrator/standalone/assistant/backups/${encodeURIComponent(chatBackups[0]!.id)}/restore`, {})
      expect(restoredChat.status).toBe(200)
      expect((restoredChat.body.messages as { id: string }[]).length).toBeGreaterThanOrEqual(1)

      // Clearing long-term memories requires 2-step confirmation, archives to memory-backups/ for 30 days, refuses manual deletion within 30 days, and supports 1-click restore
      const unconfirmedClear = await call(srvA.url, 'POST', '/orchestrator/standalone/memories/clear', { confirmStep: 1 })
      expect(unconfirmedClear.status).toBe(400)

      const confirmedClear = await call(srvA.url, 'POST', '/orchestrator/standalone/memories/clear', {
        confirmStep: 2,
        confirmed: true,
      })
      expect(confirmedClear.status).toBe(200)
      expect(confirmedClear.body.memories).toEqual([])
      const backups = confirmedClear.body.memoryBackups as { id: string; count: number; expiresAt: string }[]
      expect(backups.length).toBeGreaterThanOrEqual(1)
      const backupId = backups[0]!.id

      // Attempting to manually delete a backup within the 30-day regret window is strictly forbidden (403)
      const forbiddenDel = await call(srvA.url, 'DELETE', `/orchestrator/standalone/memories/backups/${encodeURIComponent(backupId)}`)
      expect(forbiddenDel.status).toBe(403)

      // Restoring the backup within 30 days recovers the memories immediately
      const restored = await call(srvA.url, 'POST', `/orchestrator/standalone/memories/backups/${encodeURIComponent(backupId)}/restore`, {})
      expect(restored.status).toBe(200)
      expect((restored.body.memories as { title: string }[]).some(m => m.title === '代码语言偏好')).toBe(true)

      // Exercise interactive decision cards (`PendingUserQuestion`) for Claw (`assistant_ask_user`) and Worker (`human_action`)
      const askToolRes = await call(srvA.url, 'POST', '/orchestrator/standalone/sessions/claw-assistant-main/tool', {
        name: 'assistant_ask_user',
        args: {
          title: '确认迁移批次',
          question: '请问首批迁移是否仅开启只读观察？',
          options: ['方案 A：仅开启只读观察', '方案 B：同时开启自动提醒'],
        },
      })
      expect(askToolRes.status).toBe(200)
      const qId = String((askToolRes.body.result as { questionId: string }).questionId)

      await srvA.runtime.idle()
      const workerTicketId = String(acceptedItem?.handoff?.ticketId)
      const workerReportRes = await call(srvA.url, 'POST', `/orchestrator/standalone/sessions/worker-${encodeURIComponent(workerTicketId)}/tool`, {
        name: 'orchestrator_report',
        args: {
          state: 'progress',
          summary: '正在核对 IPv6 过滤规则',
          human_action: '是否同时过滤 fe80::/10 以外的 ULA 地址？\n1. 仅过滤 fe80::/10\n2. 同时过滤 fc00::/7',
        },
      })
      expect(workerReportRes.status).toBe(200)

      const sessionsWithQs = await call(srvA.url, 'GET', '/orchestrator/standalone/sessions')
      const pendingQs = sessionsWithQs.body.pendingQuestions as { id: string; role: string; options?: string[]; ticketId?: string }[]
      expect(pendingQs.some(q => q.id === qId && q.role === 'claw')).toBe(true)
      const workerQ = pendingQs.find(q => q.role === 'worker' && q.ticketId === workerTicketId)
      expect(workerQ).toBeDefined()
      expect(workerQ?.options).toEqual(['1. 仅过滤 fe80::/10', '2. 同时过滤 fc00::/7'])

      // Answer both questions via `/orchestrator/standalone/questions/answer`
      const ansClaw = await call(srvA.url, 'POST', '/orchestrator/standalone/questions/answer', {
        id: qId,
        role: 'claw',
        answer: '方案 A：仅开启只读观察',
      })
      expect(ansClaw.status).toBe(200)

      const ansWorker = await call(srvA.url, 'POST', '/orchestrator/standalone/questions/answer', {
        id: workerQ!.id,
        role: 'worker',
        ticketId: workerTicketId,
        answer: '1. 仅过滤 fe80::/10',
      })
      expect(ansWorker.status).toBe(200)
      expect((ansWorker.body.pendingQuestions as { id: string }[]).some(q => q.id === workerQ!.id)).toBe(false)

      await srvA.runtime.idle()
    } finally {
      await srvA.stop()
      await srvB.stop()
      try { rmSync(dirA, { recursive: true, force: true }) } catch {}
      try { rmSync(dirB, { recursive: true, force: true }) } catch {}
    }
  }, 25_000)
})
