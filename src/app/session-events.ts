/** Public, provider-neutral execution events. Reasoning and provider-private payloads never enter this projection. */
export interface SessionExecutionEvent {
  type: string
  data: unknown
  at: string
}

export interface LiveTraceStep {
  seq: number
  at: string
  kind: 'tool_call' | 'tool_result' | 'assistant' | 'step'
  title: string
  detail?: string
  /** Stable identity across partial snapshots and the final transcript message. */
  id?: string
  streaming?: boolean
}

type Emit = (type: string, data: Record<string, unknown>) => void
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {}
const printable = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value ?? '')

/** Only text blocks are assistant speech; reasoning, replay state and stream records are deliberately excluded. */
export function assistantText(data: unknown): string {
  const value = record(data)
  if (typeof value.text === 'string') return value.text
  const content = record(value.message).content
  return Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') : ''
}

/** Coalesce token bursts while publishing the first token immediately and always flushing the complete body. */
export function createAssistantPublisher(emit: Emit) {
  const states = new Map<string, { text: string; data: Record<string, unknown>; published?: string; streaming?: boolean; timer?: ReturnType<typeof setTimeout> }>()
  const publish = (messageId: string) => {
    const state = states.get(messageId)!
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
    const streaming = state.data.streaming === true
    if (!state.text || (state.published === state.text && state.streaming === streaming)) return
    state.published = state.text
    state.streaming = streaming
    emit('assistant/step', { ...state.data, messageId, text: state.text })
  }
  return {
    update(messageId: string, text: string, data: Record<string, unknown> = {}, complete = false) {
      const state = states.get(messageId) ?? { text: '', data: {} }
      state.text = text
      state.data = { ...data, streaming: !complete }
      states.set(messageId, state)
      if (complete || state.published === undefined) publish(messageId)
      else state.timer ??= setTimeout(() => publish(messageId), 100)
    },
    flush() {
      for (const id of states.keys()) publish(id)
    },
    close() {
      for (const state of states.values()) if (state.timer) clearTimeout(state.timer)
    },
  }
}

/** Bridge both current DSH live frames and legacy/current durable session events into safe visible facts. */
export function createDshEventCollector(emit: Emit) {
  const publisher = createAssistantPublisher(emit)
  const calls = new Map<string, string>()
  let active: { id: string; turn?: number; step?: number; lastIndex: number; blocks: Map<number, string> } | undefined
  let serial = 0
  const body = () => [...(active?.blocks ?? [])].sort(([a], [b]) => a - b).map(([, text]) => text).join('')
  return {
    sessionEvent(event: { type: string; data?: unknown; seq?: number }) {
      const data = record(event.data)
      if (event.type === 'step/start') {
        emit(event.type, { turn: data.turn, step: data.step })
      } else if (event.type === 'tool/call') {
        const toolCallId = data.callId ?? data.toolCallId
        if (toolCallId) calls.set(toolCallId, data.name ?? data.tool)
        emit(event.type, { tool: data.name ?? data.tool, toolCallId, arguments: data.arguments, turn: data.turn, step: data.step })
      } else if (event.type === 'tool/result') {
        const message = record(data.message)
        const content = Array.isArray(message.content) ? message.content : []
        const legacy = content.filter(block => block?.type === 'tool-result')
        if (legacy.length) {
          for (const item of legacy) emit(event.type, {
            tool: calls.get(item.toolCallId), toolCallId: item.toolCallId, isError: item.isError === true,
            output: printable(item.content), turn: data.turn, step: data.step,
          })
        } else {
          const toolCallId = message.toolCallId ?? message.source?.callId ?? data.toolCallId
          const visible = content.filter(block => block?.type === 'text' && typeof block.text === 'string')
          emit(event.type, {
            tool: calls.get(toolCallId), toolCallId, isError: message.isError === true,
            output: visible.map(block => block.text).join('\n'),
            message: { role: 'tool', toolCallId, content: visible }, turn: data.turn, step: data.step,
          })
        }
      } else if (event.type === 'assistant/message') {
        const text = assistantText(data)
        const id = active?.id ?? `dsh-message:${record(data.message).id ?? event.seq ?? serial++}`
        publisher.update(id, text, { turn: data.turn, step: data.step, ...(data.interrupted ? { interrupted: true } : {}) }, true)
      }
    },
    streamFrame(value: unknown) {
      const frame = record(value)
      if (frame.type === 'start') {
        active = { id: `dsh-attempt:${frame.attemptId ?? ++serial}`, turn: frame.turn, step: frame.step, lastIndex: -1, blocks: new Map() }
      } else if (frame.type === 'chunk' && active && active.id === `dsh-attempt:${frame.attemptId}` && frame.index > active.lastIndex) {
        active.lastIndex = frame.index
        const chunk = record(frame.chunk)
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          active.blocks.set(chunk.index, (active.blocks.get(chunk.index) ?? '') + chunk.text)
        } else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
          active.blocks.set(chunk.index, chunk.block.text)
        } else return
        publisher.update(active.id, body(), { turn: active.turn, step: active.step })
      } else if (frame.type === 'end' && active && active.id === `dsh-attempt:${frame.attemptId}`) {
        // The durable message has already settled before a committed end frame. Failed attempts may only have a prefix.
        if (frame.outcome?.kind !== 'committed' || frame.outcome?.eventType !== 'assistant/message') {
          publisher.update(active.id, body(), { turn: active.turn, step: active.step, interrupted: true }, true)
        }
        active = undefined
      }
    },
    flush: publisher.flush,
    close: publisher.close,
  }
}

