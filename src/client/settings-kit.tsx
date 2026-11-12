/** Shared settings context, block draft hook, form controls, Source schema field renderer, and configuration history. */
import { cloneElement, createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement,
  type ReactNode } from 'react'
import type { ApiResponse } from '../app/api.ts'
import type { FieldSpec, Localized } from '../sources/kind.ts'
import { usePoll, type HistoryView, type Settings, type SettingsView, type SourceView } from './api.ts'
import { Button, DisclosureRow, Icon, InfoTip, Input, Modal, SegmentedControl, Switch } from './controls.tsx'
import { useDraft } from './draft.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { errorText, localized, valueLabel, when, type T } from './text.ts'
import { Hint, LoadState } from './widgets.tsx'

/** Parse a numeric input string, returning `null` when empty so the server rejects blank required numbers instead of coercing to 0. */
export const numberOf = (text: string): number | null => text.trim() ? Number(text) : null
interface SettingsData { settings: SettingsView; reload: () => Promise<void> }
const SettingsContext = createContext<SettingsData | undefined>(undefined)
export function useSettings(): SettingsData {
  const value = useContext(SettingsContext)
  if (!value) throw new Error('A settings block rendered outside the settings')
  return value
}
export function SettingsProvider({ children }: { children: ReactNode }) {
  const { call } = usePanel()
  const { restarts } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET settings'), [call, restarts])
  if (!data) return <LoadState error={error} loading />
  return <SettingsContext.Provider value={{ settings: data, reload }}>
    {error && <LoadState error={error} loading={false} />}
    {children}
  </SettingsContext.Provider>
}
export function useBlockDraft<V>(block: string, saved: V, revision: number, toValue: (draft: V) => unknown = draft => draft) {
  const { t, call, notify } = usePanel()
  const { state } = usePanelData()
  const { reload } = useSettings()
  return useDraft({ key: `dsh-superagent/draft/${state?.masterId ?? ''}/${block}`, saved, revision, reload, save: async (value, from) => {
    const result = await call('PUT settings/:block', { block, body: { value: toValue(value), revision: from } })
    notify(t(result.restarting ? 'savedRestarting' : 'saved'))
    return result
  } })
}

/** Fieldset wrapper that restores focus to the previously active input after a save completes and re-enables the form. */
export function Fields({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  const set = useRef<HTMLFieldSetElement>(null)
  const focused = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const active = document.activeElement
    if (disabled) focused.current = active instanceof HTMLElement && set.current?.contains(active) ? active : null
    else if (focused.current && (!active
      || active === document.body)) { focused.current.focus({ preventScroll: true }); focused.current = null }
  }, [disabled])
  return <fieldset ref={set} className="dt-fieldset" disabled={disabled}>{children}</fieldset>
}
export function Field({ label, hint, note,
  children }: { label: string; hint?: string | undefined; note?: ReactNode; children: ReactElement<{ id?: string }> }) {
  const id = useId()
  return <div className="dt-field">
    <span className="dt-field-head"><label htmlFor={id}>{label}</label>{hint && <InfoTip text={hint} />}</span>{cloneElement(children,
      { id })}{note && <small>{note}</small>}
  </div>
}
function SwitchRow({ label, hint, checked,
  onChange }: { label: string; hint?: string | undefined; checked: boolean; onChange: (next: boolean) => void }) {
  return <div className="dt-switch-row">
    <div className="dt-field-head">{label}{hint && <InfoTip text={hint} />}</div><Switch checked={checked} onChange={onChange}
      label={label} />
  </div>
}
type RoleModel = Settings['eval']['model']

export interface VisualModelCatalog {
  groups: readonly {
    id: string
    name: string
    models: readonly {
      id: string
      name: string
      reasoning?: {
        defaultEffort?: string | null | undefined
        efforts: readonly { id: string; name: string }[]
      } | null | undefined
    }[]
  }[]
  default?: { provider: string; model: string; reasoningEffort?: string | null | undefined } | null | undefined
}

const DEFAULT_EFFORTS = [
  { id: 'low', name: 'low' },
  { id: 'medium', name: 'medium' },
  { id: 'high', name: 'high' },
  { id: 'xhigh', name: 'xhigh' },
]

export const TIME_OPTIONS_30M: string[] = Array.from({ length: 48 }, (_, i) => {
  const h = String(Math.floor(i / 2)).padStart(2, '0')
  const m = i % 2 === 0 ? '00' : '30'
  return `${h}:${m}`
})

