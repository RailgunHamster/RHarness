// @vitest-environment jsdom
/** Verifies image-only conversation input and incremental live session rendering without the embedded App context. */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PanelComposerModal, PanelConversation } from '../src/client/standalone-composer.tsx'
import { readPanelDraft, readPanelPreferences, writePanelDraft, writePanelPreferences, readPanelDraftImages, writePanelDraftImages, type PanelImageDraft } from '../src/client/panel-draft.ts'

const imageDrafts = vi.hoisted(() => new Map<string, PanelImageDraft[]>())
vi.mock('../src/client/panel-draft.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/client/panel-draft.ts')>(),
  readPanelDraftImages: vi.fn(async (conversation: string) => imageDrafts.get(conversation) ?? []),
  writePanelDraftImages: vi.fn(async (conversation: string, images: PanelImageDraft[]) => { imageDrafts.set(conversation, images) }),
}))
import { LiveWorkspace, useLiveSession } from '../src/client/standalone-activity.tsx'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const request = vi.fn<typeof fetch>()
beforeEach(() => {
  localStorage.clear(); imageDrafts.clear()
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  vi.stubGlobal('fetch', request)
})
afterEach(() => {
  act(() => root.unmount()); container.remove()
  vi.unstubAllGlobals(); vi.useRealTimers(); request.mockReset()
})
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const render = async (node: ReactNode) => act(async () => { root.render(node) })
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === name)!
const png = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'screen.png', { type: 'image/png' })
async function input(element: HTMLInputElement | HTMLTextAreaElement, text: string) {
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, text)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function reopen() {
  await act(async () => root.unmount())
  root = createRoot(container)
  await render(<PanelConversation lang="zh" />)
}

