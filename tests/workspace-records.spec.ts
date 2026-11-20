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