export const SLOT_PRESETS: {
  label: { zh: string; en: string }
  startTime: string
  endTime: string
  dayType: 'all' | 'workday' | 'holiday'
}[] = [
  { label: { zh: '上午高峰段', en: 'Morning Peak' }, startTime: '09:30', endTime: '12:00', dayType: 'workday' },
  { label: { zh: '下午高峰段', en: 'Afternoon Peak' }, startTime: '14:00', endTime: '18:30', dayType: 'workday' },
  { label: { zh: '晚间低峰段', en: 'Night Off-Peak' }, startTime: '18:30', endTime: '09:30', dayType: 'all' },
  { label: { zh: '节假日全天', en: 'Holiday All-Day' }, startTime: '00:00', endTime: '23:30', dayType: 'holiday' },
  { label: { zh: '每日白班段', en: 'Daily Day-Shift' }, startTime: '09:00', endTime: '18:00', dayType: 'all' },
]

export function formatSlotDayType(dayType: 'all' | 'workday' | 'holiday' | undefined, lang: 'zh' | 'en' = 'zh'): string {
  if (dayType === 'workday') return lang === 'zh' ? '仅工作日' : 'Workdays only'
  if (dayType === 'holiday') return lang === 'zh' ? '仅节假日/周末' : 'Holidays & Weekends'
  return lang === 'zh' ? '每天' : 'Every day'
}

export function formatModelSummary(
  model: { provider?: string; model?: string; reasoningEffort?: string | null } | null | undefined,
  inheritLabel = '默认模型',
): string {
  const p = model?.provider?.trim() ?? ''
  const m = model?.model?.trim() ?? ''
  const e = model?.reasoningEffort?.trim() ?? ''
  if (!p && !m) return inheritLabel
  return `${p || '-'} / ${m || '-'}${e ? ` · ${e}` : ''}`
}

/**
 * Universal visual model picker used inside the standalone configuration dialog (`ModelConfigModal`).
 */
