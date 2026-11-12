/** Context-free renderer for the panel's safe Markdown subset, GFM tables, and interactive `.md` document link interception. */
import { Fragment, createElement, type ReactNode } from 'react'
import { inlines, markdownBlocks, type Inline } from './markdown.ts'

const external = { target: '_blank', rel: 'noopener noreferrer' } as const

export interface OpenMarkdownEventDetail {
  path: string
  line?: number
  anchor?: string
}

export function openMarkdownViewer(rawTarget: string): void {
  const trimmed = rawTarget.trim()
  if (!trimmed || typeof window === 'undefined') return
  let target = trimmed
  let anchor: string | undefined
  const hashIdx = target.indexOf('#')
  if (hashIdx >= 0) {
    anchor = target.slice(hashIdx + 1)
    target = target.slice(0, hashIdx)
  }
  let line: number | undefined
  const lineMatch = /^(.*\.md):(\d+)(?:-\d+)?$/i.exec(target)
  if (lineMatch) {
    target = lineMatch[1]!
    line = Number(lineMatch[2])
  }
  window.dispatchEvent(
    new CustomEvent<OpenMarkdownEventDetail>('rharness:open-markdown', {
      detail: {
        path: target,
        ...(line !== undefined ? { line } : {}),
        ...(anchor ? { anchor } : {}),
      },
    }),
  )
}

export function isMarkdownFilePath(value: string): boolean {
  const s = value.trim()
  if (!s || /^https?:\/\//i.test(s) || /^[a-z]+:/i.test(s) && !/^[a-zA-Z]:[\\/]/.test(s)) return false
  return /^(?:[a-zA-Z]:[\\/]|(?:\.{0,2}[\\/])?[\w.-]+[\\/])?[\w./\\-]*\.md(?::\d+(?:-\d+)?)?(?:#[\w-]+)?$/i.test(s)
}

function renderTextWithMdLinks(text: string): ReactNode[] {
  // Match either `[label](path/to/file.md:line)` or bare file paths ending in `.md` (with optional `:line`)
  const pattern = /\[([^\]]+)\]\(([^)\s]+\.md(?::\d+(?:-\d+)?)?(?:#[^)\s]+)?)\)|(?<![\w/\\.-])((?:[a-zA-Z]:[\\/]|(?:\.{0,2}[\\/])?[\w.-]+[\\/])[\w./\\-]*\.md(?::\d+(?:-\d+)?)?|\b(?:README|SETUP|AGENTS)\.md\b)/gi
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  let keySeq = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(<Fragment key={`t-${keySeq++}`}>{text.slice(lastIndex, match.index)}</Fragment>)
    }
    const mdLinkLabel = match[1]
    const mdLinkTarget = match[2]
    const barePath = match[3]
    const targetPath = (mdLinkTarget ?? barePath ?? '').trim()
    const displayLabel = mdLinkLabel ?? targetPath
    if (targetPath && !/^https?:\/\//i.test(targetPath)) {
      nodes.push(
        <button
          key={`md-${keySeq++}`}
          type="button"
          className="dt-textlink"
          title={`点击在网页阅读器中打开 ${targetPath}`}
          onClick={e => {
            e.preventDefault()
            e.stopPropagation()
            openMarkdownViewer(targetPath)
          }}
        >
          📄 {displayLabel}
        </button>,
      )
    } else {
      nodes.push(<Fragment key={`raw-${keySeq++}`}>{match[0]}</Fragment>)
    }
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    nodes.push(<Fragment key={`tail-${keySeq++}`}>{text.slice(lastIndex)}</Fragment>)
  }
  return nodes.length ? nodes : [<Fragment key="full">{text}</Fragment>]
}

export function headingAnchorId(prefix: string, index: number): string {
  return `${prefix}-heading-${index}`
}

export function Inlines({ parts }: { parts: Inline[] }) {
  return <>{parts.map((part, index) => {
    if (part.kind === 'bold') return <strong key={index}>{part.text}</strong>
    if (part.kind === 'code') {
      if (isMarkdownFilePath(part.text)) {
        return (
          <code key={index} className="dt-code">
            <button
              type="button"
              className="dt-textlink dt-mono"
              title={`点击在网页阅读器中打开 ${part.text}`}
              onClick={e => {
                e.preventDefault()
                e.stopPropagation()
                openMarkdownViewer(part.text)
              }}
            >
              📄 {part.text}
            </button>
          </code>
        )
      }
      return <code key={index} className="dt-code">{part.text}</code>
    }
    if (part.kind === 'link') {
      return <a key={index} className="dt-inline-link" href={part.url} title={part.url} {...external}>{part.text}</a>
    }
    return <Fragment key={index}>{renderTextWithMdLinks(part.text)}</Fragment>
  })}</>
}

export function MarkdownText({ text, idPrefix = 'md' }: { text: string; idPrefix?: string }) {
  return <div className="dt-md">{markdownBlocks(text).map((block, index) => {
    if (block.kind === 'code') {
      return (
        <pre key={index} className="dt-md-pre">
          {block.language && <div className="dt-md-code-lang">{block.language}</div>}
          <code>{block.text}</code>
        </pre>
      )
    }
    if (block.kind === 'heading') {
      const level = Math.min(6, Math.max(1, block.level))
      return createElement(
        `h${Math.min(6, Math.max(2, level))}`,
        { key: index, id: headingAnchorId(idPrefix, index), className: 'dt-md-heading', 'data-level': level },
        <Inlines parts={inlines(block.text)} />,
      )
    }
    if (block.kind === 'blockquote') {
      return (
        <blockquote key={index} className="dt-md-blockquote">
          {block.lines.map((line, lIdx) => (
            <p key={lIdx}><Inlines parts={inlines(line)} /></p>
          ))}
        </blockquote>
      )
    }
    if (block.kind === 'hr') {
      return <hr key={index} className="dt-md-hr" />
    }
    if (block.kind === 'table') {
      return (
        <div key={index} className="dt-md-table-wrap">
          <table className="dt-table dt-md-table">
            <thead>
              <tr>
                {block.headers.map((h, hIdx) => (
                  <th key={hIdx}><Inlines parts={inlines(h)} /></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rIdx) => (
                <tr key={rIdx}>
                  {row.map((cell, cIdx) => (
                    <td key={cIdx}><Inlines parts={inlines(cell)} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    if (block.kind !== 'list') return <p key={index}><Inlines parts={inlines(block.text)} /></p>
    const items = block.items.map((item, at) => <li key={at}><Inlines parts={inlines(item)} /></li>)
    return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>
  })}</div>
}
