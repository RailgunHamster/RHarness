// @vitest-environment jsdom
/** Checks the standalone workspace's primary task flow, brand icon, inline message receipts, inspector coordination, and pipeline view. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StandaloneRoot } from '../src/client/standalone-web.tsx'
import { formatSmartTimestamp } from '../src/client/standalone-api.ts'

vi.mock('../src/client/app.tsx', () => ({ App: () => <div data-testid="management-content">Management content</div> }))
vi.mock('../src/client/panel-draft.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/client/panel-draft.ts')>(),
  readPanelDraftImages: async () => [],
}))
declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('panel/messages')
    ? {
        messages: [
          { id: 'm1', sender: 'operator', text: '不要一直弹 shell 窗，见 D:\\git\\RHarness\\.artifacts\\openclaw-to-rharness-plan.md', at: '2026-11-07T15:42:06Z' },
        ],
        next: 1,
        receipts: {
          m1: {
            triggerId: 'panel:m1',
            kind: 'followup',
            ticketId: '809ac0ef46b95c33ce07874b59835bc8',
            ticketTitle: '面板重设计与防弹窗',
            ticketState: 'completed',
            sessionId: 'worker-809ac0ef46b95c33ce07874b59835bc8',
            branch: 'agent/panel-layout-redesign',
            acked: true,
          },
        },
        topics: [
          { conversation: 'main', title: '面板重设计与防弹窗', messageCount: 2, ticketCount: 1, status: 'completed', updatedAt: '2026-11-07T15:42:06Z' },
        ],
      }
    : url.includes('markdown/list')
      ? {
          items: [
            { path: '.artifacts/openclaw-to-rharness-plan.md', title: 'OpenClaw 迁移方案', group: 'artifacts', size: 1024, updatedAt: '2026-11-08T11:50:00Z', nodeName: 'claw' },
          ],
        }
    : url.includes('markdown/read')
      ? {
          path: '.artifacts/openclaw-to-rharness-plan.md',
          resolvedPath: 'D:/git/RHarness/.artifacts/openclaw-to-rharness-plan.md',
          title: 'OpenClaw 迁移方案',
          content: '# OpenClaw 迁移方案\n\n## 1. 业务盘点\n\n| 业务 | 建议 |\n|---|---|\n| 邮件与待办 | 首批只读接入 |',
          size: 1024,
          updatedAt: '2026-11-08T11:50:00Z',
          sourceNode: 'claw',
        }
    : url.includes('sessions/worker-809ac0ef46b95c33ce07874b59835bc8')
      ? {
          id: 'worker-809ac0ef46b95c33ce07874b59835bc8',
          title: '面板重设计与防弹窗',
          status: 'idle',
          cwd: '/work/wt',
          model: { provider: 'niumacode', model: 'gpt-6.1-sol' },
          tools: [],
          events: [],
          liveTrace: [{ seq: 1, at: '2026-11-07T15:43:00Z', kind: 'assistant', title: 'Assistant', detail: '已隐藏后台控制台窗口' }],
        }
      : {
          sessions: [
            { id: 'orchestrator-main', title: 'Main', status: 'idle', model: { provider: 'deepseek-official', model: 'deepseek-flash' } },
            { id: 'worker-809ac0ef46b95c33ce07874b59835bc8', title: '面板重设计与防弹窗', status: 'idle', model: { provider: 'niumacode', model: 'gpt-6.1-sol' } },
          ],
          roleModels: {
            eval: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
            executor: { provider: 'niumacode', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' },
          },
          modelProfiles: {
            config: {
              activeProfileId: 'profile-1',
              profiles: [
                {
                  id: 'profile-1',
                  name: '主力混合',
                  eval: { defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }, timeSlots: [] },
                  executor: { defaultModel: { provider: 'niumacode', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' }, timeSlots: [] },
                },
              ],
            },
            activeProfile: {
              id: 'profile-1',
              name: '主力混合',
              eval: { defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }, timeSlots: [] },
              executor: { defaultModel: { provider: 'niumacode', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' }, timeSlots: [] },
            },
            evalModel: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
            executorModel: { provider: 'niumacode', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' },
          },
          load: { running: 0, maxWorkers: 3 },
          assistantMessages: [
            { id: 'am-user-1', sender: 'operator', text: '今天有什么安排？', at: '2026-11-08T08:00:00Z' },
            { id: 'am-bot-1', sender: 'Claw', bot: true, text: '上午 10:00 有评审会议。', at: '2026-11-08T08:00:03Z' },
          ],
          pipeline: [
            {
              triggerId: 'panel:m1',
              source: 'panel',
              threadKey: 'panel:main',
              actor: 'operator',
              text: '不要一直弹 shell 窗',
              at: '2026-11-07T15:42:06Z',
              intake: { kind: 'followup', label: { zh: '并入运行工单', en: 'Follow-up to Ticket' }, detail: { zh: '执行器已确认接手', en: 'Acknowledged' } },
              ticket: { id: '809ac0ef46b95c33ce07874b59835bc8', title: '面板重设计与防弹窗', state: 'completed', branch: 'agent/panel-layout-redesign', sessionId: 'worker-809ac0ef46b95c33ce07874b59835bc8', acked: true },
              delivery: { state: 'merged', summary: '已完成并合入 main' },
            },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } })))
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('renders conversation and input first, management next, and live execution last with direct navigation', async () => {
  await act(async () => root.render(<StandaloneRoot />))
  const chat = container.querySelector('#local-chat')!
  const management = container.querySelector('#management')!
  const live = container.querySelector('#live-execution')!
  expect(container.querySelector('svg.dt-brand-logo')).not.toBeNull()
  expect(chat.querySelector('textarea')).not.toBeNull()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(chat.compareDocumentPosition(management) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(management.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(chat.querySelector('details')?.open).toBe(false)
  const links = [...container.querySelectorAll<HTMLAnchorElement>('.dt-workspace-nav a')]
  expect(links.map(link => link.getAttribute('href'))).toEqual(['#local-chat', '#management', '#live-execution'])
  expect(links.every(link => container.querySelector(link.getAttribute('href')!))).toBe(true)
})

it('shows inline message receipt cards, coordinates right-hand session inspection, and switches to the 4-stage pipeline audit', async () => {
  await act(async () => root.render(<StandaloneRoot />))
  expect(container.textContent).toContain('并入工单 #809ac0')
  expect(container.textContent).toContain('执行器已确认接手')
  expect(container.textContent).toContain('Eval:')
  expect(container.textContent).toContain('deepseek-flash (low)')
  expect(container.textContent).toContain('gpt-6.1-sol (xhigh)')

  const inspectBtn = [...container.querySelectorAll<HTMLButtonElement>('.dt-receipt-inspect-btn')][0]!
  await act(async () => { inspectBtn.click() })
  expect(container.querySelector<HTMLSelectElement>('#live-execution select')?.value).toBe('worker-809ac0ef46b95c33ce07874b59835bc8')

  const pipelineTab = [...container.querySelectorAll<HTMLButtonElement>('.dt-mode-tab')].find(btn => btn.textContent?.includes('管线追踪'))!
  await act(async () => { pipelineTab.click() })
  expect(container.textContent).toContain('1. 来源与触发 (Trigger)')
  expect(container.textContent).toContain('2. 路由与评估 (Intake / Eval)')
  expect(container.textContent).toContain('3. 归属工单 (Ticket)')
  expect(container.textContent).toContain('4. 交付结果 (Outbox / Git)')
})

it('keeps the inline input and draft while switching the workspace language', async () => {
  localStorage.clear()
  await act(async () => root.render(<StandaloneRoot />))
  const textarea = container.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'keep across language changes')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'English')!.click() })
  expect(container.querySelector('textarea')?.value).toBe('keep across language changes')
  expect(container.querySelector('#local-chat-title')?.textContent).toBe('Local chat')
  expect(container.querySelector('#live-execution')?.getAttribute('aria-label')).toBe('Live execution')
})

it('shows simple text in the profile group view, opens the standalone visual picker on 设置 or + 添加时间段, and saves on 保存并关闭', async () => {
  await act(async () => root.render(<StandaloneRoot />))
  const profilesBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '配置组')!
  await act(async () => { profilesBtn.click() })
  const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
  expect(dialogs().length).toBe(1)
  const profileDialog = dialogs()[0]!
  // Resting view shows only simple text summaries, with no giant inline picker or raw text inputs
  expect(profileDialog.textContent).toContain('deepseek-official / deepseek-flash · low')
  expect(profileDialog.textContent).toContain('niumacode / gpt-6.1-sol · xhigh')
  expect(profileDialog.querySelectorAll('.dt-model-picker').length).toBe(0)

  // Clicking "+ 添加时间段" opens the standalone visual configuration dialog
  const addSlotBtn = [...profileDialog.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('+ 添加时间段'))!
  await act(async () => { addSlotBtn.click() })
  expect(dialogs().length).toBe(2)
  const configDialog = dialogs()[1]!
  expect(configDialog.querySelectorAll('.dt-model-picker').length).toBe(1)
  expect(configDialog.querySelectorAll('.dt-model input').length).toBe(0)
  expect(configDialog.querySelectorAll('select.dt-select').length).toBe(2)

  // Clicking "保存并关闭" inside the visual configuration dialog commits the slot and returns to the simple text view
  const saveAndCloseBtn = [...configDialog.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '保存并关闭')!
  await act(async () => { saveAndCloseBtn.click() })
  expect(dialogs().length).toBe(1)
  expect(profileDialog.textContent).toContain('上午高峰段')
  expect(profileDialog.textContent).toContain('09:30 → 12:00')
})

it('formats non-today timestamps with Chinese year-month-day and opens/closes fullscreen message view via UI or ESC', async () => {
  const refNow = new Date(2026, 10, 8, 19, 15, 0)
  const sameDay = new Date(2026, 10, 8, 9, 5, 6).toISOString()
  const prevDay = new Date(2026, 10, 7, 19, 5, 45).toISOString()
  expect(formatSmartTimestamp(sameDay, 'zh', refNow)).toBe('09:05:06')
  expect(formatSmartTimestamp(prevDay, 'zh', refNow)).toBe('2026年11月7日 19:05:45')

  await act(async () => root.render(<StandaloneRoot />))
  const fullBtn = container.querySelector<HTMLButtonElement>('[data-testid="panel-fullscreen-m1"]')!
  expect(fullBtn).not.toBeNull()
  await act(async () => { fullBtn.click() })
  const modal = document.querySelector<HTMLElement>('.dt-modal.dt-fullscreen-modal')!
  expect(modal).not.toBeNull()
  expect(modal.textContent).toContain('不要一直弹 shell 窗')

  // Pressing Escape closes the expanded modal
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(document.querySelector('.dt-modal.dt-fullscreen-modal')).toBeNull()

  // Clicking the dark translucent backdrop (.dt-modal-mask) on the sides also closes the expanded modal
  await act(async () => { fullBtn.click() })
  expect(document.querySelector('.dt-modal.dt-fullscreen-modal')).not.toBeNull()
  const mask = document.querySelector<HTMLElement>('.dt-modal-mask')!
  await act(async () => { mask.click() })
  expect(document.querySelector('.dt-modal.dt-fullscreen-modal')).toBeNull()

  // Clicking a .md path in a chat message opens the floating Markdown Reader Modal with TOC outline and GFM table
  const mdLinkBtn = [...container.querySelectorAll<HTMLButtonElement>('button.dt-textlink')].find(b =>
    b.textContent?.includes('openclaw-to-rharness-plan.md'),
  )!
  expect(mdLinkBtn).not.toBeUndefined()
  await act(async () => { mdLinkBtn.click() })
  const mdModal = document.querySelector<HTMLElement>('.dt-modal.dt-fullscreen-modal')!
  expect(mdModal).not.toBeNull()
  expect(mdModal.textContent).toContain('OpenClaw 迁移方案')
  expect(mdModal.textContent).toContain('1. 业务盘点')
  expect(mdModal.querySelector('table.dt-table')).not.toBeNull()
  expect(mdModal.textContent).toContain('首批只读接入')
})

it('expands Personal Assistant into full-screen chat-app mode with self/bot bubbles and exits on button or ESC', async () => {
  await act(async () => root.render(<StandaloneRoot />))
  const assistantTab = container.querySelector<HTMLButtonElement>('[data-testid="view-tab-assistant"]')!
  await act(async () => { assistantTab.click() })

  const shell = container.querySelector<HTMLElement>('.dt-assistant-shell')!
  expect(shell).not.toBeNull()
  expect(shell.getAttribute('data-fullscreen')).toBeNull()

  const userBubble = container.querySelector<HTMLElement>('[data-testid="assistant-msg-am-user-1"]')!
  const botBubble = container.querySelector<HTMLElement>('[data-testid="assistant-msg-am-bot-1"]')!
  expect(userBubble.getAttribute('data-sender')).toBe('self')
  expect(botBubble.getAttribute('data-sender')).toBe('bot')

  const fsBtn = container.querySelector<HTMLButtonElement>('[data-testid="assistant-chat-fullscreen-btn"]')!
  expect(fsBtn.textContent).toContain('全屏对话')
  await act(async () => { fsBtn.click() })
  expect(shell.getAttribute('data-fullscreen')).toBe('true')
  expect(document.body.style.overflow).toBe('hidden')
  expect(fsBtn.textContent).toContain('退出全屏')

  // Pressing Escape exits full-screen chat mode and restores page scrolling
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(shell.getAttribute('data-fullscreen')).toBeNull()
  expect(document.body.style.overflow).toBe('')
})