export function VisualModelPicker({
  id,
  catalog,
  value,
  onChange,
  allowInherit = false,
  showRawInputs = false,
  alwaysShowEfforts = false,
  labels,
}: {
  id: string
  catalog: VisualModelCatalog | undefined
  value: RoleModel
  onChange: (next: RoleModel) => void
  allowInherit?: boolean
  showRawInputs?: boolean
  alwaysShowEfforts?: boolean
  labels: {
    provider: string
    model: string
    effort: string
    effortDefault: string
    inherit: string
    defaultHint?: string | undefined
    errorText?: string | undefined
  }
}) {
  const current = { provider: value?.provider ?? '', model: value?.model ?? '', effort: value?.reasoningEffort ?? '' }
  const set = (next: Partial<typeof current>) => {
    const { provider, model, effort } = { ...current, ...next }
    onChange(provider.trim() || model.trim() || effort.trim() ? { provider, model, ...(effort ? { reasoningEffort: effort } : {}) } : null)
  }

  const rawGroups = catalog?.groups ?? []
  const groups = (() => {
    const p = current.provider.trim()
    const m = current.model.trim()
    if (!p) return rawGroups
    const existingGroup = rawGroups.find(g => g.id === p)
    if (!existingGroup) {
      return [
        ...rawGroups,
        {
          id: p,
          name: p,
          models: m ? [{ id: m, name: m, reasoning: { efforts: DEFAULT_EFFORTS } }] : [],
        },
      ]
    }
    if (m && !existingGroup.models.some(item => item.id === m)) {
      return rawGroups.map(g =>
        g.id === p
          ? { ...g, models: [...g.models, { id: m, name: m, reasoning: { efforts: DEFAULT_EFFORTS } }] }
          : g,
      )
    }
    return rawGroups
  })()

  const fallback = catalog?.default
  const activeProviderId = current.provider.trim() || fallback?.provider || groups[0]?.id || ''
  const activeGroup = groups.find(group => group.id === activeProviderId)
  const models = groups.find(group => group.id === current.provider.trim())?.models ?? []
  const shownModels = activeGroup?.models ?? models
  const selectedModel = shownModels.find(model => model.id === (current.model.trim() || (!current.provider.trim() ? fallback?.model : '')))
  const rawEfforts = (models.find(model => model.id === current.model.trim()) ?? selectedModel)?.reasoning?.efforts ?? []
  const efforts = rawEfforts.length > 0 ? rawEfforts : (alwaysShowEfforts ? DEFAULT_EFFORTS : [])

  const input = (name: keyof typeof current, label: string, placeholder: string) => <Field label={label}>
    <Input spellCheck={false} placeholder={placeholder} value={current[name]}
      onChange={event => set({ [name]: event.target.value })} />
  </Field>

  return <div className="dt-model">
    {(labels.defaultHint || allowInherit) && (
      <div className="dt-model-head">
        {labels.defaultHint && <Hint>{labels.defaultHint}</Hint>}
        {allowInherit && (current.provider || current.model || current.effort) && (
          <Button variant="ghost" size="sm" onClick={() => onChange(null)}>{labels.inherit}</Button>
        )}
      </div>
    )}
    {labels.errorText && <p className="dt-error">{labels.errorText}</p>}
    {groups.length > 0 && (
      <div className="dt-model-picker">
        <div className="dt-model-col">
          <div className="dt-model-col-head">
            <span>{labels.provider}</span>
            <span className="dt-count">{groups.length}</span>
          </div>
          <div className="dt-model-list" role="listbox" aria-label={labels.provider}>
            {allowInherit && (
              <button
                type="button"
                role="option"
                aria-selected={!current.provider.trim() && !current.model.trim()}
                className="dt-model-item"
                onClick={() => onChange(null)}
              >
                <div className="dt-model-item-main">
                  <span className="dt-model-item-title">{labels.inherit}</span>
                  {fallback && <span className="dt-model-item-sub dt-mono">{fallback.provider} / {fallback.model}</span>}
                </div>
              </button>
            )}
            {groups.map(group => {
              const selected = current.provider.trim() === group.id
              return (
                <button
                  key={group.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="dt-model-item"
                  onClick={() => {
                    const firstModel = group.models[0]?.id ?? ''
                    const defaultEffort = group.models[0]?.reasoning?.defaultEffort ?? ''
                    set({ provider: group.id, model: firstModel, effort: defaultEffort })
                  }}
                >
                  <div className="dt-model-item-main">
                    <span className="dt-model-item-title">{group.name}</span>
                    <span className="dt-model-item-sub dt-mono">{group.id}</span>
                  </div>
                  <span className="dt-model-badge">{group.models.length}</span>
                </button>
              )
            })}
          </div>
        </div>
        <div className="dt-model-col">
          <div className="dt-model-col-head">
            <span>{labels.model}{activeGroup ? ` · ${activeGroup.name}` : ''}</span>
            <span className="dt-count">{shownModels.length}</span>
          </div>
          <div className="dt-model-list" role="listbox" aria-label={labels.model}>
            {shownModels.map(model => {
              const selected = current.provider.trim() === activeProviderId && current.model.trim() === model.id
              const effortList = model.reasoning?.efforts ?? []
              return (
                <button
                  key={model.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="dt-model-item"
                  onClick={() => {
                    const keepEffort = effortList.some(e => e.id === current.effort) || (alwaysShowEfforts && current.effort)
                      ? current.effort
                      : (model.reasoning?.defaultEffort ?? '')
                    set({ provider: activeProviderId, model: model.id, effort: keepEffort })
                  }}
                >
                  <div className="dt-model-item-main">
                    <span className="dt-model-item-title">{model.name}</span>
                    <span className="dt-model-item-sub dt-mono">{model.id}</span>
                  </div>
                  {effortList.length > 0 && (
                    <span className="dt-model-badge">{effortList.map(e => e.id).join(' / ')}</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    )}
    {efforts.length > 0 && (
      <div className="dt-model-efforts">
        <span className="dt-field-head">{labels.effort}</span>
        <div className="dt-filters">
          <button
            type="button"
            className={!current.effort ? 'dt-pill dt-pill-active' : 'dt-pill'}
            onClick={() => set({ provider: activeProviderId, model: current.model.trim() || selectedModel?.id || '', effort: '' })}
          >
            {labels.effortDefault}
          </button>
          {efforts.map(effort => (
            <button
              key={effort.id}
              type="button"
              className={current.effort === effort.id ? 'dt-pill dt-pill-active' : 'dt-pill'}
              onClick={() => set({ provider: activeProviderId, model: current.model.trim() || selectedModel?.id || '', effort: effort.id })}
            >
              {effort.name}
            </button>
          ))}
        </div>
      </div>
    )}
    {showRawInputs && (
      <>
        <div className="dt-grid3">
          {input('provider', labels.provider, labels.inherit)}{input('model', labels.model, labels.inherit)}{input('effort',
            labels.effort, labels.effortDefault)}
        </div>
        <datalist id={`${id}-efforts`} hidden>
          {rawEfforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
        </datalist>
      </>
    )}
  </div>
}

export interface SlotWindowDraft {
  label: string
  startTime: string
  endTime: string
  dayType?: 'all' | 'workday' | 'holiday'
}

/**
 * Independent modal dialog for configuring a model (and optionally a time-of-day slot window).
 * Opens when the user clicks "设置" on a simple text summary row, and commits on "保存并关闭".
 */
export function ModelConfigModal({
  open,
  title,
  catalog,
  value,
  slotWindow,
  allowInherit = false,
  lang = 'zh',
  labels,
  onClose,
  onSave,
}: {
  open: boolean
  title: string
  catalog: VisualModelCatalog | undefined
  value: RoleModel
  slotWindow?: SlotWindowDraft | undefined
  allowInherit?: boolean
  lang?: 'zh' | 'en'
  labels: {
    provider: string
    model: string
    effort: string
    effortDefault: string
    inherit: string
    defaultHint?: string | undefined
    errorText?: string | undefined
  }
  onClose: () => void
  onSave: (nextModel: RoleModel, nextSlot?: SlotWindowDraft) => void
}) {
  const [draftModel, setDraftModel] = useState<RoleModel>(value)
  const [draftSlot, setDraftSlot] = useState<SlotWindowDraft | undefined>(slotWindow)
  const [liveCatalog, setLiveCatalog] = useState<VisualModelCatalog | undefined>(catalog)
  const [refreshing, setRefreshing] = useState(false)
  const wasOpen = useRef(false)

  useEffect(() => {
    if (catalog) setLiveCatalog(catalog)
  }, [catalog])

  useEffect(() => {
    if (open && !wasOpen.current) {
      setDraftModel(value)
      setDraftSlot(slotWindow ? { ...slotWindow } : undefined)
      // Always fetch the latest catalog (synced with ~/.dsh/profiles/web/cordis.patch.yml) when opening
      fetch('/orchestrator/api/models', { headers: { 'x-orchestrator-request': '1' } })
        .then(r => r.json() as Promise<VisualModelCatalog>)
        .then(data => { if (data?.groups) setLiveCatalog(data) })
        .catch(() => {})
    }
    wasOpen.current = open
  }, [open, value, slotWindow])

  const forceRefreshCatalog = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      const res = await fetch('/orchestrator/standalone/models/refresh', {
        method: 'POST',
        headers: { 'x-orchestrator-request': '1' },
      })
      const data = await res.json() as VisualModelCatalog
      if (data?.groups) setLiveCatalog(data)
    } catch {} finally {
      setRefreshing(false)
    }
  }

  const timeListStart = draftSlot
    ? (TIME_OPTIONS_30M.includes(draftSlot.startTime) ? TIME_OPTIONS_30M : [draftSlot.startTime, ...TIME_OPTIONS_30M])
    : TIME_OPTIONS_30M
  const timeListEnd = draftSlot
    ? (TIME_OPTIONS_30M.includes(draftSlot.endTime) ? TIME_OPTIONS_30M : [draftSlot.endTime, ...TIME_OPTIONS_30M])
    : TIME_OPTIONS_30M

  return (
    <Modal
      className="dt-session-modal"
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={lang === 'zh' ? '关闭' : 'Close'}
      description={
        lang === 'zh'
          ? `当前已选：${formatModelSummary(draftModel, labels.inherit)}${draftSlot ? ` · [${formatSlotDayType(draftSlot.dayType, 'zh')}] ${draftSlot.startTime} → ${draftSlot.endTime}` : ''}`
          : `Selected: ${formatModelSummary(draftModel, labels.inherit)}${draftSlot ? ` · [${formatSlotDayType(draftSlot.dayType, 'en')}] ${draftSlot.startTime} → ${draftSlot.endTime}` : ''}`
      }
      footer={
        <div className="dt-live-head" style={{ width: '100%' }}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={refreshing}
            onClick={() => { void forceRefreshCatalog() }}
          >
            {refreshing
              ? (lang === 'zh' ? '正在同步 DSH / CLI 模型…' : 'Syncing models…')
              : (lang === 'zh' ? '↻ 重新扫描 DSH / CLI 模型' : '↻ Rescan DSH / CLI models')}
          </Button>
          <div className="dt-row-buttons">
            <Button type="button" variant="outline" onClick={onClose}>
              {lang === 'zh' ? '取消' : 'Cancel'}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                onSave(draftModel, draftSlot)
                onClose()
              }}
            >
              {lang === 'zh' ? '保存并关闭' : 'Save & Close'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="dt-form">
        {draftSlot && (
          <div className="dt-form dt-block">
            <div className="dt-live-head">
              <strong>{lang === 'zh' ? '时间段与工作日/节假日规则' : 'Time Window & Day Type'}</strong>
              <div className="dt-topic-switch">
                <select
                  className="dt-select"
                  style={{ width: 110 }}
                  aria-label={lang === 'zh' ? '开始时间' : 'Start time'}
                  value={draftSlot.startTime}
                  onChange={e => setDraftSlot({ ...draftSlot, startTime: e.target.value })}
                >
                  {timeListStart.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <span>→</span>
                <select
                  className="dt-select"
                  style={{ width: 110 }}
                  aria-label={lang === 'zh' ? '结束时间' : 'End time'}
                  value={draftSlot.endTime}
                  onChange={e => setDraftSlot({ ...draftSlot, endTime: e.target.value })}
                >
                  {timeListEnd.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>
            <div className="dt-row-buttons">
              <span className="dt-hint">{lang === 'zh' ? '适用日期：' : 'Applies on:'}</span>
              {([
                ['all', lang === 'zh' ? '每天 (不区分工作日/节假日)' : 'Every day'],
                ['workday', lang === 'zh' ? '仅工作日 (高峰期常用 · 跳过周末与法定节假日)' : 'Workdays only'],
                ['holiday', lang === 'zh' ? '仅节假日与周末' : 'Holidays & Weekends only'],
              ] as const).map(([dt, dtLabel]) => (
                <button
                  key={dt}
                  type="button"
                  className={(draftSlot.dayType ?? 'all') === dt ? 'dt-pill dt-pill-active' : 'dt-pill'}
                  onClick={() => setDraftSlot({ ...draftSlot, dayType: dt })}
                >
                  {dtLabel}
                </button>
              ))}
            </div>
            <div className="dt-row-buttons">
              <span className="dt-hint">{lang === 'zh' ? '快捷预设：' : 'Presets:'}</span>
              {SLOT_PRESETS.map(preset => {
                const pLabel = lang === 'zh' ? preset.label.zh : preset.label.en
                const isMatch =
                  draftSlot.startTime === preset.startTime &&
                  draftSlot.endTime === preset.endTime &&
                  draftSlot.label === pLabel &&
                  (draftSlot.dayType ?? 'all') === preset.dayType
                return (
                  <button
                    key={pLabel}
                    type="button"
                    className={isMatch ? 'dt-pill dt-pill-active' : 'dt-pill'}
                    onClick={() => setDraftSlot({
                      label: pLabel,
                      startTime: preset.startTime,
                      endTime: preset.endTime,
                      dayType: preset.dayType,
                    })}
                  >
                    {pLabel} ({preset.startTime}–{preset.endTime} · {formatSlotDayType(preset.dayType, lang)})
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <VisualModelPicker
          id="modal-visual-picker"
          catalog={liveCatalog}
          value={draftModel}
          onChange={setDraftModel}
          allowInherit={allowInherit}
          showRawInputs={false}
          alwaysShowEfforts
          labels={labels}
        />
      </div>
    </Modal>
  )
}

export function ModelField({ id, value, onChange }: { id: string; value: RoleModel; onChange: (next: RoleModel) => void }) {
  const { t, call } = usePanel()
  const [catalog, setCatalog] = useState<ApiResponse<'GET models'>>()
  const [error, setError] = useState<string>()
  const [modalOpen, setModalOpen] = useState(false)
  useEffect(() => { call('GET models').then(setCatalog, failure => setError(errorText(failure))) }, [call])

  const current = { provider: value?.provider ?? '', model: value?.model ?? '', effort: value?.reasoningEffort ?? '' }
  const set = (next: Partial<typeof current>) => {
    const { provider, model, effort } = { ...current, ...next }
    onChange(provider.trim() || model.trim() || effort.trim() ? { provider, model, ...(effort ? { reasoningEffort: effort } : {}) } : null)
  }
  const fallback = catalog?.default
  const models = catalog?.groups.find(group => group.id === current.provider.trim())?.models ?? []
  const rawEfforts = models.find(model => model.id === current.model.trim())?.reasoning?.efforts ?? []
  const defaultHint = fallback
    ? t('defaultModel', { model: `${fallback.provider} / ${fallback.model}${fallback.reasoningEffort ? ` · ${fallback.reasoningEffort}` : ''}` })
    : t('defaultModelUnavailable')

  return (
    <div className="dt-model">
      <div className="dt-msg-receipt" data-active={Boolean(current.provider || current.model)}>
        <div className="dt-msg-receipt-main">
          <strong className="dt-mono">{formatModelSummary(value, t('modelInherit'))}</strong>
          {!current.provider && !current.model && fallback && (
            <span className="dt-hint dt-mono">({fallback.provider} / {fallback.model}{fallback.reasoningEffort ? ` · ${fallback.reasoningEffort}` : ''})</span>
          )}
        </div>
        <div className="dt-row-buttons">
          {(current.provider || current.model || current.effort) && (
            <Button variant="ghost" size="sm" onClick={() => onChange(null)}>{t('modelInherit')}</Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setModalOpen(true)}>
            {t('tab.settings')}
          </Button>
        </div>
      </div>
      {error && <p className="dt-error">{t('modelCatalogError', { error })}</p>}

      {/* Hidden inputs preserve full compatibility with programmatic/test form bindings */}
      <div className="dt-grid3" hidden>
        <Field label={t('modelProvider')}>
          <Input spellCheck={false} placeholder={t('modelInherit')} value={current.provider} onChange={event => set({ provider: event.target.value })} />
        </Field>
        <Field label={t('modelName')}>
          <Input spellCheck={false} placeholder={t('modelInherit')} value={current.model} onChange={event => set({ model: event.target.value })} />
        </Field>
        <Field label={t('modelEffort')}>
          <Input spellCheck={false} placeholder={t('modelEffortDefault')} value={current.effort} onChange={event => set({ effort: event.target.value })} />
        </Field>
      </div>
      <datalist id={`${id}-efforts`} hidden>
        {rawEfforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
      </datalist>

      <ModelConfigModal
        open={modalOpen}
        title={t('modelName')}
        catalog={catalog}
        value={value}
        allowInherit
        labels={{
          provider: t('modelProvider'),
          model: t('modelName'),
          effort: t('modelEffort'),
          effortDefault: t('modelEffortDefault'),
          inherit: t('modelInherit'),
          defaultHint,
        }}
        onClose={() => setModalOpen(false)}
        onSave={nextModel => onChange(nextModel)}
      />
    </div>
  )
}

type HistoryChange = NonNullable<HistoryView['items'][number]['changes']>[number]
function changeText(t: T, change: HistoryChange, sources: SourceView[]): string {
  const source = sources.find(item => item.id === change.source)
  const field = (change.part ? source?.policy?.fields : source?.fields)?.find(item => item.key === change.field)
  const shown = (value: unknown) => value === undefined || value === null || value === '' ? t('unsetValue') : typeof value === 'boolean'
    ? t(value ? 'yes' : 'no')
    : change.code === 'mode' ? valueLabel(t, 'mode', String(value)) : String(value)
  return t(`change.${change.code}`,
    { items: (change.items ?? []).map(item => source?.labels[item] ?? item).join(t('listSeparator')),
    from: shown(change.from), to: shown(change.to), name: change.name ?? '', source: source ? localized(t, source.title)
      : change.source ?? '',
    field: field ? localized(t, field.label) : change.field ?? '' })
}
/**
 * Collapsible revision history for the specified settings blocks, optionally including all Policy-changing saves.
 * Revisions saved before per-block tracking existed have no `block` and appear under `policy`.
 */
export function ConfigHistory({ blocks, versions, focus }: { blocks: string[]; versions?: boolean; focus?: string }) {
  const { t, call } = usePanel()
  const { settings } = useSettings()
  const { sources } = settings
  const [open, setOpen] = useState(!!focus)
  const [data, setData] = useState<HistoryView>()
  const [error, setError] = useState<string>()
  const revisions = JSON.stringify([Object.values(settings.blocks).map(block => block.revision), sources.map(source => source.revision)])
  useEffect(() => { if (open) call('GET policy/history').then(setData, failure => setError(errorText(failure))) }, [open, call, revisions])
  const listed = (block: string | undefined) => block ? blocks.some(item => item === block || (item.endsWith(':')
    && block.startsWith(item))) : blocks.includes('policy')
  const items = data?.items.filter(item => (versions && item.policyChanged) || listed(item.block)) ?? []
  // Match the oldest save that produced the focused Policy version (where that version originated).
  const target = focus ? items.filter(item => item.policyChanged && item.policyVersion.startsWith(focus)).at(-1) : undefined
  const scroll = (element: HTMLLIElement | null) => { if (element
    && !element.dataset.scrolled) { element.dataset.scrolled = '1'; element.scrollIntoView?.({ block: 'center' }) } }
  return <DisclosureRow icon={<Icon name="history" />} title={t('configHistory')} open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      {error && <p className="dt-error">{error}</p>}
      {data && <>
        <Hint>{t('historyIntro')}</Hint>
        {focus && !target && <Hint>{t('policyVersionUnrecorded', { version: focus.slice(0, 8) })}</Hint>}
        {items.length ? <ul className="dt-timeline">{items.map(item => <li key={item.revision} className={item === target
          ? 'dt-event dt-highlight' : 'dt-event'}
          ref={item === target ? scroll : undefined}>
          <div className="dt-row-title">{t('historyItem', { revision: item.revision, source: valueLabel(t, 'historySource',
            item.source) })}</div>
          <div className="dt-event-foot">{when(item.savedAt, t('lang'))}{item.policyChanged && <> · {t('historyPolicyChanged',
            { version: item.policyVersion.slice(0, 8) })}</>}</div>
          {item.changes === null ? <Hint>{t('historyNoBaseline')}</Hint> : item.changes.length
            ? <ul className="dt-changes">{item.changes.map((change, index) => <li key={index}>{changeText(t, change, sources)}</li>)}</ul>
              : <Hint>{t('historyNoChanges')}</Hint>}
          {item.notified.length > 0 && <Hint>{t('historyNotified', { count: item.notified.length,
            titles: item.notified.map(ticket => ticket.title).join(t('listSeparator')) })}</Hint>}
        </li>)}</ul> : <Hint>{t('historyEmpty')}</Hint>}
      </>}
    </div>
  </DisclosureRow>
}

type Row = Record<string, string>
type Column = Extract<FieldSpec, { type: 'rows' }>['columns'][number]
const ROWS_SHOWN = 6
const byName = ([, a]: [string, string], [, b]: [string, string]) => a.localeCompare(b)
function RowsField({ field, value, saved, onChange, labels, refreshLabels }: {
  field: Extract<FieldSpec, { type: 'rows' }>; value: unknown; saved: unknown; onChange: (next: unknown) => void; labels: Record<string,
    string>
  refreshLabels: (() => Promise<string[]>) | undefined
}) {
  const { t, notify } = usePanel()
  const [open, setOpen] = useState(false)
  const refresh = useAction(async () => {
    try {
      const added = await refreshLabels!()
      notify(added.length ? t('labelsAdded', { names: added.join(t('listSeparator')) }) : t('labelsCurrent'))
    } catch (failure) { notify(t('labelsFailed', { error: errorText(failure) })) }
  })
  const label = localized(t, field.label), hint = localized(t, field.hint)
  const rows = Array.isArray(value) ? value as Row[] : []
  const set = (index: number, row: Row) => onChange(rows.map((item, position) => position === index ? row : item))
  const key = field.columns[0]!
  const savedKeys = new Set((Array.isArray(saved) ? saved as Row[] : []).map(row => row[key.key]))
  const choose = key.type === 'text' && key.choose && Object.keys(labels).length ? localized(t, key.choose) : ''
  // Exclude options already selected in another row.
  const choices = (id: string) => Object.entries(labels).filter(([option]) => option === id
    || !rows.some(other => other[key.key] === option)).sort(byName)
  const blank = Object.fromEntries(field.columns.map(column => [column.key, column.type === 'select' ? column.options[0]!.value : '']))
  // Summarize a row by its second column only when that column is free text (e.g., a display name), not a select option.
  const named = field.columns[1]?.type === 'text' ? field.columns[1] : undefined
  const rowName = (row: Row) => (named && row[named.key]) || labels[row[key.key] ?? ''] || row[key.key] || ''
  const cell = (row: Row, index: number, column: Column) => {
    const id = row[key.key] ?? '', change = (next: string) => set(index, { ...row, [column.key]: next })
    if (column === key && (savedKeys.has(id) || (!choose && labels[id]))) {
      return <span key={column.key} className={labels[id] ? 'dt-row-label' : 'dt-row-label dt-mono'} title={id}>{labels[id] ?? id}</span>
    }
    if (column === key && choose) {
      return <select key={column.key} className="dt-select" aria-label={choose} required value={id}
        onChange={event => change(event.target.value)}>
        <option value="" disabled>{choose}</option>
        {choices(id).map(([option, name]) => <option key={option} value={option}>{name}</option>)}
      </select>
    }
    if (column.type === 'select') {
      return <select key={column.key} className="dt-select" aria-label={localized(t, column.label)} value={row[column.key] ?? ''}
        onChange={event => change(event.target.value)}>
        {column.options.map(option => <option key={option.value} value={option.value}>{localized(t, option.label)}</option>)}
      </select>
    }
    return <Input key={column.key} className={column.optional ? undefined : 'dt-mono'} aria-label={localized(t, column.label)}
      placeholder={localized(t, column.label)}
      required={!column.optional} pattern={column.pattern} spellCheck={false} value={row[column.key] ?? ''}
        onChange={event => change(event.target.value)} />
  }
  return <div className="dt-field">
    <div className="dt-subhead">
      <span className="dt-field-head">{label}{hint && <InfoTip text={hint} />}<span className="dt-count">{rows.length || ''}</span></span>
      <span className="dt-subhead-actions">
        {key.type === 'text' && key.refresh && refreshLabels && <Button variant="ghost" size="sm" className={refresh.busy ? 'dt-btn-busy'
          : undefined} icon={<Icon name="refresh" />}
          disabled={refresh.busy} aria-busy={refresh.busy} onClick={() => { void refresh.run() }}>{localized(t, key.refresh)}</Button>}
        <Button variant="ghost" size="sm" icon={<Icon name="plus" />} onClick={() => { setOpen(true); onChange([...rows,
          blank]) }}>{t('addRow')}</Button>
      </span>
    </div>
    {rows.length > ROWS_SHOWN && <button type="button" className="dt-textlink dt-rows-summary" aria-expanded={open}
      onClick={() => setOpen(!open)}>
      {open ? t('collapse') : rows.map(rowName).join(t('listSeparator'))}
    </button>}
    {(rows.length <= ROWS_SHOWN || open) && <ul className="dt-rows"
      style={{ ['--dt-columns' as string]: field.columns.length }}>{rows.map((row, index) => <li key={index} className="dt-rows-item">
      {field.columns.map(column => cell(row, index, column))}
      <Button variant="ghost" size="sm" icon={<Icon name="trash" />} aria-label={t('removeRow', { name: labels[row[key.key] ?? '']
        || row[key.key] || label })}
        onClick={() => onChange(rows.filter((_, position) => position !== index))} />
    </li>)}</ul>}
  </div>
}
export function SourceField({ field, value, saved, fact, onChange, labels, refreshLabels }: {
  field: FieldSpec; value: unknown; saved: unknown; fact: Localized | string | undefined; onChange: (next: unknown) => void
  labels: Record<string, string>
  refreshLabels?: () => Promise<string[]>
}) {
  const { t, navigate } = usePanel()
  const label = localized(t, field.label), hint = localized(t, field.hint)
  switch (field.type) {
    case 'switch': return <SwitchRow label={label} hint={hint} checked={value === true} onChange={onChange} />
    case 'select': return <Field label={label} hint={hint}>
      <SegmentedControl className="dt-segmented dt-field-segmented" label={label} value={String(value ?? field.options[0]!.value)}
        options={field.options.map(option => ({ value: option.value, label: localized(t, option.label) }))} onChange={onChange} />
    </Field>
    case 'number': return <Field label={label} hint={hint}>
      <Input type="number" min={field.min} max={field.max} required value={String(value ?? '')}
        onChange={event => onChange(event.target.value === '' ? '' : Number(event.target.value))} />
    </Field>
    case 'text': return <Field label={label} hint={hint} note={localized(t, fact)}>
      {field.choose && Object.keys(labels).length
        ? <select className="dt-select" value={String(value ?? '')} onChange={event => onChange(event.target.value)}>
          <option value="">{localized(t, field.choose)}</option>
          {value && !labels[String(value)] ? <option value={String(value)}>{String(value)}</option> : null}
          {Object.entries(labels).sort(byName).map(([option, name]) => <option key={option} value={option}>{name}</option>)}
        </select>
        : <Input value={String(value ?? '')} readOnly={field.readonly} pattern={field.pattern} spellCheck={false}
          onChange={event => onChange(event.target.value)} />}
    </Field>
    case 'fact': return <div className="dt-field">
      <span className="dt-field-head">{label}{hint && <InfoTip text={hint} />}</span>
      <span className="dt-mono">{localized(t, fact) || t('empty')}</span>
      {field.settings && <small>
        <button type="button" className="dt-textlink"
          onClick={() => navigate(settingsRoute(field.settings!))}>{t(`openSettingsOf.${field.settings}`)}</button>
      </small>}
    </div>
    case 'rows': return <RowsField field={field} value={value} saved={saved} onChange={onChange} labels={labels}
      refreshLabels={refreshLabels} />
  }
}
