/** Live standalone execution events: no provider credentials or real model calls are needed. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStandaloneHost, type StandaloneHostOptions } from '../src/app/standalone-host.ts'
import { readLiveDshTrace, runCodexTurn, runCursorTurn, runDshTurn } from '../src/app/local-drivers.ts'
import { createCodexEventCollector, createCursorEventCollector, createDshEventCollector, projectLiveTrace, type SessionExecutionEvent } from '../src/app/session-events.ts'

vi.mock('../src/app/local-drivers.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/app/local-drivers.ts')>(),
  runDshTurn: vi.fn(),
  runCodexTurn: vi.fn(),
  runCursorTurn: vi.fn(),
}))

const directories: string[] = []
const hosts: ReturnType<typeof createStandaloneHost>[] = []
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), 'standalone-events-test-'))
  directories.push(dir)
  return dir
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const sink = () => {
  const events: SessionExecutionEvent[] = []
  return { events, emit: (type: string, data: unknown) => events.push({ type, data, at: '2026-11-07T00:00:00.000Z' }) }
}
async function session(options: Partial<StandaloneHostOptions> = {}, sessionId = 'test-session') {
  const cwd = temporary()
  const host = createStandaloneHost({ stateDir: cwd, port: 0, ...options })
  hosts.push(host)
  const controller = host.ctx.get('sessionController') as unknown as { create: (options: { sessionId: string; workspaceId: string }) => Promise<void> }
  await controller.create({ sessionId, workspaceId: cwd })
  return { host, agent: host.agents.get(sessionId)!, cwd, sessionId }
}
const prompt = (id = 'prompt') => ({ id, role: 'user' as const, content: [{ type: 'text', text: 'Run the task' }] })

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('standalone incremental execution events', () => {
  it('returns an immutable prefix cursor, complete live snapshots, and one final reply', async () => {
    const gate = deferred()
    let request: Parameters<NonNullable<StandaloneHostOptions['driver']>>[0] | undefined
    const { host, agent, sessionId } = await session({ driver: async input => {
      request = input
      input.onEvent('assistant/step', { messageId: 'reply', text: 'live prefix', streaming: true, reasoning: 'PRIVATE THOUGHT' })
      await gate.promise
      input.onEvent('tool/call', { toolCallId: 'call', tool: 'read', arguments: { path: 'file' } })
      input.onEvent('tool/result', { toolCallId: 'call', tool: 'read', output: 'done' })
      input.onEvent('assistant/step', { messageId: 'reply', text: 'live prefix\n' + '正文'.repeat(6000), streaming: false })
      return 'live prefix\n' + '正文'.repeat(6000)
    } })
    const initialDetail = host.getSessionDetail(sessionId)!
    agent.followup(prompt())
    await vi.waitFor(() => expect(request).toBeDefined())
    const first = host.getSessionEvents(sessionId)!
    expect(first.status).toBe('running')
    expect(first.events.map(event => event.seq)).toEqual(first.events.map((_, index) => index))
    expect(first.liveTrace.filter(step => step.kind === 'assistant')).toMatchObject([{ detail: 'live prefix', streaming: true }])
    expect(initialDetail.events).toHaveLength(0)
    expect(host.getSessionEvents(sessionId, first.next)!.events).toEqual([])
    gate.resolve()
    await agent.whenIdle()
    const next = host.getSessionEvents(sessionId, first.next)!
    expect(next.status).toBe('idle')
    expect(next.events[0]!.seq).toBe(first.next)
    expect(new Set([...first.events, ...next.events].map(event => event.seq)).size).toBe(next.next)
    expect(host.getSessionEvents(sessionId, next.next)!.events).toEqual([])
    expect(next.liveTrace.filter(step => step.kind === 'assistant')).toHaveLength(1)
    expect(next.liveTrace.find(step => step.kind === 'assistant')!.detail).toBe('live prefix\n' + '正文'.repeat(6000))
    expect(next.liveTrace.filter(step => step.kind.startsWith('tool_'))).toHaveLength(2)
    expect(JSON.stringify(host.getSessionDetail(sessionId))).not.toContain('PRIVATE THOUGHT')
    expect(host.getSessionDetail(sessionId)!.liveTrace).toEqual(next.liveTrace)
    for (const after of [NaN, Infinity, -1]) expect(host.getSessionEvents(sessionId, after)!.events).toHaveLength(next.next)
    expect(host.getSessionEvents(sessionId, 1.9)!.events[0]!.seq).toBe(1)
    expect(host.getSessionEvents(sessionId, next.next + 10)!.events).toEqual([])
    expect(host.getSessionEvents('missing')).toBeUndefined()
  })

  it.each([
    ['deepseek-official', runDshTurn], ['anthropic', runDshTurn], ['codex', runCodexTurn], ['cursor', runCursorTurn],
  ] as const)('forwards live facts from the %s executor before its turn completes', async (provider, driver) => {
    const gate = deferred()
    vi.mocked(driver).mockImplementationOnce(async input => {
      expect('onToolResult' in input).toBe(false)
      input.onEvent?.('assistant/step', { messageId: 'native-item', text: '正在执行', streaming: true })
      await gate.promise
      input.onEvent?.('assistant/step', { messageId: 'native-item', text: '执行完成', streaming: false })
      return '执行完成'
    })
    const { host, agent, sessionId } = await session({ liveAgents: true, roleModel: () => ({ provider, model: 'test-model' }) })
    agent.followup(prompt())
    await vi.waitFor(() => expect(host.getSessionEvents(sessionId)!.liveTrace[0]?.detail).toBe('正在执行'))
    expect(agent.status).toBe('running')
    gate.resolve()
    await agent.whenIdle()
    expect(host.getSessionEvents(sessionId)!.liveTrace).toMatchObject([{ kind: 'assistant', detail: '执行完成', streaming: false }])
    expect(host.getSessionEvents(sessionId)!.liveTrace).toHaveLength(1)
  })

  it('keeps different sessions and repeated native item IDs in different turns separate', async () => {
    const { host, agent, cwd, sessionId } = await session({ driver: async input => {
      input.onEvent('tool/call', { toolCallId: 'item_0', tool: 'read' })
      input.onEvent('tool/result', { toolCallId: 'item_0', tool: 'read', output: 'ok' })
      input.onEvent('assistant/step', { messageId: 'item_1', text: input.messages.at(-1)!.id })
      return input.messages.at(-1)!.id
    } })
    const controller = host.ctx.get('sessionController') as unknown as { create: (options: { sessionId: string; workspaceId: string }) => Promise<void> }
    await controller.create({ sessionId: 'other', workspaceId: cwd })
    agent.followup(prompt('first'))
    await agent.whenIdle()
    agent.followup(prompt('second'))
    await agent.whenIdle()
    expect(host.getSessionEvents(sessionId)!.liveTrace.filter(step => step.kind === 'assistant').map(step => step.detail)).toEqual(['first', 'second'])
    expect(host.getSessionEvents(sessionId)!.liveTrace.filter(step => step.kind === 'tool_call')).toHaveLength(2)
    expect(host.getSessionEvents('other')!.events).toEqual([])
    expect(host.getSessionEvents('other')!.liveTrace).toEqual([])
    const restored = createStandaloneHost({ stateDir: cwd, port: 0 })
    hosts.push(restored)
    expect(restored.getSessionEvents(sessionId)!.events).toEqual(host.getSessionEvents(sessionId)!.events)
    expect(restored.getSessionEvents(sessionId)!.liveTrace).toEqual(host.getSessionEvents(sessionId)!.liveTrace)
  })

  it('does not let a cancelled driver publish stale text or finish a newer turn', async () => {
    const firstGate = deferred()
    const secondGate = deferred()
    let starts = 0
    const { host, agent, sessionId } = await session({ driver: async input => {
      const first = ++starts === 1
      input.onEvent('assistant/step', { messageId: 'reply', text: first ? 'old prefix' : 'new prefix', streaming: true })
      await (first ? firstGate.promise : secondGate.promise)
      input.onEvent('assistant/step', { messageId: 'reply', text: first ? 'STALE FINAL' : 'new final', streaming: false })
      return first ? 'STALE FINAL' : 'new final'
    } })
    agent.followup(prompt('first'))
    await vi.waitFor(() => expect(starts).toBe(1))
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    agent.followup(prompt('second'))
    await vi.waitFor(() => expect(starts).toBe(2))
    firstGate.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(agent.status).toBe('running')
    expect(JSON.stringify(host.getSessionEvents(sessionId))).not.toContain('STALE FINAL')
    secondGate.resolve()
    await agent.whenIdle()
    expect(host.getSessionEvents(sessionId)!.liveTrace.filter(step => step.kind === 'assistant').map(step => step.detail)).toEqual(['old prefix', 'new final'])
    expect(host.getSessionEvents(sessionId)!.liveTrace.find(step => step.detail === 'old prefix')!.streaming).toBe(false)
  })

  it('assigns new reply identities after a host restore even for non-streaming custom drivers', async () => {
    const { host, agent, cwd, sessionId } = await session({ driver: async () => 'same answer' })
    agent.followup(prompt('first'))
    await agent.whenIdle()
    const restored = createStandaloneHost({ stateDir: cwd, port: 0, driver: async () => 'same answer' })
    hosts.push(restored)
    const controller = restored.ctx.get('sessionController') as unknown as { resolveAgent: (id: string) => Promise<unknown> }
    await controller.resolveAgent(sessionId)
    const nextAgent = restored.agents.get(sessionId)!
    nextAgent.followup(prompt('second'))
    await nextAgent.whenIdle()
    expect(restored.getSessionEvents(sessionId)!.liveTrace.filter(step => step.kind === 'assistant')).toHaveLength(2)
    expect(host.getSessionEvents(sessionId)!.liveTrace.filter(step => step.kind === 'assistant')).toHaveLength(1)
  })

  it('preserves manual tool execution and exposes both its call and failure result', async () => {
    const { host, agent, sessionId } = await session()
    agent.tools.set('read', { name: 'read', description: 'Read', execute: async () => ({ value: 42 }) })
    await expect(host.executeSessionTool(sessionId, 'read', {})).resolves.toEqual({ value: 42 })
    agent.tools.set('fail', { name: 'fail', description: 'Fail', execute: async () => { throw new Error('failed tool') } })
    await expect(host.executeSessionTool(sessionId, 'fail', {})).rejects.toThrow('failed tool')
    expect(host.getSessionEvents(sessionId)!.liveTrace.map(step => step.kind)).toEqual(['tool_call', 'tool_result', 'tool_call', 'tool_result'])
    expect(host.getSessionEvents(sessionId)!.liveTrace.at(-1)).toMatchObject({ title: '工具失败 fail', detail: 'failed tool' })
  })

  it('turn errors reach the visible trace and settle to idle', async () => {
    const { host, agent, sessionId } = await session({ driver: () => { throw new Error('provider unavailable') } })
    agent.followup(prompt())
    await agent.whenIdle()
    expect(host.getSessionEvents(sessionId)).toMatchObject({ status: 'idle', liveTrace: [{ kind: 'step', title: '执行失败', detail: 'provider unavailable' }] })
  })
})

describe('provider event projections', () => {
  it('keeps repeated legacy replies distinct across user turns while folding a legacy final echo', () => {
    const { events, emit } = sink()
    emit('assistant/step', { text: 'same answer' })
    emit('assistant/message', { message: { content: [{ type: 'text', text: 'same answer' }] } })
    emit('user/message', prompt('next'))
    emit('assistant/message', { message: { content: [{ type: 'text', text: 'same answer' }] } })
    expect(projectLiveTrace(events).filter(step => step.kind === 'assistant')).toHaveLength(2)
  })

  it('streams full DSH text, deduplicates frames/block ends, excludes private reasoning and joins the durable final message', () => {
    const { events, emit } = sink()
    const collector = createDshEventCollector(emit)
    const chunk = (index: number, value: unknown) => collector.streamFrame({ type: 'chunk', attemptId: 'attempt', index, chunk: value })
    collector.streamFrame({ type: 'start', attemptId: 'attempt', turn: 1, step: 1 })
    chunk(0, { type: 'reasoning-delta', index: 0, text: 'PRIVATE REASONING' })
    chunk(1, { type: 'text-delta', index: 1, text: 'first' })
    expect(projectLiveTrace(events)).toMatchObject([{ kind: 'assistant', detail: 'first', streaming: true }])
    chunk(1, { type: 'text-delta', index: 1, text: 'duplicate' })
    const full = 'first' + '长正文'.repeat(4000)
    chunk(2, { type: 'text-delta', index: 1, text: '长正文'.repeat(4000) })
    chunk(3, { type: 'block-end', index: 1, block: { type: 'text', text: full } })
    collector.sessionEvent({ type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'native-message', content: [{ type: 'reasoning', text: 'PRIVATE REASONING' }, { type: 'text', text: full }] } } })
    collector.streamFrame({ type: 'end', attemptId: 'attempt', outcome: { kind: 'committed', eventType: 'assistant/message' } })
    collector.flush()
    collector.close()
    expect(projectLiveTrace(events)).toHaveLength(1)
    expect(projectLiveTrace(events)[0]).toMatchObject({ detail: full, streaming: false })
    expect(JSON.stringify(events)).not.toContain('PRIVATE')
    expect(JSON.stringify(events)).not.toContain('duplicate')
  })

  it('accepts block-only DSH replies, modern and legacy tool results without output truncation', () => {
    const { events, emit } = sink()
    const collector = createDshEventCollector(emit)
    collector.streamFrame({ type: 'start', attemptId: 'block-only' })
    collector.streamFrame({ type: 'chunk', attemptId: 'block-only', index: 0, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'block body' } } })
    collector.sessionEvent({ type: 'tool/call', data: { callId: 'call', name: 'read', arguments: '{}' } })
    const output = 'file body'.repeat(1000)
    collector.sessionEvent({ type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'call', content: [{ type: 'text', text: output }] } } })
    collector.sessionEvent({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'legacy', content: [{ type: 'text', text: 'legacy result' }] }] } } })
    collector.flush()
    collector.close()
    expect(projectLiveTrace(events).find(step => step.kind === 'assistant')!.detail).toBe('block body')
    expect(projectLiveTrace(events).find(step => step.title === '工具结果 read')!.detail).toBe(output)
    expect(projectLiveTrace(events).at(-1)!.detail).toContain('legacy result')
  })

  it('collects Codex text deltas and native tool results without turning reasoning into tools or replies', () => {
    const { events, emit } = sink()
    const collector = createCodexEventCollector(emit)
    collector.notification('item/started', { item: { type: 'reasoning', id: 'secret', text: 'PRIVATE' } })
    collector.notification('item/agentMessage/delta', { itemId: 'message', delta: 'hello ' })
    expect(projectLiveTrace(events)[0]!.detail).toBe('hello ')
    collector.notification('item/agentMessage/delta', { itemId: 'message', delta: 'world' })
    collector.notification('item/started', { item: { id: 'command', type: 'commandExecution', command: 'test' } })
    collector.notification('item/completed', { item: { id: 'command', type: 'commandExecution', command: 'test', aggregatedOutput: 'result'.repeat(2000) } })
    collector.notification('item/completed', { item: { id: 'message', type: 'agentMessage', text: 'hello world' } })
    collector.notification('item/completed', { item: { id: 'message', type: 'agentMessage', text: 'hello world' } })
    collector.flush()
    collector.close()
    const trace = projectLiveTrace(events)
    expect(trace.filter(step => step.kind === 'assistant')).toMatchObject([{ detail: 'hello world', streaming: false }])
    expect(trace.filter(step => step.kind === 'assistant')).toHaveLength(1)
    expect(trace.find(step => step.kind === 'tool_result')!.detail).toBe('result'.repeat(2000))
    expect(JSON.stringify(events)).not.toContain('PRIVATE')
  })

  it('does not duplicate Cursor partial, model-call flush, final flush and aggregate result messages', () => {
    const { events, emit } = sink()
    const collector = createCursorEventCollector(emit)
    const assistant = (text: string, extra: Record<string, unknown> = {}) => collector.event({ type: 'assistant', message: { content: [{ type: 'text', text }, { type: 'thinking', thinking: 'PRIVATE' }] }, ...extra })
    assistant('hello ', { timestamp_ms: 1 })
    assistant('hello ', { timestamp_ms: 2, model_call_id: 'flush' })
    collector.event({ type: 'tool_call', subtype: 'started', call_id: 'tool', tool_call: { readToolCall: { args: { path: 'file' } } } })
    collector.event({ type: 'tool_call', subtype: 'completed', call_id: 'tool', tool_call: { readToolCall: { args: { path: 'file' }, result: { success: true } } } })
    assistant('world', { timestamp_ms: 3 })
    assistant('world')
    collector.event({ type: 'result', result: 'hello world' })
    collector.flush()
    collector.close()
    expect(projectLiveTrace(events).filter(step => step.kind === 'assistant').map(step => step.detail)).toEqual(['hello ', 'world'])
    expect(projectLiveTrace(events).filter(step => step.kind.startsWith('tool_'))).toHaveLength(2)
    expect(collector.text).toBe('world')
    expect(JSON.stringify(events)).not.toContain('PRIVATE')
  })
})

function nativeLog(sessionId: string, cwd: string) {
  const root = join(tmpdir(), `dsh-turn-session-${encodeURIComponent(sessionId)}`)
  directories.push(root)
  const slug = `--${cwd.replace(/[^A-Za-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')}--`
  const folder = join(root, 'sessions', slug, 'dsh-superagent-test')
  mkdirSync(folder, { recursive: true })
  return folder
}

describe('historical DSH trace fallback', () => {
  it('isolates same-cwd sessions and reads complete compressed frames with full body and tool results', () => {
    const cwd = temporary()
    const id = randomUUID()
    const folder = nativeLog(id, cwd)
    const other = nativeLog(randomUUID(), cwd)
    const full = '完整回复'.repeat(3000)
    const text = (body: string) => JSON.stringify({ type: 'assistant/message', time: 1, data: { message: { content: [{ type: 'reasoning', text: 'PRIVATE' }, { type: 'text', text: body }] } } }) + '\n'
    const firstFrame = zstdCompressSync(Buffer.from(text(full)))
    const secondFrame = zstdCompressSync(Buffer.from(JSON.stringify({ type: 'tool/result', time: 2, data: { message: { role: 'tool', toolCallId: 'call', content: [{ type: 'text', text: 'tool body' }] } } }) + '\n'))
    writeFileSync(join(folder, 'session.v4.jsonl.zstd'), Buffer.concat([firstFrame, secondFrame.subarray(0, 8)]))
    writeFileSync(join(other, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(text('OTHER SESSION'))))
    expect(readLiveDshTrace(id, cwd)).toMatchObject([{ kind: 'assistant', detail: full }])
    writeFileSync(join(folder, 'session.v4.jsonl.zstd'), Buffer.concat([firstFrame, secondFrame]))
    const trace = readLiveDshTrace(id, cwd)
    expect(trace).toHaveLength(2)
    expect(trace[0]!.detail).toBe(full)
    expect(trace[1]).toMatchObject({ kind: 'tool_result', detail: 'tool body' })
    expect(JSON.stringify(trace)).not.toContain('PRIVATE')
    expect(JSON.stringify(trace)).not.toContain('OTHER SESSION')
  })

  it('retains all complete plain JSONL events even while its last line is unfinished', () => {
    const cwd = temporary()
    const id = randomUUID()
    const folder = nativeLog(id, cwd)
    const lines = Array.from({ length: 85 }, (_, seq) => JSON.stringify({ seq, type: 'tool/call', data: { callId: `call:${seq}`, name: 'read', arguments: '{}' } }))
    writeFileSync(join(folder, 'session.v4.jsonl'), lines.join('\n') + '\n{"type":')
    expect(readLiveDshTrace(id, cwd)).toHaveLength(85)
  })
})
