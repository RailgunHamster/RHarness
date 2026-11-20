type Waiting = { since: number; priority: number; start: () => void }
type Pool = { running: number; waiting: Waiting[]; cooldown: number; wake?: ReturnType<typeof setTimeout> }

/** Per-serving-endpoint admission for model turns, with FIFO aging, shared rate-limit cooldown and cancellable waiting. */
export class ModelQueue {
  private pools = new Map<string, Pool>()
  constructor(private capacity = 2) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Capacity must be a positive integer')
  }

  snapshot() {
    return [...this.pools.values()].map(pool => ({ running: pool.running, queued: pool.waiting.length, cooldownMs: Math.max(0, pool.cooldown - Date.now()) }))
  }

  async run<T>(endpoint: string, foreground: boolean, signal: AbortSignal,
    task: (duringTool: <R>(work: () => Promise<R>) => Promise<R>) => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    let pool = this.pools.get(endpoint)
    if (!pool) { pool = { running: 0, waiting: [], cooldown: 0 }; this.pools.set(endpoint, pool) }
    const admission = pool
    let held = false
    let closed = false
    let pending: Promise<void> | undefined
    const release = () => {
      if (!held) return
      held = false
      admission.running--
      this.drain(admission)
    }
    const acquire = () => {
      signal.throwIfAborted()
      if (held || closed) return
      return pending ??= new Promise<void>((resolve, reject) => {
        const waiter: Waiting = { since: Date.now(), priority: foreground ? 1 : 0, start: () => {
          signal.removeEventListener('abort', cancel)
          if (!closed) { held = true; admission.running++ }
          resolve()
        } }
        const cancel = () => {
          admission.waiting = admission.waiting.filter(item => item !== waiter)
          reject(signal.reason)
          this.drain(admission)
        }
        signal.addEventListener('abort', cancel, { once: true })
        admission.waiting.push(waiter)
        this.drain(admission)
      }).finally(() => { pending = undefined })
    }
    await acquire()
    try {
      signal.throwIfAborted()
      return await task(async work => {
        release()
        try { return await work() } finally { if (!closed) await acquire() }
      })
    }
    catch (err) {
      if (/\b429\b|rate.?limit|too many requests/i.test(String(err))) {
        const seconds = /retry.after\D{0,6}(\d+)/i.exec(String(err))?.[1]
        admission.cooldown = Math.max(admission.cooldown, Date.now() + Math.min(300, Math.max(1, Number(seconds ?? 5))) * 1000)
      }
      throw err
    } finally { closed = true; release() }
  }

  private drain(pool: Pool) {
    if (!pool.waiting.length || pool.running >= this.capacity) return
    if (pool.cooldown > Date.now()) {
      pool.wake ??= setTimeout(() => { delete pool.wake; this.drain(pool) }, pool.cooldown - Date.now())
      return
    }
    // Waiting 30 seconds gives a background turn the priority of a new interactive one.
    pool.waiting.sort((a,b) => (b.priority - a.priority) * 30_000 + a.since - b.since)
    while (pool.running < this.capacity && pool.waiting.length) pool.waiting.shift()!.start()
  }
}

export const nativeModelQueue = new ModelQueue()
