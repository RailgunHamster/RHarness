import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, join, relative, isAbsolute } from 'node:path'

export interface ReportFile { name: string; sha256: string; bytes: number; validation: string }
const office: Record<string,string> = { '.docx': 'word/document.xml', '.xlsx': 'xl/workbook.xml', '.pptx': 'ppt/presentation.xml' }

function zipMembers(bytes: Buffer): Set<string> {
  const end = bytes.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]))
  if (end < 0 || end + 22 > bytes.length || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) throw new Error('Missing ZIP directory')
  const count = bytes.readUInt16LE(end + 10)
  let offset = bytes.readUInt32LE(end + 16)
  const names = new Set<string>()
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP directory')
    const nameSize = bytes.readUInt16LE(offset + 28)
    const local = bytes.readUInt32LE(offset + 42)
    if (local + 30 >= end || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('Missing ZIP member')
    names.add(bytes.toString('utf8', offset + 46, offset + 46 + nameSize))
    offset += 46 + nameSize + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32)
  }
  if (offset !== end) throw new Error('Truncated ZIP directory')
  return names
}

export function inspectReportFile(name: string, bytes: Buffer): ReportFile {
  if (basename(name) !== name || /[\x00-\x1f\\/:]/.test(name) || !bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('Invalid deliverable file')
  const ext = extname(name).toLowerCase()
  let validation: string
  if (office[ext]) {
    const members = zipMembers(bytes)
    if (!members.has('[Content_Types].xml') || !members.has(office[ext]!)) throw new Error('Missing Office document parts')
    validation = 'Office package structure'
  } else if (ext === '.pdf') {
    if (!bytes.subarray(0,8).toString().startsWith('%PDF-') || !bytes.subarray(-1024).toString().includes('%%EOF')) throw new Error('Invalid PDF envelope')
    validation = 'PDF header and end marker'
  } else if (['.html','.htm','.md','.txt'].includes(ext)) {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (ext.startsWith('.ht') && !/<(?:!doctype\s+html|html)[\s>]/i.test(decoded)) throw new Error('Invalid HTML document')
    validation = ext.startsWith('.ht') ? 'UTF-8 HTML document' : 'UTF-8 text'
  } else throw new Error('Unsupported deliverable type')
  return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), validation }
}

export function collectReportFiles(worktree: string, accept: (metadata: ReportFile, bytes: Buffer) => void) {
  const dir = join(worktree, '.artifacts')
  try { if (!lstatSync(dir).isDirectory() || relative(realpathSync(worktree), realpathSync(dir)) !== '.artifacts') return } catch { return }
  for (const name of readdirSync(dir).sort().slice(0, 100)) {
    const path = join(dir, name)
    try {
      if (!lstatSync(path).isFile()) continue
      const rel = relative(realpathSync(dir), realpathSync(path))
      if (rel.startsWith('..') || isAbsolute(rel) || statSync(path).size > 8 * 1024 * 1024) continue
      const bytes = readFileSync(path)
      const metadata = inspectReportFile(name, bytes)
      accept(metadata, bytes)
    } catch { /* Other worker output stays available in the ticket worktree. */ }
  }
}
