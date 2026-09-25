import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createWorktree, worktreeSummary, removeWorktree, isColonyWorktree } from '../lib/worktrees.mjs'

async function tempRepo() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'colony-')))
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  return { dir, git }
}

test('each task gets its own worktree and branch, hidden from the main checkout', async () => {
  const { dir, git } = await tempRepo()
  const a = await createWorktree(dir, 'Fix the harvest rounding bug')
  const b = await createWorktree(dir, 'Fix the harvest rounding bug')
  assert.notEqual(a.path, b.path)
  assert.match(a.branch, /^colony\/fix-the-harvest-rounding-bug-[0-9a-f]{4}$/)
  assert.ok(isColonyWorktree(dir, a.path))
  assert.equal(git('status', '--porcelain').toString(), '')
})

test('summary counts uncommitted files and commits; removal refuses dirty unless forced, keeps branch', async () => {
  const { dir, git } = await tempRepo()
  const wt = await createWorktree(dir, 'task')
  await fs.writeFile(path.join(wt.path, 'a.txt'), 'hi')
  assert.deepEqual(await worktreeSummary(dir, wt.path), { branch: wt.branch, changed: 1, commits: 0 })
  assert.equal((await removeWorktree(dir, wt.path)).dirty, true)
  assert.equal((await removeWorktree(dir, wt.path, { force: true })).ok, true)
  assert.ok(git('branch', '--list', wt.branch).toString().includes(wt.branch))
})

test('refuses to touch folders outside .claude/worktrees', async () => {
  const { dir } = await tempRepo()
  assert.equal(isColonyWorktree(dir, dir), false)
  assert.equal(isColonyWorktree(dir, path.join(dir, '.claude', 'worktrees', '..', '..')), false)
  assert.equal((await removeWorktree(dir, dir)).ok, false)
})

test('not a git repo: no worktree, caller runs in place', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'colony-plain-'))
  assert.equal(await createWorktree(dir, 'task'), null)
})
