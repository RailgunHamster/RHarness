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
