/** Standalone workspace: 3-column coordinated workbench, RHFiles/RHRemote-style multi-address device group, per-role N-segment time-window model profiles, 4-stage pipeline audit, and session console. */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app.tsx'
import { Button, Input, Modal, Switch, Tag } from './controls.tsx'
import {
  formatModelSummary,
  formatSlotDayType,
  ModelConfigModal,
  SLOT_PRESETS,
  type VisualModelCatalog,
} from './settings-kit.tsx'
import { PanelConversation } from './standalone-composer.tsx'
import { LiveWorkspace, SessionActivity, useLiveSession } from './standalone-activity.tsx'
import { TicketActivity } from './ticket-activity.tsx'
import { MarkdownText as MarkdownLite, headingAnchorId, openMarkdownViewer, type OpenMarkdownEventDetail } from './markdown-view.tsx'
import { markdownBlocks } from './markdown.ts'
import {
  ClawFeedNotificationsSlotView,
  getEnabledUIViewSlots,
  PersonalAssistantSlotView,
  RHToolkitSlotView,
  type MainViewSlotId,
} from './ui-slots.tsx'
import {
  formatSmartTimestamp,
  standaloneFetch,
  type AssistantChatBackupInfo,
  type AssistantContextConfigInfo,
  type AssistantMessageInfo,
  type ClawFeedItemInfo,
  type DayModeOverrideInfo,
  type DeviceGroupSummary,
  type Lang,
  type LiveSessionRunInfo,
  type MemoryBackupInfo,
  type MemoryCategoryInfo,
  type MemoryEntryInfo,
  type ModelProfileGroupInfo,
  type ModelProfilesState,
  type PendingUserQuestionInfo,
  type PipelineRow,
  type PluginDescriptorInfo,
  type RoleModelScheduleConfigInfo,
  type RoleModelsSummary,
  type RoleTimeSlotRuleInfo,
  type SessionProgressCardInfo,
  type SessionSummary,
  type WorkerNodeInfo,
} from './standalone-api.ts'
import { en, zh, type DshSuperagentKey } from './locales.ts'
import type { T } from './text.ts'

function makeTranslator(dict: Record<string, string>): T {
  return ((key: DshSuperagentKey, values?: Record<string, unknown>) => {
    const template = dict[key] ?? en[key] ?? key
    return values ? template.replace(/\{(\w+)\}/g, (_match, name: string) =>
      values[name] !== undefined && values[name] !== null ? String(values[name]) : `{${name}}`) : template
  }) as T
}

export function RHarnessLogo({ size = 24 }: { size?: number }) {
  return <svg
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    className="dt-brand-logo"
  >
    <rect width="32" height="32" rx="8" fill="#2563EB" />
    <path
      d="M9.5 23V9H16.2C18.85 9 20.6 10.55 20.6 13.05C20.6 14.95 19.45 16.35 17.6 16.85L21.2 23H18.05L14.85 17.15H12.3V23H9.5ZM12.3 14.8H15.85C17.15 14.8 17.9 14.1 17.9 13.05C17.9 12 17.15 11.35 15.85 11.35H12.3V14.8Z"
      fill="#FFFFFF"
    />
    <circle cx="23.5" cy="9.5" r="2.5" fill="#60A5FA" />
    <circle cx="23.5" cy="22.5" r="2.2" fill="#93C5FD" />
    <path d="M20.2 12.2L22.2 10.5M19.8 19.5L22.1 21.4" stroke="#93C5FD" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
}

