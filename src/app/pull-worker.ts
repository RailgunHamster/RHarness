import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { signOperation, validOperation, type DeviceIdentityRecord, type PeerOperation } from './device-group.ts'
import type { TurnReceipt, TurnReceipts } from './turn-receipts.ts'
import type { RemoteTurnRequestBody, RemoteTurnResponseBody } from './worker-nodes.ts'

const keySchema = z.string().regex(/^[a-f0-9]{64}$/)
const updateSchema = z.object({
  key: keySchema, after: z.number().int().nonnegative(), page: z.object({
    state: z.enum(['running','completed','failed','uncertain']), cursor: z.number().int().nonnegative(), more: z.boolean(),
    events: z.array(z.object({ type: z.string(), data: z.unknown() })).max(64),
    result: z.object({ replyText: z.string(), branch: z.string().optional(), headSha: z.string().optional(), worktreeDir: z.string().optional(),
      repoRoot: z.string().optional(), gitBundleB64: z.string().optional(), syncedFiles: z.array(z.object({ relPath: z.string(), contentB64: z.string() })).optional() }).optional(),
    error: z.string().optional(),
  }),
})
type Update = z.infer<typeof updateSchema>
interface Offer { key: string; after: number; body?: RemoteTurnRequestBody; proof?: PeerOperation }
interface PullConfig { url: string; hubId: string }

export function pullConfig(url: string, hubId: string): PullConfig {
  const target = new URL(url)
  if ((target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(target.hostname))) ||
      target.username || target.password || target.pathname !== '/' || target.search || target.hash || !keySchema.safeParse(hubId).success)
    throw new Error('Pull transport needs a paired hub device ID and an HTTPS origin (HTTP allowed on loopback)')
  return { url: target.origin, hubId }
}

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const peerId = (operation: PeerOperation) => hash(Buffer.from(operation.issuer, 'base64url'))

