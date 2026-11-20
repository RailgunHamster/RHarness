import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceRecords, draftInput, workspaceTools } from '../src/app/workspace-records.ts'

const stores: WorkspaceRecords[] = []
function store() { const records = new WorkspaceRecords(':memory:'); stores.push(records); return records }
afterEach(() => { for (const records of stores.splice(0)) records.close() })

it('preserves historical versions, rejects stale and cross-session edits, and patches unique text literally', async () => {
  const records = store()
  const input = draftInput.parse({ title: 'Plan', text: 'one two', base: 0 })
  const first = records.save(input, 'worker-A')
  const tool = workspaceTools(() => records, 'worker-A').find(t => t.name === 'workspace_edit')!
  await tool.execute({ id: first.id, base: 1, before: 'two', after: '$& three' }, { signal: AbortSignal.timeout(1000) })
  expect(records.get(first.id)?.text).toBe('one $& three')
  expect(records.get(first.id, 1)?.text).toBe('one two')
  expect(() => records.save({ ...input, id: first.id, base: 1 }, 'worker-A')).toThrow(/revision/)
  expect(() => records.save({ ...input, id: first.id, base: 2 }, 'worker-B')).toThrow(/Unknown/)
  expect(records.list('worker-B')).toEqual([])
})

it('binds an approval to the displayed revision, account and payload before starting a single side effect', async () => {
  const records = store()
  const action = records.propose('assistant', 'calendar_add', 'owner-1', { summary: 'Meeting' })
  const perform = vi.fn(async () => ({ ok: true }))
  const [a,b] = await Promise.allSettled([records.decide(action.id, 1, true, perform), records.decide(action.id, 1, true, perform)])
  expect([a.status,b.status]).toEqual(['fulfilled','rejected'])
  expect(perform).toHaveBeenCalledExactlyOnceWith(action)
  expect(records.get(action.id)?.state).toBe('done')
  expect(records.get(action.id, 1)?.target).toBe('owner-1')
  const next = records.propose('assistant', 'todo_write', 'owner-2', {})
  expect((await records.decide(next.id, 1, true, async () => { throw new Error('response lost') })).state).toBe('uncertain')
  await expect(records.decide(next.id, 1, true, perform)).rejects.toThrow(/reviewed/)
})

it('orders shared-endpoint turns, removes a cancelled waiter and allows another endpoint to proceed', async () => {
  const { ModelQueue } = await import('../src/app/model-queue.ts')
  const gate = new ModelQueue(1)
  const signal = new AbortController().signal
  let release!: () => void
  const busy = gate.run('shared', false, signal, () => new Promise<void>(resolve => { release = resolve }))
  await Promise.resolve()
  const order: string[] = []
  const work = gate.run('shared', false, signal, async () => { order.push('worker') })
  const chat = gate.run('shared', true, signal, async () => { order.push('assistant') })
  const controller = new AbortController()
  const cancelled = gate.run('shared', true, controller.signal, async () => { order.push('cancelled') })
  controller.abort()
  await expect(cancelled).rejects.toThrow()
  await gate.run('other', false, signal, async () => { order.push('independent') })
  release()
  await Promise.all([busy,work,chat])
  expect(order).toEqual(['independent','assistant','worker'])
})

it('requires a fresh observation after the browser is handed back', async () => {
  const { BrowserInputLease } = await import('../src/app/research-and-ux-plugins.ts')
  const lease = new BrowserInputLease()
  const old = lease.observation()
  lease.setPaused(true)
  await expect(lease.run('a', async () => {})).rejects.toThrow(/user/)
  lease.setPaused(false); lease.record('a', old)
  await expect(lease.run('a', async () => {})).rejects.toThrow(/Refresh/)
  lease.record('a', lease.observation())
  expect(await lease.run('a', async () => 'ok')).toBe('ok')
})

it('separates same-title memories by scope, records provenance and preserves supersession', async () => {
  const { saveMemoryEntry, visibleMemory, replaceMemoryEntry } = await import('../src/app/memory-plugin.ts')
  const common = { title: 'Location', content: 'Example' }
  const personal = saveMemoryEntry([], { ...common, scope: 'personal' })
  const project = saveMemoryEntry(personal.list, { ...common, scope: 'project', scopeKey: 'p', provenance: { reference: 'worker-1', verifiedAt: new Date().toISOString() } })
  const audience = { role: 'worker' as const, project: 'p', device: 'b' }
  expect(project.list.filter(entry => visibleMemory(entry, audience))).toEqual([project.entry])
  const replacement = replaceMemoryEntry(project.list, project.entry.id, { content: 'Revised' })
  expect(replacement.entry).toMatchObject({ supersedes: project.entry.id, scopeKey: 'p', provenance: project.entry.provenance })
})

