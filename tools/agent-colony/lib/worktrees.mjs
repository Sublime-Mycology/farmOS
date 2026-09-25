// One git worktree per launched agent, so agents working in parallel never share a checkout.
//
//   <repo>/.claude/worktrees/<slug>   on a new branch colony/<slug>, cut from the repo's HEAD
//
// That is the same place Claude Code keeps its own worktrees, so the scanner already files these
// sessions under their repo. The folder is added to .git/info/exclude (local, never committed) so
// it does not show up as untracked in the main checkout.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const run = promisify(execFile)
const git = (cwd, ...args) => run('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 60000 })

export const WORKTREE_DIR = path.join('.claude', 'worktrees')

export async function isGitRepo(dir) {
  try {
    const { stdout } = await git(dir, 'rev-parse', '--is-inside-work-tree')
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

function slugify(text) {
  const words = String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 5).join('-')
  return `${words.slice(0, 32).replace(/-+$/, '') || 'task'}-${crypto.randomBytes(2).toString('hex')}`
}

async function excludeWorktrees(repo) {
  try {
    const { stdout } = await git(repo, 'rev-parse', '--git-common-dir')
    const exclude = path.join(path.resolve(repo, stdout.trim()), 'info', 'exclude')
    let text = ''
    try { text = await fs.readFile(exclude, 'utf8') } catch { /* none yet */ }
    if (!text.split('\n').includes('/.claude/worktrees/')) {
      await fs.mkdir(path.dirname(exclude), { recursive: true })
      await fs.appendFile(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}/.claude/worktrees/\n`)
    }
  } catch { /* cosmetic only */ }
}

/** Create a worktree for a task. Returns { path, branch }, or null if `repo` is not a git repo. */
export async function createWorktree(repo, label) {
  if (!(await isGitRepo(repo))) return null
  const slug = slugify(label)
  const dir = path.join(repo, WORKTREE_DIR, slug)
  const branch = `colony/${slug}`
  await fs.mkdir(path.dirname(dir), { recursive: true })
  await git(repo, 'worktree', 'add', '-b', branch, dir, 'HEAD')
  await excludeWorktrees(repo)
  return { path: dir, branch }
}

/** Is `dir` a worktree this tool (or Claude Code) made inside `repo`? Guards every destructive call. */
export function isColonyWorktree(repo, dir) {
  const base = path.resolve(repo, WORKTREE_DIR) + path.sep
  const target = path.resolve(dir)
  return target.startsWith(base) && !target.slice(base.length).includes(path.sep)
}

/** What an agent has done in its worktree: uncommitted files, and commits since it branched. */
export async function worktreeSummary(repo, dir) {
  if (!isColonyWorktree(repo, dir)) return null
  try {
    const [{ stdout: status }, { stdout: branch }] = await Promise.all([
      git(dir, 'status', '--porcelain'),
      git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    ])
    let commits = 0
    try {
      const { stdout: base } = await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')
      const { stdout } = await git(dir, 'rev-list', '--count', `${base.trim()}..HEAD`)
      commits = Number(stdout.trim()) || 0
    } catch { /* detached main checkout */ }
    return { branch: branch.trim(), changed: status.split('\n').filter(Boolean).length, commits }
  } catch {
    return { missing: true }
  }
}

/**
 * Remove a worktree folder. The branch is kept, so anything committed survives. Refuses when
 * there are uncommitted changes unless `force`.
 */
export async function removeWorktree(repo, dir, { force = false } = {}) {
  if (!isColonyWorktree(repo, dir)) return { ok: false, error: 'Not a colony worktree' }
  try {
    await git(repo, 'worktree', 'remove', ...(force ? ['--force'] : []), dir)
    return { ok: true }
  } catch (err) {
    const msg = String(err.stderr || err.message)
    if (/modified or untracked|contains modified/.test(msg)) return { ok: false, dirty: true, error: 'It has uncommitted changes.' }
    if (/is not a working tree/.test(msg)) {
      await git(repo, 'worktree', 'prune').catch(() => {})
      return { ok: true }
    }
    return { ok: false, error: msg.trim().split('\n').pop() }
  }
}
