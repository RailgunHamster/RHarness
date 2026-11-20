import { randomBytes, randomInt } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { runNativeModelTurn } from './local-drivers.ts'
import type { RegisteredToolSpec, SessionTurnMessage } from './standalone-host.ts'

export type ProbeKind = 'text' | 'tools' | 'vision'
type Input = Parameters<typeof runNativeModelTurn>[0]
export interface ProbeResult { kind: ProbeKind; provider: string; model: string; passed: boolean; ms: number; at: string; reason?: string }

function colorCard(rgb: number[]) {
  const chunk = (name: string, data: Buffer) => {
    const tag = Buffer.from(name), header = Buffer.alloc(4), tail = Buffer.alloc(4)
    header.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(Buffer.concat([tag,data])))
    return Buffer.concat([header,tag,data,tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(48); header.writeUInt32BE(48,4); header[8] = 8; header[9] = 2
  const row = Buffer.from([0,...Array.from({ length: 48 }, () => rgb).flat()])
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',header),
    chunk('IDAT',deflateSync(Buffer.concat(Array.from({ length: 48 }, () => row)))), chunk('IEND',Buffer.alloc(0))])
}

export async function probeModel(selection: { provider: string; model: string }, kind: ProbeKind, driver: (input: Input) => Promise<string> = runNativeModelTurn): Promise<ProbeResult> {
  const started = Date.now(), nonce = randomBytes(8).toString('hex')
  const dir = mkdtempSync(join(tmpdir(),'rharness-probe-'))
  let expected = nonce, used = false
  const tools = new Map<string, RegisteredToolSpec>()
  const content: SessionTurnMessage['content'] = []
  try {
    if (selection.provider === 'human') throw new Error('Human session')
    if (kind === 'tools') {
      tools.set('probe_echo', { name: 'probe_echo', description: 'Return the test token.', parameters: { type: 'object', properties: {} }, execute: async () => { used = true; return { token: nonce } } })
      content.push({ type: 'text', text: 'Call probe_echo and reply with its token alone.' })
    } else if (kind === 'vision') {
      const index = randomInt(3)
      expected = ['red','green','blue'][index]!
      const file = join(dir,'sample.png')
      writeFileSync(file, colorCard([0,1,2].map(i => i === index ? 255 : 0)))
      content.push({ type: 'text', text: 'Name the solid color in this picture in one English word.' }, { type: 'image', path: file, mediaType: 'image/png' })
    } else content.push({ type: 'text', text: 'Reply with this exact token: ' + nonce })
    const result = await driver({ ...selection, cwd: dir, diagnostic: true, sessionId: 'probe-' + nonce, tools,
      systemPrompt: 'Respond only to the synthetic capability test.', messages: [{ id: nonce, role: 'user', content }], signal: AbortSignal.timeout(45_000) })
    const normalized = result.trim().toLowerCase().replace(/^[\s\x60"'*]+|[\s\x60"'*.!。]+$/g, '')
    const passed = kind === 'tools' ? used && result.includes(expected) : normalized === expected
    return { provider: selection.provider, model: selection.model, kind, passed, ms: Date.now() - started, at: new Date().toISOString() }
  } catch {
    return { ...selection, kind, passed: false, reason: 'Driver unavailable, unsupported or timed out', ms: Date.now() - started, at: new Date().toISOString() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
