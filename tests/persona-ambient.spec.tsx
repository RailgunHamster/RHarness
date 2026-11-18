// @vitest-environment jsdom
/** Persona presets, kaomoji, sticker gallery CRUD, auto-applied learnings, ambient (lunar/solar-term/weather/news), Assistant-only tools, and the 🎭 workbench UI. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildAmbientPromptSection,
  buildAmbientSnapshot,
  mergeAmbientConfigForSync,
  mergePersonaLearningsForSync,
  normalizeAssistantAmbientConfig,
  removeResidentAddress,
  setPrimaryResidentAddress,
  upsertResidentAddress,
  buildAssistantPersonaAmbientTools,
  buildPersonaLearningPromptSummary,
  buildPersonaPromptSection,
  defaultAssistantAmbientConfig,
  defaultAssistantPersonaConfig,
  deleteStickerFile,
  extractPersonaLearningFromUserMessage,
  fetchWeatherForCity,
  findSticker,
  buildAmapNavigationUrl,
  buildBaiduNavigationUrl,
  cityQueryVariants,
  formatDurationZh,
  formatLunarDate,
  parseCoordinateText,
  planNavigation,
  scorePlaceMatch,
  searchPlacesWithAmap,
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
import { DATA_CENTER_TAG, createDeviceGroup, ensureDeviceIdentity, isDataCenterNode, retagOwnClaims, verifyAndExtractGroupMembers, verifySignedClaim } from '../src/app/device-group.ts'

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

  it('supports multiple resident addresses: primary drives the weather city, detailed text is kept verbatim', () => {
    const shanghai = { name: '上海', latitude: 31.23, longitude: 121.47, timezone: 'Asia/Shanghai' }
    const beijing = { name: '北京', latitude: 39.9, longitude: 116.4, timezone: 'Asia/Shanghai' }
    let cfg = defaultAssistantAmbientConfig()
    expect(cfg.residentAddresses).toEqual([])
    const home = upsertResidentAddress(cfg, { label: '家', address: '上海市徐汇区梅陇十一村46号401', city: shanghai })
    cfg = home.config
    expect(cfg.residentAddresses).toHaveLength(1)
    expect(cfg.residentAddresses[0]).toMatchObject({ label: '家', address: '上海市徐汇区梅陇十一村46号401', isPrimary: true })
    // Weather baseline follows the primary address's city, not the legacy default.
    expect(cfg.homeCity.name).toBe('上海')
    const office = upsertResidentAddress(cfg, { label: '公司', address: '北京市海淀区中关村大街1号', city: beijing })
    cfg = office.config
    expect(cfg.residentAddresses).toHaveLength(2)
    expect(cfg.homeCity.name).toBe('上海')
    cfg = setPrimaryResidentAddress(cfg, office.entry.id)
    expect(cfg.homeCity.name).toBe('北京')
    expect(cfg.residentAddresses.filter(a => a.isPrimary)).toHaveLength(1)
    // Same detailed address upserts instead of duplicating.
    cfg = upsertResidentAddress(cfg, { label: '家', address: '上海市徐汇区梅陇十一村46号401', city: shanghai }).config
    expect(cfg.residentAddresses).toHaveLength(2)
    // Removing the primary promotes the remaining address and re-bases the weather city.
    const primaryId = cfg.residentAddresses.find(a => a.isPrimary)!.id
    cfg = removeResidentAddress(cfg, primaryId)
    expect(cfg.residentAddresses).toHaveLength(1)
    expect(cfg.homeCity.name).toBe('上海')
    // Garbage entries are dropped by normalization; legacy configs without addresses still work.
    const messy = normalizeAssistantAmbientConfig({ homeCity: beijing, residentAddresses: [{ address: '' }, { address: '无坐标地址' }, null] })
    expect(messy.residentAddresses).toEqual([])
    expect(messy.homeCity.name).toBe('北京')
    // The prompt section carries the detailed addresses (primary marked), snapshot carries them too.
    const withHome = upsertResidentAddress(defaultAssistantAmbientConfig(), { label: '家', address: '上海市徐汇区梅陇十一村46号401', city: shanghai }).config
    const snapshot = buildAmbientSnapshot(withHome, undefined, new Date('2026-11-17T10:00:00+08:00'))
    expect(snapshot.residentAddresses).toHaveLength(1)
    const section = buildAmbientPromptSection(snapshot)
    expect(section).toContain('上海市徐汇区梅陇十一村46号401')
    expect(section).toContain('主要')
  })

  it('identifies the data-center node by its dedicated tag only (never by name or role tags)', () => {
    expect(DATA_CENTER_TAG).toBe('数据中心')
    expect(isDataCenterNode(['eval-hub', 'always-on', '数据中心'])).toBe(true)
    expect(isDataCenterNode(['eval-hub', 'always-on'])).toBe(false)
    expect(isDataCenterNode(['worker', 'workstation', 'windows'])).toBe(false)
    expect(isDataCenterNode([])).toBe(false)
    // Retagging re-signs the node's own claims so peers verify & adopt the new tags.
    const identity = ensureDeviceIdentity(undefined, 0)
    const packet = createDeviceGroup(identity, '测试设备组')
    expect(verifyAndExtractGroupMembers(packet).some(m => m.tags.includes(DATA_CENTER_TAG))).toBe(false)
    const retagged = retagOwnClaims(packet, identity, [...identity.tags, DATA_CENTER_TAG])
    expect(verifySignedClaim(retagged.root).tags).toContain(DATA_CENTER_TAG)
    expect(verifyAndExtractGroupMembers(retagged).every(m => m.tags.includes(DATA_CENTER_TAG))).toBe(true)
  })

  it('syncs resident addresses & learnings across nodes: union by id, newer wins, deletions stay deleted', () => {
    const shanghai = { name: '上海', latitude: 31.23, longitude: 121.47, timezone: 'Asia/Shanghai' }
    const beijing = { name: '北京', latitude: 39.9, longitude: 116.4, timezone: 'Asia/Shanghai' }
    // Node A (desktop) has 家; node B (phone hub) starts empty, then receives A's state.
    const cfgA = upsertResidentAddress(defaultAssistantAmbientConfig(), { label: '家', address: '上海市徐汇区梅陇十一村46号401', city: shanghai }).config
    let cfgB = mergeAmbientConfigForSync(defaultAssistantAmbientConfig(), cfgA)
    expect(cfgB.residentAddresses.map(a => a.label)).toEqual(['家'])
    expect(cfgB.homeCity.name).toBe('上海')
    // B adds 公司 locally; A adds nothing. Merging B back into A keeps both, exactly one primary.
    cfgB = upsertResidentAddress(cfgB, { label: '公司', address: '北京市海淀区中关村大街1号', city: beijing }).config
    const merged = mergeAmbientConfigForSync(cfgA, cfgB)
    expect(merged.residentAddresses.map(a => a.label).sort()).toEqual(['公司', '家'])
    expect(merged.residentAddresses.filter(a => a.isPrimary)).toHaveLength(1)
    // An edit on B (newer updatedAt) beats the stale copy on A.
    const editedOnB: typeof cfgB = {
      ...cfgB,
      residentAddresses: cfgB.residentAddresses.map(a => (a.label === '家' ? { ...a, address: '上海市徐汇区新地址2号', updatedAt: '2999-01-01T00:00:00.000Z' } : a)),
    }
    expect(mergeAmbientConfigForSync(cfgA, editedOnB).residentAddresses.find(a => a.label === '家')!.address).toBe('上海市徐汇区新地址2号')
    // Deletion on the sender (id in removedIds) does not resurrect on the receiver.
    const homeId = cfgA.residentAddresses[0]!.id
    const afterDelete = mergeAmbientConfigForSync(merged, cfgB, [homeId])
    expect(afterDelete.residentAddresses.map(a => a.label)).toEqual(['公司'])
    // Learnings merge the same way.
    const l1: PersonaLearningEntry = { id: 'pl-1', kind: 'preference', content: '喜欢简短回复', enabled: true, source: 'user', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
    const l2: PersonaLearningEntry = { id: 'pl-2', kind: 'style', content: '多用颜文字', enabled: true, source: 'auto', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }
    expect(mergePersonaLearningsForSync([l1], [l2]).map(e => e.id)).toEqual(['pl-1', 'pl-2'])
    expect(mergePersonaLearningsForSync([l1, l2], [l2], ['pl-1']).map(e => e.id)).toEqual(['pl-2'])
  })

  it('plans navigation with Amap when a key exists and degrades to map links without one', async () => {
    expect(formatDurationZh(25)).toBe('约 25 分钟')
    expect(formatDurationZh(95)).toBe('约 1 小时 35 分钟')
    const shanghai = { name: '上海', latitude: 31.23, longitude: 121.47, timezone: 'Asia/Shanghai' }
    const beijing = { name: '北京', latitude: 39.9, longitude: 116.4, timezone: 'Asia/Shanghai' }
    let cfg = upsertResidentAddress(defaultAssistantAmbientConfig(), { label: '家', address: '上海市徐汇区梅陇十一村46号401', city: shanghai }).config
    cfg = upsertResidentAddress(cfg, { label: '公司', address: '北京市海淀区中关村大街1号', city: beijing }).config
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('geocode/geo')) {
        const address = new URL(url).searchParams.get('address') ?? ''
        const location = address.includes('徐汇') ? '121.42,31.19' : '116.40,39.99'
        return new Response(JSON.stringify({ status: '1', geocodes: [{ location, formatted_address: address, city: '上海市' }] }), { status: 200 })
      }
      if (url.includes('direction/driving')) {
        return new Response(JSON.stringify({ status: '1', route: { paths: [{ distance: '12500', duration: '1800', steps: [{ instruction: '沿沪闵路向北行驶' }, { instruction: '到达目的地' }] }] } }), { status: 200 })
      }
      if (url.includes('direction/transit')) {
        return new Response(JSON.stringify({ status: '1', route: { transits: [{ distance: '9800', duration: '2400', segments: [{ walking: { distance: '300' }, bus: { buslines: [{ name: '地铁1号线', departure_stop: { name: '徐家汇' }, arrival_stop: { name: '人民广场' } }] } }] }] } }), { status: 200 })
      }
      // Open-Meteo city-candidate fallback (no-key path): no hits in this mock.
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const driving = await planNavigation({ toText: '公司', mode: 'driving', addresses: cfg.residentAddresses, amapKey: 'test-key', fetcher })
    expect(driving.provider).toBe('amap')
    expect(driving.origin.label).toBe('家')
    expect(driving.destination.label).toBe('公司')
    expect(driving.distanceKm).toBe(12.5)
    expect(driving.durationText).toBe('约 30 分钟')
    expect(driving.steps[0]).toContain('沪闵路')
    expect(driving.links.amap).toContain('uri.amap.com/navigation')
    expect(driving.links.baidu).toContain('api.map.baidu.com/direction')

    const transit = await planNavigation({ fromText: '家', toText: '市中心', mode: 'transit', addresses: cfg.residentAddresses, amapKey: 'test-key', fetcher })
    expect(transit.provider).toBe('amap')
    expect(transit.steps.join(' ')).toContain('地铁1号线')

    // No key: still returns tappable links from saved city coordinates, with an explanatory note.
    const linksOnly = await planNavigation({ toText: '公司', mode: 'driving', addresses: cfg.residentAddresses, fetcher })
    expect(linksOnly.provider).toBe('links')
    expect(linksOnly.durationText).toBeUndefined()
    expect(linksOnly.note).toContain('高德地图 Key')
    expect(linksOnly.links.amap).toContain('uri.amap.com')
    expect(buildBaiduNavigationUrl('家', '公司', 'transit', '上海')).toContain('mode=transit')
    expect(buildAmapNavigationUrl({ label: '家' }, { label: '公司', longitude: 116.4, latitude: 39.9 }, 'driving')).toBeUndefined()
  })

  it('resolves place names via POI search, stops for confirmation when ambiguous, and accepts pasted coordinates', async () => {
    expect(parseCoordinateText('121.446272, 31.126632')).toEqual({ longitude: 121.446272, latitude: 31.126632 })
    expect(parseCoordinateText('上海市徐汇区')).toBeUndefined()
    expect(parseCoordinateText('999, 999')).toBeUndefined()
    const shanghai = { name: '上海', latitude: 31.23, longitude: 121.47, timezone: 'Asia/Shanghai' }
    const cfg = upsertResidentAddress(defaultAssistantAmbientConfig(), { label: '家', address: '上海市徐汇区梅陇十一村46号401', city: shanghai }).config
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('place/text')) {
        return new Response(JSON.stringify({ status: '1', pois: [
          { name: '米哈游(北杨园区)', address: '华发路811号', location: '121.438,31.128', cityname: '上海市', adname: '徐汇区' },
          { name: '米哈游总部', address: '宜山路700号', location: '121.396,31.169', cityname: '上海市', adname: '徐汇区' },
        ] }), { status: 200 })
      }
      if (url.includes('geocode/geo')) {
        // Deliberately WRONG road-side point (the original bug): must not be used for place names.
        return new Response(JSON.stringify({ status: '1', geocodes: [{ location: '121.395,31.169', formatted_address: '上海市徐汇区', city: '上海市', level: '区县' }] }), { status: 200 })
      }
      if (url.includes('direction/driving')) {
        return new Response(JSON.stringify({ status: '1', route: { paths: [{ distance: '2700', duration: '420', steps: [{ instruction: '沿华发路行驶' }] }] } }), { status: 200 })
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as unknown as typeof fetch

    // "米哈游" matches both POIs: planning must stop and ask, not silently route to either.
    const ambiguous = await planNavigation({ toText: '米哈游', mode: 'driving', addresses: cfg.residentAddresses, amapKey: 'k', fetcher })
    expect(ambiguous.needsConfirmation).toBe(true)
    expect(ambiguous.confirmationFor).toBe('destination')
    expect(ambiguous.candidates?.map(c => c.name)).toEqual(['米哈游(北杨园区)', '米哈游总部'])
    expect(ambiguous.durationText).toBeUndefined()

    // Exact place name resolves decisively via POI (not the wrong geocode point).
    const decisive = await planNavigation({ toText: '米哈游(北杨园区)', mode: 'driving', addresses: cfg.residentAddresses, amapKey: 'k', fetcher })
    expect(decisive.needsConfirmation).toBeUndefined()
    expect(decisive.provider).toBe('amap')
    expect(decisive.precision).toBe('poi')
    expect(decisive.destination).toMatchObject({ longitude: 121.438, latitude: 31.128 })
    expect(decisive.distanceKm).toBe(2.7)

    // Pasted coordinates go straight through with zero resolution error.
    const byCoord = await planNavigation({ toText: '121.438,31.128', toLabel: '米哈游(北杨园区)', mode: 'driving', addresses: cfg.residentAddresses, amapKey: 'k', fetcher })
    // Overall precision reports the weakest link (origin resolved via POI here); the pasted coordinate itself is used verbatim.
    expect(byCoord.precision).toBe('poi')
    expect(byCoord.destination).toMatchObject({ longitude: 121.438, latitude: 31.128 })
    expect(byCoord.destination.label).toBe('米哈游(北杨园区)')
    expect(byCoord.provider).toBe('amap')

    expect(scorePlaceMatch('米哈游(北杨园区)', { name: '米哈游(北杨园区)', longitude: 1, latitude: 1 })).toBe(100)
    const places = await searchPlacesWithAmap('米哈游', { apiKey: 'k', fetcher })
    expect(places).toHaveLength(2)
    expect(places[0]).toMatchObject({ district: '徐汇区', cityName: '上海市' })
  })

  it('re-saving an address under the same label replaces it instead of stacking a stale duplicate', () => {
    const shanghai = { name: '上海', latitude: 31.23, longitude: 121.47, timezone: 'Asia/Shanghai' }
    let cfg = upsertResidentAddress(defaultAssistantAmbientConfig(), { label: '老婆公司', address: '上海市徐汇区华发路米哈游(北杨园区)-北区2号楼', city: shanghai }).config
    const firstId = cfg.residentAddresses[0]!.id
    cfg = upsertResidentAddress(cfg, { label: '老婆公司', address: '上海市徐汇区华发路888弄北区2号楼', city: { ...shanghai, longitude: 121.438, latitude: 31.128 } }).config
    expect(cfg.residentAddresses).toHaveLength(1)
    expect(cfg.residentAddresses[0]).toMatchObject({ id: firstId, address: '上海市徐汇区华发路888弄北区2号楼' })
    expect(cfg.residentAddresses[0]!.city.longitude).toBe(121.438)
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
      if (url.includes('navigation/route')) {
        return new Response(JSON.stringify({
          provider: 'amap', mode: 'driving',
          origin: { label: '家', longitude: 121.42, latitude: 31.19 },
          destination: { label: '公司', longitude: 116.4, latitude: 39.99 },
          distanceKm: 12.5, durationMin: 25, durationText: '约 25 分钟',
          steps: ['沿沪闵路向北行驶', '到达目的地'],
          links: { amap: 'https://uri.amap.com/navigation?from=a&to=b&mode=car', baidu: 'https://api.map.baidu.com/direction?origin=a&destination=b' },
          note: '驾车路线（高德，含实时路况）：家 → 公司',
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
        const body = JSON.parse(String(init.body ?? '{}')) as { homeCity?: { name: string; latitude: number; longitude: number; timezone: string }; city?: string; residentAddresses?: { id: string; label: string; address: string; city: { name: string; latitude: number; longitude: number; timezone: string }; isPrimary: boolean; createdAt: string; updatedAt: string }[] }
        if (Array.isArray(body.residentAddresses)) {
          const primary = body.residentAddresses.find(a => a.isPrimary) ?? body.residentAddresses[0]
          const cfg = { ...defaultAssistantAmbientConfig(), residentAddresses: body.residentAddresses, ...(primary ? { homeCity: primary.city } : {}) }
          return new Response(JSON.stringify({ config: cfg, ambient: buildAmbientSnapshot(cfg, undefined, new Date('2026-11-17T10:00:00+08:00')) }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
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
    expect(dialog.querySelector('[data-testid="ambient-address-input"]')).not.toBeNull()
    expect(dialog.textContent).toContain('常驻地址')
    expect(dialog.textContent).toContain('测试新闻头条')
  })

  it('keeps the unsent assistant composer text (and restores it after remount, like a refresh)', async () => {
    const view = (
      <PersonalAssistantSlotView
        lang="zh"
        messages={[]}
        memories={[]}
        onRefresh={async () => {}}
        onJumpToEngineeringTicket={() => {}}
        onSwitchToMemoryTab={() => {}}
      />
    )
    await act(async () => root.render(view))
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '还没发出去的半句话')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(localStorage.length).toBeGreaterThan(0)
    await act(async () => root.unmount())
    const root2 = createRoot(container)
    await act(async () => root2.render(view))
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('还没发出去的半句话')
    await act(async () => root2.unmount())
    localStorage.clear()
  })

  it('renders the same workbench embedded as a page (记忆与知识库 sub-tab) without a dialog shell', async () => {
    await act(async () => root.render(
      <PersonaAmbientWorkbench lang="zh" open embedded onClose={() => {}} />,
    ))
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    const page = container.querySelector('#persona-ambient-page')!
    expect(page).not.toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(page.textContent).toContain('人设风格')
    const stickerTab = page.querySelector<HTMLButtonElement>('[data-testid="persona-tab-stickers"]')!
    await act(async () => { stickerTab.click() })
    expect(page.querySelector('[data-testid="sticker-card-stk-1"]')).not.toBeNull()
    const ambientTab = page.querySelector<HTMLButtonElement>('[data-testid="persona-tab-ambient"]')!
    await act(async () => { ambientTab.click() })
    expect(page.querySelector<HTMLInputElement>('[data-testid="ambient-address-input"]')).not.toBeNull()
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
    const setInput = async (input: HTMLInputElement, value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await setInput(page.querySelector<HTMLInputElement>('[data-testid="ambient-address-label-input"]')!, '家')
    await setInput(page.querySelector<HTMLInputElement>('[data-testid="ambient-address-input"]')!, '上海市徐汇区梅陇十一村46号401')
    // Resolve the city from the detailed address via the candidate picker (no "City not found").
    const resolveBtn = page.querySelector<HTMLButtonElement>('[data-testid="ambient-search-city-btn"]')!
    await act(async () => { resolveBtn.click(); await new Promise(r => setTimeout(r, 30)) })
    const candidates = container.querySelector('[data-testid="ambient-city-candidates"]')!
    expect(candidates).not.toBeNull()
    expect(candidates.textContent).toContain('徐汇区')
    const pick = candidates.querySelector<HTMLButtonElement>('[data-testid="ambient-city-candidate-0"]')!
    await act(async () => { pick.click() })
    // Save the address: it appears as a primary resident-address row with its detailed text + city.
    const addBtn = page.querySelector<HTMLButtonElement>('[data-testid="ambient-add-address-btn"]')!
    await act(async () => { addBtn.click(); await new Promise(r => setTimeout(r, 30)) })
    expect(container.textContent).toContain('已保存常驻地址「家」')
    const rows = [...container.querySelectorAll('[data-testid^="ambient-address-row-"]')]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('上海市徐汇区梅陇十一村46号401')
    expect(rows[0]!.textContent).toContain('徐汇区')
    expect(rows[0]!.textContent).toContain('主要')
    expect(container.querySelector('[data-testid="ambient-city-candidates"]')).toBeNull()

    // Navigation panel: query a route and render duration + map links.
    expect(page.querySelector('[data-testid="amap-key-input"]')).not.toBeNull()
    const toInput = page.querySelector<HTMLInputElement>('[data-testid="nav-to-input"]')!
    await setInput(toInput, '公司')
    const queryBtn = page.querySelector<HTMLButtonElement>('[data-testid="nav-query-btn"]')!
    await act(async () => { queryBtn.click(); await new Promise(r => setTimeout(r, 30)) })
    const result = container.querySelector('[data-testid="nav-result"]')!
    expect(result).not.toBeNull()
    expect(result.textContent).toContain('约 25 分钟')
    expect(result.textContent).toContain('沪闵路')
    expect(result.querySelector<HTMLAnchorElement>('[data-testid="nav-link-amap"]')!.href).toContain('uri.amap.com')
    expect(result.querySelector<HTMLAnchorElement>('[data-testid="nav-link-baidu"]')!.href).toContain('map.baidu.com')

    // Edit the saved address in place: form refills, saving replaces the row (no duplicate).
    const row = container.querySelector('[data-testid^="ambient-address-row-"]')!
    const rowId = row.getAttribute('data-testid')!.replace('ambient-address-row-', '')
    const editBtn = container.querySelector<HTMLButtonElement>(`[data-testid="ambient-address-edit-${rowId}"]`)!
    await act(async () => { editBtn.click() })
    expect(container.querySelector('[data-testid="ambient-editing-hint"]')).not.toBeNull()
    const addressInput = page.querySelector<HTMLInputElement>('[data-testid="ambient-address-input"]')!
    expect(addressInput.value).toContain('梅陇十一村')
    expect(page.querySelector<HTMLButtonElement>('[data-testid="ambient-add-address-btn"]')!.textContent).toContain('保存修改')
    await setInput(addressInput, '上海市徐汇区华发路888弄北区2号楼')
    // No forced re-resolve: the stored city is reused, so 保存修改 works immediately.
    expect(page.querySelector<HTMLButtonElement>('[data-testid="ambient-add-address-btn"]')!.disabled).toBe(false)
    expect(container.textContent).toContain('沿用已解析的')
    await act(async () => { page.querySelector<HTMLButtonElement>('[data-testid="ambient-add-address-btn"]')!.click(); await new Promise(r => setTimeout(r, 30)) })
    expect(container.textContent).toContain('已修改常驻地址「家」')
    const rowsAfter = [...container.querySelectorAll('[data-testid^="ambient-address-row-"]')]
    expect(rowsAfter).toHaveLength(1)
    expect(rowsAfter[0]!.textContent).toContain('华发路888弄北区2号楼')
    expect(container.querySelector('[data-testid="ambient-editing-hint"]')).toBeNull()
  })
})
