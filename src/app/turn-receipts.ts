import { createHash, createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import type { RemoteTurnRequestBody, RemoteTurnResponseBody } from './worker-nodes.ts'

type TurnEvent = RemoteTurnResponseBody['events'][number]
export interface TurnReceipt {
  state: 'running' | 'completed' | 'failed' | 'uncertain'
  cursor: number
  events: TurnEvent[]
  more: boolean
  result?: Omit<RemoteTurnResponseBody, 'events'>
  error?: string
}

export function turnReceiptKey(secret: string, body: RemoteTurnRequestBody): string {
  return createHmac('sha256', secret).update(JSON.stringify([
    body.sessionId, body.messages.filter(message => message.role === 'user').map(message => message.id),
  ])).digest('hex')
}

/** Stores a worker's accepted turns before execution and replays their ordered events after reconnect. */
export class TurnReceipts {
  private db: DatabaseSync
  private active = new Set<Promise<void>>()

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS turns (key TEXT PRIMARY KEY, digest TEXT, state TEXT, result TEXT, error TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS events (key TEXT, seq INTEGER, data TEXT, PRIMARY KEY(key,seq));
      UPDATE turns SET state='uncertain', error='Worker restarted during execution. Review the ticket before retrying.' WHERE state='running';`)
    // Retain small tombstones so a delayed retry cannot repeat an expired turn.
    this.db.exec(`DELETE FROM events WHERE key IN (SELECT key FROM turns WHERE created < unixepoch()-604800);
      UPDATE turns SET state='uncertain', result=NULL, error='Receipt payload expired' WHERE result IS NOT NULL AND created < unixepoch()-604800;`)
  }

  start(key: string, body: RemoteTurnRequestBody, run: (emit: (event: TurnEvent) => void) => Promise<RemoteTurnResponseBody>): boolean {
    const { hubUrl: _url, hubEndpoints: _endpoints, ...request } = body
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const existing = this.db.prepare('SELECT digest FROM turns WHERE key=?').get(key)
    if (existing) return existing.digest === digest
    this.db.prepare("INSERT INTO turns VALUES (?,?,'running',NULL,NULL,unixepoch())").run(key, digest)
    let seq = 0
    const emit = (event: TurnEvent) => {
      this.db.prepare('INSERT INTO events VALUES (?,?,?)').run(key, ++seq, JSON.stringify(event))
    }
    const job = Promise.resolve().then(() => run(emit)).then(({ events: _events, ...result }) => {
      this.db.prepare("UPDATE turns SET state='completed', result=? WHERE key=?").run(JSON.stringify(result), key)
    }).catch((error: unknown) => {
      this.db.prepare("UPDATE turns SET state='failed', error=? WHERE key=?").run(String(error), key)
    })
    this.active.add(job)
    void job.finally(() => this.active.delete(job))
    return true
  }

  read(key: string, after: number): TurnReceipt | undefined {
    const row = this.db.prepare('SELECT state,result,error FROM turns WHERE key=?').get(key)
    if (!row) return undefined
    const rows = this.db.prepare('SELECT seq,data FROM events WHERE key=? AND seq>? ORDER BY seq LIMIT 65').all(key, after)
    const page = rows.slice(0, 64)
    const more = page.length < rows.length
    return {
      state: row.state as TurnReceipt['state'], cursor: Number(page.at(-1)?.seq ?? after), more,
      events: page.map(event => JSON.parse(String(event.data)) as TurnEvent),
      ...(row.result && !more ? { result: JSON.parse(String(row.result)) } : {}),
      ...(row.error ? { error: String(row.error) } : {}),
    }
  }

  async close() {
    await Promise.allSettled(this.active)
    this.db.close()
  }
}

export async function requestRemoteTurn(input: {
  candidates: string[]; key: string; body: RemoteTurnRequestBody; signal: AbortSignal
  onEvent: (type: string, data: unknown) => void
}): Promise<RemoteTurnResponseBody> {
  const headers = { 'content-type': 'application/json', 'x-orchestrator-request': '1', 'x-turn-receipt': input.key }
  let peer: string | null = null
  let cursor = 0
  let submitted = false
  let unknown: unknown
  // A receipt can be polled through another address of the same worker after a dropped response.
  for (const base of [...input.candidates, ...input.candidates]) {
    const endpoint = base.replace(/\/+$/, '') + '/orchestrator/standalone/worker-node/execute'
    let probe: Response
    try {
      probe = await fetch(endpoint, { method: 'HEAD', signal: AbortSignal.any([input.signal, AbortSignal.timeout(4000)]) })
    } catch (error) { input.signal.throwIfAborted(); unknown = error; continue }
    const identity = probe.headers.get('x-turn-peer')
    if (peer && peer !== identity) continue
    if (!identity || probe.headers.get('x-turn-protocol') !== '1') {
      if (submitted) continue
      if (![404, 405].includes(probe.status)) { unknown = new Error('Worker receipt negotiation failed: ' + probe.status); continue }
      const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(input.body), signal: input.signal })
      const value = await res.json() as RemoteTurnResponseBody & { error?: string }
      if (!res.ok) throw new Error(value.error ?? 'Legacy worker rejected the turn')
      return value
    }
    peer = identity
    for (;;) {
      let res: Response
      let page: TurnReceipt
      try {
        const mode = submitted ? 'read' : 'start'
        res = await fetch(endpoint + '?receipt=' + mode + '&after=' + cursor, {
          method: 'POST', headers, body: submitted ? '{}' : JSON.stringify(input.body),
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]),
        })
        page = await res.json() as TurnReceipt
      } catch (error) { input.signal.throwIfAborted(); unknown = error; break }
      if (res.status === 404 && submitted) { submitted = false; continue }
      if (!res.ok) throw new Error(page.error ?? 'Worker receipt rejected (' + res.status + ')')
      submitted = true
      for (const event of page.events) input.onEvent(event.type, event.data)
      cursor = page.cursor
      if (page.more) continue
      if (page.state === 'completed' && page.result) return { ...page.result, events: [] }
      if (page.state !== 'running') throw new Error(page.error ?? 'Remote turn outcome is uncertain')
      await delay(250, undefined, { signal: input.signal })
    }
  }
  throw new Error('Worker receipt unavailable: ' + String(unknown ?? peer ?? 'no reachable endpoint'))
}
