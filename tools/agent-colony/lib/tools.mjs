// Tool adapters: one entry per coding-agent CLI the colony can drive.
//
// An adapter has two independent halves, and a tool can have either or both:
//
//   launch   how to start a headless run:  args(prompt, opts) -> argv, and parse(line, task) to
//            turn each line of its output into status/activity. Optional resume(sessionId).
//   watch    scan() -> threads, for tools whose own session history we can read from disk.
//            Only Claude Code has this so far; a launched run of any other tool is shown from
//            the process itself for as long as the server is up.
//
// Adding a tool: add an entry here, or without touching code, list it in data/tools.json:
//   [{ "id": "mytool", "name": "My Tool", "command": ["mytool", "run", "{prompt}"] }]

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Is `bin` on PATH? Cheaper and quieter than running it. */
export function onPath(bin) {
  if (!bin) return false
  if (bin.includes('/') || bin.includes('\\')) return fs.existsSync(bin)
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(dir, bin + ext)).isFile()) return true
      } catch { /* not here */ }
    }
  }
  return false
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/** Plain-text output: the latest non-empty line is what it's doing. */
function parseText(line, task) {
  const text = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim()
  if (text) task.activity = clip(text, 140)
  return text
}

// ---------------------------------------------------------------------------------------------
// Claude Code

function summariseClaude(ev) {
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    const parts = []
    for (const c of ev.message.content) {
      if (c.type === 'text' && c.text.trim()) parts.push(c.text.trim())
      if (c.type === 'tool_use') {
        const i = c.input || {}
        const t = i.file_path || i.path || i.command || i.pattern || i.description || ''
        parts.push(`→ ${c.name}${t ? ': ' + String(t).slice(0, 120) : ''}`)
      }
    }
    return parts.join('\n')
  }
  if (ev.type === 'result') return ev.is_error ? `✗ ${ev.result || ev.subtype}` : `✓ Done${ev.result ? ': ' + String(ev.result).slice(0, 300) : ''}`
  if (ev.type === 'system' && ev.subtype === 'init') return `Started in ${ev.cwd || ''} (${ev.model || 'model'})`
  return ''
}

const CLAUDE_BIN = process.env.COLONY_CLAUDE_BIN || 'claude'

const claudeCode = {
  id: 'claude-code',
  name: 'Claude Code',
  bin: CLAUDE_BIN,
  watches: true,
  permissionModes: ['acceptEdits', 'plan', 'default', 'bypassPermissions'],
  promptOnStdin: true,
  args(prompt, { permissionMode, resume, allowedTools = [], addDirs = [] }) {
    const a = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', permissionMode]
    if (resume) a.push('--resume', resume)
    // Commands you allowed for this repo in the colony (headless runs can't ask).
    if (allowedTools.length) a.push('--allowedTools', allowedTools.join(','))
    // Folders outside the worktree the repo's agents work in (granted per repo in the colony).
    for (const d of addDirs) a.push('--add-dir', d)
    return a
  },
  canResume: true,
  parse(line, task) {
    let ev
    try { ev = JSON.parse(line) } catch { return parseText(line, task) }
    if (ev.session_id && !task.sessionId) task.sessionId = ev.session_id
    if (ev.type === 'result') task.status = ev.is_error ? 'error' : 'waiting'
    const text = summariseClaude(ev)
    if (text) task.activity = clip(text.split('\n').pop(), 140)
    return text
  },
  resumeCommand: (id) => `${CLAUDE_BIN} --resume ${id}`,
  version() {
    try {
      const r = spawnSync(CLAUDE_BIN, ['--version'], { timeout: 8000, encoding: 'utf8', shell: process.platform === 'win32' })
      return r.status === 0 ? (r.stdout || '').trim() : ''
    } catch { return '' }
  },
}

// ---------------------------------------------------------------------------------------------
// Other CLIs: launch only. Permission modes are mapped to each tool's nearest equivalent.

const codex = {
  id: 'codex',
  name: 'Codex',
  bin: 'codex',
  permissionModes: ['acceptEdits', 'plan', 'bypassPermissions'],
  args(prompt, { permissionMode }) {
    if (permissionMode === 'plan') return ['exec', '--sandbox', 'read-only', prompt]
    if (permissionMode === 'bypassPermissions') return ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt]
    return ['exec', '--full-auto', prompt] // edits inside the worktree, sandboxed
  },
  parse: parseText,
}

const aider = {
  id: 'aider',
  name: 'Aider',
  bin: 'aider',
  permissionModes: ['acceptEdits', 'plan'],
  args(prompt, { permissionMode }) {
    const a = ['--message', prompt, '--yes-always', '--no-pretty', '--no-stream']
    if (permissionMode === 'plan') a.push('--dry-run')
    return a
  },
  parse: parseText,
}

/** Tools the user listed in data/tools.json. `{prompt}` in the command is replaced by the task. */
function customTools() {
  let list = []
  try { list = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tools.json'), 'utf8')) } catch { return [] }
  if (!Array.isArray(list)) return []
  return list
    .filter((t) => t && typeof t.id === 'string' && Array.isArray(t.command) && t.command.length)
    .map((t) => ({
      id: t.id,
      name: t.name || t.id,
      bin: t.command[0],
      permissionModes: ['acceptEdits'],
      custom: true,
      args: (prompt) => t.command.slice(1).map((a) => String(a).replaceAll('{prompt}', prompt)),
      parse: parseText,
    }))
}

let cached = null
export function tools() {
  if (!cached) {
    cached = [claudeCode, codex, aider, ...customTools()].map((t) => ({ ...t, available: onPath(t.bin) }))
  }
  return cached
}

export function tool(id) {
  return tools().find((t) => t.id === id) || null
}

/** What the browser needs to know about each tool. */
export function describeTools(allowBypass) {
  return tools().map((t) => ({
    id: t.id,
    name: t.name,
    available: t.available,
    watches: !!t.watches,
    canResume: !!t.canResume,
    permissionModes: t.permissionModes.filter((m) => allowBypass || m !== 'bypassPermissions'),
  }))
}