const CODEX_TOOLS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView'])

/** Codex notifications include private reasoning items; only explicitly public message/tool item types are projected. */
export function createCodexEventCollector(emit: Emit) {
  const publisher = createAssistantPublisher(emit)
  const texts = new Map<string, string>()
  const calls = new Set<string>()
  const results = new Set<string>()
  let serial = 0
  const toolCall = (id: string, tool: unknown, args: unknown) => {
    if (calls.has(id)) return
    calls.add(id)
    emit('tool/call', { toolCallId: id, tool, arguments: args })
  }
  const toolResult = (id: string, tool: unknown, output: unknown, isError = false) => {
    if (results.has(id)) return
    results.add(id)
    emit('tool/result', { toolCallId: id, tool, output: printable(output), isError })
  }
  return {
    notification(method: string, params: Record<string, unknown>) {
      if (method === 'item/agentMessage/delta') {
        if (typeof params.delta !== 'string') return
        const id = `codex:${params.itemId ?? 'message'}`
        const text = (texts.get(id) ?? '') + params.delta
        texts.set(id, text)
        publisher.update(id, text)
      } else if (method === 'item/started' || method === 'item/completed') {
        const item = record(params.item)
        const id = `codex:${item.callId ?? item.id ?? ++serial}`
        if (item.type === 'agentMessage') {
          if (method === 'item/completed') {
            const text = typeof item.text === 'string' ? item.text : texts.get(id) ?? ''
            texts.set(id, text)
            publisher.update(id, text, {}, true)
          }
        } else if (CODEX_TOOLS.has(item.type)) {
          const tool = item.tool ?? item.name ?? item.type
          toolCall(id, tool, item.arguments ?? item.command ?? item.changes ?? item.query ?? {})
          if (method === 'item/completed') toolResult(id, tool, item.aggregatedOutput ?? item.output ?? item.contentItems ?? item.changes ?? item.result ?? item.status ?? '', item.status === 'failed' || !!item.error)
        }
      }
    },
    toolCall,
    toolResult,
    flush: publisher.flush,
    close: publisher.close,
  }
}

