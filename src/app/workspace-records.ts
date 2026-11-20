import { inspectReportFile, type ReportFile } from './report-files.ts'
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

export function transcriptDocument(source: string, transcript: string): Draft {
  const lines = transcript.replace(/\r/g, '').split('\n').filter(line => line.trim() && line !== 'WEBVTT' && !/^\d+$/.test(line.trim()))
  // Keep provider-supplied time ranges and speaker labels. Plain ASR output remains unattributed.
  const text = lines.join('\n').trim()
  if (!text) throw new Error('Transcript is empty')
  return draftInput.parse({ kind: 'meeting', title: source.split(/[\\/]/).at(-1)?.slice(0, 190) || 'Transcript', base: 0,
    text, evidence: ['audio_transcribe', 'Source: ' + source.slice(-900)] })
}
export interface WorkspaceRecord {
  id: string; revision: number; owner: string; title: string; text: string
  kind: Draft['kind'] | 'action'; evidence: string[]; at: string
  state: 'draft' | 'review' | 'running' | 'done' | 'dismissed' | 'uncertain'
  target?: string; tool?: string; result?: string; attachment?: ReportFile
}
export interface WorkspaceArchive { records: WorkspaceRecord[]; files: { sha: string; data: string }[] }
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
      CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY, digest TEXT, status TEXT, result TEXT);
      CREATE TABLE IF NOT EXISTS attachments (sha TEXT PRIMARY KEY, content BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS filenames (owner TEXT, name TEXT, id TEXT, PRIMARY KEY (owner, name));
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
    if (current?.kind === 'action' || current?.attachment) throw new Error('Published files and action previews are immutable')
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

  publishFile(owner: string, metadata: ReportFile, content: Buffer, summary: string) {
    const row = this.db.prepare('SELECT id FROM filenames WHERE owner=? AND name=?').get(owner, metadata.name)
    const existing = row ? this.get(String(row.id)) : undefined
    if (existing?.attachment?.sha256 === metadata.sha256 && existing.text === summary) return existing
    const id = existing?.id ?? randomUUID()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT OR IGNORE INTO attachments VALUES (?,?)').run(metadata.sha256, content)
      this.db.prepare('INSERT OR IGNORE INTO filenames VALUES (?,?,?)').run(owner, metadata.name, id)
      const result = this.append({ id, owner, revision: 0, at: '', title: metadata.name, text: summary, evidence: [metadata.validation, metadata.sha256],
        kind: 'report', state: 'done', attachment: metadata }, existing?.revision ?? 0)
      this.db.exec('COMMIT'); return result
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  download(id: string, revision: number) {
    const file = this.get(id, revision)?.attachment
    if (!file) return undefined
    const row = this.db.prepare('SELECT content FROM attachments WHERE sha=?').get(file.sha256)
    return row ? { file, bytes: Buffer.from(row.content as Uint8Array) } : undefined
  }

  operation(key: string, digest: string) {
    const row = this.db.prepare('SELECT digest,status,result FROM operations WHERE key=?').get(key)
    if (!row) return undefined
    if (row.digest !== digest) throw new RevisionConflict('Operation content changed')
    return { state: String(row.status), result: row.result ? JSON.parse(String(row.result)) as unknown : undefined }
  }

  async performOnce(key: string, digest: string, execute: () => Promise<unknown>) {
    const existing = this.operation(key, digest)
    if (existing) return existing
    this.db.prepare("INSERT INTO operations VALUES (?,?,'started',NULL)").run(key, digest)
    try {
      const result = await execute()
      this.db.prepare("UPDATE operations SET status='done',result=? WHERE key=?").run(JSON.stringify(result) ?? 'null', key)
      return { state: 'done', result }
    } catch (error) {
      this.db.prepare("UPDATE operations SET status='uncertain' WHERE key=?").run(key)
      throw error
    }
  }

  archive(): WorkspaceArchive {
    return {
      records: this.db.prepare('SELECT data FROM revisions ORDER BY id, revision').all().map(row => JSON.parse(String(row.data)) as WorkspaceRecord),
      files: this.db.prepare('SELECT sha,content FROM attachments').all().map(row => ({ sha: String(row.sha), data: Buffer.from(row.content as Uint8Array).toString('base64') })),
    }
  }

  restore(archive: WorkspaceArchive, mode: 'merge' | 'replace') {
    const schema = z.object({
      id: z.string().uuid(), owner: z.string().min(1).max(220), revision: z.number().int().positive(), at: z.iso.datetime(),
      kind: z.enum(['action','meeting','report','document']), state: z.enum(['draft','review','running','done','dismissed','uncertain']),
      title: z.string().max(240), text: z.string().max(240000), evidence: z.array(z.string().max(1200)).max(24),
      target: z.string().optional(), tool: z.string().optional(), result: z.string().optional(),
      attachment: z.object({ name: z.string(), bytes: z.number().int(), sha256: z.string(), validation: z.string() }).optional(),
    })
    const records = z.array(schema).parse(archive.records)
    const blobs = new Map(archive.files.map(file => [file.sha, file.data]))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (mode === 'replace') {
        // Action receipts survive snapshot rollback so a completed operation cannot run again.
        this.db.exec("DELETE FROM revisions WHERE json_extract(data,'$.kind')!='action';DELETE FROM filenames")
      }
      const restored = new Set<string>()
      for (const record of records) {
        const existing = this.get(record.id)
        if (existing && (existing.owner !== record.owner || (existing.kind === 'action') !== (record.kind === 'action'))) throw new Error('Conflicting document identity')
        if (this.get(record.id, record.revision)) continue
        if (record.attachment) {
          const encoded = blobs.get(record.attachment.sha256)
          if (!encoded) throw new Error('Missing report bytes')
          const bytes = Buffer.from(encoded, 'base64')
          const verified = inspectReportFile(record.attachment.name, bytes)
          if (verified.sha256 !== record.attachment.sha256) throw new Error('Backup report digest mismatch')
          record.attachment = verified
          this.db.prepare('INSERT OR IGNORE INTO attachments VALUES (?,?)').run(verified.sha256, bytes)
          this.db.prepare('INSERT OR IGNORE INTO filenames VALUES (?,?,?)').run(record.owner, verified.name, record.id)
        }
        this.db.prepare('INSERT INTO revisions VALUES (?,?,?,?)').run(record.id, record.revision, record.owner, JSON.stringify(record))
        restored.add(record.id)
      }
      for (const id of restored) {
        const latest = this.get(id)!
        if (latest.kind === 'action' && ['review','running'].includes(latest.state)) {
          this.append({ ...latest, state: 'dismissed', result: 'Restored for reference. Create a new preview to run this action.' }, latest.revision)
        }
      }
      this.db.exec("DELETE FROM attachments WHERE sha NOT IN (SELECT json_extract(data,'$.attachment.sha256') FROM revisions WHERE json_type(data,'$.attachment.sha256')='text')")
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
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
    { name: 'meeting_propose_followup', description: 'Propose a follow-up from a specific transcript revision and exact excerpt for user approval before engineering intake.',
      parameters: z.toJSONSchema(z.object({ id: z.string().uuid(), revision: z.number().int().positive(), excerpt: z.string().min(1).max(1600), request: z.string().min(1).max(2000) })),
      execute: async raw => {
        const args = z.object({ id: z.string().uuid(), revision: z.number().int().positive(), excerpt: z.string().min(1).max(1600), request: z.string().min(1).max(2000) }).parse(raw)
        const note = get().get(args.id, args.revision)
        if (note?.owner !== owner || note.kind !== 'meeting' || !note.text.includes(args.excerpt)) throw new Error('Transcript excerpt unavailable')
        return get().propose(owner, 'meeting_followup', 'panel/engineering', { ...args, title: note.title })
      } },
    { name: 'workspace_report_reference', description: 'Read a worker report shared by exact document ID and revision. Returns its validation evidence alongside the report.',
      parameters: z.toJSONSchema(z.object({ id: z.string().uuid(), revision: z.number().int().positive() })),
      execute: async raw => {
        const args = z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).parse(raw)
        const report = get().get(args.id, args.revision)
        if (report?.kind !== 'report' || !report.owner.startsWith('worker-')) throw new Error('Unknown report reference')
        return report
      } },
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
