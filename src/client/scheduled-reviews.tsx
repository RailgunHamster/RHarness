import { useEffect, useState } from 'react'
import type { ScheduledReview } from '../app/scheduled-reviews.ts'
import { Button, Modal } from './controls.tsx'
import { standaloneFetch, formatSmartTimestamp, type Lang } from './standalone-api.ts'

const modes = { prepare: ['准备草稿','Prepare a draft'], follow: ['跟进进度','Follow progress'], silent: ['静默观察','Observe silently'], notify: ['通知面板','Notify panel'] }
export function ReviewSchedule({ open, close, lang }: { open: boolean; close: () => void; lang: Lang }) {
  const zh = lang === 'zh'
  const [items, setItems] = useState<ScheduledReview[]>([])
  const [prompt, setPrompt] = useState(''), [due, setDue] = useState(''), [repeat, setRepeat] = useState('')
  const [mode, setMode] = useState<ScheduledReview['mode']>('prepare')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    standaloneFetch<{ items: ScheduledReview[] }>('schedules', 'GET', undefined, abort.signal).then(data => setItems(data.items)).catch(err => { if (!abort.signal.aborted) setError(String(err)) })
    return () => abort.abort()
  }, [open])
  const save = async (old?: ScheduledReview) => {
    setBusy(true); setError('')
    try {
      const body = old ? { ...old, base: old.revision, enabled: !old.enabled }
        : { prompt, due: new Date(due).toISOString(), mode, ...(repeat ? { intervalMinutes: Number(repeat) } : {}) }
      const result = await standaloneFetch<{ items: ScheduledReview[] }>('schedules','POST',body)
      setItems(result.items); if (!old) { setPrompt(''); setDue('') }
    } catch (err) { setError(String(err)) }
    finally { setBusy(false) }
  }
  return <Modal open={open} onClose={close} title={zh ? '定时研判' : 'Scheduled reviews'} closeLabel={zh ? '关闭' : 'Close'}>
    <form className="dt-record-editor" onSubmit={event => { event.preventDefault(); void save() }}>
      <label>{zh ? '关注什么' : 'What to review'}<textarea required maxLength={1600} rows={2} value={prompt} onChange={e => setPrompt(e.target.value)} /></label>
      <label>{zh ? '首次时间' : 'First review'}<input required type="datetime-local" value={due} onChange={e => setDue(e.target.value)} /></label>
      <label>{zh ? '处理方式' : 'Mode'}<select value={mode} onChange={e => setMode(e.target.value as typeof mode)}>{Object.entries(modes).map(([key,label]) => <option key={key} value={key}>{label[zh ? 0 : 1]}</option>)}</select></label>
      <label>{zh ? '重复' : 'Repeat'}<select value={repeat} onChange={e => setRepeat(e.target.value)}>{[['', '仅一次','Once'],['60','每小时','Every hour'],['1440','每 24 小时','Every 24 hours'],['10080','每 7 天','Every 7 days']].map(([value,cn,en]) => <option key={value} value={value}>{zh ? cn : en}</option>)}</select></label>
      <Button type="submit" variant="primary" disabled={busy}>{zh ? '添加计划' : 'Add schedule'}</Button>
      {error && <p role="alert" className="dt-error">{error}</p>}
      {items.map(item => <div className="dt-record-link" key={item.id}><strong>{item.prompt}</strong><small>{modes[item.mode][zh ? 0 : 1]} · {formatSmartTimestamp(item.due, lang)}</small>
        {item.lastTrigger && <small>{zh ? '上次触发' : 'Last triggered'} · {formatSmartTimestamp(item.lastAt!, lang)}</small>}
        {(item.enabled || !item.lastTrigger || item.intervalMinutes) && <Button size="sm" disabled={busy} onClick={() => void save(item)}>{item.enabled ? (zh ? '暂停' : 'Pause') : (zh ? '恢复' : 'Resume')}</Button>}</div>)}
    </form>
  </Modal>
}
