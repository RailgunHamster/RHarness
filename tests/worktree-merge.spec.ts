import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { autoMergeTicketWorktree, inspectTicketWorktree, mergeTicketWorktree } from '../src/app/worktree-merge.ts'

function git(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

describe('ticket git worktree inspection and merge', () => {
  it('inspects a ticket worktree branch and auto-merges committed + uncommitted changes into main on completion', () => {
    const root = mkdtempSync(join(tmpdir(), 'rharness-wt-test-'))
    const repoDir = join(root, 'repo')
    const ticketDir = join(root, 'work', '2026-11-07_demo')
    try {
      git(root, ['init', '-b', 'main', repoDir])
      git(repoDir, ['config', 'user.name', 'Test User'])
      git(repoDir, ['config', 'user.email', 'test@example.com'])
      writeFileSync(join(repoDir, 'hello.txt'), 'v1\n', 'utf8')
      git(repoDir, ['add', 'hello.txt'])
      git(repoDir, ['commit', '-m', 'init'])

      git(repoDir, ['worktree', 'add', '-B', 'agent/2026-11-07_demo', ticketDir, 'HEAD'])

      const initial = inspectTicketWorktree(repoDir, ticketDir)
      expect(initial.available).toBe(true)
      expect(initial.branch).toBe('agent/2026-11-07_demo')
      expect(initial.baseBranch).toBe('main')
      expect(initial.merged).toBe(true)
      expect(autoMergeTicketWorktree(repoDir, ticketDir)).toBeUndefined()

      // Make one committed change and one uncommitted change inside the ticket worktree
      writeFileSync(join(ticketDir, 'hello.txt'), 'v2\n', 'utf8')
      git(ticketDir, ['add', 'hello.txt'])
      git(ticketDir, ['commit', '-m', 'feat: update hello to v2'])
      writeFileSync(join(ticketDir, 'extra.txt'), 'extra\n', 'utf8')

      const beforeMerge = inspectTicketWorktree(repoDir, ticketDir)
      expect(beforeMerge.merged).toBe(false)
      expect(beforeMerge.aheadCommits).toHaveLength(1)
      expect(beforeMerge.aheadCommits[0]?.subject).toBe('feat: update hello to v2')
      expect(beforeMerge.dirtyFiles).toHaveLength(1)

      // Auto-merge back into main repo upon ticket completion
      const result = autoMergeTicketWorktree(repoDir, ticketDir, { title: 'Demo ticket' })
      expect(result?.merged).toBe(true)
      expect(result?.status.merged).toBe(true)
      expect(result?.status.autoMerged).toBe(true)
      expect(result?.status.aheadCommits).toHaveLength(0)
      expect(result?.status.dirtyFiles).toHaveLength(0)
      expect(readFileSync(join(repoDir, 'hello.txt'), 'utf8').trim()).toBe('v2')
      expect(readFileSync(join(repoDir, 'extra.txt'), 'utf8').trim()).toBe('extra')

      // Manual merge after auto-merge is a safe no-op
      const second = mergeTicketWorktree(repoDir, ticketDir)
      expect(second.merged).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 45_000)
})
