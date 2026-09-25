// Reads Claude Code's own session files. Read-only: nothing here writes to ~/.claude.
//
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl                 one transcript per thread
//   ~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/*.jsonl     errands (subagents)
//   ~/.claude/sessions/<pid>.json                                      live CLI processes

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { existsSync } from 'node:fs'

const HOME = os.homedir()
export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude')
const PROJECTS = path.join(CLAUDE_HOME, 'projects')
const LIVE = path.join(CLAUDE_HOME, 'sessions')

const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 128 * 1024
const RUNNING_WINDOW_MS = 2 * 60 * 1000
const LIVE_RUNNING_WINDOW_MS = 15 * 60 * 1000
const WAITING_WINDOW_MS = 24 * 60 * 60 * 1000
const SLEEP_AFTER_MS = 3 * 24 * 60 * 60 * 1000
const ERRAND_WINDOW_MS = 10 * 60 * 1000

export const isSessionId = (v) =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

const cache = new Map() // file -> { mtimeMs, size, parsed }

async function readSlice(file, start, length) {
  const fh = await fs.open(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, start)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

function parseLines(text, dropFirst, dropLast) {
  const lines = text.split('\n')
  if (dropFirst) lines.shift()
  if (dropLast) lines.pop()
  const out = []
  for (const line of lines) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* partial line */ }
  }
  return out
}

const MAX_WINDOW = 8 * 1024 * 1024

/**
 * The first and last stretch of a transcript. A single record can be enormous (a pasted image is
 * hundreds of KB on one line), so each window grows until it holds whole records worth reading.
 */
async function readRecords(file, size) {
  if (size <= HEAD_BYTES + TAIL_BYTES) {
    return { head: parseLines(await readSlice(file, 0, size), false, false), tail: null }
  }
  let head = []
  for (let n = HEAD_BYTES; n <= MAX_WINDOW; n *= 4) {
    head = parseLines(await readSlice(file, 0, Math.min(n, size)), false, n < size)
    if (head.some((r) => r.cwd) || n >= size) break
  }
  let tail = []
  for (let n = TAIL_BYTES; n <= MAX_WINDOW; n *= 4) {
    const len = Math.min(n, size)
    tail = parseLines(await readSlice(file, size - len, len), len < size, false)
    if (tail.filter((r) => r.type === 'user' || r.type === 'assistant').length >= 2 || len >= size) break
  }
  return { head, tail }
}

/** How many transcripts exist at all; used once at start-up to decide on the demo. */
export async function countTranscripts() {
  let n = 0
  try {
    for (const d of await fs.readdir(PROJECTS, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      for (const f of await fs.readdir(path.join(PROJECTS, d.name))) if (f.endsWith('.jsonl')) n++
    }
  } catch { /* no ~/.claude/projects */ }
  return n
}

function firstText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && part.type === 'text' && typeof part.text === 'string') return part.text
    }
  }
  return ''
}

function cleanPrompt(s) {
  return String(s)
    .replace(/<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function describeTool(block) {
  const input = block.input || {}
  const target = input.file_path || input.path || input.pattern || input.command || input.url ||
    input.description || input.query || input.prompt || ''
  const short = typeof target === 'string' ? clip(target.replace(/\s+/g, ' '), 80) : ''
  return short ? `${block.name}: ${short}` : block.name
}

/** Everything the colony wants to know about one transcript. */
function summarise(records) {
  const meta = {
    customTitle: '', aiTitle: '', summary: '', firstPrompt: '', cwd: '', branch: '', model: '',
    startedAt: 0, activity: '', turnEnded: false, errored: false, lastRole: '',
  }
  for (const r of records) {
    if (r.customTitle) meta.customTitle = r.customTitle
    if (r.aiTitle) meta.aiTitle = r.aiTitle
    if (r.type === 'summary' && r.summary) meta.summary = r.summary
    if (!meta.cwd && r.cwd) meta.cwd = r.cwd
    if (r.gitBranch && r.gitBranch !== 'HEAD') meta.branch = r.gitBranch
    if (!meta.startedAt && r.timestamp) {
      const t = Date.parse(r.timestamp)
      if (!Number.isNaN(t)) meta.startedAt = t
    }
    if (r.isSidechain) continue
    if (r.type === 'user' && r.message) {
      const content = r.message.content
      const isToolResult = Array.isArray(content) && content.some((c) => c && c.type === 'tool_result')
      if (!isToolResult) {
        const text = cleanPrompt(firstText(content))
        if (text && !meta.firstPrompt) meta.firstPrompt = text
        if (text && !r.isMeta) meta.activity = `You: ${clip(text, 90)}`
      }
      meta.turnEnded = false
      meta.errored = false
      meta.lastRole = 'user'
    } else if (r.type === 'assistant' && r.message) {
      if (r.message.model && !r.message.model.startsWith('<')) meta.model = r.message.model
      const content = Array.isArray(r.message.content) ? r.message.content : []
      const last = content[content.length - 1]
      const tool = [...content].reverse().find((c) => c && c.type === 'tool_use')
      const text = [...content].reverse().find((c) => c && c.type === 'text' && c.text.trim())
      if (tool) meta.activity = describeTool(tool)
      else if (text) meta.activity = clip(text.text.replace(/\s+/g, ' ').trim(), 110)
      meta.turnEnded = !!last && last.type === 'text' && r.message.stop_reason !== 'tool_use'
      meta.errored = !!r.isApiErrorMessage
      meta.lastRole = 'assistant'
    }
  }
  return meta
}

const roots = new Map()
/** The git checkout a folder belongs to, so a session started in a subfolder joins its repo. */
function repoRoot(dir) {
  if (roots.has(dir)) return roots.get(dir)
  let cur = dir
  let found = dir
  for (let i = 0; i < 40; i++) {
    if (existsSync(path.join(cur, '.git'))) { found = cur; break }
    const up = path.dirname(cur)
    if (up === cur) break
    cur = up
  }
  roots.set(dir, found)
  return found
}

function splitWorktree(cwd) {
  const m = /[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)/.exec(cwd)
  if (!m) return { root: repoRoot(cwd), worktree: '' }
  return { root: cwd.slice(0, m.index), worktree: m[1] }
}

/** Log-scale completion: a 4 KB transcript is a foundation, 4 MB is a finished building. */
export function completion(size) {
  const lo = Math.log(4 * 1024)
  const hi = Math.log(4 * 1024 * 1024)
  return Math.max(0.05, Math.min(1, (Math.log(Math.max(size, 1)) - lo) / (hi - lo)))
}

async function liveSessions() {
  const live = new Map()
  let files = []
  try { files = await fs.readdir(LIVE) } catch { return live }
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const rec = JSON.parse(await fs.readFile(path.join(LIVE, f), 'utf8'))
      if (!rec.sessionId || !rec.pid) continue
      process.kill(rec.pid, 0)
      live.set(rec.sessionId, rec.pid)
    } catch { /* stale or unreadable */ }
  }
  return live
}

