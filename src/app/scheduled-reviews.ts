import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import { panelTrigger } from '../sources/panel.ts'

export const reviewInput = z.object({
  id: z.string().uuid().optional(), base: z.number().int().nonnegative().default(0),
  prompt: z.string().trim().min(1).max(1600), mode: z.enum(['prepare','follow','silent','notify']),
  due: z.iso.datetime(), intervalMinutes: z.number().int().min(5).max(525600).optional(), enabled: z.boolean().default(true),
})
export interface ScheduledReview extends Omit<z.infer<typeof reviewInput>, 'base' | 'id'> {
  id: string; revision: number; lastTrigger?: string; lastAt?: string
}

export function saveReview(existing: ScheduledReview[], input: z.infer<typeof reviewInput>): ScheduledReview[] {
  const prev = existing.find(item => item.id === input.id)
  if ((input.id && !prev) || (prev?.revision ?? 0) !== input.base) throw new Error('Schedule changed. Reload before editing.')
  if (!prev && existing.length >= 100) throw new Error('Review schedule limit reached')
  const { base, ...fields } = input
  const next = { ...prev, ...fields, id: prev?.id ?? randomUUID(), revision: base + 1 }
  return [next, ...existing.filter(item => item.id !== next.id)]
}

export function consumeDueReviews(reviews: ScheduledReview[], now: number, receive: (trigger: Trigger) => void) {
  let changed = false
  const items = reviews.map(review => {
    const due = Date.parse(review.due)
    if (!review.enabled || now < due) return review
    const interval = (review.intervalMinutes ?? 0) * 60_000
    // Coalesce missed ticks after downtime; the stable occurrence ID makes receive-before-checkpoint replay safe.
    const tick = interval ? due + Math.floor((now - due) / interval) * interval : due
    const at = new Date(tick).toISOString()
    const trigger = panelTrigger({ id: 'schedule-' + review.id + '-' + tick, conversation: 'schedule-' + review.id, sender: 'scheduler', at, text: review.prompt })
    const instructions = {
      prepare: 'Prepare a review draft for the operator.',
      follow: 'Read existing progress and report changes since the previous review.',
      silent: 'Record an observation for later recall. No notification was requested.',
      notify: 'Send any policy-authorized notice to this panel thread.',
    }
    trigger.text = instructions[review.mode] + '\n' + review.prompt
    delete trigger.addressed
    if (review.mode !== 'notify') delete trigger.channel
    trigger.human = false
    trigger.meta = { ...trigger.meta, scheduleId: review.id, requestedMode: review.mode }
    receive(trigger)
    changed = true
    return { ...review, lastTrigger: trigger.id, lastAt: at, due: interval ? new Date(tick + interval).toISOString() : at, enabled: Boolean(interval), revision: review.revision + 1 }
  })
  return changed ? items : reviews
}