/** Cursor stream-json partials have two duplicate flush forms; consume only timestamped deltas without model_call_id. */
export function createCursorEventCollector(emit: Emit) {
  const publisher = createAssistantPublisher(emit)
  const calls = new Set<string>()
  const results = new Set<string>()
  let segment = 0
  let text = ''
  let aggregate = ''
  let boundary = false
  let failure: string | undefined
  const id = () => `cursor:${segment}`
  return {
    event(value: unknown) {
      const event = record(value)
      if (event.type === 'assistant') {
        if (event.timestamp_ms === undefined || event.model_call_id !== undefined) return
        const delta = assistantText(event)
        if (!delta) return
        if (boundary) { segment++; text = ''; boundary = false }
        text += delta
        aggregate += delta
        publisher.update(id(), text)
      } else if (event.type === 'tool_call') {
        if (text && !boundary) { publisher.update(id(), text, {}, true); boundary = true }
        const [key, raw] = Object.entries(record(event.tool_call))[0] ?? ['tool', {}]
        const tool = record(raw)
        const toolCallId = String(event.call_id ?? tool.args?.toolCallId ?? `${segment}:${key}`)
        const name = tool.name ?? key
        if (!calls.has(toolCallId)) {
          calls.add(toolCallId)
          emit('tool/call', { toolCallId, tool: name, arguments: tool.args ?? tool.arguments ?? {} })
        }
        if (event.subtype === 'completed' && !results.has(toolCallId)) {
          results.add(toolCallId)
          emit('tool/result', { toolCallId, tool: name, output: printable(tool.result ?? event.result ?? ''), isError: !!tool.result?.error })
        }
      } else if (event.type === 'result') {
        if (event.is_error) { failure = String(event.result ?? 'Cursor turn failed'); return }
        if (typeof event.result === 'string') {
          // The terminal result aggregates all segments. Reconcile an unflushed suffix, but never append it twice.
          const suffix = event.result.startsWith(aggregate) ? event.result.slice(aggregate.length) : !aggregate ? event.result : ''
          if (suffix) {
            if (boundary) { segment++; text = ''; boundary = false }
            text += suffix
            aggregate += suffix
          }
        }
        publisher.update(id(), text, {}, true)
      }
    },
    get text() { return text },
    get failure() { return failure },
    flush: publisher.flush,
    close: publisher.close,
  }
}

/** Reconstruct a complete visible snapshot. Stable message IDs replace partials instead of duplicating final replies. */
export function projectLiveTrace(events: readonly SessionExecutionEvent[]): LiveTraceStep[] {
  const steps: LiveTraceStep[] = []
  const byId = new Map<string, LiveTraceStep>()
  let lastAssistant: LiveTraceStep | undefined
  for (const [seq, event] of events.entries()) {
    const data = record(event.data)
    if (event.type === 'assistant/step' || event.type === 'assistant/message') {
      const text = assistantText(data)
      if (!text.trim()) continue
      const suppliedId = data.messageId ?? record(data.message).id
      // Legacy drivers returned their last assistant/step again as assistant/message without an identity.
      const id = suppliedId ? `assistant:${suppliedId}` : event.type === 'assistant/message' && lastAssistant?.detail === text
        ? lastAssistant.id! : `assistant:${seq}`
      const existing = byId.get(id)
      if (existing) {
        existing.detail = text
        existing.streaming = data.streaming === true
      } else {
        const step: LiveTraceStep = { id, seq, at: event.at, kind: 'assistant', title: '模型回复', detail: text, streaming: data.streaming === true }
        steps.push(step)
        byId.set(id, step)
      }
      lastAssistant = event.type === 'assistant/step' ? byId.get(id) : undefined
    } else if (event.type === 'user/message') {
      lastAssistant = undefined
    } else if (event.type === 'tool/call' || event.type === 'tool/result') {
      const result = event.type === 'tool/result'
      const callId = data.toolCallId ?? data.callId
      const id = `${result ? 'result' : 'call'}:${callId ?? seq}`
      if (byId.has(id)) continue
      const detail = result ? printable(data.output ?? data.result ?? record(data.message).content ?? '') : printable(data.arguments ?? {})
      const step: LiveTraceStep = { id, seq, at: event.at, kind: result ? 'tool_result' : 'tool_call',
        title: `${result ? (data.isError ? '工具失败' : '工具结果') : '调用工具'} ${data.tool ?? data.name ?? callId ?? ''}`, detail }
      steps.push(step)
      byId.set(id, step)
    } else if (event.type === 'step/start' || event.type === 'turn/error' || event.type === 'turn/cancelled') {
      if (event.type !== 'step/start') for (const step of steps) if (step.kind === 'assistant') step.streaming = false
      steps.push({ id: `step:${seq}`, seq, at: event.at, kind: 'step', title: event.type === 'step/start' ? `Step ${data.step ?? '?'}` : event.type === 'turn/error' ? '执行失败' : '执行已取消',
        ...(data.message ? { detail: String(data.message) } : {}) })
    }
  }
  return steps
}
