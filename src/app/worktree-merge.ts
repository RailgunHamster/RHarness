/**
 * Inspect and merge a Ticket's isolated Git worktree (`$DSH_SUPERAGENT_DIR`) back into the main repository working tree.
 * Because `git worktree` shares the main repository's `.git` object database, commits created inside the Ticket directory
 * are immediately visible to the main repository and can be merged into `main` without copying files or fetching.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface WorktreeCommit {
  sha: string
  subject: string
}

export interface TicketWorktreeStatus {
  available: boolean
  directory: string
  branch: string
  head: string
  baseBranch: string
  baseHead: string
  dirtyFiles: string[]
  aheadCommits: WorktreeCommit[]
  merged: boolean
  autoMerged?: boolean
  lastMergeOutput?: string
  lastMergeError?: string
}

export interface MergeTicketWorktreeOptions {
  title?: string
  commitDirty?: boolean
  push?: boolean
}

export interface MergeTicketWorktreeResult {
  status: TicketWorktreeStatus
  merged: boolean
  output: string
  error?: string
}

const mergeHistory = new Map<string, { autoMerged?: boolean; output?: string; error?: string }>()

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

function readGitState(cwd: string): { branch: string; fullHead: string; shortHead: string; dirtyFiles: string[] } {
  const out = runGit(cwd, ['status', '--porcelain=v2', '--branch'])
  let branch = '(detached)'
  let fullHead = ''
  const dirtyFiles: string[] = []
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('# branch.oid ')) {
      fullHead = line.slice('# branch.oid '.length).trim()
    } else if (line.startsWith('# branch.head ')) {
      const headName = line.slice('# branch.head '.length).trim()
      branch = headName === '(detached)' ? '(detached)' : headName
    } else if (!line.startsWith('#')) {
      dirtyFiles.push(line)
    }
  }
  return { branch, fullHead, shortHead: fullHead.slice(0, 7), dirtyFiles }
}

export function inspectTicketWorktree(repoRoot: string, ticketDir: string | undefined): TicketWorktreeStatus {
  const empty: TicketWorktreeStatus = {
    available: false,
    directory: ticketDir ?? '',
    branch: '',
    head: '',
    baseBranch: '',
    baseHead: '',
    dirtyFiles: [],
    aheadCommits: [],
    merged: true,
  }
  if (!ticketDir || !existsSync(join(ticketDir, '.git')) || !existsSync(join(repoRoot, '.git'))) {
    return empty
  }
  try {
    const key = resolve(ticketDir)
    const history = mergeHistory.get(key)
    const base = readGitState(repoRoot)
    const wt = readGitState(ticketDir)
    const logRaw = base.fullHead ? runGit(ticketDir, ['log', '--format=%h\t%s', `${base.fullHead}..HEAD`]) : ''
    const aheadCommits: WorktreeCommit[] = logRaw
      ? logRaw.split(/\r?\n/).filter(Boolean).map(line => {
          const [sha = '', ...rest] = line.split('\t')
          return { sha, subject: rest.join('\t') }
        })
      : []
    const merged = aheadCommits.length === 0 && wt.dirtyFiles.length === 0
    return {
      available: true,
      directory: ticketDir,
      branch: wt.branch,
      head: wt.shortHead,
      baseBranch: base.branch,
      baseHead: base.shortHead,
      dirtyFiles: wt.dirtyFiles,
      aheadCommits,
      merged,
      ...(history?.autoMerged ? { autoMerged: true } : {}),
      ...(history?.output ? { lastMergeOutput: history.output } : {}),
      ...(!merged && history?.error ? { lastMergeError: history.error } : {}),
    }
  } catch {
    return empty
  }
}

export function mergeTicketWorktree(
  repoRoot: string,
  ticketDir: string | undefined,
  options: MergeTicketWorktreeOptions = {},
): MergeTicketWorktreeResult {
  const initial = inspectTicketWorktree(repoRoot, ticketDir)
  if (!initial.available || !ticketDir) {
    throw new Error('Ticket worktree is not available')
  }
  const key = resolve(ticketDir)
  const logs: string[] = []
  if (initial.dirtyFiles.length > 0 && options.commitDirty !== false) {
    runGit(ticketDir, ['add', '-A'])
    const msg = `feat: ${(options.title ?? 'apply ticket worktree changes').replace(/\r?\n/g, ' ').slice(0, 72)}`
    const commitOut = runGit(ticketDir, ['commit', '-m', msg])
    if (commitOut) logs.push(commitOut)
  }

  const baseFullHead = runGit(repoRoot, ['rev-parse', 'HEAD'])
  const targetFullHead = runGit(ticketDir, ['rev-parse', 'HEAD'])
  const aheadCount = Number(runGit(ticketDir, ['rev-list', '--count', `${baseFullHead}..${targetFullHead}`])) || 0
  if (aheadCount === 0) {
    const status = inspectTicketWorktree(repoRoot, ticketDir)
    return {
      status,
      merged: false,
      output: logs.join('\n') || 'Already up to date with main repository branch.',
    }
  }

  const mergeRef = initial.branch && initial.branch !== '(detached)' ? initial.branch : targetFullHead
  try {
    const mergeOut = runGit(repoRoot, ['merge', '--no-edit', mergeRef])
    if (mergeOut) logs.push(mergeOut)
  } catch (err) {
    try { runGit(repoRoot, ['merge', '--abort']) } catch {}
    const message = err instanceof Error ? err.message : String(err)
    mergeHistory.set(key, { error: message })
    throw new Error(`Merge conflict or dirty main tree when merging ${mergeRef}: ${message}`)
  }

  if (options.push) {
    const pushOut = runGit(repoRoot, ['push'])
    if (pushOut) logs.push(pushOut)
  }

  const output = logs.join('\n') || `Merged ${mergeRef} into ${initial.baseBranch}.`
  mergeHistory.set(key, { autoMerged: true, output })
  return {
    status: inspectTicketWorktree(repoRoot, ticketDir),
    merged: true,
    output,
  }
}

/**
 * Automatically merges a Ticket's worktree into the main repository when a Worker completes its work.
 * If a merge conflict occurs, aborts the merge cleanly so the main repository is never left in a conflicted state,
 * and records the conflict on the worktree status for manual inspection.
 */
export function autoMergeTicketWorktree(
  repoRoot: string,
  ticketDir: string | undefined,
  options: MergeTicketWorktreeOptions = {},
): MergeTicketWorktreeResult | undefined {
  const initial = inspectTicketWorktree(repoRoot, ticketDir)
  if (!initial.available || !ticketDir || initial.merged) {
    return undefined
  }
  try {
    return mergeTicketWorktree(repoRoot, ticketDir, {
      ...options,
      commitDirty: options.commitDirty ?? true,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      status: inspectTicketWorktree(repoRoot, ticketDir),
      merged: false,
      output: '',
      error: message,
    }
  }
}
