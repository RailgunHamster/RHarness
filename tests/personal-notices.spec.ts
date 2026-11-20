import { afterEach, expect, it, vi } from 'vitest'
import { createPersonalNoticeReader, readPeerPersonalNotices } from '../src/app/personal-notices.ts'

const owner = { appId: 'test-app', appSecret: 'test-secret', dmChatId: 'test-chat', ownerOpenId: 'owner' }
const brief = '生活简报 2026-11-20（中国时间）\n\n日程提醒'
const todo = '📋 今日待办汇总（08:30）\n\n核对行程'
function message(id: number, text: string) {
  return { message_id: String(id), chat_id: owner.dmChatId, sender: { id: owner.appId, sender_type: 'app' },
    msg_type: 'text', create_time: String(1700000000000 + id), body: { content: JSON.stringify({ text }) } }
}
afterEach(() => vi.unstubAllGlobals())

it('reads only scheduled notices from the owner DM, handles page overlap and shares simultaneous reads', async () => {
  const history = vi.fn(async (url: string) => {
    if (url.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'test-token' })
    const params = new URL(url).searchParams
    expect(params.get('container_id')).toBe(owner.dmChatId)
    const second = params.has('page_token')
    const items = second ? [
      message(4, todo), message(3, '[K线仓库·进度] 11-20 00:00 | 队列更新'),
      message(2, '[K线仓库·契合度] 11-20 00:19 | 检查完成'),
    ] : [
      message(5, brief), message(4, todo), message(6, '助理回复中提到了生活简报'),
      { ...message(7, todo), chat_id: 'elsewhere' }, { ...message(8, todo), deleted: true },
      { ...message(9, brief), sender: { id: 'another-app', sender_type: 'app' } },
      { ...message(10, brief), sender: { id: owner.appId, sender_type: 'user' } },
      { ...message(11, brief), msg_type: 'post' }, { ...message(12, brief), create_time: 'invalid' },
    ]
    return Response.json({ code: 0, data: { items, has_more: !second, page_token: 'next' } })
  })
  vi.stubGlobal('fetch', history)
  const read = createPersonalNoticeReader()
  const [feed] = await Promise.all([read(owner), read(owner)])
  expect(feed.items.map(i => i.kind)).toEqual(['brief', 'todo', 'progress', 'fit'])
  expect(feed.items[0]?.text).toBe(brief)
  await read(owner)
  expect(history).toHaveBeenCalledTimes(3)
})

it('retries after a source error and only proxies the fixed local-only notice route', async () => {
  const read = createPersonalNoticeReader()
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ code: 0, tenant_access_token: 'test-token' }))
    .mockResolvedValueOnce(Response.json({ code: 123 }))
    .mockResolvedValueOnce(Response.json({ code: 0, tenant_access_token: 'test-token' }))
    .mockResolvedValueOnce(Response.json({ code: 0, data: { items: [], has_more: false } }))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(Response.json({ items: [] }))
  vi.stubGlobal('fetch', fetcher)
  await expect(read(owner)).rejects.toThrow('Feishu history unavailable')
  await expect(read(owner)).resolves.toEqual({ items: [] })
  await expect(readPeerPersonalNotices(['http://offline', 'http://peer/'])).resolves.toEqual({ items: [] })
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe('http://peer/orchestrator/standalone/personal-notices?localOnly=1')
})
