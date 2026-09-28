// Launching agents and handing threads back to the user.
//
// A task is one headless run of a tool (see tools.mjs) in its own git worktree. Claude Code runs
// write a transcript under ~/.claude like any other session, so once one has a session id the
// scanner picks it up as an ordinary thread. Runs of other tools are shown from the process itself.

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import path from 'node:path'
import { tool as findTool } from './tools.mjs'

export const ALLOW_BYPASS = process.env.COLONY_ALLOW_BYPASS === '1'
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

/**
 * Start a headless run of `toolId` in `cwd`.
 * `repo` is the repo it belongs to (cwd may be a worktree inside it); `worktree` names that worktree.
 * `resume` continues an existing session, for tools that support it.
 */
export function startTask({ toolId = 'claude-code', repo, cwd, prompt, resume = '', permissionMode = 'acceptEdits', title = '', worktree = null, allowedTools = [], addDirs = [] }) {
  const tool = findTool(toolId)
  if (!tool) throw new Error(`Unknown tool: ${toolId}`)
  if (!tool.permissionModes.includes(permissionMode)) permissionMode = tool.permissionModes[0]
  if (permissionMode === 'bypassPermissions' && !ALLOW_BYPASS) permissionMode = tool.permissionModes[0]

  const id = crypto.randomUUID()
  const task = {
    id,
    tool: tool.id,
    toolName: tool.name,
    repo: repo || cwd,
    cwd,
    worktree: worktree ? path.basename(worktree.path) : '',
    branch: worktree ? worktree.branch : '',
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
    task.updatedAt = Date.now()
  }

  let proc
  try {
    // Tools that read the task from stdin get it there: no quoting, any length, any characters.
    const args = tool.args(prompt, { permissionMode, resume, allowedTools, addDirs })
    proc = spawnTool(tool.bin, args, { cwd, stdio: [tool.promptOnStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: agentEnv() })
    if (tool.promptOnStdin) {
      proc.stdin.on('error', () => {})
      proc.stdin.end(prompt)
    }
  } catch (err) {
    task.status = 'error'
    task.activity = `Could not start ${tool.bin}: ${err.message}`
    push(task.activity)
    return task
  }
  task.proc = proc

  const lines = (stream, fn) => {
    let buf = ''
    stream.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim()) fn(line)
      }
    })
  }
  lines(proc.stdout, (line) => push(tool.parse(line, task)))
  lines(proc.stderr, (line) => {
    push(line.slice(0, 300))
    // Tools that talk on stderr (most of them, for progress) still count as activity.
    if (!tool.watches) task.activity = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim().slice(0, 140) || task.activity
  })
  proc.on('error', (err) => {
    task.status = 'error'
    task.activity = `Could not start ${tool.bin}: ${err.message}`
    push(task.activity)
  })
  proc.on('close', (code) => {
    task.exitCode = code
    task.proc = null
    if (task.status === 'running') task.status = code === 0 ? 'waiting' : 'error'
    task.updatedAt = Date.now()
  })
  return task
}

/**
 * Windows can only start npm-installed CLIs (claude.cmd, codex.cmd) through cmd.exe, and Node
 * hands cmd.exe the arguments unquoted. Quote them ourselves, the way cmd.exe expects.
 */
export function winQuote(arg) {
  const s = String(arg).replace(/\r?\n/g, ' ')
  return /^[\w\-.:/\\=@,]+$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`
}

function spawnTool(bin, args, opts) {
  if (process.platform !== 'win32') return spawn(bin, args, opts)
  return spawn(winQuote(bin), args.map(winQuote), { ...opts, shell: true, windowsHide: true })
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

export function forgetTask(id) {
  const t = tasks.get(id)
  if (t && !t.proc) tasks.delete(id)
}

/** Forget finished tasks after a while; Claude Code ones live on as ordinary threads. */
export function pruneTasks(maxAgeMs = 24 * 60 * 60 * 1000) {
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
    // start "title" /D "folder" cmd.exe /k <command>, passed to cmd.exe exactly as written.
    return trySpawn('cmd.exe', ['/d', '/c', `start "Agent Colony" /D "${cwd}" cmd.exe /k ${command}`], { windowsVerbatimArguments: true })
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
  if (process.platform === 'win32') return trySpawn('cmd.exe', ['/d', '/c', `start "" "${url}"`], { windowsVerbatimArguments: true })
  return trySpawn('xdg-open', [url])
}

export function revealFolder(dir) {
  if (process.platform === 'win32') return trySpawn('explorer.exe', [path.resolve(dir)])
  return openUrl(path.resolve(dir))
}
