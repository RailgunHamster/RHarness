/**
 * Model Configuration Profiles (Preset 1, 2, 3) with Per-Role (`assistant`, `eval`, `executor`)
 * Multi-Window (N-Segment) Time-of-Day Scheduling and Workday / Holiday Distinction.
 */
import type { RoleModelsSummary } from '../client/standalone-api.ts'

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/**
 * Controls which calendar days a time slot applies to:
 * - `'all'`: Every day (both workdays and holidays/weekends)
 * - `'workday'`: Workdays only (Mon-Fri excluding statutory holidays, plus statutory make-up workdays)
 * - `'holiday'`: Holidays & weekends only (Sat-Sun excluding make-up workdays, plus statutory holidays)
 */
export type SlotDayType = 'all' | 'workday' | 'holiday'

export type DayModeOverride = 'auto' | 'force-workday' | 'force-holiday'

export interface RoleTimeSlotRule {
  id: string
  label: string
  /** 24-hour time string `HH:mm`, e.g. `"09:00"`. Supports cross-midnight ranges such as `"23:00"` to `"08:00"`. */
  startTime: string
  /** 24-hour time string `HH:mm`, e.g. `"18:00"`. */
  endTime: string
  /** Whether this time slot applies every day (`'all'`), on workdays (`'workday'`), or on holidays/weekends (`'holiday'`). Defaults to `'all'`. */
  dayType?: SlotDayType
  model: ModelSelection
  enabled: boolean
}

export interface RoleModelScheduleConfig {
  defaultModel: ModelSelection
  timeSlots: RoleTimeSlotRule[]
}

export interface ModelProfileGroup {
  id: string
  name: string
  /** Personal Assistant (`claw-assistant-main`) model & time-slot schedule. */
  assistant: RoleModelScheduleConfig
  /** Engineering Eval (`orchestrator`) model & time-slot schedule. */
  eval: RoleModelScheduleConfig
  /** Engineering Worker (`worker-*`) model & time-slot schedule. */
  executor: RoleModelScheduleConfig
  /** Legacy compatibility getters/fields if older payloads sent `evalModel` / `executorModel` directly. */
  evalModel?: ModelSelection
  executorModel?: ModelSelection
}

export interface ModelProfilesConfig {
  /** Currently active profile group ID (`'profile-1'`, `'profile-2'`, `'profile-3'`). */
  activeProfileId: string
  /** Optional manual override for whether today is treated as a workday or holiday. Defaults to `'auto'`. */
  dayModeOverride?: DayModeOverride
  /** Optional user-specified holiday dates (`YYYY-MM-DD`). */
  customHolidays?: string[]
  /** Optional user-specified make-up workday dates (`YYYY-MM-DD`). */
  customWorkdays?: string[]
  profiles: ModelProfileGroup[]
}

export interface CalendarDayStatus {
  dateStr: string
  weekdayIndex: number
  weekdayLabel: { zh: string; en: string }
  effectiveDayType: 'workday' | 'holiday'
  dayModeOverride: DayModeOverride
  reason: { zh: string; en: string }
}

/** Built-in statutory holidays (China 2025-2026) in `YYYY-MM-DD`. */
const CN_STATUTORY_HOLIDAYS = new Set<string>([
  // 2025
  '2025-01-01',
  '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04',
  '2025-04-04', '2025-04-05', '2025-04-06',
  '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05',
  '2025-05-31', '2025-06-01', '2025-06-02',
  '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08',
  // 2026
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
])

/** Built-in statutory make-up workdays on weekends (China 2025-2026) in `YYYY-MM-DD`. */
const CN_MAKEUP_WORKDAYS = new Set<string>([
  // 2025
  '2025-01-26', '2025-02-08', '2025-04-27', '2025-09-28', '2025-10-11',
  // 2026
  '2026-01-04', '2026-02-14', '2026-02-28', '2026-04-26', '2026-05-09', '2026-09-20', '2026-10-10',
])

