import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { RegisteredToolSpec } from './standalone-host.ts'

export const draftInput = z.object({
  id: z.string().uuid().optional(), base: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(200), text: z.string().max(240_000),
  kind: z.enum(['document', 'report', 'meeting']).default('document'),
  evidence: z.array(z.string().max(1000)).max(24).default([]),
})
type Draft = z.infer<typeof draftInput>
export interface WorkspaceRecord {
  id: string; revision: number; owner: string; title: string; text: string
  kind: Draft['kind'] | 'action'; evidence: string[]; at: string
  state: 'draft' | 'review' | 'running' | 'done' | 'dismissed' | 'uncertain'
  target?: string; tool?: string; result?: string
}
export type RecordSummary = Omit<WorkspaceRecord, 'text' | 'evidence' | 'result'>
/** Signals a stale document version or a previously claimed action. */
export class RevisionConflict extends Error {}

/** An append-only revision history for scoped documents, reports and reviewed external actions. */
export class WorkspaceRecords {
  private db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS revisions (id TEXT, revision INTEGER, owner TEXT, data TEXT, PRIMARY KEY (id, revision));
      CREATE INDEX IF NOT EXISTS by_owner ON revisions(owner,id,revision);`)
    const interrupted = this.db.prepare("SELECT id FROM revisions WHERE json_extract(data,'$.state')='running'").all()
    for (const { id } of interrupted) {
      const current = this.get(String(id))
      if (current?.state === 'running') this.append({ ...current, state: 'uncertain', result: 'Interrupted. Verify the destination before creating another action.' }, current.revision)
    }
  }

  get(id: string, revision?: number): WorkspaceRecord | undefined {
    const row = revision === undefined
      ? this.db.prepare('SELECT data FROM revisions WHERE id=? ORDER BY revision DESC LIMIT 1').get(id)
      : this.db.prepare('SELECT data FROM revisions WHERE id=? AND revision=?').get(id, revision)
    return row ? JSON.parse(String(row.data)) as WorkspaceRecord : undefined
  }

  list(owner?: string): RecordSummary[] {
    const rows = this.db.prepare(`SELECT data, MAX(revision) FROM revisions WHERE (? IS NULL OR owner=?) GROUP BY id ORDER BY json_extract(data,'$.at') DESC LIMIT 150`).all(owner ?? null, owner ?? null)
    return rows.map(row => {
      const { text: _text, evidence: _evidence, result: _result, ...summary } = JSON.parse(String(row.data)) as WorkspaceRecord
      return summary
    })
  }

  private append(record: WorkspaceRecord, base: number) {
    const next = { ...record, revision: base + 1, at: new Date().toISOString() }
    const saved = this.db.prepare('INSERT OR IGNORE INTO revisions VALUES (?,?,?,?)').run(next.id, next.revision, next.owner, JSON.stringify(next))
    if (!saved.changes) throw new RevisionConflict('This item has a newer revision. Reload to compare your changes.')
    return next
  }

  save(input: Draft, owner: string) {
    const current = input.id ? this.get(input.id) : undefined
    if (input.id && (!current || current.owner !== owner)) throw new Error('Unknown workspace document')
    if ((current?.revision ?? 0) !== input.base) throw new RevisionConflict('Reload the latest document revision')
    if (current?.kind === 'action') throw new Error('Action previews are immutable')
    return this.append({ ...input, state: 'draft', id: input.id ?? randomUUID(), owner, revision: 0, at: '' }, input.base)
  }

  propose(owner: string, tool: string, target: string, args: Record<string, unknown>) {
    return this.append({ id: randomUUID(), owner, tool, target, title: tool, text: JSON.stringify(args, null, 2), evidence: [], kind: 'action', state: 'review', revision: 0, at: '' }, 0)
  }

  async decide(id: string, base: number, approve: boolean, perform: (item: WorkspaceRecord) => Promise<unknown>) {
    const original = this.get(id)
    if (!original || original.kind !== 'action') throw new Error('Unknown action')
    if (original.revision !== base || original.state !== 'review') throw new RevisionConflict('Action was already reviewed')
    const claim = this.append({ ...original, state: approve ? 'running' : 'dismissed' }, base)
    if (!approve) return claim
    try {
      const result = await perform(original)
      return this.append({ ...claim, state: 'done', result: JSON.stringify(result)?.slice(0, 6000) }, claim.revision)
    } catch (error) {
      return this.append({ ...claim, state: 'uncertain', result: String(error).slice(0, 6000) }, claim.revision)
    }
  }

  close() { this.db.close() }
}

export function workspaceTools(get: () => WorkspaceRecords, owner: string): RegisteredToolSpec[] {
  const read = z.object({ id: z.string().uuid().optional(), revision: z.number().int().positive().optional() })
  const patch = z.object({ id: z.string().uuid(), base: z.number().int().positive(), before: z.string().min(1), after: z.string() })
  return [
    { name: 'workspace_read', description: 'List your documents or read one exact revision by ID.', parameters: z.toJSONSchema(read),
      execute: async raw => { const query = read.parse(raw); if (!query.id) return get().list(owner)
        const value = get().get(query.id, query.revision); if (value?.owner !== owner) throw new Error('Unknown document'); return value } },
    { name: 'workspace_save', description: 'Create or revise a durable document, timestamped meeting note or worker report. Include verification evidence. Use base=0 for creation, then supply the last revision.',
      parameters: z.toJSONSchema(draftInput), execute: async raw => get().save(draftInput.parse(raw), owner) },
    { name: 'workspace_edit', description: 'Replace a unique passage in a specific document revision.', parameters: z.toJSONSchema(patch),
      execute: async raw => {
        const args = patch.parse(raw)
        const item = get().get(args.id)
        if (item?.owner !== owner || item?.kind === 'action') throw new Error('Unknown document')
        if (item.revision !== args.base) throw new RevisionConflict('Reload latest revision')
        if (item.text.split(args.before).length !== 2) throw new Error('Select a unique passage')
        return get().save(draftInput.parse({ ...item, base: args.base, text: item.text.replace(args.before, () => args.after) }), owner)
      } },
  ]
}
