/**
 * Tests for the standalone multi-actor server, Local Panel Source (`panelKind`), and Session Console endpoints.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recoverStaleStateLock, startStandaloneServer } from '../src/server/standalone.ts'
import { FALLBACK_CATALOG } from '../src/app/standalone-host.ts'
import { panelKind, panelTrigger } from '../src/sources/panel.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'standalone-server-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('standalone server and multi-provider actors', () => {
  it('starts without GitHub CLI when GitHub Source is disabled, exposes multi-provider catalog, and accepts Local Panel messages through Human/Agent Sessions', async () => {
    const srv = await startStandaloneServer({ port: 0, stateDir: dir, liveAgents: false })
    try {
      const api = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(`${srv.url}${path}`, {
          method,
          headers: {
            host: `127.0.0.1:${srv.port}`,
            'x-orchestrator-request': '1',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        })
        return { status: res.status, body: await res.json() as Record<string, unknown> }
      }

      // 1. State is ready with no setup problem
      const state = await api('GET', '/orchestrator/api/state')
      expect(state.status).toBe(200)
      expect(state.body).toMatchObject({
        paused: false,
        setup: { problem: null },
        health: { runtime: { state: 'ready' }, panel: { state: 'ready' } },
      })

      // 2. Models endpoint exposes DSH, Codex, and Human providers
      const models = await api('GET', '/orchestrator/api/models')
      expect(models.status).toBe(200)
      const groups = (models.body.groups as { id: string }[]).map(g => g.id)
      expect(groups).toEqual(FALLBACK_CATALOG.groups.map(g => g.id))

      // 3. Role models can be configured to different providers (e.g., Codex for Eval, Human for Executor)
      const settingsBefore = await api('GET', '/orchestrator/api/settings')
      const blocks = settingsBefore.body.blocks as Record<string, { revision: number; value: Record<string, unknown> }>
      const evalSave = await api('PUT', '/orchestrator/api/settings/eval', {
        revision: blocks.eval!.revision,
        value: { ...blocks.eval!.value, model: { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' } },
      })
      expect(evalSave.status).toBe(200)

      const execSave = await api('PUT', '/orchestrator/api/settings/executor', {
        revision: blocks.executor!.revision,
        value: { ...blocks.executor!.value, model: { provider: 'human', model: 'human-operator' } },
      })
      expect(execSave.status).toBe(200)

      // 4. Send a text-and-image message from the Local Panel Source
      const image = Buffer.alloc(33)
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image)
      image.write('IHDR', 12, 'ascii')
      image.writeUInt32BE(1, 16)
      image.writeUInt32BE(1, 20)
      const encodedImage = image.toString('base64')
      const posted = await api('POST', '/orchestrator/standalone/panel/messages', {
        conversation: 'feature-chat',
        sender: 'operator',
        text: 'Please implement the new login button shown here',
        content: [{ type: 'image', mediaType: 'image/png', data: encodedImage, name: 'mockup.png' }],
      })
      expect(posted.status).toBe(200)
      const triggerId = String(posted.body.id)
      expect(posted.body.threadKey).toBe('panel:feature-chat')
      const trigger = srv.runtime.store.triggers.get(triggerId)!
      expect(trigger.text).toBe('Please implement the new login button shown here')
      expect(trigger.meta.images).toHaveLength(1)
      expect(JSON.stringify(trigger)).not.toContain(encodedImage)
      const history = await api('GET', '/orchestrator/standalone/panel/messages?conversation=feature-chat')
      const savedMessage = (history.body.messages as { content: { type: string; data?: string }[] }[])[0]!
      expect(savedMessage.content.find(part => part.type === 'image')?.data).toBe(encodedImage)

      // 5. Inspect main Session and route the explicit candidate as a new Ticket via Session Console tool endpoint
      const masterId = String(state.body.masterId)
      const routed = await api('POST', `/orchestrator/standalone/sessions/${encodeURIComponent(masterId)}/tool`, {
        name: 'orchestrator_route',
        args: {
          decisions: [{
            kind: 'accept',
            trigger_id: triggerId,
            title: 'Implement new login button',
            worktree_name: 'login-button',
            acknowledgement: 'Got it, implementing the login button.',
          }],
        },
      })
      expect(routed.status).toBe(200)
      await srv.runtime.idle()

      const tickets = await api('GET', '/orchestrator/api/tickets?state=open')
      const items = (tickets.body.items as { id: string; title: string }[])
      expect(items).toHaveLength(1)
      expect(items[0]!.title).toBe('Implement new login button')

      // 6. Worker session is created with the configured Human provider and can report ready
      const workerSessionId = `worker-${items[0]!.id}`
      const workerSession = await api('GET', `/orchestrator/standalone/sessions/${encodeURIComponent(workerSessionId)}`)
      expect(workerSession.status).toBe(200)
      expect(workerSession.body.model).toMatchObject({ provider: 'human', model: 'human-operator' })
      const workerInput = (workerSession.body.events as { type: string; data: { content?: { type: string; path?: string }[] } }[])
        .find(event => event.type === 'user/message')
      expect(workerInput?.data.content?.map(part => part.type)).toContain('image')
      expect(workerInput?.data.content?.find(part => part.type === 'image')?.path).toEqual(expect.stringContaining('panel-images'))

      const reported = await api('POST', `/orchestrator/standalone/sessions/${encodeURIComponent(workerSessionId)}/tool`, {
        name: 'orchestrator_report',
        args: {
          state: 'ready',
          summary: 'Implemented and verified the login button.',
        },
      })
      expect(reported.status).toBe(200)
      await srv.runtime.idle()

      const ended = await api('GET', '/orchestrator/api/tickets?state=ended')
      expect((ended.body.items as { id: string }[]).map(t => t.id)).toContain(items[0]!.id)
    } finally {
      await srv.stop()
    }
  })

  it('translates panel messages into triggers with stable IDs and channel addresses', () => {
    const trigger = panelTrigger({
      id: 'm1',
      conversation: 'ops',
      sender: 'operator',
      text: 'check status',
      at: '2026-11-06T00:00:00.000Z',
    })
    expect(trigger.source).toBe('panel')
    expect(trigger.human).toBe(true)
    expect(trigger.addressed).toBe('direct')
    expect(panelKind.scope?.({ meta: trigger.meta }, panelKind.schema.parse({}))).toEqual({
      listened: true,
      observed: true,
      row: 'panel',
    })
  })

  it('automatically recovers from an orphaned .lock directory left by a crashed PID', async () => {
    const stateDir = join(dir, 'crashed-node')
    mkdirSync(stateDir, { recursive: true })
    mkdirSync(`${stateDir}.lock`, { recursive: true })
    // PID 99999999 is guaranteed not to exist
    writeFileSync(join(stateDir, 'standalone.pid'), '99999999\n', 'utf8')

    expect(recoverStaleStateLock(stateDir)).toBe(true)
    expect(existsSync(`${stateDir}.lock`)).toBe(false)

    // Re-create stale lock & dead PID to verify startStandaloneServer auto-recovers inline without ELOCKED
    mkdirSync(`${stateDir}.lock`, { recursive: true })
    writeFileSync(join(stateDir, 'standalone.pid'), '99999999\n', 'utf8')
    const srv = await startStandaloneServer({ port: 0, host: '127.0.0.1', stateDir, liveAgents: false })
    try {
      expect(srv.port).toBeGreaterThan(0)
    } finally {
      await srv.stop()
    }
  })
})