const WEEKDAY_NAMES_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WEEKDAY_NAMES_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function formatLocalDateYmd(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function resolveDayCalendarStatus(
  now = new Date(),
  options?: {
    dayModeOverride?: DayModeOverride
    customHolidays?: readonly string[]
    customWorkdays?: readonly string[]
  },
): CalendarDayStatus {
  const dateStr = formatLocalDateYmd(now)
  const weekdayIndex = now.getDay()
  const weekdayLabel = {
    zh: WEEKDAY_NAMES_ZH[weekdayIndex] ?? '周日',
    en: WEEKDAY_NAMES_EN[weekdayIndex] ?? 'Sun',
  }
  const override = options?.dayModeOverride ?? 'auto'

  if (override === 'force-workday') {
    return {
      dateStr,
      weekdayIndex,
      weekdayLabel,
      effectiveDayType: 'workday',
      dayModeOverride: override,
      reason: { zh: '手动强制按工作日生效', en: 'Manually forced as Workday' },
    }
  }
  if (override === 'force-holiday') {
    return {
      dateStr,
      weekdayIndex,
      weekdayLabel,
      effectiveDayType: 'holiday',
      dayModeOverride: override,
      reason: { zh: '手动强制按节假日生效', en: 'Manually forced as Holiday' },
    }
  }

  const customHolidaySet = new Set((options?.customHolidays ?? []).map(s => s.trim()).filter(Boolean))
  const customWorkdaySet = new Set((options?.customWorkdays ?? []).map(s => s.trim()).filter(Boolean))

  if (customHolidaySet.has(dateStr)) {
    return {
      dateStr,
      weekdayIndex,
      weekdayLabel,
      effectiveDayType: 'holiday',
      dayModeOverride: 'auto',
      reason: { zh: '自定义节假日', en: 'Custom holiday' },
    }
  }
  if (customWorkdaySet.has(dateStr)) {
    return {
      dateStr,
      weekdayIndex,
      weekdayLabel,
      effectiveDayType: 'workday',
      dayModeOverride: 'auto',
      reason: { zh: '自定义调休工作日', en: 'Custom workday' },
    }
  }
  if (CN_STATUTORY_HOLIDAYS.has(dateStr)) {
    return {
      dateStr,
      weekdayIndex,
      weekdayLabel,
      effectiveDayType: 'holiday',
      dayModeOverride: 'auto',
      reason: { zh: '法定节假日', en: 'Statutory holiday' },
    }
  }
  if (CN_MAKEUP_WORKDAYS.has(dateStr)) {
    return {
      dateStr,
      weekdayIndex,
      weekdayLabel,
      effectiveDayType: 'workday',
      dayModeOverride: 'auto',
      reason: { zh: '法定调休补班日', en: 'Make-up workday' },
    }
  }

  const isWeekend = weekdayIndex === 0 || weekdayIndex === 6
  return {
    dateStr,
    weekdayIndex,
    weekdayLabel,
    effectiveDayType: isWeekend ? 'holiday' : 'workday',
    dayModeOverride: 'auto',
    reason: isWeekend
      ? { zh: '周末休息日', en: 'Weekend' }
      : { zh: '常规工作日', en: 'Regular workday' },
  }
}

export function parseHhMm(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return undefined
  const h = Number(match[1])
  const m = Number(match[2])
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return undefined
  return h * 60 + m
}

export function isTimeInWindow(nowMinutes: number, startHhMm: string, endHhMm: string): boolean {
  const start = parseHhMm(startHhMm)
  const end = parseHhMm(endHhMm)
  if (start === undefined || end === undefined) return false
  if (start === end) return true
  if (start < end) {
    return nowMinutes >= start && nowMinutes < end
  }
  // Cross-midnight window (e.g. 22:00 -> 08:00)
  return nowMinutes >= start || nowMinutes < end
}

function normalizeSlot(slot: RoleTimeSlotRule): RoleTimeSlotRule {
  const dayType: SlotDayType =
    slot.dayType === 'workday' || slot.dayType === 'holiday' || slot.dayType === 'all'
      ? slot.dayType
      : 'all'
  return {
    ...slot,
    dayType,
  }
}

export function normalizeProfileGroup(
  raw: Partial<ModelProfileGroup> & { id: string; name: string },
  fallbackEval: ModelSelection,
  fallbackExec: ModelSelection,
): ModelProfileGroup {
  const evalDefault = raw.eval?.defaultModel ?? raw.evalModel ?? fallbackEval
  const execDefault = raw.executor?.defaultModel ?? raw.executorModel ?? fallbackExec
  const evalSlots = (Array.isArray(raw.eval?.timeSlots) ? raw.eval.timeSlots : []).map(normalizeSlot)
  const execSlots = (Array.isArray(raw.executor?.timeSlots) ? raw.executor.timeSlots : []).map(normalizeSlot)

  // If `assistant` was not yet stored separately, inherit `eval`'s defaultModel & timeSlots so existing user schedules immediately apply to Personal Assistant!
  const assistantDefault = raw.assistant?.defaultModel ?? evalDefault
  const assistantSlots = (
    Array.isArray(raw.assistant?.timeSlots)
      ? raw.assistant.timeSlots
      : evalSlots.map(s => ({ ...s, id: `asst-${s.id}`, model: { ...s.model } }))
  ).map(normalizeSlot)

  return {
    id: raw.id,
    name: raw.name,
    assistant: {
      defaultModel: assistantDefault,
      timeSlots: assistantSlots,
    },
    eval: {
      defaultModel: evalDefault,
      timeSlots: evalSlots,
    },
    executor: {
      defaultModel: execDefault,
      timeSlots: execSlots,
    },
  }
}

export function defaultModelProfilesConfig(current?: RoleModelsSummary): ModelProfilesConfig {
  const baseEval: ModelSelection = current?.eval ?? {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'low',
  }
  const baseExec: ModelSelection = current?.executor ?? {
    provider: 'niumacode',
    model: 'gpt-6.1-sol',
    reasoningEffort: 'xhigh',
  }
  return {
    activeProfileId: 'profile-1',
    dayModeOverride: 'auto',
    customHolidays: [],
    customWorkdays: [],
    profiles: [
      {
        id: 'profile-1',
        name: '配置组 1 · 主力混合',
        assistant: {
          defaultModel: { ...baseEval },
          timeSlots: [],
        },
        eval: {
          defaultModel: { ...baseEval },
          timeSlots: [],
        },
        executor: {
          defaultModel: { ...baseExec },
          timeSlots: [
            {
              id: 'p1-exec-peak-1',
              label: '工作日早高峰',
              startTime: '09:30',
              endTime: '12:00',
              dayType: 'workday',
              model: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
              enabled: false,
            },
            {
              id: 'p1-exec-peak-2',
              label: '工作日下午高峰',
              startTime: '14:00',
              endTime: '18:30',
              dayType: 'workday',
              model: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
              enabled: false,
            },
            {
              id: 'p1-exec-offpeak',
              label: '夜间低峰满血段',
              startTime: '18:30',
              endTime: '09:30',
              dayType: 'all',
              model: { ...baseExec, reasoningEffort: 'xhigh' },
              enabled: false,
            },
          ],
        },
      },
      {
        id: 'profile-2',
        name: '配置组 2 · 轻量高速',
        assistant: {
          defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
          timeSlots: [],
        },
        eval: {
          defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
          timeSlots: [],
        },
        executor: {
          defaultModel: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
          timeSlots: [],
        },
      },
      {
        id: 'profile-3',
        name: '配置组 3 · 深度攻坚',
        assistant: {
          defaultModel: { ...baseEval, reasoningEffort: 'high' },
          timeSlots: [],
        },
        eval: {
          defaultModel: { ...baseEval, reasoningEffort: 'high' },
          timeSlots: [],
        },
        executor: {
          defaultModel: { ...baseExec, reasoningEffort: 'xhigh' },
          timeSlots: [],
        },
      },
    ],
  }
}

export function resolveRoleModelAtTime(
  roleConfig: RoleModelScheduleConfig,
  nowMinutes: number,
  effectiveDayType: 'workday' | 'holiday' = 'workday',
): {
  model: ModelSelection
  matchedSlot?: RoleTimeSlotRule
} {
  for (const slot of roleConfig.timeSlots ?? []) {
    if (!slot.enabled) continue
    const slotDayType: SlotDayType = slot.dayType ?? 'all'
    if (slotDayType === 'workday' && effectiveDayType !== 'workday') continue
    if (slotDayType === 'holiday' && effectiveDayType !== 'holiday') continue
    if (isTimeInWindow(nowMinutes, slot.startTime, slot.endTime)) {
      return { model: slot.model, matchedSlot: slot }
    }
  }
  return { model: roleConfig.defaultModel }
}

export function resolveEffectiveModelProfile(
  config: ModelProfilesConfig | undefined,
  fallback: RoleModelsSummary,
  now = new Date(),
): {
  activeProfile: ModelProfileGroup
  assistantModel: ModelSelection
  evalModel: ModelSelection
  executorModel: ModelSelection
  matchedAssistantSlot?: RoleTimeSlotRule
  matchedEvalSlot?: RoleTimeSlotRule
  matchedExecutorSlot?: RoleTimeSlotRule
  calendarStatus: CalendarDayStatus
} {
  const defaults = defaultModelProfilesConfig(fallback)
  const rawProfiles = config?.profiles?.length ? config.profiles : defaults.profiles
  const normalizedProfiles = rawProfiles.map(p =>
    normalizeProfileGroup(p, defaults.profiles[0]!.eval.defaultModel, defaults.profiles[0]!.executor.defaultModel),
  )
  const activeProfile =
    normalizedProfiles.find(p => p.id === config?.activeProfileId) ??
    normalizedProfiles[0] ??
    defaults.profiles[0]!

  const calendarStatus = resolveDayCalendarStatus(now, {
    ...(config?.dayModeOverride ? { dayModeOverride: config.dayModeOverride } : {}),
    ...(config?.customHolidays ? { customHolidays: config.customHolidays } : {}),
    ...(config?.customWorkdays ? { customWorkdays: config.customWorkdays } : {}),
  })
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const asstResolved = resolveRoleModelAtTime(activeProfile.assistant, nowMinutes, calendarStatus.effectiveDayType)
  const evalResolved = resolveRoleModelAtTime(activeProfile.eval, nowMinutes, calendarStatus.effectiveDayType)
  const execResolved = resolveRoleModelAtTime(activeProfile.executor, nowMinutes, calendarStatus.effectiveDayType)

  return {
    activeProfile,
    assistantModel: asstResolved.model,
    evalModel: evalResolved.model,
    executorModel: execResolved.model,
    ...(asstResolved.matchedSlot ? { matchedAssistantSlot: asstResolved.matchedSlot } : {}),
    ...(evalResolved.matchedSlot ? { matchedEvalSlot: evalResolved.matchedSlot } : {}),
    ...(execResolved.matchedSlot ? { matchedExecutorSlot: execResolved.matchedSlot } : {}),
    calendarStatus,
  }
}
