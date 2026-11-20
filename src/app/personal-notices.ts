/** Read-only mirror of scheduled text notices in the configured owner's Feishu DM. */
import { z } from 'zod'
import { HistoricalMessageSchema, HistoryPageSchema, historyText } from '../sources/feishu-trigger.ts'
import { getFeishuTenantToken, type FeishuCredentials } from './personal-skills.ts'

const headings = {
  brief: /^生活简报\s+\d{4}-\d{2}-\d{2}（中国时间）/,
  todo: /^(?:📋\s*)?今日待办汇总（\d{2}:\d{2}）/,
  progress: /^\[K线仓库·进度\]\s+\d{2}-\d{2}\s+\d{2}:\d{2}/,
  fit: /^\[K线仓库·契合度\]\s+\d{2}-\d{2}\s+\d{2}:\d{2}/,
} as const

const noticeSchema = z.object({
  id: z.string(), kind: z.enum(['brief', 'todo', 'progress', 'fit']), at: z.iso.datetime(), text: z.string(),
})
export type PersonalNotice = z.infer<typeof noticeSchema>
const feedSchema = z.object({ items: z.array(noticeSchema).max(12) })
type Feed = z.infer<typeof feedSchema>

async function readFeishuNotices(cred: FeishuCredentials): Promise<Feed> {
  const token = await getFeishuTenantToken(cred)
  const params = new URLSearchParams({
    container_id_type: 'chat', container_id: cred.dmChatId, sort_type: 'ByCreateTimeDesc', page_size: '50',
    start_time: String(Math.floor(Date.now() / 1000) - 7 * 86400),
  })
  const notices = new Map<string, PersonalNotice>()
  for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?${params}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000),
    })
    const result = await response.json()
    if (!response.ok || result.code !== 0) throw new Error(`Feishu history unavailable (${result.code ?? response.status})`)
    const page = HistoryPageSchema.parse(result.data)
    for (const raw of page.items) {
      const item = HistoricalMessageSchema.safeParse(raw).data
      if (!item || item.chat_id !== cred.dmChatId || item.deleted || item.msg_type !== 'text' ||
          item.sender.sender_type !== 'app' || item.sender.id !== cred.appId) continue
      const text = historyText(item)
      const kind = (Object.keys(headings) as PersonalNotice['kind'][]).find(key => headings[key].test(text))
      const date = new Date(Number(item.create_time))
      if (kind && Number.isFinite(date.getTime())) {
        notices.set(item.message_id, { id: item.message_id, kind, text, at: date.toISOString() })
      }
    }
    if (notices.size >= 12 || !page.has_more) break
    if (!page.page_token || page.page_token === params.get('page_token')) throw new Error('Feishu history cursor did not advance')
    params.set('page_token', page.page_token)
  }
  return { items: [...notices.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12) }
}

/** Share a short-lived read across browsers. Only matching notices enter the cache. */
export function createPersonalNoticeReader() {
  let cache: { owner: string; expires: number; feed: Promise<Feed> } | undefined
  return (cred: FeishuCredentials) => {
    const owner = `${cred.appId}/${cred.dmChatId}`
    if (cache?.owner === owner && cache.expires > Date.now()) return cache.feed
    const feed = readFeishuNotices(cred).catch((error: unknown) => {
      if (cache?.feed === feed) cache = undefined
      throw error
    })
    cache = { owner, expires: Date.now() + 60_000, feed }
    return feed
  }
}

/** Other panel nodes ask the configured personal node for its filtered feed. */
export async function readPeerPersonalNotices(endpoints: readonly string[]): Promise<Feed> {
  for (const endpoint of new Set(endpoints)) {
    try {
      const response = await fetch(`${endpoint.replace(/\/+$/, '')}/orchestrator/standalone/personal-notices?localOnly=1`, {
        headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.timeout(12_000),
      })
      if (response.ok) return feedSchema.parse(await response.json())
    } catch { /* Try the next configured address. */ }
  }
  throw new Error('Personal notice source is unavailable')
}
