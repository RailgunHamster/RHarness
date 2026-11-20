import { readFile } from 'node:fs/promises'
import type { CatalogGroup, runDshTurn } from './local-drivers.ts'

export function ollamaBase() { return (process.env.RHARNESS_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '') }

export async function discoverOllama(): Promise<CatalogGroup | undefined> {
  try {
    const res = await fetch(ollamaBase() + '/api/tags', { signal: AbortSignal.timeout(1200) })
    if (!res.ok) return undefined
    const data = await res.json() as { models?: { name?: string }[] }
    const models = (data.models ?? []).flatMap(model => typeof model.name === 'string' && model.name ? [{ id: model.name, name: model.name }] : [])
    if (models.length) return { id: 'ollama-local', name: 'Ollama', models }
  } catch {}
  return undefined
}

type Call = { function: { name: string; arguments: Record<string, unknown> } }
type Message = { role: string; content: string; images?: string[]; tool_calls?: Call[]; tool_name?: string }

export async function runOllamaTurn(input: Parameters<typeof runDshTurn>[0], admit: <T>(request: () => Promise<T>) => Promise<T> = request => request()): Promise<string> {
  const messages: Message[] = [{ role: 'system', content: input.systemPrompt }]
  for (const original of input.messages) {
    const images: string[] = []
    for (const part of original.content) if (part.type === 'image' && typeof part.path === 'string') {
      images.push((await readFile(part.path, { signal: input.signal })).toString('base64'))
    }
    messages.push({ role: original.role, content: original.content.flatMap(p => typeof p.text === 'string' ? [p.text] : []).join('\n'), ...(images.length ? { images } : {}) })
  }
  const tools = [...input.tools.values()].map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters ?? { type: 'object', properties: {} } } }))
  for (let step = 0; step < 32; step++) {
    const data = await admit(async () => {
      const res = await fetch(ollamaBase() + '/api/chat', { method: 'POST', signal: input.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: input.model, messages, stream: false, ...(tools.length ? { tools } : {}) }) })
      if (!res.ok) throw new Error('Ollama returned HTTP ' + res.status + ' Retry-After ' + (res.headers.get('retry-after') ?? '5'))
      return await res.json() as { message?: Message; error?: string }
    })
    const reply = data.message
    if (!reply || data.error) throw new Error('Ollama returned no assistant message')
    if (!reply.tool_calls?.length) return reply.content
    messages.push(reply)
    for (const [index, call] of reply.tool_calls.entries()) {
      input.signal.throwIfAborted()
      const tool = input.tools.get(call.function.name)
      if (!tool) throw new Error('Ollama requested an unavailable tool')
      const callId = 'ollama-' + step + '-' + index
      input.onEvent?.('tool/call', { tool: tool.name, toolCallId: callId, arguments: call.function.arguments })
      const result = await tool.execute(call.function.arguments, { signal: input.signal })
      input.onEvent?.('tool/result', { tool: tool.name, toolCallId: callId, output: result })
      input.onToolResult?.(tool.name, result)
      messages.push({ role: 'tool', tool_name: tool.name, content: typeof result === 'string' ? result : JSON.stringify(result) ?? '' })
    }
  }
  throw new Error('Ollama turn reached its tool-step limit')
}
