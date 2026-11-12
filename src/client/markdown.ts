/** Lightweight parser for the Markdown subset used in reports and questions, plus plain-text URL linkification; never interprets raw HTML. */

export type Inline = { kind: 'text' | 'bold' | 'code'; text: string } | { kind: 'link'; text: string; url: string }
export type Block =
  | { kind: 'heading'; level: number; text: string; line?: number }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; language?: string; text: string }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'blockquote'; lines: string[] }
  | { kind: 'hr' }

function parseTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map(c => c.trim())
}

function isTableSeparator(line: string | undefined): boolean {
  if (!line || !line.includes('|')) return false
  const cells = parseTableCells(line)
  return cells.length >= 2 && cells.every(c => /^:?-+:?$/.test(c))
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.length > 24 ? `${parsed.pathname.slice(0, 24)}…` : parsed.pathname
    return `${parsed.host}${path === '/' ? '' : path}`
  } catch (error) { void error /* Not a URL after all; show it as written. */; return url }
}
/** Splits plain text into text and bare-URL link nodes, excluding trailing sentence punctuation from URLs. */
export function linkify(text: string): Inline[] {
  return text.split(/(https?:\/\/[^\s)，。]*[^\s)，。.,;:!?'"])/).filter(Boolean).map((part): Inline => /^https?:\/\//.test(part)
    ? { kind: 'link', text: shortUrl(part), url: part } : { kind: 'text', text: part })
}
export function inlines(text: string): Inline[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/).flatMap((part): Inline[] => {
    if (/^\*\*[^*]+\*\*$/.test(part)) return [{ kind: 'bold', text: part.slice(2, -2) }]
    if (/^`[^`]+`$/.test(part)) return [{ kind: 'code', text: part.slice(1, -1) }]
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part)
    return link ? [{ kind: 'link', text: link[1]!, url: link[2]! }] : linkify(part)
  })
}
export function markdownBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let list: Extract<Block, { kind: 'list' }> | undefined
  let quote: Extract<Block, { kind: 'blockquote' }> | undefined
  let code: { language?: string; lines: string[] } | undefined
  const flushCode = () => {
    if (!code) return
    blocks.push({ kind: 'code', ...code.language ? { language: code.language } : {}, text: code.lines.join('\n') })
    code = undefined
  }
  // Always normalize CRLF (`\r\n`) and lone CR (`\r`) to `\n` so regexes using `.` and `$` match Windows files accurately.
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!
    if (code) {
      const end = /^\s*```\s*$/.test(line)
      if (end) flushCode()
      else code.lines.push(line)
      continue
    }
    const fence = /^\s*```\s*([\w-]+)?\s*$/.exec(line)
    if (fence) {
      list = undefined
      quote = undefined
      code = { ...(fence[1] ? { language: fence[1] } : {}), lines: [] }
      continue
    }
    if (line.includes('|') && isTableSeparator(rawLines[i + 1])) {
      list = undefined
      quote = undefined
      const headers = parseTableCells(line)
      const rows: string[][] = []
      i++ // skip separator line
      while (i + 1 < rawLines.length && rawLines[i + 1]!.trim().startsWith('|') && rawLines[i + 1]!.includes('|')) {
        i++
        rows.push(parseTableCells(rawLines[i]!))
      }
      blocks.push({ kind: 'table', headers, rows })
      continue
    }
    const bq = /^\s*>\s?(.*)$/.exec(line)
    if (bq) {
      list = undefined
      if (!quote) blocks.push(quote = { kind: 'blockquote', lines: [] })
      if (bq[1]!.trim()) quote.lines.push(bq[1]!.trim())
      continue
    }
    quote = undefined
    if (/^\s*(?:[-]{3,}|[*]{3,}|[_]{3,})\s*$/.test(line)) {
      list = undefined
      blocks.push({ kind: 'hr' })
      continue
    }
    const item = /^\s*[-*+]\s+(.*)$/.exec(line) ?? /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (item) {
      const ordered = !/^\s*[-*+]/.test(line)
      if (!list || list.ordered !== ordered) blocks.push(list = { kind: 'list', ordered, items: [] })
      list.items.push(item[1]!)
      continue
    }
    list = undefined
    const heading = /^\s*(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line)
    if (line.trim()) {
      blocks.push(
        heading
          ? { kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() }
          : { kind: 'paragraph', text: line },
      )
    }
  }
  flushCode()
  return blocks
}
