// Launching agents and handing threads back to the user.
//
// A task is a headless `claude -p` process. It writes its own transcript under ~/.claude like any
// other session, so once it has a session id the scanner picks it up as an ordinary thread; until
// then it is shown from here so its bot can walk out of the ship straight away.

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import path from 'node:path'

const CLAUDE_BIN = process.env.COLONY_CLAUDE_BIN || 'claude'
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
const ALLOW_BYPASS = process.env.COLONY_ALLOW_BYPASS === '1'
const LOG_LIMIT = 200

const tasks = new Map()

/**
 * If this server was itself started from inside a Claude Code session, its environment names that
 * session, and a child `claude` would attach to it instead of starting its own. Strip those.
 */
const INHERITED = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_AFTER_LAST_COMPACT|CLAUDE_CODE_(SESSION_ID|CHILD_SESSION|REMOTE_SESSION_ID|ENTRYPOINT|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|WORKER_EPOCH))$/
function agentEnv() {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (!INHERITED.test(k)) env[k] = v
  return env
}

export function claudeAvailable() {
  try {
    const r = spawnSync(CLAUDE_BIN, ['--version'], { timeout: 8000, encoding: 'utf8', shell: process.platform === 'win32' })
    return r.status === 0 ? (r.stdout || '').trim() || 'claude' : ''
  } catch {
    return ''
  }
}

export function permissionModes() {
  return ['acceptEdits', 'plan', 'default', ...(ALLOW_BYPASS ? ['bypassPermissions'] : [])]
}

function summariseEvent(ev) {
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

/** Start a headless agent in `cwd`. `resume` continues an existing session instead. */
export function startTask({ cwd, prompt, resume = '', permissionMode = 'acceptEdits', title = '' }) {
  if (!PERMISSION_MODES.has(permissionMode)) permissionMode = 'acceptEdits'
  if (permissionMode === 'bypassPermissions' && !ALLOW_BYPASS) permissionMode = 'acceptEdits'
  const id = crypto.randomUUID()
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', permissionMode]
  if (resume) args.push('--resume', resume)

  const task = {
    id,
    cwd,
    repo: cwd,
    prompt,
    title: title || prompt.replace(/\s+/g, ' ').slice(0, 100),
    sessionId: resume || '',
    status: 'running',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    log: [],
    activity: 'Starting…',
    exitCode: null,
    proc: null,
  }
  tasks.set(id, task)

  const push = (line) => {
    if (!line) return
    task.log.push({ t: Date.now(), line })
    if (task.log.length > LOG_LIMIT) task.log.shift()
    task.activity = line.split('\n').pop().slice(0, 140)
    task.updatedAt = Date.now()
  }

  let proc
  try {
    proc = spawn(CLAUDE_BIN, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: agentEnv(), shell: process.platform === 'win32' })
  } catch (err) {
    task.status = 'error'
    push(`Could not start claude: ${err.message}`)
    return task
  }
  task.proc = proc

  let buf = ''
  proc.stdout.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line)
        if (ev.session_id && !task.sessionId) task.sessionId = ev.session_id
        if (ev.type === 'result') task.status = ev.is_error ? 'error' : 'waiting'
        push(summariseEvent(ev))
      } catch {
        push(line.slice(0, 300))
      }
    }
  })
  proc.stderr.on('data', (chunk) => push(String(chunk).trim().slice(0, 300)))
  proc.on('error', (err) => {
    task.status = 'error'
    push(`Could not start claude: ${err.message}`)
  })
  proc.on('close', (code) => {
    task.exitCode = code
    task.proc = null
    if (task.status === 'running') task.status = code === 0 ? 'waiting' : 'error'
    task.updatedAt = Date.now()
  })
  return task
}

export function stopTask(id) {
  const task = tasks.get(id)
  if (!task || !task.proc) return false
  task.proc.kill('SIGINT')
  return true
}

export function getTask(id) {
  const t = tasks.get(id)
  return t && publicTask(t)
}

export function publicTask(t) {
  const { proc, ...rest } = t
  return { ...rest, alive: !!proc }
}

export function listTasks() {
  return [...tasks.values()].map(publicTask)
}

/** Forget finished tasks after a while; their transcripts live on as ordinary threads. */
export function pruneTasks(maxAgeMs = 6 * 60 * 60 * 1000) {
  const now = Date.now()
  for (const [id, t] of tasks) if (!t.proc && now - t.updatedAt > maxAgeMs) tasks.delete(id)
}

// ---------------------------------------------------------------------------------------------
// Handing things back to the user's desktop

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const asq = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

function trySpawn(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts })
    } catch {
      return resolve(false)
    }
    child.once('error', () => resolve(false))
    child.once('spawn', () => { child.unref(); resolve(true) })
  })
}

/** Open a terminal in `cwd` running `command`. Resolves to true if something launched. */
export async function openTerminal(cwd, command) {
  if (process.platform === 'darwin') {
    const script = `tell application "Terminal"\n activate\n do script ${asq(`cd ${shq(cwd)} && ${command}`)}\nend tell`
    return trySpawn('osascript', ['-e', script])
  }
  if (process.platform === 'win32') {
    return trySpawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', `cd /d "${cwd}" && ${command}`], { shell: false })
  }
  const inner = `cd ${shq(cwd)} && ${command}; exec bash`
  const candidates = [
    [process.env.TERMINAL, ['-e', 'bash', '-lc', inner]],
    ['x-terminal-emulator', ['-e', 'bash', '-lc', inner]],
    ['gnome-terminal', ['--', 'bash', '-lc', inner]],
    ['konsole', ['-e', 'bash', '-lc', inner]],
    ['xfce4-terminal', ['-x', 'bash', '-lc', inner]],
    ['kitty', ['bash', '-lc', inner]],
    ['alacritty', ['-e', 'bash', '-lc', inner]],
    ['xterm', ['-e', 'bash', '-lc', inner]],
  ]
  for (const [cmd, args] of candidates) {
    if (cmd && (await trySpawn(cmd, args))) return true
  }
  return false
}

export function openUrl(url) {
  if (process.platform === 'darwin') return trySpawn('open', [url])
  if (process.platform === 'win32') return trySpawn('cmd.exe', ['/c', 'start', '""', url])
  return trySpawn('xdg-open', [url])
}

export function revealFolder(dir) {
  return openUrl(path.resolve(dir))
}

export function resumeCommand(sessionId) {
  return `${CLAUDE_BIN} --resume ${sessionId}`
}