/** Holds only typed executor turns for a specific paired worker and preserves the last acknowledged event. */
export class PullMailbox {
  private db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS offers(key TEXT PRIMARY KEY, peer TEXT, digest TEXT, body TEXT, state TEXT, cursor INTEGER, result TEXT, error TEXT, updated INTEGER);
      CREATE INDEX IF NOT EXISTS peer_offers ON offers(peer,state);
      CREATE TABLE IF NOT EXISTS pull_events(key TEXT, seq INTEGER, event TEXT, PRIMARY KEY(key,seq));`)
    this.prune()
  }

  private prune() {
    this.db.exec(`UPDATE offers SET body=NULL,result=NULL,state='uncertain',error='Expired pull receipt' WHERE updated < unixepoch()-604800 AND body IS NOT NULL;
      DELETE FROM pull_events WHERE key IN (SELECT key FROM offers WHERE body IS NULL);`)
  }

  async dispatch(peer: string, key: string, body: RemoteTurnRequestBody, signal: AbortSignal, emit: (type: string, data: unknown) => void): Promise<RemoteTurnResponseBody> {
    signal.throwIfAborted()
    this.prune()
    const { hubUrl: _url, hubEndpoints: _addresses, ...request } = body
    const digest = hash(JSON.stringify(request))
    this.db.prepare("INSERT OR IGNORE INTO offers VALUES (?,?,?,?,'queued',0,NULL,NULL,unixepoch())").run(key,peer,digest,JSON.stringify(body))
    const saved = this.db.prepare('SELECT peer,digest FROM offers WHERE key=?').get(key)!
    if (saved.peer !== peer || saved.digest !== digest) throw new Error('Pull turn already assigned with different parameters')
    let after = 0
    const abandon = () => this.db.prepare("UPDATE offers SET state='uncertain',error='Dispatch cancelled' WHERE key=? AND state IN ('queued','running')").run(key)
    signal.addEventListener('abort', abandon, { once: true })
    try {
      for (;;) {
        const state = this.db.prepare('SELECT state,result,error FROM offers WHERE key=?').get(key)!
        const events = this.db.prepare('SELECT seq,event FROM pull_events WHERE key=? AND seq>? ORDER BY seq LIMIT 64').all(key, after)
        for (const row of events) {
          const event = JSON.parse(String(row.event))
          emit(event.type, event.data)
          after = Number(row.seq)
        }
        if (events.length === 64) continue
        if (state.state === 'completed') return { ...JSON.parse(String(state.result)), events: [] }
        if (!['queued','running'].includes(String(state.state))) throw new Error(String(state.error ?? 'Pull worker needs review'))
        await delay(400, undefined, { signal })
      }
    } finally { signal.removeEventListener('abort', abandon) }
  }

  exchange(identity: DeviceIdentityRecord, trusted: string[], proof: PeerOperation, known: string | null, update: unknown): Offer | null {
    if (!validOperation(proof, 'worker-pull', [identity.deviceId,known,update], trusted)) throw new Error('Untrusted pull request')
    const peer = peerId(proof)
    if (update) this.accept(peer, updateSchema.parse(update))
    const row = this.db.prepare("SELECT key,body,cursor FROM offers WHERE peer=? AND state IN ('running','queued') AND updated>=unixepoch()-604800 ORDER BY rowid LIMIT 1").get(peer)
    if (!row) return null
    const key = String(row.key)
    this.db.prepare("UPDATE offers SET state='running', updated=unixepoch() WHERE key=?").run(key)
    if (key === known) return { key, after: Number(row.cursor) }
    const body = JSON.parse(String(row.body)) as RemoteTurnRequestBody
    return { key, after: Number(row.cursor), body, proof: signOperation(identity,key,'worker-turn',[peer,body]) }
  }

  private accept(peer: string, { key, after, page }: Update) {
    const row = this.db.prepare('SELECT peer,cursor,state FROM offers WHERE key=?').get(key)
    if (row?.peer !== peer || page.cursor !== after + page.events.length || after > Number(row.cursor)) throw new Error('Invalid pull cursor or recipient')
    if (row.state !== 'running' || after !== row.cursor) return
    const state = page.more ? 'running' : page.state
    if (state === 'completed' && !page.result) throw new Error('Missing pull result')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const insert = this.db.prepare('INSERT INTO pull_events VALUES (?,?,?)')
      page.events.forEach((event,i) => insert.run(key, after + i + 1, JSON.stringify(event)))
      this.db.prepare('UPDATE offers SET cursor=?,state=?,result=?,error=?,updated=unixepoch() WHERE key=?')
        .run(page.cursor, state, state === 'completed' ? JSON.stringify(page.result) : null, page.error ?? null, key)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  close() { this.db.close() }
}

export function createWorkerPoll(config: PullConfig, identity: () => DeviceIdentityRecord, trusted: () => string[], receipts: () => TurnReceipts,
  execute: (body: RemoteTurnRequestBody, emit: (event: TurnReceipt['events'][number]) => void) => Promise<RemoteTurnResponseBody>) {
  let current: Offer | undefined
  return async (signal: AbortSignal) => {
    const self = identity()
    const known = current?.key ?? null
    const page = current && receipts().read(current.key, current.after)
    const update = current && page ? { key: current.key, after: current.after, page } : null
    const proof = signOperation(self, crypto.randomUUID(), 'worker-pull', [config.hubId, known, update])
    const res = await fetch(config.url + '/orchestrator/standalone/worker-node/pull', { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proof, known, update }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
    if (!res.ok) throw new Error('Worker poll failed (' + res.status + ')')
    const offer = (await res.json() as { offer: Offer | null }).offer
    if (offer?.body) {
      if (!offer.proof || offer.proof.key !== offer.key || peerId(offer.proof) !== config.hubId ||
          !validOperation(offer.proof, 'worker-turn', [self.deviceId, offer.body], trusted())) throw new Error('Untrusted pull offer')
      const body = { ...offer.body, hubUrl: config.url, hubEndpoints: [config.url] }
      if (!receipts().start(offer.key, body, emit => execute(body, emit))) throw new Error('Pull turn changed after receipt')
    } else if (offer && offer.key !== known) throw new Error('Missing signed pull offer')
    current = offer ?? undefined
    return Boolean(offer)
  }
}
