/** Embed the selected worker's live feed and Git worktree merge controls directly in its ticket detail. */
import { useEffect, useState } from 'react'
import { Button, Tag } from './controls.tsx'
import { SessionActivity, useLiveSession } from './standalone-activity.tsx'
import { standaloneFetch, type Lang } from './standalone-api.ts'

interface WorktreeStatus {
  available: boolean
  directory: string
  branch: string
  head: string
  baseBranch: string
  baseHead: string
  dirtyFiles: string[]
  aheadCommits: { sha: string; subject: string }[]
  merged: boolean
  autoMerged?: boolean
  lastMergeOutput?: string
  lastMergeError?: string
}

function TicketWorktreeCard({ ticketId, lang, running }: { ticketId: string; lang: Lang; running: boolean }) {
  const [status, setStatus] = useState<WorktreeStatus>()
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const next = await standaloneFetch<WorktreeStatus>(`tickets/${encodeURIComponent(ticketId)}/worktree`)
        if (active) setStatus(next)
      } catch {
        // Ignore transient poll errors
      }
    }
    void load()
    if (!running) return () => { active = false }
    const timer = setInterval(() => { void load() }, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [ticketId, running])

  if (!status?.available) return null

  const mergeNow = async (push: boolean) => {
    if (busy) return
    setBusy(true); setError(''); setFeedback('')
    try {
      const res = await standaloneFetch<{ status: WorktreeStatus; merged: boolean; output: string }>(
        `tickets/${encodeURIComponent(ticketId)}/worktree/merge`,
        'POST',
        { commitDirty: true, push },
      )
      setStatus(res.status)
      setFeedback(res.output)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return <section className="dt-live-workspace dt-ticket-activity" aria-label={lang === 'zh' ? 'Git Worktree 合并' : 'Git worktree merge'}>
    <div className="dt-row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>{lang === 'zh' ? '独立工作树 (Git Worktree)' : 'Isolated Git Worktree'}</h3>
        <Tag tone={status.merged ? 'success' : status.lastMergeError ? 'danger' : 'info'}>
          {status.merged
            ? status.autoMerged
              ? (lang === 'zh' ? `已自动合并到 ${status.baseBranch}` : `Auto-merged into ${status.baseBranch}`)
              : (lang === 'zh' ? `已与 ${status.baseBranch} 同步` : `Synced with ${status.baseBranch}`)
            : (lang === 'zh'
                ? `执行中 / 待合并 (${status.aheadCommits.length} 个提交${status.dirtyFiles.length ? ` · ${status.dirtyFiles.length} 个未提交改动` : ''})`
                : `Pending merge (${status.aheadCommits.length} commits${status.dirtyFiles.length ? ` · ${status.dirtyFiles.length} dirty files` : ''})`)}
        </Tag>
        <span className="dt-mono dt-hint">
          {status.branch} ({status.head}) → {status.baseBranch} ({status.baseHead})
        </span>
      </div>
      {!status.merged && <div className="dt-row-buttons">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => { void mergeNow(false) }}>
          {busy ? (lang === 'zh' ? '正在合并…' : 'Merging…') : (lang === 'zh' ? `立即合并到 ${status.baseBranch}` : `Merge into ${status.baseBranch}`)}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { void mergeNow(true) }}>
          {lang === 'zh' ? `合并到 ${status.baseBranch} 并推送` : `Merge & push`}
        </Button>
      </div>}
    </div>
    {status.aheadCommits.length > 0 && <ul className="dt-plain-list" style={{ marginTop: 8 }}>
      {status.aheadCommits.map(commit => <li key={commit.sha} className="dt-mono" style={{ fontSize: 12 }}>
        <strong>{commit.sha}</strong> {commit.subject}
      </li>)}
    </ul>}
    {status.dirtyFiles.length > 0 && <p className="dt-hint dt-mono" style={{ marginTop: 6 }}>
      {lang === 'zh' ? '未提交改动（完工或点击合并时会自动打包提交并合入主分支）：' : 'Uncommitted files (auto-committed and merged on completion): '}
      {status.dirtyFiles.slice(0, 6).join(', ')}{status.dirtyFiles.length > 6 ? ` +${status.dirtyFiles.length - 6}` : ''}
    </p>}
    {(feedback || status.lastMergeOutput) && <pre className="dt-raw-events" role="status" style={{ marginTop: 8 }}>{feedback || status.lastMergeOutput}</pre>}
    {(error || status.lastMergeError) && <p className="dt-error" role="status" style={{ marginTop: 8 }}>{error || status.lastMergeError}</p>}
  </section>
}

export function TicketActivity({ sessionId, lang }: { sessionId: string; lang: Lang }) {
  const { detail, error } = useLiveSession(sessionId)
  const ticketId = sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined
  return <>
    {ticketId && <TicketWorktreeCard ticketId={ticketId} lang={lang} running={detail?.status === 'running'} />}
    <section className="dt-live-workspace dt-ticket-activity" aria-label={lang === 'zh' ? '工单实时执行' : 'Ticket live execution'}>
      <h3>{lang === 'zh' ? '实时执行过程' : 'Live execution'}</h3>
      {error && <p className="dt-error" role="status">{lang === 'zh' ? '连接中断，正在重试：' : 'Connection lost, retrying: '}{error}</p>}
      {detail ? <SessionActivity detail={detail} lang={lang} /> : <p className="dt-hint">{lang === 'zh' ? '正在连接执行会话…' : 'Connecting to session…'}</p>}
    </section>
  </>
}