it('keeps immutable binary revisions and validates bytes on backup restore', async () => {
  const { inspectReportFile } = await import('../src/app/report-files.ts')
  const records = store()
  const first = Buffer.from('# First report'), second = Buffer.from('# Second report')
  const saved = records.publishFile('worker-1', inspectReportFile('report.md', first), first, 'verified')
  const revised = records.publishFile('worker-1', inspectReportFile('report.md', second), second, 'verified')
  expect(revised).toMatchObject({ id: saved.id, revision: 2 })
  expect(records.publishFile('worker-1', inspectReportFile('report.md', second), second, 'verified').revision).toBe(2)
  const pending = records.propose('assistant','todo_write','test',{})
  const restored = store()
  restored.restore(records.archive(),'replace')
  expect(restored.download(saved.id,1)?.bytes.equals(first)).toBe(true)
  expect(restored.get(pending.id)?.state).toBe('dismissed')
  const damaged = records.archive()
  damaged.files[0]!.data = Buffer.from('other').toString('base64')
  const empty = store()
  expect(() => empty.restore(damaged,'merge')).toThrow(/digest/)
  expect(empty.list()).toEqual([])
  expect(() => inspectReportFile('invalid.xlsx', first)).toThrow(/ZIP/)
  expect(() => inspectReportFile('invalid.pdf', first)).toThrow(/PDF/)
})

it('preserves original meeting timestamps and only proposes a quoted follow-up against that revision', async () => {
  const { transcriptDocument } = await import('../src/app/workspace-records.ts')
  const records = store()
  const doc = records.save(transcriptDocument('call.wav','00:00:12 Alice: review the draft'), 'assistant')
  const tool = workspaceTools(() => records,'assistant').find(t => t.name === 'meeting_propose_followup')!
  const req = { id: doc.id, revision: 1, excerpt: '00:00:12 Alice: review the draft', request: 'Review' }
  const exec = { signal: AbortSignal.timeout(500) }
  expect(await tool.execute(req,exec)).toMatchObject({ state: 'review', target: 'panel/engineering' })
  await expect(tool.execute({ ...req, excerpt: 'unknown' },exec)).rejects.toThrow(/excerpt/)
})

it('coalesces missed scheduled ticks, retains machine authorship, and uses the same ID on replay', async () => {
  const { consumeDueReviews, saveReview, reviewInput } = await import('../src/app/scheduled-reviews.ts')
  const date = '2026-01-01T00:00:00.000Z'
  const reviews = saveReview([], reviewInput.parse({ prompt: 'Check the report', mode: 'silent', due: date, intervalMinutes: 60 }))
  const now = Date.parse(date) + 5.5 * 3600_000
  const receive = vi.fn()
  const next = consumeDueReviews(reviews,now,receive)
  expect(receive).toHaveBeenCalledTimes(1)
  expect(receive.mock.calls[0]![0]).toMatchObject({ human: false, meta: { requestedMode: 'silent' } })
  expect(receive.mock.calls[0]![0]).not.toHaveProperty('channel')
  consumeDueReviews(reviews,now,receive)
  expect(receive.mock.calls[1]![0].id).toBe(next[0]?.lastTrigger)
  expect(consumeDueReviews(next,now,receive)).toBe(next)
})

it('binds a signed connector command to a trusted issuer, a destination and exact arguments', async () => {
  const { ensureDeviceIdentity, signOperation, validOperation } = await import('../src/app/device-group.ts')
  const issuer = ensureDeviceIdentity(undefined, 0)
  const value = ['calendar_add','local-account',{ summary: 'test' }]
  const proof = signOperation(issuer, 'review:1', 'connector-write', value)
  expect(validOperation(proof,'connector-write',value,[issuer.publicKeyB64])).toBe(true)
  expect(validOperation(proof,'connector-write',value,[])).toBe(false)
  expect(validOperation(proof,'connector-write',['another account'],[issuer.publicKeyB64])).toBe(false)
  const records = store(), perform = vi.fn(async () => ({ ok: true }))
  await Promise.all([records.performOnce('issuer/key','hash',perform), records.performOnce('issuer/key','hash',perform)])
  expect(perform).toHaveBeenCalledTimes(1)
  expect(records.operation('issuer/key','hash')?.state).toBe('done')
})

it('discovers a local model and completes a tool roundtrip through its actual HTTP driver', async () => {
  const { createServer } = await import('node:http')
  const { discoverOllama, runOllamaTurn } = await import('../src/app/ollama-driver.ts')
  const { probeModel } = await import('../src/app/model-probe.ts')
  const calls: string[] = []
  const endpoint = createServer(async (req,res) => {
    res.setHeader('content-type','application/json')
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'fixture' }] })); return }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const message = body.messages.at(-1)
    calls.push(message.role)
    res.end(JSON.stringify({ message: message.role === 'tool' ? { role: 'assistant', content: JSON.parse(message.content).token }
      : { role: 'assistant', content: '', tool_calls: [{ function: { name: 'probe_echo', arguments: {} } }] } }))
  })
  await new Promise<void>(resolve => endpoint.listen(0,'127.0.0.1',resolve))
  try {
    const addr = endpoint.address(); if (!addr || typeof addr === 'string') throw new Error('No fixture listener')
    vi.stubEnv('RHARNESS_OLLAMA_URL', 'http://127.0.0.1:' + addr.port)
    expect((await discoverOllama())?.models[0]?.id).toBe('fixture')
    expect((await probeModel({ provider: 'ollama-local', model: 'fixture' },'tools',runOllamaTurn)).passed).toBe(true)
    expect(calls).toEqual(['user','tool'])
  } finally { vi.unstubAllEnvs(); await new Promise<void>(resolve => endpoint.close(() => resolve())) }
})
