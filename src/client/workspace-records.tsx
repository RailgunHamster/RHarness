import { useEffect, useRef, useState } from 'react'
import type { RecordSummary, WorkspaceRecord } from '../app/workspace-records.ts'
import { Button, Modal } from './controls.tsx'
import { standaloneFetch, type Lang } from './standalone-api.ts'

const labels = {
  draft: ['草稿', 'Draft'], review: ['待确认', 'Needs approval'], running: ['执行中', 'Running'],
  done: ['已执行', 'Completed'], dismissed: ['已取消', 'Dismissed'], uncertain: ['须核对结果', 'Verify outcome'],
}
export function WorkspaceDocuments({ open, close, lang }: { open: boolean; close: () => void; lang: Lang }) {
  const zh = lang === 'zh'
  const [items, setItems] = useState<RecordSummary[]>([])
  const [item, setItem] = useState<WorkspaceRecord>()
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const version = useRef(0)
  const dirty = title !== (item?.title ?? '') || text !== (item?.text ?? '')
  const mayLeave = () => !dirty || window.confirm(zh ? '放弃尚未保存的修改？' : 'Discard unsaved changes?')
  const show = (record?: WorkspaceRecord) => {
    setItem(record); setTitle(record?.title ?? ''); setText(record?.text ?? ''); setError('')
  }
  const refresh = async () => setItems((await standaloneFetch<{ items: RecordSummary[] }>('workspace')).items)
  useEffect(() => {
    if (!open) return
    let current = true
    const fetchList = async () => {
      try { const result = await standaloneFetch<{ items: RecordSummary[] }>('workspace'); if (current) setItems(result.items) }
      catch (err) { if (current) setError(String(err)) }
    }
    void fetchList()
    const timer = setInterval(() => void fetchList(), 6000)
    return () => { current = false; clearInterval(timer); version.current++ }
  }, [open])
  const select = async (id: string, revision?: number) => {
    if (!mayLeave()) return
    const token = ++version.current
    try { const value = await standaloneFetch<WorkspaceRecord>('workspace?id=' + encodeURIComponent(id) + (revision ? '&revision=' + revision : '')); if (version.current === token) show(value) }
    catch (err) { if (version.current === token) setError(String(err)) }
  }
  const submit = async (decision?: boolean) => {
    setBusy(true); setError('')
    try {
      const saved = decision === undefined
        ? await standaloneFetch<WorkspaceRecord>('workspace/save', 'POST', { id: item?.id, base: item?.revision ?? 0, kind: item?.kind ?? 'document', title, text, evidence: item?.evidence ?? [] })
        : await standaloneFetch<WorkspaceRecord>('workspace/decide', 'POST', { id: item?.id, revision: item?.revision, approve: decision })
      show(saved); await refresh()
    } catch (err) { setError(String(err)) }
    finally { setBusy(false) }
  }
  const state = item && labels[item.state][zh ? 0 : 1]
  const action = item?.kind === 'action'
  const latest = items.find(row => row.id === item?.id)?.revision ?? item?.revision ?? 0
  return <Modal open={open} title={zh ? '工作文档与确认' : 'Documents & approvals'} closeLabel={zh ? '关闭' : 'Close'}
    onClose={() => { if (!busy && mayLeave()) { show(); close() } }} className="dt-record-modal">
    <div className="dt-record-browser">
      <div className="dt-record-index">
        <Button variant="outline" disabled={busy} onClick={() => { if (mayLeave()) { version.current++; show() } }}>{zh ? '新建文档' : 'New document'}</Button>
        {items.map(row => <button className="dt-record-link" key={row.id} type="button" aria-current={item?.id === row.id} disabled={busy} onClick={() => void select(row.id)}>
          <strong>{row.title}</strong><small>{labels[row.state][zh ? 0 : 1]} · v{row.revision}</small></button>)}
      </div>
      <div className="dt-record-editor">
        {item && <div className="dt-record-meta"><span>{state} · {item.owner}</span>
          <label>{zh ? '版本 ' : 'Revision '}<select value={item.revision} disabled={busy} onChange={e => void select(item.id, Number(e.target.value))}>
            {Array.from({ length: latest }, (_, i) => latest - i).map(v => <option key={v} value={v}>v{v}</option>)}</select></label></div>}
        {action ? <><strong>{item.title}</strong><span>{zh ? '目标账户' : 'Destination'} · {item.target}</span><pre>{item.text}</pre>
          {item.result && <p role="status">{item.result}</p>}
          {item.state === 'review' && item.revision === latest && <div className="dt-row-buttons"><Button variant="primary" disabled={busy} onClick={() => void submit(true)}>{zh ? '确认执行此版本' : 'Approve this revision'}</Button>
          <Button variant="outline" disabled={busy} onClick={() => void submit(false)}>{zh ? '取消操作' : 'Dismiss'}</Button></div>}</>
          : <><label>{zh ? '标题' : 'Title'}<input value={title} disabled={busy} maxLength={200} onChange={e => setTitle(e.target.value)} /></label>
          <label>{zh ? '正文' : 'Text'}<textarea value={text} disabled={busy} rows={12} maxLength={240000} onChange={e => setText(e.target.value)} /></label>
          {item?.evidence.map((line,i) => <small key={i}>{line}</small>)}
          <Button variant="primary" disabled={busy || !dirty || !title.trim() || Boolean(item && item.revision < latest)} onClick={() => void submit()}>{zh ? '保存版本' : 'Save revision'}</Button></>}
        {error && <p role="alert" className="dt-error">{error}</p>}
        {item && latest > item.revision && <Button onClick={() => void select(item.id)}>{zh ? '打开最新版本' : 'Open latest revision'}</Button>}
      </div>
    </div>
  </Modal>
}