function RoleScheduleEditor({
  roleTitle,
  config,
  catalog,
  lang,
  onChange,
}: {
  idPrefix?: string
  roleTitle: string
  config: RoleModelScheduleConfigInfo
  catalog: VisualModelCatalog | undefined
  lang: Lang
  onChange: (next: RoleModelScheduleConfigInfo) => void
}) {
  const [editingTarget, setEditingTarget] = useState<
    | { kind: 'default' }
    | { kind: 'slot'; index: number }
    | { kind: 'new-slot'; presetIndex: number }
    | null
  >(null)

  const pickerLabels = {
    provider: lang === 'zh' ? '模型提供商' : 'Provider',
    model: lang === 'zh' ? '模型名称' : 'Model',
    effort: lang === 'zh' ? '推理强度 (Reasoning Effort)' : 'Reasoning effort',
    effortDefault: lang === 'zh' ? '默认强度' : 'Default',
    inherit: lang === 'zh' ? '默认' : 'Default',
  }

  const updateSlot = (idx: number, patch: Partial<RoleTimeSlotRuleInfo>) => {
    onChange({
      ...config,
      timeSlots: config.timeSlots.map((s, i) => i === idx ? { ...s, ...patch } : s),
    })
  }

  const removeSlot = (idx: number) => {
    onChange({
      ...config,
      timeSlots: config.timeSlots.filter((_, i) => i !== idx),
    })
  }

  const activePreset = editingTarget?.kind === 'new-slot'
    ? SLOT_PRESETS[editingTarget.presetIndex % SLOT_PRESETS.length]!
    : undefined
  const editingSlot = editingTarget?.kind === 'slot' ? config.timeSlots[editingTarget.index] : undefined

  return <div className="dt-pipeline-list" style={{ padding: 12, borderRadius: 12, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-module-platform)' }}>
    <div className="dt-live-head">
      <strong>{roleTitle}</strong>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={e => {
          e.preventDefault()
          e.stopPropagation()
          setEditingTarget({ kind: 'new-slot', presetIndex: config.timeSlots.length })
        }}
      >
        {lang === 'zh' ? '+ 添加时间段' : '+ Add time slot'}
      </Button>
    </div>

    {/* Simple text row for the Role Default Model */}
    <div className="dt-msg-receipt" data-active="true">
      <div className="dt-msg-receipt-main">
        <Tag tone="info">{lang === 'zh' ? '默认模型' : 'Default'}</Tag>
        <strong className="dt-mono">{formatModelSummary(config.defaultModel)}</strong>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={e => {
          e.preventDefault()
          e.stopPropagation()
          setEditingTarget({ kind: 'default' })
        }}
      >
        {lang === 'zh' ? '设置' : 'Configure'}
      </Button>
    </div>

    {/* Simple text rows for Time Slots */}
    {config.timeSlots.length > 0 && <div className="dt-pipeline-list" style={{ marginTop: 4 }}>
      <span className="dt-hint">
        {lang === 'zh'
          ? `分时自动切换（共 ${config.timeSlots.length} 段；未命中启用时段时使用上方默认模型）：`
          : `Time-slot overrides (${config.timeSlots.length}):`}
      </span>
      {config.timeSlots.map((slot, idx) => (
        <div key={slot.id} className="dt-msg-receipt" data-active={slot.enabled}>
          <div className="dt-msg-receipt-main">
            <Switch
              checked={slot.enabled}
              onChange={enabled => updateSlot(idx, { enabled })}
              label={slot.label}
            />
            <strong>{slot.label}</strong>
            <Tag tone="info">{formatSlotDayType(slot.dayType, lang)}</Tag>
            <Tag tone={slot.enabled ? 'success' : 'neutral'}>
              {slot.startTime} → {slot.endTime}
            </Tag>
            <span className="dt-mono">{formatModelSummary(slot.model)}</span>
          </div>
          <div className="dt-row-buttons">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={e => {
                e.preventDefault()
                e.stopPropagation()
                setEditingTarget({ kind: 'slot', index: idx })
              }}
            >
              {lang === 'zh' ? '设置' : 'Configure'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={e => {
                e.preventDefault()
                e.stopPropagation()
                removeSlot(idx)
              }}
            >
              {lang === 'zh' ? '删除' : 'Remove'}
            </Button>
          </div>
        </div>
      ))}
    </div>}

    {/* Standalone Visual Configuration Dialog opened when clicking "设置" or "+ 添加时间段" */}
    <ModelConfigModal
      open={editingTarget !== null}
      title={
        editingTarget?.kind === 'default'
          ? `${roleTitle} · ${lang === 'zh' ? '默认模型设置' : 'Default Model'}`
          : editingTarget?.kind === 'slot'
            ? `${roleTitle} · ${lang === 'zh' ? '编辑时间段模型' : 'Edit Time Slot'}`
            : `${roleTitle} · ${lang === 'zh' ? '添加时间段模型' : 'Add Time Slot'}`
      }
      catalog={catalog}
      value={
        editingTarget?.kind === 'slot' && editingSlot
          ? editingSlot.model
          : config.defaultModel
      }
      slotWindow={
        editingTarget?.kind === 'slot' && editingSlot
          ? {
              label: editingSlot.label,
              startTime: editingSlot.startTime,
              endTime: editingSlot.endTime,
              dayType: editingSlot.dayType ?? 'all',
            }
          : editingTarget?.kind === 'new-slot' && activePreset
            ? {
                label: lang === 'zh' ? activePreset.label.zh : activePreset.label.en,
                startTime: activePreset.startTime,
                endTime: activePreset.endTime,
                dayType: activePreset.dayType,
              }
            : undefined
      }
      allowInherit={false}
      lang={lang}
      labels={pickerLabels}
      onClose={() => setEditingTarget(null)}
      onSave={(nextModel, nextSlot) => {
        if (!nextModel) return
        if (editingTarget?.kind === 'default') {
          onChange({ ...config, defaultModel: nextModel })
        } else if (editingTarget?.kind === 'slot' && editingSlot) {
          updateSlot(editingTarget.index, {
            model: nextModel,
            ...(nextSlot ? {
              label: nextSlot.label,
              startTime: nextSlot.startTime,
              endTime: nextSlot.endTime,
              dayType: nextSlot.dayType ?? 'all',
            } : {}),
          })
        } else if (editingTarget?.kind === 'new-slot' && nextSlot) {
          const created: RoleTimeSlotRuleInfo = {
            id: `slot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            label: nextSlot.label,
            startTime: nextSlot.startTime,
            endTime: nextSlot.endTime,
            dayType: nextSlot.dayType ?? 'all',
            model: nextModel,
            enabled: true,
          }
          onChange({
            ...config,
            timeSlots: [...config.timeSlots, created],
          })
        }
      }}
    />
  </div>
}

function ModelProfilesModal({
  open,
  lang,
  profilesState,
  onClose,
  onUpdated,
}: {
  open: boolean
  lang: Lang
  profilesState: ModelProfilesState | undefined
  onClose: () => void
  onUpdated: (next: ModelProfilesState) => void
}) {
  const [profiles, setProfiles] = useState<ModelProfileGroupInfo[]>([])
  const [activeProfileId, setActiveProfileId] = useState('profile-1')
  const [selectedTabId, setSelectedTabId] = useState('profile-1')
  const [dayModeOverride, setDayModeOverride] = useState<DayModeOverrideInfo>('auto')
  const [catalog, setCatalog] = useState<VisualModelCatalog>()
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const wasOpenRef = useRef(false)

  // Only initialize local state when the modal transitions from closed -> open (never overwrite while open during background polls!)
  useEffect(() => {
    if (open && !wasOpenRef.current && profilesState?.config?.profiles) {
      setProfiles(profilesState.config.profiles)
      setActiveProfileId(profilesState.config.activeProfileId)
      setSelectedTabId(profilesState.config.activeProfileId)
      setDayModeOverride(profilesState.config.dayModeOverride ?? 'auto')
      setFeedback('')
      setError('')
    }
    wasOpenRef.current = open
  }, [open, profilesState])

  // Load the visual model catalog when modal opens
  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetch('/orchestrator/api/models', { headers: { 'x-orchestrator-request': '1' } })
      .then(r => r.json() as Promise<VisualModelCatalog>)
      .then(data => { if (!cancelled && data?.groups) setCatalog(data) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [open])

  const persistImmediately = async (
    nextProfiles: ModelProfileGroupInfo[],
    nextActiveId: string,
    nextDayMode: DayModeOverrideInfo = dayModeOverride,
    closeAfter = false,
  ) => {
    setBusy(true); setError('')
    try {
      const res = await standaloneFetch<ModelProfilesState>('model-profiles', 'PUT', {
        activeProfileId: nextActiveId,
        dayModeOverride: nextDayMode,
        profiles: nextProfiles,
      })
      if (res?.config?.profiles) onUpdated(res)
      setFeedback(lang === 'zh' ? '✓ 已保存' : '✓ Saved')
      if (closeAfter) onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const updateGroup = (idx: number, patch: Partial<ModelProfileGroupInfo>) => {
    const nextProfiles = profiles.map((item, i) => i === idx ? { ...item, ...patch } : item)
    setProfiles(nextProfiles)
    void persistImmediately(nextProfiles, activeProfileId, dayModeOverride)
  }

  const selectAndActivateGroup = (id: string) => {
    setSelectedTabId(id)
    setActiveProfileId(id)
    void persistImmediately(profiles, id, dayModeOverride)
  }

  const updateDayMode = (nextMode: DayModeOverrideInfo) => {
    setDayModeOverride(nextMode)
    void persistImmediately(profiles, activeProfileId, nextMode)
  }

  const currentIdx = Math.max(0, profiles.findIndex(p => p.id === selectedTabId))
  const currentGroup = profiles[currentIdx]
  const cal = profilesState?.calendarStatus

  return <Modal
    className="dt-session-modal"
    open={open}
    onClose={onClose}
    title={lang === 'zh' ? '模型配置组 (1/2/3) 与工作日/节假日分时调度' : 'Model Profile Groups (1/2/3)'}
    closeLabel={lang === 'zh' ? '关闭' : 'Close'}
    footer={
      <div className="dt-row-buttons">
        <Button type="button" variant="outline" onClick={onClose}>
          {lang === 'zh' ? '关闭' : 'Close'}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={busy}
          onClick={() => { void persistImmediately(profiles, activeProfileId, dayModeOverride, true) }}
        >
          {lang === 'zh' ? '保存并关闭' : 'Save & Close'}
        </Button>
      </div>
    }
  >
    <div className="dt-form">
      <div className="dt-live-head">
        <div className="dt-mode-switcher" role="tablist" aria-label={lang === 'zh' ? '选择配置组' : 'Select profile group'}>
          {profiles.map((p, idx) => <button
            key={p.id}
            type="button"
            role="tab"
            className="dt-mode-tab"
            aria-selected={selectedTabId === p.id}
            onClick={() => selectAndActivateGroup(p.id)}
          >
            {lang === 'zh' ? `组${idx + 1}：${p.name}` : `Group ${idx + 1}: ${p.name}`}
          </button>)}
        </div>
        {feedback && <span className="dt-hint" role="status">{feedback}</span>}
      </div>

      {/* Workday vs Holiday Status & Override Bar */}
      <div className="dt-msg-receipt" data-active="true">
        <div className="dt-msg-receipt-main">
          <strong>{lang === 'zh' ? '📅 工作日 / 节假日判定：' : '📅 Calendar Day Mode:'}</strong>
          {cal && (
            <Tag tone={cal.effectiveDayType === 'workday' ? 'info' : 'warning'}>
              {cal.dateStr} ({lang === 'zh' ? cal.weekdayLabel.zh : cal.weekdayLabel.en}) ·{' '}
              {cal.effectiveDayType === 'workday'
                ? (lang === 'zh' ? '当前按【工作日】规则生效' : 'Active as Workday')
                : (lang === 'zh' ? '当前按【节假日/周末】规则生效' : 'Active as Holiday/Weekend')}
            </Tag>
          )}
          {cal && <span className="dt-hint">({lang === 'zh' ? cal.reason.zh : cal.reason.en})</span>}
        </div>
        <div className="dt-row-buttons">
          {([
            ['auto', lang === 'zh' ? '自动识别法定节假日/周末' : 'Auto Calendar'],
            ['force-workday', lang === 'zh' ? '强制按工作日生效' : 'Force Workday'],
            ['force-holiday', lang === 'zh' ? '强制按节假日生效' : 'Force Holiday'],
          ] as const).map(([modeKey, modeLabel]) => (
            <button
              key={modeKey}
              type="button"
              className={dayModeOverride === modeKey ? 'dt-pill dt-pill-active' : 'dt-pill'}
              onClick={() => updateDayMode(modeKey)}
            >
              {modeLabel}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="dt-error" role="status">{error}</p>}

      {currentGroup && <div key={currentGroup.id} className="dt-form dt-block">
        <div className="dt-live-head">
          <div className="dt-msg-receipt-main">
            <h3 className="dt-block-title">#{currentIdx + 1} · {currentGroup.name}</h3>
            <Tag tone={activeProfileId === currentGroup.id ? 'success' : 'neutral'}>
              {activeProfileId === currentGroup.id ? (lang === 'zh' ? '当前生效组' : 'Active group') : currentGroup.id}
            </Tag>
          </div>
        </div>

        <RoleScheduleEditor
          idPrefix={`${currentGroup.id}-assistant`}
          roleTitle={lang === 'zh' ? '角色 1：个人助理模型 (Claw Assistant)' : 'Role 1: Personal Assistant (Claw)'}
          config={currentGroup.assistant ?? currentGroup.eval}
          catalog={catalog}
          lang={lang}
          onChange={nextAsst => updateGroup(currentIdx, { assistant: nextAsst })}
        />

        <RoleScheduleEditor
          idPrefix={`${currentGroup.id}-eval`}
          roleTitle={lang === 'zh' ? '角色 2：工程主控评估模型 (Eval / Orchestrator)' : 'Role 2: Engineering Eval / Orchestrator'}
          config={currentGroup.eval}
          catalog={catalog}
          lang={lang}
          onChange={nextEval => updateGroup(currentIdx, { eval: nextEval })}
        />

        <RoleScheduleEditor
          idPrefix={`${currentGroup.id}-exec`}
          roleTitle={lang === 'zh' ? '角色 3：工程工单执行器模型 (Worker / Executor)' : 'Role 3: Engineering Worker / Executor'}
          config={currentGroup.executor}
          catalog={catalog}
          lang={lang}
          onChange={nextExec => updateGroup(currentIdx, { executor: nextExec })}
        />
      </div>}
    </div>
  </Modal>
}

function WorkerNodesModal({
  open,
  lang,
  nodes,
  deviceGroup,
  onClose,
  onNodesUpdated,
}: {
  open: boolean
  lang: Lang
  nodes: WorkerNodeInfo[]
  deviceGroup: DeviceGroupSummary | undefined
  onClose: () => void
  onNodesUpdated: (next: WorkerNodeInfo[]) => void
}) {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [nodeHostname, setNodeHostname] = useState('')
  const [tailscaleDnsName, setTailscaleDnsName] = useState('')
  const [tailscaleIps, setTailscaleIps] = useState('')
  const [tags, setTags] = useState('heavy-coding, windows, preferred')
  const [gitUrl, setGitUrl] = useState('')
  const [inviteUri, setInviteUri] = useState('')
  const [joinUri, setJoinUri] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')

  const generateInvite = async () => {
    if (busy) return
    setBusy(true); setError(''); setFeedback('')
    try {
      const res = await standaloneFetch<{ uri: string; groupName: string }>('device-group/invite', 'POST', { canInvite: true })
      setInviteUri(res.uri)
      setFeedback(lang === 'zh' ? '已生成一次性入组邀请码（自动携带本机局域网IP、不变机器名、Tailscale固定域名与IP），复制到另一台电脑即可一键入组！' : 'Generated one-use invitation URI with all address forms.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const joinByInvite = async (event: FormEvent) => {
    event.preventDefault()
    if (!joinUri.trim() || busy) return
    setBusy(true); setError(''); setFeedback('')
    try {
      const res = await standaloneFetch<{ nodes: WorkerNodeInfo[] }>('device-group/join', 'POST', { uri: joinUri.trim() })
      onNodesUpdated(res.nodes)
      setJoinUri('')
      setFeedback(lang === 'zh' ? '已成功通过公钥签名验证加入设备组，组内所有电脑的多重地址已自动同步！' : 'Joined device group and synced all peers!')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const addNode = async (event: FormEvent) => {
    event.preventDefault()
    if (!id.trim() || !url.trim() || busy) return
    setBusy(true); setError('')
    try {
      const res = await standaloneFetch<{ nodes: WorkerNodeInfo[] }>('nodes', 'POST', {
        id: id.trim(),
        name: name.trim() || id.trim(),
        url: url.trim(),
        ...(nodeHostname.trim() ? { hostname: nodeHostname.trim() } : {}),
        ...(tailscaleDnsName.trim() ? { tailscaleDnsName: tailscaleDnsName.trim() } : {}),
        ...(tailscaleIps.trim() ? { tailscaleIps: tailscaleIps.trim() } : {}),
        tags,
        ...(gitUrl.trim() ? { gitUrl: gitUrl.trim() } : {}),
        status: 'online',
      })
      onNodesUpdated(res.nodes)
      setId(''); setName(''); setUrl(''); setNodeHostname(''); setTailscaleDnsName(''); setTailscaleIps(''); setGitUrl('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const removeNode = async (nodeId: string) => {
    if (busy || nodeId === 'local') return
    setBusy(true); setError('')
    try {
      const res = await standaloneFetch<{ nodes: WorkerNodeInfo[] }>(`nodes/${encodeURIComponent(nodeId)}`, 'DELETE')
      onNodesUpdated(res.nodes)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return <Modal
    className="dt-session-modal"
    open={open}
    onClose={onClose}
    title={lang === 'zh' ? '设备组令牌配对与多重地址防掉线节点池' : 'Device Group Pairing & Multi-Address Resilient Nodes'}
    closeLabel={lang === 'zh' ? '关闭' : 'Close'}
    description={lang === 'zh'
      ? '结合 RHFiles 公钥签名设备组与 RHRemote 多路径寻址：每台节点同时保存「局域网 IP + 不变机器名 + Tailscale 固定域名 (机器名.xxx.ts.net) + Tailscale IP」，局域网 IP 变化时自动按序无缝回退。'
      : 'Stores LAN IP, invariant hostname, Tailscale MagicDNS FQDN, and Tailscale IP for every node with automatic failover.'}
  >
    <div className="dt-form">
      {error && <p className="dt-error" role="status">{error}</p>}
      {feedback && <p className="dt-hint" role="status">{feedback}</p>}

      {deviceGroup && <div className="dt-form dt-block">
        <div className="dt-live-head">
          <div>
            <h3 className="dt-block-title">
              {lang === 'zh' ? '本机加密身份与多路径地址' : 'Local Identity & Multi-Path Addresses'}
              {deviceGroup.groupName && <Tag tone="success">{deviceGroup.groupName}</Tag>}
            </h3>
            <div className="dt-mono dt-hint">
              <div>{lang === 'zh' ? '机器名：' : 'Hostname: '}<strong>{deviceGroup.identity.hostname || deviceGroup.identity.deviceName}</strong> · ID: {deviceGroup.identity.deviceId.slice(0, 16)}…</div>
              {deviceGroup.identity.tailscaleDnsName && <div>Tailscale MagicDNS: <strong>{deviceGroup.identity.tailscaleDnsName}</strong> ({deviceGroup.identity.tailscaleIps?.join(', ')})</div>}
              <div>{lang === 'zh' ? '候选端点列表：' : 'Endpoints: '}{deviceGroup.identity.endpoints.join('  |  ')}</div>
            </div>
          </div>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => { void generateInvite() }}>
            {lang === 'zh' ? '生成一次性入组邀请码' : 'Generate 1-use Invite URI'}
          </Button>
        </div>

        {inviteUri && <div className="dt-field">
          <span className="dt-field-head">{lang === 'zh' ? '一次性邀请码（复制到其他电脑粘贴即可入组互通）：' : 'One-use Invitation URI:'}</span>
          <textarea className="dt-textarea dt-mono" rows={2} readOnly value={inviteUri} />
        </div>}

        <form className="dt-topic-switch" onSubmit={event => { void joinByInvite(event) }}>
          <Input
            value={joinUri}
            onChange={e => setJoinUri(e.target.value)}
            placeholder={lang === 'zh' ? '粘贴其他电脑生成的 rharness-group-invite:v1:... 邀请码加入设备组' : 'Paste rharness-group-invite:v1:... URI to join'}
          />
          <Button type="submit" variant="outline" size="sm" disabled={busy || !joinUri.trim()}>
            {lang === 'zh' ? '使用邀请码加入' : 'Join group'}
          </Button>
        </form>
      </div>}

      <div className="dt-pipeline-list">
        {nodes.map(node => <div key={node.id} className="dt-msg-receipt" data-active={node.status === 'online'}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
            <div className="dt-msg-receipt-main">
              <Tag tone={node.status === 'online' ? 'success' : 'neutral'}>
                {node.status === 'online' ? (lang === 'zh' ? '在线' : 'Online') : (lang === 'zh' ? '离线' : 'Offline')}
              </Tag>
              <strong>{node.name}</strong>
              <span className="dt-mono dt-hint">({node.id})</span>
              {node.tags.map(tag => <span key={tag} className="dt-mono dt-msg-receipt-branch">{tag}</span>)}
            </div>
            <div className="dt-mono dt-hint" style={{ fontSize: 11 }}>
              {node.hostname && <span>{lang === 'zh' ? '机器名: ' : 'Host: '}<strong>{node.hostname}</strong> · </span>}
              {node.tailscaleDnsName && <span>Tailscale: <strong>{node.tailscaleDnsName}</strong>{node.tailscaleIps?.length ? ` (${node.tailscaleIps.join(', ')})` : ''} · </span>}
              <span>{lang === 'zh' ? '多路径候选: ' : 'Routes: '}{(node.endpoints?.length ? node.endpoints : [node.url]).join(' → ')}</span>
            </div>
          </div>
          {node.id !== 'local' && <Button size="sm" variant="outline" disabled={busy} onClick={() => { void removeNode(node.id) }}>
            {lang === 'zh' ? '移除' : 'Remove'}
          </Button>}
        </div>)}
      </div>

      <details className="dt-conversation-settings">
        <summary>{lang === 'zh' ? '手动添加或补充节点多重地址' : 'Manually add or override LAN/Tailscale node'}</summary>
        <form className="dt-form" onSubmit={event => { void addNode(event) }}>
          <div className="dt-grid3">
            <label className="dt-field">
              <span className="dt-field-head">{lang === 'zh' ? '节点 ID (如 worker-node)' : 'Node ID'}</span>
              <Input value={id} onChange={e => setId(e.target.value)} placeholder="worker-node" />
            </label>
            <label className="dt-field">
              <span className="dt-field-head">{lang === 'zh' ? '显示名称' : 'Display name'}</span>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Worker 节点" />
            </label>
            <label className="dt-field">
              <span className="dt-field-head">{lang === 'zh' ? '首选局域网地址 (URL)' : 'Primary LAN URL'}</span>
              <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="http://192.168.1.50:4318" />
            </label>
          </div>
          <div className="dt-grid3">
            <label className="dt-field">
              <span className="dt-field-head">{lang === 'zh' ? '不变机器名 (Hostname)' : 'Invariant Hostname'}</span>
              <Input value={nodeHostname} onChange={e => setNodeHostname(e.target.value)} placeholder="worker-host" />
            </label>
            <label className="dt-field">
              <span className="dt-field-head">{lang === 'zh' ? 'Tailscale 固定名 (机器名.xxx.ts.net)' : 'Tailscale MagicDNS FQDN'}</span>
              <Input value={tailscaleDnsName} onChange={e => setTailscaleDnsName(e.target.value)} placeholder="worker-node.your-tailnet.ts.net" />
            </label>
            <label className="dt-field">
              <span className="dt-field-head">{lang === 'zh' ? 'Tailscale IP' : 'Tailscale IP'}</span>
              <Input value={tailscaleIps} onChange={e => setTailscaleIps(e.target.value)} placeholder="100.64.0.20" />
            </label>
          </div>
          <div className="dt-grid3">
            <label className="dt-field">
              <span className="dt-field-head">{lang === 'zh' ? '能力标签 (供评估模型匹配)' : 'Capability tags'}</span>
              <Input value={tags} onChange={e => setTags(e.target.value)} placeholder="heavy-coding, windows, preferred" />
            </label>
            <label className="dt-field">
              <span className="dt-field-head">{lang === 'zh' ? 'Git 仓库路径 (可选)' : 'Git repo path'}</span>
              <Input value={gitUrl} onChange={e => setGitUrl(e.target.value)} placeholder="D:/git/RHarness" />
            </label>
            <div className="dt-field" style={{ justifyContent: 'flex-end' }}>
              <Button type="submit" variant="primary" disabled={busy || !id.trim() || !url.trim()}>
                {lang === 'zh' ? '保存节点' : 'Save node'}
              </Button>
            </div>
          </div>
        </form>
      </details>
    </div>
  </Modal>
}

function MemoryAndPluginsSection({
  lang,
  memories,
  memoryBackups,
  plugins,
  onMemoriesUpdated,
  onMemoryBackupsUpdated,
  onPluginsUpdated,
}: {
  lang: Lang
  memories: MemoryEntryInfo[]
  memoryBackups: MemoryBackupInfo[]
  plugins: PluginDescriptorInfo[]
  onMemoriesUpdated: (next: MemoryEntryInfo[]) => void
  onMemoryBackupsUpdated: (next: MemoryBackupInfo[]) => void
  onPluginsUpdated: (next: PluginDescriptorInfo[]) => void
}) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [category, setCategory] = useState<MemoryCategoryInfo>('preference')
  const [tags, setTags] = useState('')
  const [pinned, setPinned] = useState(true)
  const [milestoneDate, setMilestoneDate] = useState('')
  const [milestoneRecurrence, setMilestoneRecurrence] = useState<'yearly' | 'once'>('yearly')
  const [milestoneLeadDays, setMilestoneLeadDays] = useState('30, 14, 7, 1, 0')
  const [pluginCat, setPluginCat] = useState<string>('all')
  const [filterCat, setFilterCat] = useState<string>('all')
  const [searchQ, setSearchQ] = useState('')
  const [clearConfirmStep, setClearConfirmStep] = useState<0 | 1 | 2>(0)
  const [consolidateFeedback, setConsolidateFeedback] = useState('')
  const [siyuanInstances, setSiyuanInstances] = useState<{
    instance: 'siyuan' | 'siyuan-rh'
    label: string
    scope?: string
    error?: string
    notebooks: { id: string; name: string; closed?: boolean }[]
    recentDocs: { docId: string; notebookId: string; notebookName: string; title: string; hpath: string; updated?: string }[]
  }[]>([])
  const [siyuanFilterInst, setSiyuanFilterInst] = useState<'all' | 'siyuan' | 'siyuan-rh'>('all')
  const [siyuanQuery, setSiyuanQuery] = useState('')
  const [siyuanSearchResults, setSiyuanSearchResults] = useState<{
    instance: 'siyuan' | 'siyuan-rh'
    instanceLabel: string
    docId: string
    blockId: string
    notebookName: string
    hpath: string
    type: string
    snippet: string
  }[]>()
  const [siyuanLoading, setSiyuanLoading] = useState(false)
  const [activePluginForPanel, setActivePluginForPanel] = useState<PluginDescriptorInfo>()
  const [pluginPanelData, setPluginPanelData] = useState<{
    pluginId: string
    enabled: boolean
    statusMetrics: { label: { zh: string; en: string }; value: string; tone?: 'success' | 'warning' | 'info' | 'neutral' }[]
    statusItems: { id: string; badge: string; badgeTone?: 'success' | 'warning' | 'info' | 'neutral'; title: string; subtitle?: string; time?: string }[]
    actions: { id: string; label: { zh: string; en: string }; variant?: 'primary' | 'outline' }[]
    settingsSchema: {
      key: string
      label: { zh: string; en: string }
      hint?: { zh: string; en: string }
      type: 'boolean' | 'select' | 'text' | 'number'
      options?: { value: string; label: string }[]
      defaultValue: unknown
    }[]
    settingsValues: Record<string, unknown>
  }>()
  const [pluginDraftConfig, setPluginDraftConfig] = useState<Record<string, unknown>>({})
  const [pluginPanelFeedback, setPluginPanelFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const openPluginPanel = async (pl: PluginDescriptorInfo) => {
    setActivePluginForPanel(pl)
    setPluginPanelFeedback('')
    try {
      const data = await standaloneFetch<NonNullable<typeof pluginPanelData>>(
        `plugins/${encodeURIComponent(pl.id)}/panel`,
        'GET',
      )
      setPluginPanelData(data)
      setPluginDraftConfig(data.settingsValues ?? {})
    } catch (err) {
      setPluginPanelFeedback(err instanceof Error ? err.message : String(err))
    }
  }

  const savePluginConfig = async () => {
    if (!activePluginForPanel || busy) return
    setBusy(true); setPluginPanelFeedback('')
    try {
      const res = await standaloneFetch<{ settingsValues: Record<string, unknown> }>(
        `plugins/${encodeURIComponent(activePluginForPanel.id)}/config`,
        'POST',
        { values: pluginDraftConfig },
      )
      setPluginDraftConfig(res.settingsValues)
      setPluginPanelFeedback(lang === 'zh' ? '✓ 插件设置已保存并实时生效' : '✓ Plugin settings saved')
      await openPluginPanel(activePluginForPanel)
    } catch (err) {
      setPluginPanelFeedback(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const runPluginAction = async (actionId: string) => {
    if (!activePluginForPanel || busy) return
    setBusy(true); setPluginPanelFeedback('')
    try {
      const res = await standaloneFetch<{ message?: string }>(
        `plugins/${encodeURIComponent(activePluginForPanel.id)}/action`,
        'POST',
        { actionId },
      )
      const refreshed = await standaloneFetch<NonNullable<typeof pluginPanelData>>(
        `plugins/${encodeURIComponent(activePluginForPanel.id)}/panel`,
        'GET',
      )
      setPluginPanelData(refreshed)
      if (res.message) setPluginPanelFeedback(`✓ ${res.message}`)
    } catch (err) {
      setPluginPanelFeedback(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const loadSiyuanNotebooks = useCallback(() => {
    setSiyuanLoading(true)
    standaloneFetch<{ instances: typeof siyuanInstances }>('siyuan/notebooks', 'GET')
      .then(res => {
        if (res.instances) setSiyuanInstances(res.instances)
      })
      .catch(() => {})
      .finally(() => setSiyuanLoading(false))
  }, [])

  useEffect(() => {
    loadSiyuanNotebooks()
  }, [loadSiyuanNotebooks])

  const runSiyuanSearch = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!siyuanQuery.trim()) {
      setSiyuanSearchResults(undefined)
      return
    }
    setSiyuanLoading(true); setError('')
    try {
      const res = await standaloneFetch<{ items: NonNullable<typeof siyuanSearchResults> }>(
        `siyuan/search?q=${encodeURIComponent(siyuanQuery.trim())}&instance=${encodeURIComponent(siyuanFilterInst)}`,
        'GET',
      )
      setSiyuanSearchResults(res.items ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSiyuanLoading(false)
    }
  }

  const runConsolidate = async () => {
    if (busy) return
    setBusy(true); setError(''); setConsolidateFeedback('')
    try {
      const res = await standaloneFetch<{
        extractedCount: number
        mergedCount: number
        purgedNoiseCount: number
        memories: MemoryEntryInfo[]
        memoryBackups: MemoryBackupInfo[]
      }>('memories/consolidate', 'POST', {})
      onMemoriesUpdated(res.memories)
      onMemoryBackupsUpdated(res.memoryBackups)
      setConsolidateFeedback(
        lang === 'zh'
          ? `✨ 提炼与去重完成：从对话新提取 ${res.extractedCount} 条高价值记忆，合并重复 ${res.mergedCount} 条，清理无效状态噪音 ${res.purgedNoiseCount} 条`
          : `✨ Consolidated: extracted ${res.extractedCount}, merged ${res.mergedCount}, purged ${res.purgedNoiseCount} noise entries`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const saveMem = async (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim() || !content.trim() || busy) return
    setBusy(true); setError('')
    try {
      const parsedLeads = milestoneLeadDays
        .split(/[\s,，]+/)
        .map(s => Number(s.trim()))
        .filter(n => Number.isFinite(n) && n >= 0 && n <= 365)
      const milestonePayload =
        category === 'milestone' || milestoneDate.trim()
          ? {
              targetDate: milestoneDate.trim() || '12-01',
              recurrence: milestoneRecurrence,
              leadDays: parsedLeads.length ? parsedLeads : [30, 14, 7, 1, 0],
            }
          : undefined
      const res = await standaloneFetch<{ memories: MemoryEntryInfo[]; memoryBackups?: MemoryBackupInfo[] }>('memories', 'POST', {
        title: title.trim(),
        content: content.trim(),
        category,
        tags,
        pinned,
        ...(milestonePayload ? { milestone: milestonePayload } : {}),
      })
      onMemoriesUpdated(res.memories)
      if (res.memoryBackups) onMemoryBackupsUpdated(res.memoryBackups)
      setTitle(''); setContent(''); setTags(''); setMilestoneDate('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const togglePin = async (entry: MemoryEntryInfo) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const res = await standaloneFetch<{ memories: MemoryEntryInfo[] }>('memories', 'POST', {
        id: entry.id,
        title: entry.title,
        content: entry.content,
        category: entry.category,
        tags: entry.tags,
        pinned: !entry.pinned,
      })
      onMemoriesUpdated(res.memories)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const removeMem = async (id: string) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const res = await standaloneFetch<{ memories: MemoryEntryInfo[]; memoryBackups?: MemoryBackupInfo[] }>(`memories/${encodeURIComponent(id)}`, 'DELETE')
      onMemoriesUpdated(res.memories)
      if (res.memoryBackups) onMemoryBackupsUpdated(res.memoryBackups)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const clearAllMemoriesConfirmed = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const res = await standaloneFetch<{ memories: MemoryEntryInfo[]; memoryBackups: MemoryBackupInfo[] }>('memories/clear', 'POST', {
        confirmStep: 2,
        confirmed: true,
      })
      onMemoriesUpdated(res.memories)
      onMemoryBackupsUpdated(res.memoryBackups)
      setClearConfirmStep(0)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const restoreBackup = async (backupId: string) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const res = await standaloneFetch<{ memories: MemoryEntryInfo[]; memoryBackups: MemoryBackupInfo[] }>(
        `memories/backups/${encodeURIComponent(backupId)}/restore`,
        'POST',
        {},
      )
      onMemoriesUpdated(res.memories)
      onMemoryBackupsUpdated(res.memoryBackups)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const togglePlugin = async (pluginId: string, enabled: boolean) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const res = await standaloneFetch<{ plugins: PluginDescriptorInfo[] }>(`plugins/${encodeURIComponent(pluginId)}/toggle`, 'POST', { enabled })
      onPluginsUpdated(res.plugins)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const filtered = memories.filter(m => {
    if (filterCat !== 'all' && m.category !== filterCat) return false
    if (!searchQ.trim()) return true
    const hay = `${m.title} ${m.content} ${m.tags.join(' ')}`.toLowerCase()
    return hay.includes(searchQ.trim().toLowerCase())
  })

  const filteredPlugins = plugins.filter(pl => {
    if (pluginCat === 'all') return true
    if (pluginCat === 'agent') return pl.category === 'assistant' || pl.category === 'memory'
    if (pluginCat === 'ui-slot') return pl.category === 'ui-slot' || Boolean(pl.uiSlot)
    if (pluginCat === 'distributed') return pl.category === 'distributed' || pl.category === 'scheduler'
    if (pluginCat === 'core-source') return pl.category === 'core' || pl.category === 'source'
    return true
  })

  return <div className="dt-form">
    {error && <p className="dt-error" role="status">{error}</p>}
    <section className="dt-pipeline-card" aria-label={lang === 'zh' ? '一等公民插件中心' : 'First-class Plugin Center'}>
      <div className="dt-live-head">
        <div>
          <h2>
            {lang === 'zh'
              ? `一等公民插件中心 (Cordis / DSH Plugin Host · 共 ${plugins.length} 个插件)`
              : `First-Class Plugin Center (${plugins.length} plugins)`}
          </h2>
          <span className="dt-hint">
            {lang === 'zh'
              ? '全系统插件化架构：涵盖个人助理、长期记忆、前端 UI 视图插槽 (ctx.slots)、分布式设备组、分时模型调度、Worktree 自动合入及外部消息源'
              : 'All backend agent loops, frontend UI slots (ctx.slots), distributed device group, scheduler, and sources registered as modular plugins'}
          </span>
        </div>
        <div className="dt-row-buttons">
          {([
            ['all', lang === 'zh' ? `全部 (${plugins.length})` : `All (${plugins.length})`],
            ['ui-slot', lang === 'zh' ? 'UI 视图与顶栏插槽' : 'UI Slots'],
            ['agent', lang === 'zh' ? '助理与记忆' : 'Assistant & Memory'],
            ['distributed', lang === 'zh' ? '分布式与调度' : 'Distributed & Scheduler'],
            ['core-source', lang === 'zh' ? '核心引擎与消息源' : 'Core & Sources'],
          ] as const).map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant={pluginCat === key ? 'primary' : 'outline'}
              onClick={() => setPluginCat(key)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      <div className="dt-pipeline-list">
        {filteredPlugins.map(pl => <div key={pl.id} className="dt-msg-receipt" data-active={pl.enabled}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
            <div className="dt-msg-receipt-main">
              <Tag tone={pl.enabled ? 'success' : 'neutral'}>
                {pl.enabled ? (lang === 'zh' ? '已启用' : 'Enabled') : (lang === 'zh' ? '已停用' : 'Disabled')}
              </Tag>
              <strong>{lang === 'zh' ? pl.title.zh : pl.title.en}</strong>
              <span className="dt-mono dt-hint">{pl.packageName}</span>
              {pl.roles.map(r => <span key={r} className="dt-mono dt-msg-receipt-branch">
                {r === 'assistant'
                  ? (lang === 'zh' ? 'Claw 助理' : 'Assistant')
                  : r === 'orchestrator'
                    ? 'Eval'
                    : r === 'ui-slot'
                      ? (lang === 'zh' ? 'UI 插槽' : 'UI Slot')
                      : 'Worker'}
              </span>)}
              {pl.uiSlot && <span className="dt-mono dt-msg-receipt-branch">Slot: {pl.uiSlot}</span>}
              {pl.stats && <Tag tone="info">{lang === 'zh' ? pl.stats.zh : pl.stats.en}</Tag>}
            </div>
            <span className="dt-hint">{lang === 'zh' ? pl.description.zh : pl.description.en}</span>
            {pl.tools.length > 0 && <div className="dt-mono dt-hint">
              {lang === 'zh' ? '挂载工具：' : 'Tools: '}{pl.tools.join(', ')}
              {pl.promptSection ? ` · Prompt: [${pl.promptSection}]` : ''}
            </div>}
          </div>
          <div className="dt-row-buttons">
            <Button
              size="sm"
              variant="outline"
              onClick={() => { void openPluginPanel(pl) }}
              data-testid={`plugin-panel-btn-${pl.id}`}
            >
              {lang === 'zh' ? '🎛 状态与设置' : '🎛 Status & Settings'}
            </Button>
            {pl.canToggle ? <Switch
              checked={pl.enabled}
              disabled={busy}
              onChange={next => { void togglePlugin(pl.id, next) }}
              label={lang === 'zh' ? (pl.enabled ? '启用中' : '已停用') : (pl.enabled ? 'On' : 'Off')}
            /> : <Tag tone="info">{lang === 'zh' ? '核心常驻' : 'Core'}</Tag>}
          </div>
        </div>)}
      </div>
    </section>

    <Modal
      className="dt-fullscreen-modal"
      open={Boolean(activePluginForPanel)}
      onClose={() => { setActivePluginForPanel(undefined); setPluginPanelData(undefined) }}
      title={
        activePluginForPanel
          ? `🎛 ${lang === 'zh' ? activePluginForPanel.title.zh : activePluginForPanel.title.en}`
          : ''
      }
      closeLabel={lang === 'zh' ? '关闭 (ESC)' : 'Close (ESC)'}
      description={
        activePluginForPanel
          ? `${activePluginForPanel.packageName} · ${lang === 'zh' ? '插件自有「实时状态 + 独立设置」一体化面板' : 'Plugin Self-Owned Status & Settings Workbench'}`
          : undefined
      }
      footer={
        <div className="dt-live-head" style={{ width: '100%' }}>
          <span className="dt-hint">
            {pluginPanelFeedback || (lang === 'zh' ? '点击左右暗色背景或按 ESC 即可关闭面板' : 'Click dark backdrop or press ESC to close')}
          </span>
          <div className="dt-row-buttons">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !activePluginForPanel}
              onClick={() => { if (activePluginForPanel) void openPluginPanel(activePluginForPanel) }}
            >
              {lang === 'zh' ? '↻ 刷新状态' : '↻ Refresh Status'}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => { void savePluginConfig() }}
            >
              {lang === 'zh' ? '💾 保存插件设置' : '💾 Save Plugin Settings'}
            </Button>
          </div>
        </div>
      }
    >
      {pluginPanelData && (
        <div className="dt-form">
          <div className="dt-form dt-block">
            <div className="dt-live-head">
              <h3 className="dt-block-title">
                {lang === 'zh' ? '📊 实时状态与快捷动作 (Plugin Live Status & Actions)' : '📊 Live Status & Quick Actions'}
              </h3>
              <div className="dt-row-buttons">
                {pluginPanelData.actions.map(act => (
                  <Button
                    key={act.id}
                    size="sm"
                    variant={act.variant ?? 'outline'}
                    disabled={busy}
                    onClick={() => { void runPluginAction(act.id) }}
                  >
                    {lang === 'zh' ? act.label.zh : act.label.en}
                  </Button>
                ))}
              </div>
            </div>
            <div className="dt-grid3">
              {pluginPanelData.statusMetrics.map((m, idx) => (
                <div key={idx} className="dt-msg-receipt" data-active="true">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span className="dt-hint">{lang === 'zh' ? m.label.zh : m.label.en}</span>
                    <strong>{m.value}</strong>
                  </div>
                </div>
              ))}
            </div>
            {pluginPanelData.statusItems.length > 0 && (
              <div className="dt-pipeline-list" style={{ marginTop: 8 }}>
                {pluginPanelData.statusItems.map(item => (
                  <div key={item.id} className="dt-msg-receipt" data-active="true">
                    <div className="dt-msg-receipt-main">
                      <Tag tone={item.badgeTone ?? 'info'}>{item.badge}</Tag>
                      <strong>{item.title}</strong>
                      {item.subtitle && <span className="dt-mono dt-hint">{item.subtitle}</span>}
                      {item.time && <span className="dt-mono dt-hint">{formatSmartTimestamp(item.time, lang)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="dt-form dt-block">
            <h3 className="dt-block-title">
              {lang === 'zh' ? '⚙️ 插件独立设置 (Plugin Self-Owned Settings)' : '⚙️ Plugin Self-Owned Settings'}
            </h3>
            <div className="dt-form">
              {pluginPanelData.settingsSchema.map(field => {
                const val = pluginDraftConfig[field.key] ?? field.defaultValue
                if (field.type === 'boolean') {
                  return (
                    <div key={field.key} className="dt-live-head">
                      <div>
                        <strong>{lang === 'zh' ? field.label.zh : field.label.en}</strong>
                        {field.hint && <div className="dt-hint">{lang === 'zh' ? field.hint.zh : field.hint.en}</div>}
                      </div>
                      <Switch
                        checked={Boolean(val)}
                        onChange={next => setPluginDraftConfig(prev => ({ ...prev, [field.key]: next }))}
                        label={Boolean(val) ? (lang === 'zh' ? '已开启' : 'On') : (lang === 'zh' ? '已关闭' : 'Off')}
                      />
                    </div>
                  )
                }
                if (field.type === 'select') {
                  return (
                    <label key={field.key} className="dt-field">
                      <span className="dt-field-head">{lang === 'zh' ? field.label.zh : field.label.en}</span>
                      {field.hint && <span className="dt-hint">{lang === 'zh' ? field.hint.zh : field.hint.en}</span>}
                      <select
                        className="dt-select"
                        value={String(val ?? '')}
                        onChange={e => setPluginDraftConfig(prev => ({ ...prev, [field.key]: e.target.value }))}
                      >
                        {(field.options ?? []).map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </label>
                  )
                }
                return (
                  <label key={field.key} className="dt-field">
                    <span className="dt-field-head">{lang === 'zh' ? field.label.zh : field.label.en}</span>
                    {field.hint && <span className="dt-hint">{lang === 'zh' ? field.hint.zh : field.hint.en}</span>}
                    <Input
                      type={field.type === 'number' ? 'number' : 'text'}
                      value={String(val ?? '')}
                      onChange={e =>
                        setPluginDraftConfig(prev => ({
                          ...prev,
                          [field.key]: field.type === 'number' ? Number(e.target.value) : e.target.value,
                        }))
                      }
                    />
                  </label>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </Modal>

    <section className="dt-pipeline-card" aria-label={lang === 'zh' ? '长期记忆库' : 'Long-term memory store'}>
      <div className="dt-live-head">
        <div>
          <h2>{lang === 'zh' ? '长期记忆库 (@rharness/plugin-memory)' : 'Long-Term Memory Store'}</h2>
          <span className="dt-hint">{lang === 'zh' ? '开启「常驻注入 (Pinned)」的记忆会自动注入每轮 System Prompt；未常驻记忆会在每轮对话根据语义与关键词自动召回 (Auto-Recall Top-4)；删除或清空的记忆移入 30 天保护备份箱' : 'Pinned memories are injected into every turn; non-pinned memories are auto-recalled per turn via hybrid match; deleted memories are backed up for 30 days'}</span>
        </div>
        <div className="dt-row-buttons">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => { void runConsolidate() }}
          >
            {lang === 'zh' ? '✨ 提炼与去重整理' : '✨ Consolidate & Dedupe'}
          </Button>
          {memories.length > 0 && clearConfirmStep === 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setClearConfirmStep(1)}
              data-testid="memory-clear-step0-btn"
            >
              {lang === 'zh' ? `清空全部记忆 (${memories.length})` : `Clear All Memories (${memories.length})`}
            </Button>
          )}
          {memories.length > 0 && clearConfirmStep === 1 && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setClearConfirmStep(2)}
                data-testid="memory-clear-step1-btn"
              >
                {lang === 'zh'
                  ? `⚠️ 第 1/2 次确认：确定将 ${memories.length} 条记忆移入 30 天备份目录？`
                  : `Step 1/2: Move ${memories.length} memories to 30-day backup?`}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setClearConfirmStep(0)}>
                {lang === 'zh' ? '取消' : 'Cancel'}
              </Button>
            </>
          )}
          {memories.length > 0 && clearConfirmStep === 2 && (
            <>
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => { void clearAllMemoriesConfirmed() }}
                data-testid="memory-clear-step2-btn"
              >
                {lang === 'zh'
                  ? '🔒 第 2/2 次最终确认：立即清空并锁定备份 30 天（可随时恢复）'
                  : 'Step 2/2 Final Confirm: Clear & Lock Backup for 30 Days'}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setClearConfirmStep(0)}>
                {lang === 'zh' ? '取消' : 'Cancel'}
              </Button>
            </>
          )}
        </div>
      </div>
      {consolidateFeedback && <p className="dt-hint" role="status" style={{ color: 'var(--dsw-alias-state-success-primary)' }}>{consolidateFeedback}</p>}

      <form className="dt-form dt-block" onSubmit={event => { void saveMem(event) }}>
        <div className="dt-live-head">
          <h3 className="dt-block-title">{lang === 'zh' ? '新增 / 更新记忆条目' : 'Add or update memory'}</h3>
          <Switch
            checked={pinned}
            onChange={setPinned}
            label={lang === 'zh' ? '📌 常驻注入每轮 System Prompt' : '📌 Pin to System Prompt'}
          />
        </div>
        <div className="dt-grid3">
          <label className="dt-field">
            <span className="dt-field-head">{lang === 'zh' ? '记忆标题' : 'Title'}</span>
            <Input value={title} onChange={e => setTitle(e.target.value)} placeholder={lang === 'zh' ? '例如：我的代码风格与常用服务器偏好' : 'e.g. Coding preferences'} />
          </label>
          <label className="dt-field">
            <span className="dt-field-head">{lang === 'zh' ? '分类' : 'Category'}</span>
            <select
              className="dt-select"
              value={category}
              onChange={e => {
                const nextCat = e.target.value as MemoryCategoryInfo
                setCategory(nextCat)
                if (nextCat === 'milestone') setPinned(false)
              }}
            >
              <option value="milestone">{lang === 'zh' ? '🎂 重大事件 / 生日纪念日 (milestone · 阶梯提醒)' : '🎂 Milestone / Anniversary'}</option>
              <option value="preference">{lang === 'zh' ? '常驻偏好 (preference)' : 'Preference'}</option>
              <option value="device">{lang === 'zh' ? '设备与网络拓扑 (device)' : 'Device & Topology'}</option>
              <option value="project">{lang === 'zh' ? '项目规范 (project)' : 'Project convention'}</option>
              <option value="fact">{lang === 'zh' ? '日常事实 / 随手记 (fact)' : 'Fact / Note'}</option>
              <option value="episodic">{lang === 'zh' ? '跨工单经验 (episodic)' : 'Episodic lesson'}</option>
            </select>
          </label>
          <label className="dt-field">
            <span className="dt-field-head">{lang === 'zh' ? '检索标签 (逗号分隔)' : 'Tags'}</span>
            <Input value={tags} onChange={e => setTags(e.target.value)} placeholder="生日, 纪念日, 续费" />
          </label>
        </div>
        {category === 'milestone' && (
          <div className="dt-grid3">
            <label className="dt-field">
              <span className="dt-field-head">{lang === 'zh' ? '目标日期 (MM-DD 或 YYYY-MM-DD)' : 'Target Date'}</span>
              <Input
                value={milestoneDate}
                onChange={e => setMilestoneDate(e.target.value)}
                placeholder={lang === 'zh' ? '例如：05-20 (每年循环) 或 2027-03-15' : 'e.g. 05-20 or 2027-03-15'}
              />
            </label>
            <label className="dt-field">
              <span className="dt-field-head">{lang === 'zh' ? '重复周期' : 'Recurrence'}</span>
              <select
                className="dt-select"
                value={milestoneRecurrence}
                onChange={e => setMilestoneRecurrence(e.target.value as 'yearly' | 'once')}
              >
                <option value="yearly">{lang === 'zh' ? '🔄 每年循环 (生日 / 纪念日 / 年度续期)' : 'Yearly'}</option>
                <option value="once">{lang === 'zh' ? '1️⃣ 单次重大节点 (指定年份)' : 'One-time'}</option>
              </select>
            </label>
            <label className="dt-field">
              <span className="dt-field-head">{lang === 'zh' ? '阶梯提醒天数 (提前1月/2周/1周/1天/当天)' : 'Lead Days'}</span>
              <Input
                value={milestoneLeadDays}
                onChange={e => setMilestoneLeadDays(e.target.value)}
                placeholder="30, 14, 7, 1, 0"
              />
            </label>
          </div>
        )}
        <label className="dt-field">
          <span className="dt-field-head">{lang === 'zh' ? '记忆详细内容' : 'Memory content'}</span>
          <textarea
            className="dt-textarea"
            rows={3}
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder={lang === 'zh' ? '输入希望智能体长期记住的事实、机器信息、个人习惯或备忘事项…' : 'Write durable facts, preferences, or notes…'}
          />
        </label>
        <div className="dt-row-buttons">
          <Button type="submit" variant="primary" size="sm" disabled={busy || !title.trim() || !content.trim()}>
            {lang === 'zh' ? '保存记忆' : 'Save memory'}
          </Button>
        </div>
      </form>

      <div className="dt-topic-switch">
        <Input
          value={searchQ}
          onChange={e => setSearchQ(e.target.value)}
          placeholder={lang === 'zh' ? '搜索记忆标题、内容或标签…' : 'Search memories…'}
        />
        <select className="dt-select" style={{ maxWidth: 200 }} value={filterCat} onChange={e => setFilterCat(e.target.value)}>
          <option value="all">{lang === 'zh' ? '全部分类' : 'All categories'}</option>
          <option value="milestone">{lang === 'zh' ? '🎂 生日与纪念日 (milestone)' : 'Milestones'}</option>
          <option value="preference">{lang === 'zh' ? '常驻偏好' : 'Preferences'}</option>
          <option value="device">{lang === 'zh' ? '设备拓扑' : 'Devices'}</option>
          <option value="project">{lang === 'zh' ? '项目规范' : 'Projects'}</option>
          <option value="fact">{lang === 'zh' ? '日常随手记' : 'Facts'}</option>
          <option value="episodic">{lang === 'zh' ? '历史经验' : 'Episodic'}</option>
        </select>
      </div>

      <div className="dt-pipeline-list">
        {!filtered.length && <p className="dt-hint">{lang === 'zh' ? '暂无匹配的记忆条目。' : 'No matching memories.'}</p>}
        {filtered.map(mem => <div key={mem.id} className="dt-msg-receipt" data-active={mem.pinned || Boolean(mem.milestone)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
            <div className="dt-msg-receipt-main">
              {mem.pinned && <Tag tone="success">{lang === 'zh' ? '📌 常驻注入 Prompt' : '📌 Pinned'}</Tag>}
              <Tag tone={mem.category === 'milestone' ? 'warning' : 'info'}>
                {mem.category === 'milestone' ? '🎂 重大事件/纪念日' : mem.category}
              </Tag>
              {mem.milestone && (
                <Tag tone="info">
                  {`📅 ${mem.milestone.recurrence === 'yearly' ? '每年' : ''} ${mem.milestone.targetDate} · 提前 ${(mem.milestone.leadDays ?? [30, 14, 7, 1, 0]).join('/')} 天提醒`}
                </Tag>
              )}
              <strong>{mem.title}</strong>
              {mem.tags.map(t => <span key={t} className="dt-mono dt-msg-receipt-branch">#{t}</span>)}
              <span className="dt-mono dt-hint">by {mem.source} · {formatSmartTimestamp(mem.updatedAt, lang)}</span>
            </div>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{mem.content}</div>
          </div>
          <div className="dt-row-buttons">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => { void togglePin(mem) }}>
              {mem.pinned ? (lang === 'zh' ? '取消常驻' : 'Unpin') : (lang === 'zh' ? '设为常驻' : 'Pin')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void removeMem(mem.id) }}>
              {lang === 'zh' ? '移入30天备份' : 'Delete (30d Backup)'}
            </Button>
          </div>
        </div>)}
      </div>

      {/* 30-Day Regret & Recovery Vault (`memory-backups/`) */}
      <div className="dt-form dt-block" data-testid="memory-backup-vault">
        <div className="dt-live-head">
          <div>
            <h3 className="dt-block-title">
              {lang === 'zh'
                ? `🛡 记忆备份与 30 天反悔恢复箱 (memory-backups/ · 共 ${memoryBackups.length} 份备份)`
                : `🛡 30-Day Memory Backup & Recovery Vault (${memoryBackups.length})`}
            </h3>
            <span className="dt-hint">
              {lang === 'zh'
                ? '被清空或单条删除的记忆均保存在磁盘 memory-backups/ 目录下：30 天内受保护不可手动彻底删除、随时可一键反悔恢复；满 30 天后系统自动清理。'
                : 'Cleared or deleted memories are locked in memory-backups/ for 30 days: cannot be manually deleted within 30 days, can be restored anytime, and auto-purge after 30 days.'}
            </span>
          </div>
        </div>
        {memoryBackups.length === 0 ? (
          <p className="dt-hint">{lang === 'zh' ? '当前暂无已删除的记忆备份。' : 'No memory backups currently.'}</p>
        ) : (
          <div className="dt-pipeline-list">
            {memoryBackups.map(bak => {
              const remainingDays = Math.max(
                1,
                Math.ceil((Date.parse(bak.expiresAt) - Date.now()) / (24 * 60 * 60 * 1000)),
              )
              return (
                <div key={bak.id} className="dt-msg-receipt" data-active="true" data-testid={`memory-backup-${bak.id}`}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
                    <div className="dt-msg-receipt-main">
                      <Tag tone="warning">
                        {lang === 'zh' ? `🔒 30天保护期 · 剩余 ${remainingDays} 天自动清理` : `🔒 Protected · ${remainingDays}d left`}
                      </Tag>
                      <Tag tone="info">
                        {bak.reason === 'clear-all'
                          ? (lang === 'zh' ? `清空全部记忆备份 (${bak.count} 条)` : `Full Clear Backup (${bak.count})`)
                          : (lang === 'zh' ? `单条删除备份 (${bak.count} 条)` : `Single Delete Backup (${bak.count})`)}
                      </Tag>
                      <span className="dt-mono dt-hint">
                        {formatSmartTimestamp(bak.deletedAt, lang)} · {bak.id}
                      </span>
                    </div>
                    <div style={{ fontSize: 13 }}>
                      {bak.entries.map(e => `【${e.title}】${e.content.slice(0, 80)}${e.content.length > 80 ? '…' : ''}`).join(' ｜ ')}
                    </div>
                  </div>
                  <div className="dt-row-buttons">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy}
                      onClick={() => { void restoreBackup(bak.id) }}
                      data-testid={`restore-backup-${bak.id}`}
                    >
                      {lang === 'zh' ? '↩ 一键恢复 (反悔恢复)' : '↩ Restore Backup'}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>

    {plugins.some(p => p.id === 'dsh-personal-skills' && p.enabled) && <section className="dt-pipeline-card" aria-label={lang === 'zh' ? '思源双实例知识库' : 'SiYuan Dual-Instance Knowledge Base'}>
      <div className="dt-live-head">
        <div>
          <h2>
            {lang === 'zh'
              ? '📚 思源双实例知识库 (SiYuan Knowledge Base · 🏠 共享库 siyuan + 🔒 私有库 siyuan_rh)'
              : '📚 SiYuan Dual-Instance Knowledge Base (siyuan + siyuan_rh)'}
          </h2>
          <span className="dt-hint">
            {lang === 'zh'
              ? '只读连接外部思源笔记实例作为唯一真实知识源（自动拦截私密笔记本并执行敏感字段脱敏），点击任意文档即可在网页 Markdown 阅读器中打开'
              : 'Read-only bridge to configured SiYuan instances with gateway-level privacy guardrails; click any note to open in the Markdown reader'}
          </span>
        </div>
        <div className="dt-row-buttons">
          <Button size="sm" variant="outline" disabled={siyuanLoading} onClick={loadSiyuanNotebooks}>
            {lang === 'zh' ? '↻ 刷新思源目录' : '↻ Refresh SiYuan'}
          </Button>
        </div>
      </div>

      <div className="dt-grid3">
        {siyuanInstances.map(inst => (
          <div key={inst.instance} className="dt-msg-receipt" data-active="true">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
              <div className="dt-msg-receipt-main">
                <Tag tone={inst.instance === 'siyuan' ? 'info' : 'success'}>
                  {inst.instance === 'siyuan' ? '🏠 家庭共用 (siyuan)' : '🔒 个人私有 (siyuan_rh)'}
                </Tag>
                <strong>{inst.notebooks.length} {lang === 'zh' ? '个笔记本' : 'notebooks'}</strong>
              </div>
              <div className="dt-row-buttons">
                {inst.notebooks.map(nb => (
                  <span key={nb.id} className="dt-mono dt-msg-receipt-branch">📁 {nb.name}</span>
                ))}
              </div>
              {inst.error && <span className="dt-error">{inst.error}</span>}
            </div>
          </div>
        ))}
      </div>

      <form className="dt-topic-switch" onSubmit={e => { void runSiyuanSearch(e) }}>
        <Input
          value={siyuanQuery}
          onChange={e => {
            setSiyuanQuery(e.target.value)
            if (!e.target.value.trim()) setSiyuanSearchResults(undefined)
          }}
          placeholder={lang === 'zh' ? '全文检索思源笔记标题或正文关键词…' : 'Search across SiYuan notes…'}
        />
        <select
          className="dt-select"
          style={{ maxWidth: 240 }}
          value={siyuanFilterInst}
          onChange={e => setSiyuanFilterInst(e.target.value as typeof siyuanFilterInst)}
        >
          <option value="all">{lang === 'zh' ? '全部实例 (siyuan + siyuan_rh)' : 'Both instances'}</option>
          <option value="siyuan">{lang === 'zh' ? '🏠 共享库 (siyuan)' : 'Shared (siyuan)'}</option>
          <option value="siyuan-rh">{lang === 'zh' ? '🔒 私有库 (siyuan_rh)' : 'Private (siyuan_rh)'}</option>
        </select>
        <Button type="submit" size="sm" variant="primary" disabled={siyuanLoading}>
          {lang === 'zh' ? '🔍 检索思源' : '🔍 Search'}
        </Button>
        {siyuanSearchResults !== undefined && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => { setSiyuanQuery(''); setSiyuanSearchResults(undefined) }}
          >
            {lang === 'zh' ? '返回最近文档' : 'Clear'}
          </Button>
        )}
      </form>

      {siyuanLoading && <p className="dt-hint">{lang === 'zh' ? '正在通过安全通道查询思源笔记…' : 'Querying SiYuan…'}</p>}

      <div className="dt-pipeline-list">
        {siyuanSearchResults !== undefined ? (
          <>
            {siyuanSearchResults.map(item => (
              <div key={`${item.instance}-${item.blockId}`} className="dt-msg-receipt" data-active="true">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
                  <div className="dt-msg-receipt-main">
                    <Tag tone={item.instance === 'siyuan' ? 'info' : 'success'}>{item.instanceLabel}</Tag>
                    <span className="dt-mono dt-msg-receipt-branch">📁 {item.notebookName}</span>
                    <strong>{item.hpath}</strong>
                  </div>
                  {item.snippet && <div className="dt-hint" style={{ fontSize: 12.5 }}>{item.snippet}</div>}
                </div>
                <div className="dt-row-buttons">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openMarkdownViewer(`siyuan/${item.instance}/${item.docId}.md`)}
                  >
                    {lang === 'zh' ? '📄 在阅读器打开全文' : '📄 Open Document'}
                  </Button>
                </div>
              </div>
            ))}
            {siyuanSearchResults.length === 0 && (
              <p className="dt-hint">{lang === 'zh' ? '未在思源笔记中找到匹配内容。' : 'No matching notes found in SiYuan.'}</p>
            )}
          </>
        ) : (
          siyuanInstances
            .filter(inst => siyuanFilterInst === 'all' || inst.instance === siyuanFilterInst)
            .flatMap(inst =>
              inst.recentDocs.map(doc => ({
                ...doc,
                instance: inst.instance,
                instanceLabel: inst.instance === 'siyuan' ? '🏠 家庭共用 (siyuan)' : '🔒 个人私有 (siyuan_rh)',
              })),
            )
            .map(doc => (
              <div key={`${doc.instance}-${doc.docId}`} className="dt-msg-receipt" data-active="true">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
                  <div className="dt-msg-receipt-main">
                    <Tag tone={doc.instance === 'siyuan' ? 'info' : 'success'}>{doc.instanceLabel}</Tag>
                    <span className="dt-mono dt-msg-receipt-branch">📁 {doc.notebookName}</span>
                    <strong>{doc.title}</strong>
                    <span className="dt-mono dt-hint">{doc.hpath}</span>
                  </div>
                </div>
                <div className="dt-row-buttons">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openMarkdownViewer(`siyuan/${doc.instance}/${doc.docId}.md`)}
                  >
                    {lang === 'zh' ? '📄 在阅读器打开全文' : '📄 Open Document'}
                  </Button>
                </div>
              </div>
            ))
        )}
      </div>
    </section>}
  </div>
}

function PipelineAuditSection({
  rows,
  lang,
  onInspectSession,
}: {
  rows: PipelineRow[]
  lang: Lang
  onInspectSession: (sessionId: string) => void
}) {
  if (!rows.length) {
    return <p className="dt-hint">{lang === 'zh' ? '暂无触发记录。在上方发送一条消息即可看到 4 阶段全链路流转。' : 'No triggers yet. Send a message above to see its 4-stage pipeline journey.'}</p>
  }
  return <div className="dt-pipeline-list" role="region" aria-label={lang === 'zh' ? '4 阶段全链路管线追踪' : '4-stage pipeline audit'}>
    {rows.map(row => {
      const intakeTone = row.intake.kind === 'created'
        ? 'success'
        : row.intake.kind === 'followup' || row.intake.kind === 'evaluating'
          ? 'info'
          : row.intake.kind === 'filtered'
            ? 'warning'
            : 'neutral'
      const delivTone = row.delivery.state === 'merged'
        ? 'success'
        : row.delivery.state === 'running'
          ? 'info'
          : 'neutral'
      const delivLabel = row.delivery.state === 'merged'
        ? (lang === 'zh' ? '已完成并合入 main' : 'Merged into main')
        : row.delivery.state === 'running'
          ? (lang === 'zh' ? '正在执行' : 'Running')
          : row.delivery.state === 'completed'
            ? (lang === 'zh' ? '已结束' : 'Ended')
            : (lang === 'zh' ? '无交付动作' : 'No delivery')
      return <div key={row.triggerId} className="dt-pipeline-row">
        <div className="dt-pipeline-cell">
          <span className="dt-pipeline-stage">{lang === 'zh' ? '1. 来源与触发 (Trigger)' : '1. Source & Trigger'}</span>
          <strong className="dt-pipeline-text">{row.text || (lang === 'zh' ? '（图片消息）' : '(Image message)')}</strong>
          <span className="dt-mono dt-hint">{row.threadKey} · {formatSmartTimestamp(row.at, lang)}</span>
        </div>
        <div className="dt-pipeline-cell">
          <span className="dt-pipeline-stage">{lang === 'zh' ? '2. 路由与评估 (Intake / Eval)' : '2. Intake & Eval'}</span>
          <div><Tag tone={intakeTone}>{lang === 'zh' ? row.intake.label.zh : row.intake.label.en}</Tag></div>
          <span className="dt-hint">{lang === 'zh' ? row.intake.detail.zh : row.intake.detail.en}</span>
        </div>
        <div className="dt-pipeline-cell">
          <span className="dt-pipeline-stage">{lang === 'zh' ? '3. 归属工单 (Ticket)' : '3. Ticket'}</span>
          {row.ticket ? <>
            <strong className="dt-pipeline-text">#{row.ticket.id.slice(0, 6)} · {row.ticket.title}</strong>
            <span className="dt-mono dt-hint">
              {row.ticket.nodeName ? `🖥 ${row.ticket.nodeName} · ` : ''}{row.ticket.branch ?? row.ticket.sessionId}
            </span>
          </> : <span className="dt-hint">{lang === 'zh' ? '未关联工单' : 'No ticket'}</span>}
        </div>
        <div className="dt-pipeline-cell">
          <span className="dt-pipeline-stage">{lang === 'zh' ? '4. 交付结果 (Outbox / Git)' : '4. Delivery & Git'}</span>
          <div className="dt-pipeline-deliv-head">
            <Tag tone={delivTone}>{delivLabel}</Tag>
            {row.ticket && <button
              type="button"
              className="dt-receipt-inspect-btn"
              onClick={() => onInspectSession(row.ticket!.sessionId)}
            >
              {lang === 'zh' ? '检视执行流' : 'Inspect'}
            </button>}
          </div>
          {row.delivery.summary && <span className="dt-hint dt-pipeline-summary">{row.delivery.summary}</span>}
        </div>
      </div>
    })}
  </div>
}

function SessionConsoleModal({ sessionId, lang, onClose, onSelectSession }: {
  sessionId: string | undefined; lang: 'zh' | 'en'; onClose: () => void; onSelectSession: (id: string) => void
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [toolName, setToolName] = useState('')
  const [toolArgs, setToolArgs] = useState('{}')
  const [replyText, setReplyText] = useState('')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const epoch = useRef(0)
  const { detail, error, updated } = useLiveSession(sessionId, revision)
  useEffect(() => {
    epoch.current++
    setBusy(false)
    setToolName(''); setFeedback(''); setReplyText(''); setToolArgs('{}')
    if (!sessionId) return
    const controller = new AbortController()
    void standaloneFetch<{ sessions: SessionSummary[] }>('sessions', 'GET', undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) setSessions(result.sessions) })
      .catch(err => { if (!controller.signal.aborted) setFeedback(String(err)) })
    return () => controller.abort()
  }, [sessionId])
  const selectedTool = toolName || detail?.tools[0]?.name || ''
  const callTool = async (event: FormEvent) => {
    event.preventDefault()
    if (!sessionId || !selectedTool || busy) return
    const requestEpoch = epoch.current
    setBusy(true); setFeedback('')
    try {
      const output = await standaloneFetch<{ result: unknown }>(`sessions/${encodeURIComponent(sessionId)}/tool`, 'POST', {
        name: selectedTool, args: JSON.parse(toolArgs) as unknown,
      })
      if (epoch.current !== requestEpoch) return
      setFeedback(JSON.stringify(output.result, null, 2)); setRevision(value => value + 1)
    } catch (err) { if (epoch.current === requestEpoch) setFeedback(err instanceof Error ? err.message : String(err)) }
    finally { if (epoch.current === requestEpoch) setBusy(false) }
  }
  const sendReply = async () => {
    if (!sessionId || busy) return
    const requestEpoch = epoch.current
    setBusy(true); setFeedback('')
    try {
      await standaloneFetch(`sessions/${encodeURIComponent(sessionId)}/reply`, 'POST', { text: replyText, endTurn: true })
      if (epoch.current !== requestEpoch) return
      setReplyText(''); setRevision(value => value + 1)
    } catch (err) { if (epoch.current === requestEpoch) setFeedback(err instanceof Error ? err.message : String(err)) }
    finally { if (epoch.current === requestEpoch) setBusy(false) }
  }
  return <Modal className="dt-session-modal" open={!!sessionId} onClose={onClose}
    title={detail ? detail.title : (sessionId ?? '')} closeLabel={lang === 'zh' ? '关闭' : 'Close'}
    description={detail ? `${detail.model.provider} / ${detail.model.model} · ${updated} · ${detail.cwd}` : undefined}>
    <div className="dt-form">
      {sessions.length > 0 && <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '切换会话' : 'Switch session'}</span>
        <select className="dt-select" value={sessionId ?? ''} onChange={event => onSelectSession(event.target.value)}>
          {sessions.map(session => <option key={session.id} value={session.id}>{session.title} · {session.status}</option>)}
        </select></label>}
      {error && <p className="dt-error" role="status">{error}</p>}
      {detail && <>
        <SessionActivity key={sessionId} detail={detail} lang={lang} />
        <details className="dt-console-debug"><summary>{lang === 'zh' ? '调试与人工操作' : 'Debug and human controls'}</summary>
          <form className="dt-field" onSubmit={event => { void callTool(event) }}>
            <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '角色工具' : 'Role tool'}</span>
              <select className="dt-select" value={selectedTool} onChange={event => setToolName(event.target.value)}>
                {detail.tools.map(tool => <option key={tool.name} value={tool.name}>{tool.name}</option>)}
              </select></label>
            {detail.id.startsWith('worker-') && <div className="dt-row-buttons">{(['progress', 'ready'] as const).map(state =>
              <Button key={state} size="sm" onClick={() => { setToolName('orchestrator_report'); setToolArgs(JSON.stringify({ state,
                summary: state === 'ready' ? '已完成实现并通过全部验证。' : '正在分析并实现改动…' }, null, 2)) }}>
                {state === 'ready' ? (lang === 'zh' ? '填入就绪报告' : 'Preset: ready') : (lang === 'zh' ? '填入进展报告' : 'Preset: progress')}</Button>)}</div>}
            <textarea className="dt-textarea dt-mono" rows={4} aria-label={lang === 'zh' ? '工具参数' : 'Tool arguments'}
              value={toolArgs} onChange={event => setToolArgs(event.target.value)} />
            <Button type="submit" variant="outline" size="sm" disabled={busy || !selectedTool}>{lang === 'zh' ? '执行工具' : 'Run tool'}</Button>
          </form>
          <label className="dt-field"><span className="dt-field-head">{lang === 'zh' ? '人工助手回复' : 'Human assistant reply'}</span>
            <textarea className="dt-textarea" rows={3} value={replyText} onChange={event => setReplyText(event.target.value)} /></label>
          <Button size="sm" disabled={busy} onClick={() => { void sendReply() }}>{lang === 'zh' ? '发送回复并结束回合' : 'Reply and end turn'}</Button>
          <details><summary>{lang === 'zh' ? '原始会话事件' : 'Raw session events'} ({detail.events.length})</summary>
            <pre className="dt-raw-events">{JSON.stringify(detail.events.slice(-20), null, 2)}</pre></details>
        </details>
      </>}
      {feedback && <pre className="dt-raw-events" role="status">{feedback}</pre>}
    </div>
  </Modal>
}

interface MarkdownCatalogItem {
  path: string
  title: string
  group: 'artifacts' | 'worktree' | 'docs'
  size: number
  updatedAt: string
  nodeName: string
}

interface MarkdownDocPayload {
  path: string
  resolvedPath: string
  title: string
  content: string
  size: number
  updatedAt: string
  sourceNode?: string
  focusLine?: number
}

function MarkdownReaderModal({
  open,
  target,
  lang,
  onClose,
  onSelectPath,
}: {
  open: boolean
  target: { path: string; line?: number } | undefined
  lang: Lang
  onClose: () => void
  onSelectPath: (path: string, line?: number) => void
}) {
  const [catalog, setCatalog] = useState<MarkdownCatalogItem[]>([])
  const [doc, setDoc] = useState<MarkdownDocPayload>()
  const [customPath, setCustomPath] = useState('')
  const [mode, setMode] = useState<'rendered' | 'raw'>('rendered')
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')

  // Load the document catalog when modal opens
  useEffect(() => {
    if (!open) return
    let cancelled = false
    standaloneFetch<{ items: MarkdownCatalogItem[] }>('markdown/list', 'GET')
      .then(res => {
        if (cancelled) return
        setCatalog(res.items ?? [])
        if (!target?.path && res.items?.length) {
          onSelectPath(res.items[0]!.path)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [open, target?.path, onSelectPath])

  // Load the requested `.md` file whenever `target.path` changes
  useEffect(() => {
    if (!open || !target?.path) return
    let cancelled = false
    setLoading(true)
    setError('')
    setCustomPath(target.path)
    const qPath = target.line ? `${target.path}:${target.line}` : target.path
    standaloneFetch<MarkdownDocPayload>(`markdown/read?path=${encodeURIComponent(qPath)}`, 'GET')
      .then(res => {
        if (cancelled) return
        setDoc(res)
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [open, target?.path, target?.line])

  const headings = useMemo(() => {
    if (!doc?.content) return []
    const blocks = markdownBlocks(doc.content)
    return blocks.flatMap((b, index) =>
      b.kind === 'heading' ? [{ index, level: b.level, text: b.text, id: headingAnchorId('md-reader', index) }] : [],
    )
  }, [doc?.content])

  const scrollToHeading = (id: string) => {
    const el = document.getElementById(id)
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }

  const copyContent = async () => {
    if (!doc?.content) return
    try {
      await navigator.clipboard.writeText(doc.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {}
  }

  const downloadMarkdown = () => {
    if (!doc?.content) return
    const blob = new Blob([doc.content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = doc.path.split('/').at(-1) || 'document.md'
    a.click()
    URL.revokeObjectURL(url)
  }

  const lineCount = doc?.content ? doc.content.split('\n').length : 0
  const artifactsList = catalog.filter(c => c.group === 'artifacts' || c.group === 'worktree')
  const docsList = catalog.filter(c => c.group === 'docs')

  return (
    <Modal
      className="dt-fullscreen-modal"
      open={open}
      onClose={onClose}
      title={doc ? `📄 ${doc.title}` : (lang === 'zh' ? '📄 Markdown 文档阅读器' : '📄 Markdown Reader')}
      closeLabel={lang === 'zh' ? '关闭 (ESC)' : 'Close (ESC)'}
      description={
        doc
          ? `${doc.path}${doc.sourceNode ? ` · 🖥 来源节点：${doc.sourceNode}` : ''} · ${lineCount} 行 · ${formatSmartTimestamp(doc.updatedAt, lang)}`
          : (lang === 'zh' ? '点击左右半透明暗色背景、按 ESC 或点击关闭按钮即可退出' : 'Click dark backdrop or press ESC to close')
      }
      footer={
        <div className="dt-live-head" style={{ width: '100%' }}>
          <div className="dt-row-buttons">
            <div className="dt-mode-switcher" role="tablist" aria-label={lang === 'zh' ? '阅读视图模式' : 'Reader view mode'}>
              <button
                type="button"
                role="tab"
                className="dt-mode-tab"
                aria-selected={mode === 'rendered'}
                onClick={() => setMode('rendered')}
              >
                {lang === 'zh' ? '📖 渲染视图 (含表格与目录)' : '📖 Rendered GFM'}
              </button>
              <button
                type="button"
                role="tab"
                className="dt-mode-tab"
                aria-selected={mode === 'raw'}
                onClick={() => setMode('raw')}
              >
                {lang === 'zh' ? '📝 原始 Markdown' : '📝 Raw Markdown'}
              </button>
            </div>
            {doc && (
              <>
                <Button size="sm" variant="outline" onClick={() => { void copyContent() }}>
                  {copied ? (lang === 'zh' ? '✓ 已复制全文' : '✓ Copied') : (lang === 'zh' ? '复制全文' : 'Copy')}
                </Button>
                <Button size="sm" variant="outline" onClick={downloadMarkdown}>
                  {lang === 'zh' ? '下载 .md' : 'Download .md'}
                </Button>
              </>
            )}
          </div>
          <Button size="sm" variant="primary" onClick={onClose}>
            {lang === 'zh' ? '关闭 (ESC)' : 'Close (ESC)'}
          </Button>
        </div>
      }
    >
      <div className="dt-form">
        <div className="dt-topic-switch">
          <select
            className="dt-select"
            style={{ maxWidth: 360 }}
            aria-label={lang === 'zh' ? '选择文档' : 'Select document'}
            value={doc?.path ?? target?.path ?? ''}
            onChange={e => { if (e.target.value) onSelectPath(e.target.value) }}
          >
            {artifactsList.length > 0 && (
              <optgroup label={lang === 'zh' ? '📦 调研与方案产物 (.artifacts / 工单)' : '📦 Artifacts & Plans'}>
                {artifactsList.map(item => (
                  <option key={item.path} value={item.path}>
                    {item.title} ({item.path})
                  </option>
                ))}
              </optgroup>
            )}
            {docsList.length > 0 && (
              <optgroup label={lang === 'zh' ? '📚 项目与架构文档 (docs)' : '📚 Project & Architecture Docs'}>
                {docsList.map(item => (
                  <option key={item.path} value={item.path}>
                    {item.title} ({item.path})
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <Input
            value={customPath}
            onChange={e => setCustomPath(e.target.value)}
            placeholder={lang === 'zh' ? '输入或粘贴任意 .md 路径（支持本机或跨节点路径如 C:/AI/.../*.md）…' : 'Enter any .md path…'}
            onKeyDown={e => {
              if (e.key === 'Enter' && customPath.trim()) {
                e.preventDefault()
                onSelectPath(customPath.trim())
              }
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!customPath.trim() || loading}
            onClick={() => onSelectPath(customPath.trim())}
          >
            {lang === 'zh' ? '打开文档' : 'Open'}
          </Button>
        </div>

        {error && <p className="dt-error" role="status">{error}</p>}
        {loading && <p className="dt-hint">{lang === 'zh' ? '正在加载文档内容（支持跨机穿透读取）…' : 'Loading document…'}</p>}

        {doc && (
          <div className="dt-workbench-chat-grid">
            <aside className="dt-topic-sidebar" aria-label={lang === 'zh' ? '章节目录大纲' : 'Table of contents'}>
              <div className="dt-topic-sidebar-head">
                <span>{lang === 'zh' ? '📑 章节目录 (TOC)' : '📑 Outline (TOC)'}</span>
                <span className="dt-mono">{headings.length}</span>
              </div>
              <div className="dt-topic-list" style={{ maxHeight: '62vh' }}>
                {headings.length === 0 ? (
                  <span className="dt-hint">{lang === 'zh' ? '无章节标题' : 'No headings'}</span>
                ) : (
                  headings.map(h => (
                    <button
                      key={h.id}
                      type="button"
                      className="dt-topic-card"
                      style={{ paddingLeft: `${Math.max(8, (h.level - 1) * 12 + 8)}px` }}
                      onClick={() => {
                        setMode('rendered')
                        setTimeout(() => scrollToHeading(h.id), 20)
                      }}
                    >
                      <span className="dt-topic-card-title">{h.text}</span>
                    </button>
                  ))
                )}
              </div>
            </aside>

            <div className="dt-chat-stage">
              {mode === 'raw' ? (
                <pre className="dt-raw-events" style={{ maxHeight: '66vh', fontSize: 13, lineHeight: '21px' }}>
                  {doc.content}
                </pre>
              ) : (
                <article className="dt-md-doc-sheet">
                  <MarkdownLite text={doc.content} idPrefix="md-reader" />
                </article>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

export function StandaloneRoot() {
  const [lang, setLang] = useState<'zh' | 'en'>('zh')
  const [activeSession, setActiveSession] = useState<string>()
  const [inspectedSession, setInspectedSession] = useState<string>()
  const [nodesModalOpen, setNodesModalOpen] = useState(false)
  const [profilesModalOpen, setProfilesModalOpen] = useState(false)
  const [mdReaderTarget, setMdReaderTarget] = useState<{ path: string; line?: number }>()
  const [mdReaderOpen, setMdReaderOpen] = useState(false)
  const [viewMode, setViewMode] = useState<MainViewSlotId>('assistant')
  const [roleModels, setRoleModels] = useState<RoleModelsSummary>()
  const [modelProfiles, setModelProfiles] = useState<ModelProfilesState>()
  const [deviceGroup, setDeviceGroup] = useState<DeviceGroupSummary>()
  const [workerLoad, setWorkerLoad] = useState<{ running: number; maxWorkers: number }>()
  const [workerNodes, setWorkerNodes] = useState<WorkerNodeInfo[]>([])
  const [memories, setMemories] = useState<MemoryEntryInfo[]>([])
  const [memoryBackups, setMemoryBackups] = useState<MemoryBackupInfo[]>([])
  const [plugins, setPlugins] = useState<PluginDescriptorInfo[]>([])
  const [assistantMessages, setAssistantMessages] = useState<AssistantMessageInfo[]>([])
  const [assistantLiveRun, setAssistantLiveRun] = useState<LiveSessionRunInfo | null>(null)
  const [assistantChatBackups, setAssistantChatBackups] = useState<AssistantChatBackupInfo[]>([])
  const [assistantContextConfig, setAssistantContextConfig] = useState<AssistantContextConfigInfo>()
  const [clawfeedItems, setClawfeedItems] = useState<ClawFeedItemInfo[]>([])
  const [progressCards, setProgressCards] = useState<Record<string, SessionProgressCardInfo>>({})
  const [pendingQuestions, setPendingQuestions] = useState<PendingUserQuestionInfo[]>([])
  const [pipelineRows, setPipelineRows] = useState<PipelineRow[]>([])

  const handleMetaUpdate = useCallback((meta: {
    roleModels?: RoleModelsSummary
    modelProfiles?: ModelProfilesState
    deviceGroup?: DeviceGroupSummary
    load?: { running: number; maxWorkers: number }
    nodes?: WorkerNodeInfo[]
    memories?: MemoryEntryInfo[]
    memoryBackups?: MemoryBackupInfo[]
    plugins?: PluginDescriptorInfo[]
    assistantMessages?: AssistantMessageInfo[]
    assistantLiveRun?: LiveSessionRunInfo | null
    assistantChatBackups?: AssistantChatBackupInfo[]
    assistantContextConfig?: AssistantContextConfigInfo
    clawfeedItems?: ClawFeedItemInfo[]
    progressCards?: Record<string, SessionProgressCardInfo>
    pendingQuestions?: PendingUserQuestionInfo[]
    pipeline?: PipelineRow[]
  }) => {
    if (meta.roleModels) setRoleModels(meta.roleModels)
    if (meta.modelProfiles) setModelProfiles(meta.modelProfiles)
    if (meta.deviceGroup) setDeviceGroup(meta.deviceGroup)
    if (meta.load) setWorkerLoad(meta.load)
    if (meta.nodes) setWorkerNodes(meta.nodes)
    if (meta.memories) setMemories(meta.memories)
    if (meta.memoryBackups) setMemoryBackups(meta.memoryBackups)
    if (meta.plugins) setPlugins(meta.plugins)
    if (meta.assistantMessages) setAssistantMessages(meta.assistantMessages)
    if (meta.assistantLiveRun !== undefined) setAssistantLiveRun(meta.assistantLiveRun)
    if (meta.assistantChatBackups) setAssistantChatBackups(meta.assistantChatBackups)
    if (meta.assistantContextConfig) setAssistantContextConfig(meta.assistantContextConfig)
    if (meta.clawfeedItems) setClawfeedItems(meta.clawfeedItems)
    if (meta.progressCards) setProgressCards(meta.progressCards)
    if (meta.pendingQuestions) setPendingQuestions(meta.pendingQuestions)
    if (meta.pipeline) setPipelineRows(meta.pipeline)
  }, [])

  const refreshAssistantMessages = useCallback(async () => {
    try {
      const res = await standaloneFetch<{
        messages: AssistantMessageInfo[]
        liveRun?: LiveSessionRunInfo | null
        chatBackups?: AssistantChatBackupInfo[]
        contextConfig?: AssistantContextConfigInfo
      }>('assistant/messages', 'GET')
      setAssistantMessages(res.messages)
      if (res.liveRun !== undefined) setAssistantLiveRun(res.liveRun)
      if (res.chatBackups) setAssistantChatBackups(res.chatBackups)
      if (res.contextConfig) setAssistantContextConfig(res.contextConfig)
    } catch {}
  }, [])

  const hasActiveAssistantOrHandoffRun = Boolean(
    assistantLiveRun ||
      assistantMessages.some(
        m => m.handoff && (m.handoff.state === 'evaluating' || m.handoff.ticketState === 'running'),
      ),
  )

  useEffect(() => {
    if (viewMode !== 'assistant' || !hasActiveAssistantOrHandoffRun) return
    const timer = setInterval(() => {
      void refreshAssistantMessages()
    }, 650)
    return () => clearInterval(timer)
  }, [viewMode, hasActiveAssistantOrHandoffRun, refreshAssistantMessages])

  const enabledSlots = useMemo(() => getEnabledUIViewSlots(plugins), [plugins])
  useEffect(() => {
    if (!enabledSlots.some(s => s.id === viewMode)) {
      setViewMode(enabledSlots[0]?.id ?? 'memory')
    }
  }, [enabledSlots, viewMode])

  useEffect(() => {
    const onOpenMd = (event: Event) => {
      const detail = (event as CustomEvent<OpenMarkdownEventDetail>).detail
      if (detail?.path) {
        setMdReaderTarget({ path: detail.path, ...(detail.line !== undefined ? { line: detail.line } : {}) })
        setMdReaderOpen(true)
      }
    }
    window.addEventListener('rharness:open-markdown', onOpenMd)
    return () => window.removeEventListener('rharness:open-markdown', onOpenMd)
  }, [])

  const quickSwitchProfile = async (profileId: string) => {
    try {
      const res = await standaloneFetch<ModelProfilesState>('model-profiles', 'PUT', {
        activeProfileId: profileId,
      })
      setModelProfiles(res)
      setRoleModels({
        ...(res.assistantModel ? { assistant: res.assistantModel } : {}),
        eval: res.evalModel,
        executor: res.executorModel,
      })
    } catch {}
  }

  const handleInspectSession = useCallback((sessionId: string) => {
    setInspectedSession(sessionId)
    const el = document.getElementById('live-execution')
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
  }, [])

  const t = useMemo(() => makeTranslator(lang === 'zh' ? zh : en), [lang])
  const activeAsstModel = roleModels?.assistant ?? roleModels?.eval
  const asstLabel = activeAsstModel ? `${activeAsstModel.model}${activeAsstModel.reasoningEffort ? ` (${activeAsstModel.reasoningEffort})` : ''}` : 'default'
  const evalLabel = roleModels?.eval ? `${roleModels.eval.model}${roleModels.eval.reasoningEffort ? ` (${roleModels.eval.reasoningEffort})` : ''}` : 'default'
  const workerLabel = roleModels?.executor ? `${roleModels.executor.model}${roleModels.executor.reasoningEffort ? ` (${roleModels.executor.reasoningEffort})` : ''}` : 'default'
  const onlineNodeCount = workerNodes.filter(n => n.status === 'online').length || 1
  const profilesList = modelProfiles?.config?.profiles ?? []
  const isProfilesPluginEnabled = plugins.find(p => p.id === 'dsh-model-profiles')?.enabled !== false
  const isDeviceGroupPluginEnabled = plugins.find(p => p.id === 'dsh-device-group')?.enabled !== false

  return <div className="dt-standalone-root" data-view-mode={viewMode}>
    <div className="dt-standalone-bar">
      <div className="dt-standalone-brand">
        <RHarnessLogo size={26} />
        <strong>RHarness</strong>
        <span>{lang === 'zh' ? '智能体工作台' : 'Agent Workbench'}</span>
        <div className="dt-mode-switcher" role="tablist" aria-label={lang === 'zh' ? '工作台视图模式' : 'Workspace view mode'}>
          {enabledSlots.map(slot => <button
            key={slot.id}
            type="button"
            role="tab"
            className="dt-mode-tab"
            aria-selected={viewMode === slot.id}
            onClick={() => setViewMode(slot.id)}
            data-testid={`view-tab-${slot.id}`}
          >
            {slot.label(lang, {
              assistantCount: assistantMessages.length,
              clawfeedCount: clawfeedItems.length,
              memoryCount: memories.length,
              enabledPlugins: plugins.filter(p => p.enabled).length,
              totalPlugins: plugins.length,
              pipelineCount: pipelineRows.length,
            })}
          </button>)}
        </div>
      </div>
      <div className="dt-standalone-actions">
        <div className="dt-model-pills" aria-label={lang === 'zh' ? '当前模型与并发状态' : 'Active models and concurrency'}>
          {isProfilesPluginEnabled && profilesList.length > 0 && <div className="dt-mode-switcher" role="group" aria-label={lang === 'zh' ? '快速切换模型配置组' : 'Quick switch model profile'}>
            {profilesList.map((p, idx) => <button
              key={p.id}
              type="button"
              className="dt-mode-tab"
              title={p.name}
              aria-selected={modelProfiles?.activeProfile.id === p.id}
              onClick={() => { void quickSwitchProfile(p.id) }}
            >
              {lang === 'zh' ? `组${idx + 1}` : `P${idx + 1}`}
            </button>)}
          </div>}
          <span className="dt-model-pill" title={modelProfiles?.matchedAssistantSlot ? `${modelProfiles.matchedAssistantSlot.label} (${modelProfiles.matchedAssistantSlot.startTime}-${modelProfiles.matchedAssistantSlot.endTime})` : (lang === 'zh' ? '个人助理模型 (Claw Assistant)' : 'Personal Assistant model')}>
            <span className="dt-pill-dot" />Claw: <strong className="dt-mono">{asstLabel}</strong>
            {modelProfiles?.matchedAssistantSlot && <span className="dt-mono">({modelProfiles.matchedAssistantSlot.label})</span>}
          </span>
          <span className="dt-model-pill" title={modelProfiles?.matchedEvalSlot ? `${modelProfiles.matchedEvalSlot.label} (${modelProfiles.matchedEvalSlot.startTime}-${modelProfiles.matchedEvalSlot.endTime})` : (lang === 'zh' ? '主控评估模型 (Eval)' : 'Eval model')}>
            <span className="dt-pill-dot" data-tone="eval" />Eval: <strong className="dt-mono">{evalLabel}</strong>
            {modelProfiles?.matchedEvalSlot && <span className="dt-mono">({modelProfiles.matchedEvalSlot.label})</span>}
          </span>
          <span className="dt-model-pill" title={modelProfiles?.matchedExecutorSlot ? `${modelProfiles.matchedExecutorSlot.label} (${modelProfiles.matchedExecutorSlot.startTime}-${modelProfiles.matchedExecutorSlot.endTime})` : (lang === 'zh' ? '工单执行器模型 (Executor)' : 'Executor model')}>
            <span className="dt-pill-dot" data-tone="worker" />Worker: <strong className="dt-mono">{workerLabel}</strong>
            {modelProfiles?.matchedExecutorSlot && <span className="dt-mono">({modelProfiles.matchedExecutorSlot.label})</span>}
          </span>
          {workerLoad && <span className="dt-model-pill">
            {lang === 'zh' ? `槽位 ${workerLoad.running}/${workerLoad.maxWorkers}` : `Slots ${workerLoad.running}/${workerLoad.maxWorkers}`}
          </span>}
          {isProfilesPluginEnabled && <Button variant="outline" size="sm" onClick={() => setProfilesModalOpen(true)}>
            {lang === 'zh' ? '配置组' : 'Profiles'}
          </Button>}
          {isDeviceGroupPluginEnabled && <Button variant="outline" size="sm" onClick={() => setNodesModalOpen(true)}>
            {lang === 'zh' ? `节点 (${onlineNodeCount})` : `Nodes (${onlineNodeCount})`}
          </Button>}
          {pendingQuestions.length > 0 && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                const first = pendingQuestions[0]
                if (first?.role === 'claw') setViewMode('assistant')
                else setViewMode('workbench')
              }}
              data-testid="topbar-pending-questions-btn"
            >
              {lang === 'zh' ? `🔔 待您拍板 (${pendingQuestions.length})` : `🔔 Decisions (${pendingQuestions.length})`}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMdReaderOpen(true)}
            data-testid="open-markdown-reader-btn"
          >
            {lang === 'zh' ? '📄 文档阅读' : '📄 Docs & Plans'}
          </Button>
        </div>
        <nav className="dt-workspace-nav" aria-label={lang === 'zh' ? '工作台区域' : 'Workspace sections'}>
          <a href="#local-chat" onClick={() => setViewMode('workbench')}>{lang === 'zh' ? '工程对话' : 'Local chat'}</a>
          <a href="#management" onClick={() => setViewMode('management')}>{lang === 'zh' ? '管理面板' : 'Management'}</a>
          <a href="#live-execution" onClick={() => setViewMode('workbench')}>{lang === 'zh' ? '实时执行' : 'Live execution'}</a>
        </nav>
        <Button variant="outline" size="sm" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}>{lang === 'zh' ? 'English' : '中文'}</Button>
      </div>
    </div>

    <div className="dt-workbench-grid">
      <PanelConversation
        lang={lang}
        visible={viewMode === 'workbench'}
        pendingQuestions={pendingQuestions}
        onQuestionsUpdated={setPendingQuestions}
        inspectedSessionId={inspectedSession}
        onInspectSession={handleInspectSession}
      />
      <div id="management" className="dt-standalone-management">
        {viewMode === 'assistant' && <PersonalAssistantSlotView
          lang={lang}
          messages={assistantMessages}
          liveRun={assistantLiveRun}
          chatBackups={assistantChatBackups}
          memories={memories}
          pendingQuestions={pendingQuestions}
          progressCard={progressCards['claw-assistant-main']}
          contextConfig={assistantContextConfig}
          activeAssistantModel={activeAsstModel}
          matchedAssistantSlot={modelProfiles?.matchedAssistantSlot}
          onRefresh={refreshAssistantMessages}
          onQuestionsUpdated={setPendingQuestions}
          onChatBackupsUpdated={setAssistantChatBackups}
          onMemoriesUpdated={setMemories}
          onContextConfigUpdated={setAssistantContextConfig}
          onJumpToEngineeringTicket={ticketId => {
            setViewMode('workbench')
            if (ticketId) handleInspectSession(`worker-${ticketId}`)
          }}
          onSwitchToMemoryTab={() => setViewMode('memory')}
          onOpenAssistantSession={() => setActiveSession('claw-assistant-main')}
        />}
        {viewMode === 'clawfeed' && <ClawFeedNotificationsSlotView
          lang={lang}
          items={clawfeedItems}
          onItemsUpdated={setClawfeedItems}
        />}
        {viewMode === 'rhtoolkit' && <RHToolkitSlotView lang={lang} />}
        {viewMode === 'memory' && <MemoryAndPluginsSection
          lang={lang}
          memories={memories}
          memoryBackups={memoryBackups}
          plugins={plugins}
          onMemoriesUpdated={setMemories}
          onMemoryBackupsUpdated={setMemoryBackups}
          onPluginsUpdated={setPlugins}
        />}
        {viewMode === 'pipeline' && <section className="dt-pipeline-card" aria-label={lang === 'zh' ? '全链路管线与审计' : 'End-to-end pipeline audit'}>
          <div className="dt-live-head">
            <div>
              <h2>{lang === 'zh' ? '全链路管线追踪 (Source → Eval → Ticket → Git)' : 'End-to-End Pipeline Audit'}</h2>
              <span className="dt-hint">{lang === 'zh' ? '按横截面展示每条消息从触发、准入研判、分布式节点分配到代码合入的完整路径' : 'Cross-section of every request from trigger intake to node assignment and branch merge'}</span>
            </div>
          </div>
          <PipelineAuditSection rows={pipelineRows} lang={lang} onInspectSession={id => { setViewMode('workbench'); handleInspectSession(id) }} />
        </section>}
        <div className="dt-management-suite" hidden={viewMode === 'pipeline' || viewMode === 'memory' || viewMode === 'assistant' || viewMode === 'clawfeed' || viewMode === 'rhtoolkit'}>
          <App t={t} openSession={async id => setActiveSession(id)} deploymentForm={undefined}
            renderSessionActivity={id => <TicketActivity key={id} sessionId={id} lang={lang} />} />
        </div>
      </div>
      <LiveWorkspace
        lang={lang}
        onOpenSession={setActiveSession}
        inspectedSessionId={inspectedSession}
        preferredSessionId={viewMode === 'assistant' ? 'claw-assistant-main' : undefined}
        onSelectSession={setInspectedSession}
        onMetaUpdate={handleMetaUpdate}
      />
    </div>
    <ModelProfilesModal
      open={profilesModalOpen}
      lang={lang}
      profilesState={modelProfiles}
      onClose={() => setProfilesModalOpen(false)}
      onUpdated={next => {
        setModelProfiles(next)
        setRoleModels({
          ...(next.assistantModel ? { assistant: next.assistantModel } : {}),
          eval: next.evalModel,
          executor: next.executorModel,
        })
      }}
    />
    <WorkerNodesModal
      open={nodesModalOpen}
      lang={lang}
      nodes={workerNodes}
      deviceGroup={deviceGroup}
      onClose={() => setNodesModalOpen(false)}
      onNodesUpdated={setWorkerNodes}
    />
    <SessionConsoleModal sessionId={activeSession} lang={lang} onClose={() => setActiveSession(undefined)} onSelectSession={setActiveSession} />
    <MarkdownReaderModal
      open={mdReaderOpen}
      target={mdReaderTarget}
      lang={lang}
      onClose={() => setMdReaderOpen(false)}
      onSelectPath={(path, line) => {
        setMdReaderTarget({ path, ...(line !== undefined ? { line } : {}) })
        setMdReaderOpen(true)
      }}
    />
  </div>
}

const container = document.getElementById('root')
if (container) createRoot(container).render(<StandaloneRoot />)
