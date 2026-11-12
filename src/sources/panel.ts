/**
 * Local Panel Source kind: allows people in the Web Panel to start threads, reply to tickets, and receive agent replies
 * directly in the panel without requiring an external GitHub or Feishu integration.
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { ContextMessage, SourceKind } from './kind.ts'
import type { StoredPanelContent } from './panel-images.ts'
export type { PanelContentPart } from './panel-images.ts'

export const PANEL_SOURCE = 'panel'

export const PanelConfigSchema = z.object({
  operatorId: z.string().trim().min(1).max(100).default('operator'),
  operatorName: z.string().trim().max(100).default('Operator'),
  listenAll: z.boolean().default(true),
}).strict()
export type PanelConfig = z.infer<typeof PanelConfigSchema>

export interface PanelStoredMessage {
  id: string
  conversation: string
  sender: string
  bot?: boolean
  text: string
  content?: StoredPanelContent[]
  at: string
  replyTo?: string
}

export function panelTrigger(message: {
  id: string
  conversation: string
  sender: string
  text: string
  at: string
  addressed?: 'mention' | 'direct'
  replyTo?: string
  content?: StoredPanelContent[]
}): Trigger {
  const thread = message.conversation
  return {
    id: key(PANEL_SOURCE, message.id),
    source: PANEL_SOURCE,
    threads: [{ source: PANEL_SOURCE, id: thread }],
    actor: { source: PANEL_SOURCE, id: message.sender },
    human: true,
    ...(message.addressed ? { addressed: message.addressed } : { addressed: 'direct' as const }),
    at: message.at,
    text: message.text,
    channel: {
      source: PANEL_SOURCE,
      thread: `${PANEL_SOURCE}:${thread}`,
      address: { conversation: thread, message: message.id },
    },
    meta: {
      conversation: thread,
      messageId: message.id,
      ...(message.content?.some(part => part.type === 'image') ? { images: message.content.flatMap(part => part.type === 'image' ? [part.image] : []) } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    },
  }
}

/** Outbound channel writer for Panel conversations: stores agent replies in `KV.panel.messages` so the UI and threadContext can read them. */
export async function sendPanel(host: Pick<SourceContext, 'state'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const conversation = message.channel.address.conversation
  if (!conversation) return 'gone'
  const keyName = KV.panel.messages(conversation)
  const existing = host.state.get(keyName) ?? []
  if (!existing.some(item => item.id === message.id)) {
    existing.push({
      id: message.id,
      conversation,
      sender: 'dsh-superagent',
      bot: true,
      text: message.text,
      at: new Date().toISOString(),
      ...(message.channel.address.message ? { replyTo: message.channel.address.message } : {}),
    })
    host.state.set(keyName, existing)
  }
  return 'sent'
}

export const panelKind: SourceKind<PanelConfig> = {
  kind: PANEL_SOURCE,
  title: { zh: '本地面板', en: 'Local panel' },
  description: {
    zh: '直接在管理面板发起对话与工单，并在同一线程查看智能体回复。',
    en: 'Start threads and Tickets directly from the management panel and read agent replies in the same Thread.',
  },
  schema: PanelConfigSchema,
  fields: [
    {
      key: 'operatorId',
      type: 'text',
      label: { zh: '默认操作员 ID', en: 'Default operator ID' },
      hint: {
        zh: '从面板直接发送消息时使用的发送者 ID；将该 ID 加入准入名单即可直接发起明确请求。',
        en: 'Sender ID used when posting from the panel; add it to the allowed list to originate explicit requests.',
      },
    },
    {
      key: 'operatorName',
      type: 'text',
      label: { zh: '显示名称', en: 'Display name' },
    },
    {
      key: 'listenAll',
      type: 'switch',
      label: { zh: '接收全部面板消息', en: 'Receive all panel messages' },
    },
  ],
  health: ['panel'],
  scope(_input, config) {
    return { listened: true, observed: config.listenAll, row: 'panel' }
  },
  channel: {
    allowed: () => true,
    send: async (host, message) => host.state ? sendPanel({ state: host.state }, message) : 'sent',
    link: address => ({
      url: `#trigger/${encodeURIComponent(`${PANEL_SOURCE}:${address.conversation ?? 'main'}`)}`,
      label: { zh: `面板对话 ${address.conversation ?? 'main'}`, en: `Panel thread ${address.conversation ?? 'main'}` },
    }),
  },
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? trigger.id),
    read: async (_commands, trigger) => {
      const messages: ContextMessage[] = [{
        id: String(trigger.meta.messageId ?? trigger.id),
        from: trigger.actor.id,
        at: trigger.at,
        text: trigger.text,
      }]
      return { messages, body: { messages } }
    },
  },
  repliesTo: trigger => typeof trigger.meta.replyTo === 'string' ? key(PANEL_SOURCE, trigger.meta.replyTo) : undefined,
  policy: {
    unnamed: { person: { zh: '面板用户', en: 'Panel user' }, bot: { zh: '面板机器人', en: 'Panel bot' } },
    schema: z.object({
      allowed: z.array(z.object({
        id: z.string().min(1),
        name: z.string().trim().max(100).optional(),
      }).strict()).default([{ id: 'operator', name: 'Operator' }]),
    }).strict(),
    fields: [
      {
        key: 'allowed',
        type: 'rows',
        label: { zh: '能发起工作的面板发送者', en: 'Panel senders who may originate work' },
        columns: [
          { key: 'id', type: 'text', label: { zh: '发送者 ID', en: 'Sender ID' } },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        ],
      },
    ],
    explicit: {
      zh: '名单内的人在本地面板发送消息即视为明确的请求。',
      en: 'Messages sent from the local panel by someone on the list are explicit requests.',
    },
    rows(stored) {
      const config = PanelConfigSchema.parse(stored)
      return [{
        id: 'panel',
        label: { zh: '面板消息', en: 'Panel messages' },
        note: config.listenAll ? { zh: '全部消息', en: 'All' } : { zh: '仅直接请求', en: 'Direct only' },
        cells: { listedUnaddressed: config.listenAll, unlistedAddressed: true, unlistedUnaddressed: config.listenAll },
      }]
    },
  },
  environment: {
    variables: [{
      key: 'DSH_SUPERAGENT_PANEL_THREAD',
      description: {
        zh: '发起工单的本地面板线程 ID；工单不是从面板发起时为空',
        en: 'Local panel thread ID that started the ticket; empty when the ticket did not start on the panel Source',
      },
    }],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_PANEL_THREAD: trigger?.source === PANEL_SOURCE ? String(trigger.meta.conversation ?? '') : '',
    }),
  },
}

export const name = 'dsh-superagent-panel'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(panelKind), 'panel: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, panelKind)
    void source.ready.then(() => {
      source.report('panel', health('ready', 'panelReady'))
    })
    return () => {}
  })
}
