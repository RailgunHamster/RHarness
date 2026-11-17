// @vitest-environment jsdom
/** Persona presets, kaomoji, sticker gallery CRUD, auto-applied learnings, ambient (lunar/solar-term/weather/news), Assistant-only tools, and the 🎭 workbench UI. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildAmbientSnapshot,
  buildAssistantPersonaAmbientTools,
  buildPersonaLearningPromptSummary,
  buildPersonaPromptSection,
  defaultAssistantAmbientConfig,
  defaultAssistantPersonaConfig,
  deleteStickerFile,
  extractPersonaLearningFromUserMessage,
  fetchWeatherForCity,
  findSticker,
  cityQueryVariants,
  formatLunarDate,
  geocodeCity,
  getNewsBrief,
  searchCityCandidates,
  activeStickers,
  purgeExpiredStickerTrash,
  restoreStickerRecord,
  stickerTrashPurgeAt,
  trashStickerRecord,
  trashedStickers,
  normalizeAssistantPersonaConfig,
  parseRssItems,
  parseStickerMarker,
  readStickerFile,
  resolveSolarTerm,
  savePersonaLearning,
  saveStickerFromBuffer,
  stickerAllowedByPolicy,
  type PersonaLearningEntry,
  type StickerRecord,
} from '../src/app/assistant-persona-and-ambient.ts'
import { PersonaAmbientWorkbench, PersonalAssistantSlotView } from '../src/client/ui-slots.tsx'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PNG_BYTES = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('rharness-test-png-payload')])
let stickerDir = ''

beforeEach(() => {
  stickerDir = mkdtempSync(join(tmpdir(), 'rharness-stickers-'))
  process.env.RHARNESS_STICKERS_DIR = stickerDir
})
afterEach(() => {
  delete process.env.RHARNESS_STICKERS_DIR
  rmSync(stickerDir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('persona config & prompt', () => {
  it('defaults to the warm-witty companion preset and normalizes garbage input', () => {
    const cfg = defaultAssistantPersonaConfig()
    expect(cfg.presetId).toBe('warm-witty')
    expect(normalizeAssistantPersonaConfig({ presetId: 'nope', kaomojiDensity: 'rich', stickerCooldownTurns: 99 }).kaomojiDensity).toBe('rich')
    expect(normalizeAssistantPersonaConfig({ stickerCooldownTurns: 99 }).stickerCooldownTurns).toBe(10)
    expect(normalizeAssistantPersonaConfig(null).userAddress).toBe('主人')
  })

  it('builds a persona section with anti-slop rules, few-shot, kaomoji and sticker catalog', () => {
    const saved = saveStickerFromBuffer([], { data: PNG_BYTES, name: '摸鱼', tags: ['开心'] })
    const section = buildPersonaPromptSection(defaultAssistantPersonaConfig(), [], saved.list)
    expect(section).toContain('禁止 AI 腔黑名单')
    expect(section).toContain('[sticker:表情名或标签]')
    expect(section).toContain('摸鱼{开心}')
    expect(section).toContain('(｡•̀ᴗ-)')
    const off = buildPersonaPromptSection({ ...defaultAssistantPersonaConfig(), kaomojiDensity: 'off', stickerFrequency: 'off' }, [], saved.list)
    expect(off).toContain('颜文字：关闭')
    expect(off).not.toContain('[sticker:表情名或标签]')
  })

  it('only injects enabled learnings into the prompt summary within budget', () => {
    let list: PersonaLearningEntry[] = []
    list = savePersonaLearning(list, { content: '闲聊时简短一点', kind: 'style', source: 'auto' }).list
    list = savePersonaLearning(list, { content: '称呼用户为「老哥」', kind: 'address', source: 'user' }).list
    const disabled = { ...list[0]!, enabled: false }
    const summary = buildPersonaLearningPromptSummary([disabled, list[1]!])
    expect(summary).toContain('老哥')
    expect(summary).not.toContain('简短')
  })
})

describe('persona learning extraction', () => {
  it('extracts address, style and boundary instructions but ignores secrets', () => {
    expect(extractPersonaLearningFromUserMessage('以后叫我老哥')).toEqual({ kind: 'address', content: '称呼用户为「老哥」' })
    expect(extractPersonaLearningFromUserMessage('记住，闲聊时简短一点，别列123点')?.kind).toBe('style')
    expect(extractPersonaLearningFromUserMessage('别再发表情包了')?.kind).toBe('boundary')
    expect(extractPersonaLearningFromUserMessage('记住我的密码是 abc12345')).toBeUndefined()
    expect(extractPersonaLearningFromUserMessage('今天天气怎么样')).toBeUndefined()
  })

  it('dedupes identical learnings', () => {
    const first = savePersonaLearning([], { content: '回复简短', source: 'auto' })
    const second = savePersonaLearning(first.list, { content: '回复简短', source: 'auto' })
    expect(second.list).toHaveLength(1)
  })
})

describe('sticker gallery', () => {
  it('saves, reads, dedupes, finds, deletes stickers and rejects non-images', () => {
    const saved = saveStickerFromBuffer([], { data: PNG_BYTES, name: '哈哈', tags: ['开心', '开心', '日常'] })
    expect(saved.entry.tags).toEqual(['开心', '日常'])
    expect(readStickerFile(saved.entry)).toEqual(PNG_BYTES)
    const dup = saveStickerFromBuffer(saved.list, { data: PNG_BYTES, name: '重复图' })
    expect(dup.list).toHaveLength(1)
    expect(findSticker(saved.list, '开心')).toHaveLength(1)
    expect(() => saveStickerFromBuffer([], { data: Buffer.from('not an image'), name: '坏图' })).toThrow(/PNG/)
    deleteStickerFile(saved.entry)
    expect(readStickerFile(saved.entry)).toBeUndefined()
  })

  it('soft-deletes into a 1-day trash: restorable within 24h, auto-purged (file removed) afterwards', () => {
    const t0 = new Date('2026-11-17T00:00:00Z')
    const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from('rharness-test-gif-payload')])
    const saved = saveStickerFromBuffer([], { data: gif, name: '动图猫', tags: ['开心'] }, t0)
    expect(saved.entry.mediaType).toBe('image/gif')
    expect(readStickerFile(saved.entry)).toEqual(gif)

    const trashed = trashStickerRecord(saved.list, saved.entry.id, t0)
    expect(trashed.entry?.deletedAt).toBe(t0.toISOString())
    expect(activeStickers(trashed.list)).toHaveLength(0)
    expect(trashedStickers(trashed.list)).toHaveLength(1)
    expect(findSticker(trashed.list, '开心')).toHaveLength(0)
    expect(parseStickerMarker('hi\n[sticker:开心]', trashed.list).sticker).toBeUndefined()
    // Still restorable 23h later; file still on disk.
    expect(stickerTrashPurgeAt(trashed.entry!)).toBe('2026-11-18T00:00:00.000Z')
    const kept = purgeExpiredStickerTrash(trashed.list, new Date('2026-11-17T23:00:00Z'))
    expect(kept.purged).toHaveLength(0)
    expect(readStickerFile(saved.entry)).toEqual(gif)
    const restored = restoreStickerRecord(trashed.list, saved.entry.id, new Date('2026-11-17T23:30:00Z'))
    expect(restored.entry?.deletedAt).toBeUndefined()
    expect(activeStickers(restored.list)).toHaveLength(1)
    // After 24h in trash: purged for good and the file is removed.
    const purged = purgeExpiredStickerTrash(trashed.list, new Date('2026-11-18T00:00:01Z'))
    expect(purged.purged.map(s => s.id)).toEqual([saved.entry.id])
    expect(purged.list).toHaveLength(0)
    expect(readStickerFile(saved.entry)).toBeUndefined()
  })

  it('parses sticker markers and enforces frequency/cooldown policy', () => {
    const saved = saveStickerFromBuffer([], { data: PNG_BYTES, name: '摸鱼', tags: ['开心'] })
    const parsed = parseStickerMarker('今天也很开心呀\n[sticker:开心]', saved.list)
    expect(parsed.cleanText).toBe('今天也很开心呀')
    expect(parsed.sticker?.name).toBe('摸鱼')
    expect(parseStickerMarker('正文[sticker:不存在的]', saved.list).cleanText).toBe('正文')
    const cfg = defaultAssistantPersonaConfig()
    expect(stickerAllowedByPolicy(cfg, [false, false])).toBe(true)
    expect(stickerAllowedByPolicy(cfg, [false, true])).toBe(false)
    expect(stickerAllowedByPolicy({ ...cfg, stickerFrequency: 'off' }, [false])).toBe(false)
  })
})

describe('ambient awareness', () => {
  it('computes lunar date, solar terms and workday rhythm', () => {
    expect(formatLunarDate(new Date('2026-02-17T12:00:00+08:00'))).toContain('正月')
    const summer = resolveSolarTerm(new Date(2026, 5, 21))
    expect(summer.current).toBe('夏至')
    expect(summer.next).toBe('小暑')
    const snapshot = buildAmbientSnapshot(defaultAssistantAmbientConfig(), undefined, new Date('2026-11-16T10:00:00+08:00'))
    expect(snapshot.homeCity.name).toBe('北京')
    expect(snapshot.dayType).toBe('workday')
    expect(snapshot.oneLiner).toContain('北京')
    const weekend = buildAmbientSnapshot(defaultAssistantAmbientConfig(), undefined, new Date('2026-11-15T10:00:00+08:00'))
    expect(weekend.dayType).toBe('holiday')
  })

  it('fetches and summarizes Open-Meteo weather with a mocked fetcher', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      current: { temperature_2m: 21.4, relative_humidity_2m: 40, weather_code: 2 },
      hourly: { time: ['2026-11-17T18:00', '2026-11-17T20:00'], precipitation_probability: [30, 85] },
      daily: { weather_code: [2, 61], temperature_2m_max: [24, 19], temperature_2m_min: [15, 12] },
    }), { status: 200 })) as unknown as typeof fetch
    const weather = await fetchWeatherForCity(defaultAssistantAmbientConfig().homeCity, fetcher, new Date('2026-11-17T10:00:00Z'))
    expect(weather.current.label).toBe('多云')
    expect(weather.tonightRainProbabilityPct).toBe(85)
    expect(weather.oneLiner).toContain('今晚降雨概率 85%')
  })

  it('degrades detailed addresses into city candidates instead of failing with City not found', async () => {
    const address = '上海市徐汇区梅陇十一村46号401'
    const variants = cityQueryVariants(address)
    expect(variants[0]).toBe(address)
    expect(variants).toContain('徐汇区')
    expect(variants).toContain('上海市')
    expect(variants).toContain('上海')
    const fetcher = vi.fn(async (url: string) => {
      const name = new URL(url).searchParams.get('name')
      const results = name === '徐汇区'
        ? [{ name: '徐汇区', admin1: '上海市', country: '中国', latitude: 31.19, longitude: 121.42, timezone: 'Asia/Shanghai' }]
        : name === '上海市' || name === '上海'
          ? [{ name: '上海市', country: '中国', latitude: 31.23, longitude: 121.47, timezone: 'Asia/Shanghai' }]
          : []
      return new Response(JSON.stringify({ results }), { status: 200 })
    }) as unknown as typeof fetch
    const candidates = await searchCityCandidates(address, fetcher)
    expect(candidates.map(c => c.name)).toEqual(['徐汇区', '上海市'])
    expect(candidates[0]!.matchedQuery).toBe('徐汇区')
    // geocodeCity now resolves the same detailed address to its district instead of "not found".
    expect(await geocodeCity(address, fetcher)).toMatchObject({ name: '徐汇区', latitude: 31.19 })
    expect(await geocodeCity('不存在的火星地名', fetcher)).toBeUndefined()

    // Same-named foreign places must not outrank the Chinese city for Chinese queries.
    const shFetcher = vi.fn(async () => new Response(JSON.stringify({
      results: [
        { name: '上海市', admin1: '伊利诺伊州', country: '美国', latitude: 41.05, longitude: -90.49, timezone: 'America/Chicago', population: 99999999 },
        { name: '上海市', admin1: '上海市', country: '中国', latitude: 31.23, longitude: 121.47, timezone: 'Asia/Shanghai', population: 100 },
      ],
    }), { status: 200 })) as unknown as typeof fetch
    const shCandidates = await searchCityCandidates('上海市徐汇区某路1号', shFetcher)
    expect(shCandidates[0]).toMatchObject({ country: '中国', latitude: 31.23 })
  })

  it('parses RSS and builds a topic brief', () => {
    const xml = '<rss><channel><item><title><![CDATA[AI 新进展]]></title><link>https://example.com/a</link><pubDate>Mon, 17 Nov 2026 08:00:00 GMT</pubDate></item><item><title>芯片发布</title><link>https://example.com/b</link></item></channel></rss>'
    const items = parseRssItems(xml, 'AI', 'TestSource')
    expect(items).toHaveLength(2)
    expect(items[0]!.title).toBe('AI 新进展')
    const brief = getNewsBrief({ fetchedAt: new Date().toISOString(), items }, 'AI')
    expect(brief.items[0]!.url).toBe('https://example.com/a')
  })
})

describe('assistant persona/ambient tools', () => {
  it('manages stickers, learnings and home city through tools only', async () => {
    let stickers: StickerRecord[] = []
    let learnings: PersonaLearningEntry[] = []
    let persona = defaultAssistantPersonaConfig()
    let ambient = defaultAssistantAmbientConfig()
    const tools = buildAssistantPersonaAmbientTools({
      isEnabled: () => true,
      getPersonaConfig: () => persona,
      setPersonaConfig: next => { persona = next },
      getLearnings: () => learnings,
      setLearnings: next => { learnings = next },
      getStickers: () => stickers,
      setStickers: next => { stickers = next },
      getAmbientConfig: () => ambient,
      setAmbientConfig: next => { ambient = next },
      getWeatherCache: () => undefined,
      setWeatherCache: () => {},
      getNewsCache: () => ({ fetchedAt: new Date().toISOString(), items: [{ title: '头条', url: 'https://example.com', source: 'T', topic: '综合' }] }),
      setNewsCache: () => {},
      getAssistantMessages: () => [{ id: 'm1', at: new Date().toISOString(), content: [{ type: 'image', data: PNG_BYTES.toString('base64'), mediaType: 'image/png' }] }],
      readStoredImageBytes: async part => {
        const p = part as { data?: string }
        return p.data ? Buffer.from(p.data, 'base64') : undefined
      },
    })
    const byName = (n: string) => tools.find(t => t.name === n)!
    const added = await byName('sticker_add_from_message').execute({ name: '摸鱼', tags: ['开心'] }, { signal: new AbortController().signal }) as { ok: boolean }
    expect(added.ok).toBe(true)
    expect(stickers).toHaveLength(1)
    const listed = await byName('sticker_list').execute({}, { signal: new AbortController().signal }) as { count: number }
    expect(listed.count).toBe(1)
    await byName('persona_learning_add').execute({ content: '闲聊简短一点', kind: 'style' }, { signal: new AbortController().signal })
    expect(learnings).toHaveLength(1)
    await byName('persona_learning_delete').execute({ id_or_text: '简短' }, { signal: new AbortController().signal })
    expect(learnings).toHaveLength(0)
    // sticker_delete is a soft delete into the 1-day trash now: record kept (flagged), invisible to list/find.
    const delRes = await byName('sticker_delete').execute({ id_or_name: '摸鱼' }, { signal: new AbortController().signal }) as { ok: boolean; trashed?: { name: string }; restorableUntil?: string }
    expect(delRes.ok).toBe(true)
    expect(delRes.trashed?.name).toBe('摸鱼')
    expect(stickers).toHaveLength(1)
    expect(stickers[0]!.deletedAt).toBeTruthy()
    expect(findSticker(stickers, '摸鱼')).toHaveLength(0)
    const listedAfterDelete = await byName('sticker_list').execute({}, { signal: new AbortController().signal }) as { count: number }
    expect(listedAfterDelete.count).toBe(0)
    const restored = await byName('sticker_restore').execute({ id_or_name: '摸鱼' }, { signal: new AbortController().signal }) as { ok: boolean }
    expect(restored.ok).toBe(true)
    expect(stickers[0]!.deletedAt).toBeUndefined()
    const listedAfterRestore = await byName('sticker_list').execute({}, { signal: new AbortController().signal }) as { count: number }
    expect(listedAfterRestore.count).toBe(1)
    const brief = await byName('news_brief').execute({}, { signal: new AbortController().signal }) as { items: unknown[] }
    expect(brief.items).toHaveLength(1)
  })
})

describe('persona workbench UI', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:sticker-preview'), revokeObjectURL: vi.fn() })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/content')) return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
      if (url.includes('persona-state')) {
        return new Response(JSON.stringify({
          config: defaultAssistantPersonaConfig(),
          presets: [
            { id: 'warm-witty', label: { zh: '机灵温暖日常搭子', en: 'Warm' }, description: { zh: '自然口语', en: 'Natural' } },
          ],
          learnings: [{ id: 'learn-1', kind: 'style', content: '闲聊时简短一点', enabled: true, source: 'auto', createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z' }],
          stickers: [{ id: 'stk-1', name: '摸鱼', tags: ['开心'], fileName: 'stk-1.png', mediaType: 'image/png', sizeBytes: PNG_BYTES.length, createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z', useCount: 2, source: 'upload' }],
          stickerTrash: [{ id: 'stk-old', name: '旧表情', tags: [], fileName: 'stk-old.png', mediaType: 'image/png', sizeBytes: 10, createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-17T01:00:00Z', useCount: 0, source: 'upload', deletedAt: '2026-11-17T01:00:00Z', purgeAt: '2026-11-18T01:00:00Z' }],
          ambientConfig: defaultAssistantAmbientConfig(),
          ambient: buildAmbientSnapshot(defaultAssistantAmbientConfig(), undefined, new Date('2026-11-17T10:00:00+08:00')),
          news: { items: [{ title: '测试新闻头条', url: 'https://example.com/news', source: 'Test', topic: '科技' }] },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('ambient/geocode')) {
        return new Response(JSON.stringify({
          candidates: [
            { name: '徐汇区', admin1: '上海市', country: '中国', latitude: 31.19, longitude: 121.42, timezone: 'Asia/Shanghai', matchedQuery: '徐汇区' },
            { name: '上海市', country: '中国', latitude: 31.23, longitude: 121.47, timezone: 'Asia/Shanghai', matchedQuery: '上海市' },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('ambient/config') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body ?? '{}')) as { homeCity?: { name: string; latitude: number; longitude: number; timezone: string }; city?: string }
        const homeCity = body.homeCity ?? { name: body.city ?? '北京', latitude: 39.9, longitude: 116.4, timezone: 'Asia/Shanghai' }
        const cfg = { ...defaultAssistantAmbientConfig(), homeCity }
        return new Response(JSON.stringify({ config: cfg, ambient: buildAmbientSnapshot(cfg, undefined, new Date('2026-11-17T10:00:00+08:00')) }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/restore')) {
        return new Response(JSON.stringify({
          stickers: [
            { id: 'stk-1', name: '摸鱼', tags: ['开心'], fileName: 'stk-1.png', mediaType: 'image/png', sizeBytes: PNG_BYTES.length, createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z', useCount: 2, source: 'upload' },
            { id: 'stk-old', name: '旧表情', tags: [], fileName: 'stk-old.png', mediaType: 'image/png', sizeBytes: 10, createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-17T02:00:00Z', useCount: 0, source: 'upload' },
          ],
          stickerTrash: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('assistant/stickers') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}')) as { name?: string }
        const created = { id: 'stk-new', name: body.name ?? '新表情', tags: [], fileName: 'stk-new.gif', mediaType: 'image/gif', sizeBytes: 20, createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z', useCount: 0, source: 'upload' }
        return new Response(JSON.stringify({
          sticker: created,
          stickers: [
            { id: 'stk-1', name: '摸鱼', tags: ['开心'], fileName: 'stk-1.png', mediaType: 'image/png', sizeBytes: PNG_BYTES.length, createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z', useCount: 2, source: 'upload' },
            created,
          ],
          stickerTrash: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true, ambientConfig: defaultAssistantAmbientConfig(), ambient: buildAmbientSnapshot({ ...defaultAssistantAmbientConfig(), homeCity: { name: '上海', latitude: 31.23, longitude: 121.47, timezone: 'Asia/Shanghai' } }, undefined), stickers: [], learnings: [], config: defaultAssistantPersonaConfig() }), { status: 200, headers: { 'content-type': 'application/json' } })
      void init
    }))
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  it('shows ambient pill with home city, renders sticker in chat, and manages gallery/learnings/city in the workbench', async () => {
    const ambient = buildAmbientSnapshot(defaultAssistantAmbientConfig(), undefined, new Date('2026-11-17T10:00:00+08:00'))
    await act(async () => root.render(
      <PersonalAssistantSlotView
        lang="zh"
        messages={[
          { id: 'u1', sender: 'operator', text: '今天开心', at: '2026-11-17T02:00:00Z' },
          { id: 'b1', sender: 'claw-assistant', bot: true, text: '开心就好呀', at: '2026-11-17T02:00:05Z', sticker: { id: 'stk-1', name: '摸鱼', tags: ['开心'] } },
        ]}
        ambient={ambient}
        memories={[]}
        onRefresh={async () => {}}
        onJumpToEngineeringTicket={() => {}}
        onSwitchToMemoryTab={() => {}}
      />,
    ))
    const pill = container.querySelector<HTMLElement>('[data-testid="assistant-ambient-pill"]')!
    expect(pill.textContent).toContain('北京')
    expect(container.querySelector('[data-testid="assistant-sticker-b1"]')).not.toBeNull()

    const openBtn = container.querySelector<HTMLButtonElement>('[data-testid="assistant-persona-btn"]')!
    await act(async () => { openBtn.click() })
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('机灵温暖日常搭子')

    const stickerTab = dialog.querySelector<HTMLButtonElement>('[data-testid="persona-tab-stickers"]')!
    await act(async () => { stickerTab.click() })
    expect(dialog.querySelector('[data-testid="sticker-card-stk-1"]')).not.toBeNull()
    expect(dialog.querySelector<HTMLInputElement>('[data-testid="sticker-card-stk-1"] input')!.value).toBe('摸鱼')

    const learnTab = dialog.querySelector<HTMLButtonElement>('[data-testid="persona-tab-learnings"]')!
    await act(async () => { learnTab.click() })
    expect(dialog.querySelector('[data-testid="learning-row-learn-1"]')).not.toBeNull()
    expect(dialog.querySelector<HTMLInputElement>('[data-testid="learning-row-learn-1"] input')!.value).toBe('闲聊时简短一点')

    const ambientTab = dialog.querySelector<HTMLButtonElement>('[data-testid="persona-tab-ambient"]')!
    await act(async () => { ambientTab.click() })
    const cityInput = dialog.querySelector<HTMLInputElement>('[data-testid="ambient-city-input"]')!
    expect(cityInput.value).toBe('北京')
    expect(dialog.textContent).toContain('测试新闻头条')
  })

  it('renders the same workbench embedded as a page (记忆与知识库 sub-tab) without a dialog shell', async () => {
    await act(async () => root.render(
      <PersonaAmbientWorkbench lang="zh" open embedded onClose={() => {}} />,
    ))
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    const page = container.querySelector('#persona-ambient-page')!
    expect(page).not.toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(page.textContent).toContain('常驻城市')
    const stickerTab = page.querySelector<HTMLButtonElement>('[data-testid="persona-tab-stickers"]')!
    await act(async () => { stickerTab.click() })
    expect(page.querySelector('[data-testid="sticker-card-stk-1"]')).not.toBeNull()
    const ambientTab = page.querySelector<HTMLButtonElement>('[data-testid="persona-tab-ambient"]')!
    await act(async () => { ambientTab.click() })
    expect(page.querySelector<HTMLInputElement>('[data-testid="ambient-city-input"]')!.value).toBe('北京')
  })

  it('restores stickers from the 1-day trash and uploads a whole folder (recursive scan, GIF kept, non-images skipped)', async () => {
    await act(async () => root.render(
      <PersonaAmbientWorkbench lang="zh" open embedded onClose={() => {}} />,
    ))
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    const page = container.querySelector('#persona-ambient-page')!
    const stickerTab = page.querySelector<HTMLButtonElement>('[data-testid="persona-tab-stickers"]')!
    await act(async () => { stickerTab.click() })

    // Trash panel: deleted sticker is listed with a restore action; restoring empties the trash.
    expect(page.querySelector('[data-testid="sticker-trash-panel"]')).not.toBeNull()
    expect(page.querySelector('[data-testid="sticker-trash-card-stk-old"]')).not.toBeNull()
    const restoreBtn = page.querySelector<HTMLButtonElement>('[data-testid="sticker-restore-stk-old"]')!
    await act(async () => { restoreBtn.click() })
    expect(container.querySelector('[data-testid="sticker-trash-panel"]')).toBeNull()
    expect(container.querySelector('[data-testid="sticker-card-stk-old"]')).not.toBeNull()

    // Folder upload: a GIF deep in a subfolder + a non-image file. Only the GIF is posted, named after the file.
    const folderBtn = page.querySelector<HTMLButtonElement>('[data-testid="sticker-folder-upload-btn"]')!
    expect(folderBtn).not.toBeNull()
    const input = page.querySelector<HTMLInputElement>('[data-testid="sticker-folder-input"]')!
    expect(input.getAttribute('webkitdirectory')).not.toBeNull()
    const gifFile = new File([new Uint8Array([...Buffer.from('GIF89a', 'ascii'), 1, 2, 3])], '开心猫.gif', { type: 'image/gif' })
    Object.defineProperty(gifFile, 'webkitRelativePath', { value: '表情包/开心/开心猫.gif' })
    const txtFile = new File(['hello'], 'readme.txt', { type: 'text/plain' })
    Object.defineProperty(txtFile, 'webkitRelativePath', { value: '表情包/readme.txt' })
    Object.defineProperty(input, 'files', { value: [gifFile, txtFile], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(r => setTimeout(r, 50))
    })
    expect(container.textContent).toContain('成功加入 1 张')
    expect(container.textContent).toContain('非图片跳过 1 个')
    expect(container.querySelector('[data-testid="sticker-card-stk-new"]')).not.toBeNull()
  })

  it('resolves a detailed street address through the candidate picker instead of erroring City not found', async () => {
    await act(async () => root.render(
      <PersonaAmbientWorkbench lang="zh" open embedded onClose={() => {}} />,
    ))
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    const page = container.querySelector('#persona-ambient-page')!
    const ambientTab = page.querySelector<HTMLButtonElement>('[data-testid="persona-tab-ambient"]')!
    await act(async () => { ambientTab.click() })
    const cityInput = page.querySelector<HTMLInputElement>('[data-testid="ambient-city-input"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(cityInput, '上海市徐汇区梅陇十一村46号401')
      cityInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // Saving unpicked free text now searches candidates instead of throwing "City not found".
    const saveBtn = page.querySelector<HTMLButtonElement>('[data-testid="ambient-save-city-btn"]')!
    await act(async () => { saveBtn.click(); await new Promise(r => setTimeout(r, 30)) })
    const candidates = container.querySelector('[data-testid="ambient-city-candidates"]')!
    expect(candidates).not.toBeNull()
    expect(candidates.textContent).toContain('徐汇区')
    expect(container.textContent).toContain('候选城市')
    expect(container.textContent).not.toContain('City not found')
    // Pick the district, then save persists it and reports the resolved city name.
    const pick = candidates.querySelector<HTMLButtonElement>('[data-testid="ambient-city-candidate-0"]')!
    await act(async () => { pick.click() })
    expect(container.querySelector<HTMLButtonElement>('[data-testid="ambient-save-city-btn"]')!.textContent).toContain('徐汇区')
    await act(async () => { saveBtn.click(); await new Promise(r => setTimeout(r, 30)) })
    expect(container.textContent).toContain('常驻城市已改为 徐汇区')
    expect(container.querySelector('[data-testid="ambient-city-candidates"]')).toBeNull()
  })
})