async function scanErrands(dir, now) {
  const errands = []
  let files = []
  try { files = await fs.readdir(path.join(dir, 'subagents')) } catch { return errands }
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue
    const file = path.join(dir, 'subagents', f)
    try {
      const st = await fs.stat(file)
      if (now - st.mtimeMs > ERRAND_WINDOW_MS) continue
      const { head } = await readRecords(file, Math.min(st.size, HEAD_BYTES))
      let task = ''
      for (const r of head) {
        if (r.type === 'user' && r.message) { task = cleanPrompt(firstText(r.message.content)); break }
      }
      errands.push({ id: f.replace(/\.jsonl$/, ''), title: clip(task || 'Subagent', 90), updatedAt: st.mtimeMs })
    } catch { /* vanished */ }
  }
  return errands
}

/**
 * Every Claude Code thread on this machine. `viewed` maps thread id -> ms when the user last
 * looked at it here; a finished turn newer than that is "waiting on you".
 */
export async function scanClaude({ viewed = {}, now = Date.now() } = {}) {
  const threads = []
  let dirs = []
  try { dirs = await fs.readdir(PROJECTS, { withFileTypes: true }) } catch { return threads }
  const live = await liveSessions()

  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dir = path.join(PROJECTS, d.name)
    let files = []
    try { files = await fs.readdir(dir) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const sessionId = f.slice(0, -6)
      if (!isSessionId(sessionId)) continue
      const file = path.join(dir, f)
      let st
      try { st = await fs.stat(file) } catch { continue }
      if (!st.size) continue

      let parsed = cache.get(file)
      if (!parsed || parsed.mtimeMs !== st.mtimeMs || parsed.size !== st.size) {
        try {
          const { head, tail } = await readRecords(file, st.size)
          const meta = summarise(tail ? [...head, ...tail] : head)
          // A file larger than the two windows: head gives the title, tail gives the state.
          parsed = { mtimeMs: st.mtimeMs, size: st.size, meta }
          cache.set(file, parsed)
        } catch { continue }
      }
      const meta = parsed.meta
      if (!meta.cwd && !meta.firstPrompt) continue // not a conversation (e.g. a bare snapshot)

      const cwd = meta.cwd || '/' + d.name.replace(/^-/, '').replace(/-/g, '/')
      const { root, worktree } = splitWorktree(cwd)
      const age = now - st.mtimeMs
      const busy = !meta.turnEnded && !!meta.lastRole
      const pid = live.get(sessionId) || 0
      let status
      if (meta.errored) status = 'error'
      else if (busy && (age < RUNNING_WINDOW_MS || (pid && age < LIVE_RUNNING_WINDOW_MS))) status = 'running'
      else if (meta.turnEnded && age < WAITING_WINDOW_MS && st.mtimeMs > (viewed[sessionId] || 0)) status = 'waiting'
      else if (age > SLEEP_AFTER_MS) status = 'sleeping'
      else status = 'idle'

      threads.push({
        id: sessionId,
        repo: root,
        cwd,
        worktree,
        title: clip(meta.customTitle || meta.aiTitle || meta.summary || meta.firstPrompt || 'Untitled thread', 120),
        branch: meta.branch,
        model: meta.model,
        activity: meta.activity,
        status,
        live: !!pid,
        startedAt: meta.startedAt || st.birthtimeMs,
        updatedAt: st.mtimeMs,
        size: st.size,
        pct: completion(st.size),
        errands: status === 'running' ? await scanErrands(path.join(dir, sessionId), now) : [],
        source: 'claude-code',
      })
    }
  }
  return threads
}