it('saves each edit synchronously and restores text, reply target, settings, and images after reopening', async () => {
  request.mockImplementation(async () => json({ messages: [{ id: 'm1', sender: 'operator', text: 'original', at: '2026-11-07T10:00:00Z' }] }))
  await render(<PanelConversation lang="zh" />)
  await input(document.querySelector('textarea')!, '未发送的消息\n第二行')
  expect(readPanelDraft('main').text).toBe('未发送的消息\n第二行')
  await act(async () => button('回复此消息').click())
  const settings = document.querySelectorAll<HTMLInputElement>('.dt-conversation-settings input')
  await input(settings[1]!, 'reviewer')
  await act(async () => document.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
  await choose(png)
  await reopen()
  expect(document.querySelector('textarea')?.value).toBe('未发送的消息\n第二行')
  expect(document.body.textContent).toContain('回复：original')
  expect(document.querySelector('.dt-image-previews img')).not.toBeNull()
  expect(readPanelPreferences()).toMatchObject({ sender: 'reviewer', autoAccept: true })
  expect(document.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
})
it('isolates drafts and reply targets when switching topics and restores the selected topic', async () => {
  request.mockImplementation(async () => json({ messages: [{ id: 'm1', sender: 'operator', text: 'original', at: '2026-11-07T10:00:00Z' }] }))
  await render(<PanelConversation lang="zh" />)
  await input(document.querySelector('textarea')!, 'main draft')
  await act(async () => button('回复此消息').click())
  const topic = () => document.querySelector<HTMLInputElement>('.dt-conversation-settings input')!
  await input(topic(), 'second')
  expect(document.querySelector('textarea')?.value).toBe('main draft')
  await act(async () => button('切换').click())
  expect(document.querySelector('textarea')?.value).toBe('')
  expect(document.body.textContent).not.toContain('回复：')
  await input(document.querySelector('textarea')!, 'second draft')
  await reopen()
  expect(topic().value).toBe('second')
  expect(document.querySelector('textarea')?.value).toBe('second draft')
  await input(topic(), 'main')
  await act(async () => button('切换').click())
  expect(document.querySelector('textarea')?.value).toBe('main draft')
  expect(document.body.textContent).toContain('回复：original')
})
it('lets users finish typing a topic ID while image restoration is pending', async () => {
  request.mockImplementation(async () => json({ messages: [] }))
  vi.mocked(readPanelDraftImages).mockImplementationOnce(() => new Promise(() => {}))
  await render(<PanelConversation lang="zh" />)
  const topic = document.querySelector<HTMLInputElement>('#local-chat-topic')!
  await act(async () => topic.focus())
  await input(topic, 'topic-part-one')
  await input(topic, 'topic-part-one-two')
  expect(topic.disabled).toBe(false)
  expect(document.activeElement).toBe(topic)
  expect(document.querySelector('.dt-conversation-settings summary')?.textContent).toContain('main')
  await act(async () => button('切换').click())
  expect(readPanelPreferences().conversation).toBe('topic-part-one-two')
})
it('retains the durable draft on failure and clears text, reply target, and attachments only after success', async () => {
  let fail = true
  request.mockImplementation(async (_url, init) => init?.method === 'POST'
    ? fail ? new Response(JSON.stringify({ error: 'offline' }), { status: 503 }) : json({ id: 'sent' })
    : json({ messages: [] }))
  writePanelDraft('main', { text: 'retry this', replyTo: 'm1' })
  writePanelPreferences({ conversation: 'main', sender: 'operator', autoAccept: true })
  await render(<PanelConversation lang="zh" />)
  await choose(png)
  await act(async () => button('发送消息').click())
  await reopen()
  expect(document.querySelector('textarea')?.value).toBe('retry this')
  expect(document.querySelector('.dt-image-previews img')).not.toBeNull()
  fail = false
  await act(async () => button('发送消息').click())
  await reopen()
  expect(document.querySelector('textarea')?.value).toBe('')
  expect(readPanelDraft('main')).toEqual({ text: '', replyTo: '' })
  expect(document.querySelector('.dt-image-previews img')).toBeNull()
})
it('reports storage failure while keeping typed text available to send', async () => {
  request.mockResolvedValue(json({ messages: [] }))
  const unavailable = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  try {
    await render(<PanelConversation lang="zh" />)
    await input(document.querySelector('textarea')!, 'keep this visible')
    expect(document.body.textContent).toContain('文字草稿读取或保存失败')
    expect(document.querySelector('textarea')?.value).toBe('keep this visible')
    expect(button('发送消息').disabled).toBe(false)
  } finally { unavailable.mockRestore() }
})
it('warns when browser storage cannot restore a text draft or conversation settings', async () => {
  request.mockImplementation(async () => json({ messages: [] }))
  const unavailable = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage denied') })
  try {
    await render(<PanelConversation lang="zh" />)
    expect(document.body.textContent).toContain('文字草稿读取或保存失败')
    expect(document.body.textContent).toContain('浏览器未能恢复或保存对话设置')
    expect(document.querySelector('textarea')?.disabled).toBe(false)
  } finally { unavailable.mockRestore() }
})
it('shows an image storage failure without discarding text or claiming a saved image draft', async () => {
  request.mockImplementation(async () => json({ messages: [] }))
  vi.mocked(readPanelDraftImages).mockRejectedValueOnce(new Error('storage denied'))
  await render(<PanelConversation lang="zh" />)
  await input(document.querySelector('textarea')!, 'text still works')
  expect(document.body.textContent).toContain('图片草稿无法访问')
  expect(document.body.textContent).not.toContain('草稿自动保存 · 刷新')
  vi.mocked(writePanelDraftImages).mockRejectedValueOnce(new Error('quota'))
  await choose(png)
  expect(document.querySelector('.dt-image-previews img')).not.toBeNull()
  expect(document.body.textContent).toContain('图片草稿无法访问')
  expect(button('发送消息').disabled).toBe(false)
})
it('sends with Ctrl+Enter while ordinary Enter leaves the multiline draft intact', async () => {
  request.mockImplementation(async (_url, init) => json(init?.method === 'POST' ? { id: 'sent' } : { messages: [] }))
  await render(<PanelConversation lang="zh" />)
  const textarea = document.querySelector('textarea')!
  await input(textarea, 'multiline message')
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })) })
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(textarea.value).toBe('')
})
async function choose(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
  await vi.waitFor(() => expect(button('发送消息').disabled).toBe(false))
}
it('previews and sends an image-only message and preserves it after a failed send', async () => {
  let fail = true
  const posted: Record<string, unknown>[] = []
  request.mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      if (fail) return new Response(JSON.stringify({ error: 'temporary failure' }), { status: 400 })
      return json({ id: 'panel:m1' })
    }
    return json({ messages: [] })
  })
  await render(<PanelComposerModal open lang="zh" onClose={() => {}} />)
  expect(button('发送消息').disabled).toBe(true)
  await choose(png)
  expect(document.querySelector('img')?.src).toMatch(/^data:image\/png;base64,/)
  await act(async () => { button('发送消息').click() })
  expect(document.body.textContent).toContain('temporary failure')
  expect(document.querySelector('img')).not.toBeNull()
  expect(posted[0]).toMatchObject({ text: '', content: [{ type: 'image', mediaType: 'image/png', name: 'screen.png' }] })
  fail = false
  await act(async () => { button('发送消息').click() })
  expect(document.querySelector('img')).toBeNull()
  expect(button('发送消息').disabled).toBe(true)
})
it('places the trimmed text part before image parts in a mixed message', async () => {
  const posted: Record<string, unknown>[] = []
  request.mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') { posted.push(JSON.parse(String(init.body)) as Record<string, unknown>); return json({ id: 'panel:mixed' }) }
    return json({ messages: [] })
  })
  await render(<PanelComposerModal open lang="zh" onClose={() => {}} />)
  await choose(png)
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '  inspect this screenshot  ')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { button('发送消息').click() })
  expect(posted[0]).toMatchObject({ text: 'inspect this screenshot', content: [
    { type: 'text', text: 'inspect this screenshot' },
    { type: 'image', mediaType: 'image/png', name: 'screen.png' },
  ] })
})
it('supports clipboard screenshots and removes an attachment before sending', async () => {
  request.mockResolvedValue(json({ messages: [] }))
  await render(<PanelComposerModal open lang="zh" onClose={() => {}} />)
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { files: [png], getData: () => '' } })
  await act(async () => { document.querySelector('textarea')!.dispatchEvent(event) })
  await vi.waitFor(() => expect(document.querySelector('img')).not.toBeNull())
  expect(event.defaultPrevented).toBe(true)
  await act(async () => { button('移除').click() })
  expect(document.querySelector('img')).toBeNull()
  expect(button('发送消息').disabled).toBe(true)
})
it('shows stored images and sends replyTo for a selected message', async () => {
  const posted: unknown[] = []
  request.mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') { posted.push(JSON.parse(String(init.body))); return json({ id: 'panel:next' }) }
    return json({ messages: [{ id: 'm1', sender: 'operator', text: 'inspect this', at: '2026-11-07T10:00:00Z',
      content: [{ type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'screen.png' }] }] })
  })
  await render(<PanelComposerModal open lang="zh" onClose={() => {}} />)
  expect(document.querySelector('img')?.alt).toBe('screen.png')
  await act(async () => { button('回复此消息').click() })
  await choose(png)
  await act(async () => { button('发送消息').click() })
  expect(posted[0]).toMatchObject({ replyTo: 'm1' })
})
it('polls only new conversation messages after downloading stored images once', async () => {
  vi.useFakeTimers()
  const seen: string[] = []
  request.mockImplementation(async url => {
    const path = String(url); seen.push(path)
    return json(path.includes('&after=') ? { messages: [], next: 1 } : { messages: [{ id: 'm1', sender: 'operator', text: '', at: '2026-11-07T10:00:00Z',
      content: [{ type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'screen.png' }] }], next: 1 })
  })
  await render(<PanelComposerModal open lang="zh" onClose={() => {}} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(seen.slice(1).every(path => path.endsWith('&after=1'))).toBe(true)
  expect(document.querySelectorAll('img')).toHaveLength(1)
})
it('reloads complete session history if a restarted host returns a smaller event cursor', async () => {
  vi.useFakeTimers()
  let initialReads = 0
  request.mockImplementation(async url => {
    if (String(url).includes('/events?')) return json({ sessionId: 'worker-task', status: 'idle', events: [], next: 1 })
    initialReads++
    return json({ id: 'worker-task', events: Array.from({ length: initialReads === 1 ? 2 : 1 }, () => ({ type: 'assistant/message', at: '', data: {
      content: [{ type: 'text', text: initialReads === 1 ? 'old history' : 'restored history' }],
    } })) })
  })
  function Harness() { const { detail } = useLiveSession('worker-task'); return <div>{detail?.events.map(event => JSON.stringify(event.data)).join('')}</div> }
  await render(<Harness />)
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(initialReads).toBe(2)
  expect(container.textContent).toContain('restored history')
  expect(container.textContent).not.toContain('old history')
})
it('updates a running worker reply from live snapshots without duplicating it and switches sessions safely', async () => {
  vi.useFakeTimers()
  const seen: string[] = []
  let turn = 0
  request.mockImplementation(async url => {
    const path = String(url); seen.push(path)
    if (path.endsWith('/sessions')) return json({ sessions: [
      { id: 'main', title: 'Main', status: 'running', model: {} },
      { id: 'worker-task', title: 'Fix UI', status: 'running', model: {} },
    ] })
    if (path.includes('/events?')) return json({ sessionId: 'worker-task', status: 'running', next: 1, events: [], liveTrace: [
      { seq: 1, at: '', kind: 'assistant', title: 'Assistant', detail: `Live reply ${++turn}` },
      { seq: 2, at: '', kind: 'tool/call', title: 'read file', detail: 'file.ts' },
    ] })
    return json({ id: path.includes('worker-task') ? 'worker-task' : 'main', title: 'Fix UI', status: 'running', model: {}, tools: [], events: [],
      liveTrace: [{ seq: 1, at: '', kind: 'assistant', title: 'Assistant', detail: 'Initial reply' }] })
  })
  await render(<LiveWorkspace lang="zh" onOpenSession={() => {}} />)
  expect(document.body.textContent).toContain('Initial reply')
  expect((document.querySelector('select') as HTMLSelectElement).value).toBe('worker-task')
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(document.body.textContent).toContain('Live reply 1')
  expect(document.body.textContent).not.toContain('Initial reply')
  expect(document.querySelectorAll('.dt-session-reply')).toHaveLength(1)
  expect(document.body.textContent).toContain('read file')
  expect(seen.some(path => path.endsWith('/events?after=0'))).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(seen.some(path => path.endsWith('/events?after=1'))).toBe(true)
  const select = document.querySelector('select')!
  await act(async () => { select.value = 'main'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(seen.at(-1)).toContain('/sessions/main')
})
