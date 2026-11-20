import { useEffect, useState } from 'react'
import type { PersonalNotice } from '../app/personal-notices.ts'
import { Icon, Modal } from './controls.tsx'
import { formatSmartTimestamp, standaloneFetch, type Lang } from './standalone-api.ts'

const labels = {
  brief: { zh: '生活简报', en: 'Daily brief' },
  todo: { zh: '今日待办', en: 'Daily to-dos' },
  progress: { zh: 'K 线进度', en: 'K-line progress' },
  fit: { zh: 'K 线契合度', en: 'K-line fit report' },
}

export function PersonalNotices({ lang }: { lang: Lang }) {
  const zh = lang === 'zh'
  const title = zh ? 'Claw 提示' : 'Claw notices'
  const [items, setItems] = useState<PersonalNotice[]>()
  const [failed, setFailed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState<PersonalNotice>()
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    async function refresh() {
      if (pending || document.visibilityState === 'hidden') return
      pending = true
      try {
        const feed = await standaloneFetch<{ items: PersonalNotice[] }>('personal-notices', 'GET', undefined, controller.signal)
        if (!controller.signal.aborted) { setItems(feed.items); setFailed(false) }
      } catch {
        if (!controller.signal.aborted) setFailed(true)
      } finally {
        pending = false
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, 60_000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      controller.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [attempt])

  return <aside className="dt-personal-notices" aria-label={title}>
    <h2><Icon name="inbox" />{title}</h2>
    <button type="button" className="dt-notice-toggle" aria-expanded={expanded} aria-controls="personal-notice-list" onClick={() => setExpanded(!expanded)}>
      <Icon name="inbox" />{title}<Icon name={expanded ? 'chevron-up' : 'chevron-down'} />
    </button>
    <div id="personal-notice-list" className="dt-notice-list" data-expanded={expanded}>
      {failed && <div role="status" className="dt-hint">
        {zh ? '暂时无法更新提示。' : 'Notices could not be refreshed. '}
        <button type="button" className="dt-textlink" onClick={() => setAttempt(n => n + 1)}>{zh ? '重试' : 'Retry'}</button>
      </div>}
      {!failed && !items?.length && <span className="dt-hint">{items
        ? (zh ? '近期暂无提示' : 'No recent notices')
        : (zh ? '正在读取…' : 'Loading…')}</span>}
      {items?.map(item => {
        const preview = item.text.split(/\r?\n| \| /).slice(1).find(line => line.trim())
        return <button type="button" className="dt-notice-row" key={item.id} onClick={() => setSelected(item)}>
          <strong>{labels[item.kind][lang]}</strong>
          {preview && <span className="dt-notice-preview">{preview}</span>}
          <time dateTime={item.at}>{formatSmartTimestamp(item.at, lang)}</time>
        </button>
      })}
    </div>
    <Modal open={Boolean(selected)} title={selected ? labels[selected.kind][lang] : title}
      className="dt-notice-dialog" closeLabel={zh ? '关闭' : 'Close'} onClose={() => setSelected(undefined)}
      description={selected && `${zh ? '飞书' : 'Feishu'} · ${formatSmartTimestamp(selected.at, lang)}`}>
      <div className="dt-notice-text">{selected?.text}</div>
    </Modal>
  </aside>
}
