#!/usr/bin/env node
// Agent Colony: a local server that turns Claude Code threads into a colony you can watch.
// Zero dependencies beyond Node itself; `three` is only served to the browser.
//
//   node server.mjs [--demo] [--port 5274] [--host 127.0.0.1]

import http from 'node:http'
import fs from 'node:fs/promises'
import { existsSync, createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

import { scanClaude, completion, isSessionId, countTranscripts } from './lib/scan.mjs'
import { layout, tilesNeeded } from './lib/hex.mjs'
import { demoThreads } from './lib/demo.mjs'
import {
  ALLOW_BYPASS, startTask, stopTask, getTask, listTasks, pruneTasks, forgetTask,
  openTerminal, openUrl, revealFolder,
} from './lib/agents.mjs'
import { tool, describeTools } from './lib/tools.mjs'
import { createWorktree, removeWorktree, worktreeSummary, isColonyWorktree } from './lib/worktrees.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(ROOT, 'public')
const THREE = path.join(ROOT, 'node_modules', 'three')
const QRCODE = path.join(ROOT, 'node_modules', 'qrcode-generator')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const PORT = Number(opt('port', process.env.PORT || 5274))
// --phone: also answer on the home network, for a phone on the same Wi-Fi (or Tailscale). Anyone
// there needs the secret key from the link the colony shows, so the network alone isn't enough.
const PHONE = flag('phone') || process.env.COLONY_PHONE === '1'
const HOST = opt('host', process.env.HOST || (PHONE ? '0.0.0.0' : '127.0.0.1'))
let DEMO = flag('demo') || process.env.COLONY_DEMO === '1'
if (!DEMO && !flag('no-auto-demo') && (await countTranscripts()) === 0) {
  DEMO = true
  console.log('No Claude Code sessions found in ~/.claude yet — showing the demo colony instead.')
}
// The demo keeps its own map so its made-up repos never reserve ground in the real one.
const STATE_FILE = path.join(ROOT, 'data', DEMO ? 'colony-demo.json' : 'colony.json')

const PALETTE = ['#f2c94c', '#3d7bf2', '#2bb3a3', '#d9895b', '#9b6bf2', '#ef6f8a', '#6bcf5b', '#56c2f0']

// ---------------------------------------------------------------------------------------------
// Persistent state: the map, and what the user has archived or looked at.

let state = { zones: {}, colors: {}, archived: {}, viewed: {}, pinned: [], allowed: {} }
try {
  state = { ...state, ...JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) }
} catch { /* first run */ }

let saveTimer = null
function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true })
    const tmp = STATE_FILE + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(state, null, 2))
    await fs.rename(tmp, STATE_FILE)
  }, 300)
}

const CLAUDE_VERSION = DEMO ? '' : tool('claude-code').version()

// ---------------------------------------------------------------------------------------------
// Demo tasks: pretend agents, so the launcher can be tried without spending anything.

const demoTasks = new Map()
function startDemoTask({ repo, prompt, toolId = 'claude-code', worktree = true, title = '' }) {
  const id = crypto.randomUUID()
  const t = {
    id, cwd: repo, repo, prompt, title: title || prompt.slice(0, 100), sessionId: '', status: 'running',
    tool: toolId, toolName: tool(toolId)?.name || toolId,
    worktree: worktree ? `demo-${id.slice(0, 4)}` : '', branch: worktree ? `colony/demo-${id.slice(0, 4)}` : '',
    startedAt: Date.now(), updatedAt: Date.now(), activity: 'Reading the codebase…', alive: true,
    log: [{ t: Date.now(), line: `Started (demo) in ${repo}` }],
  }
  demoTasks.set(id, t)
  const steps = ['Grep: related code', 'Read: src/…', 'Edit: src/…', 'Bash: npm test', '✓ Done (demo)']
  steps.forEach((s, i) => setTimeout(() => {
    t.activity = s
    t.updatedAt = Date.now()
    t.log.push({ t: Date.now(), line: s })
    if (i === steps.length - 1) { t.status = 'waiting'; t.alive = false }
  }, (i + 1) * 9000))
  return t
}

// ---------------------------------------------------------------------------------------------
// The colony: threads grouped into repos, repos laid out on hex tiles.

async function buildColony() {
  pruneTasks()
  const now = Date.now()
  let threads = DEMO
    ? demoThreads({ viewed: state.viewed, completion })
    : await scanClaude({ viewed: state.viewed, now })
  for (const t of threads) {
    t.tool = 'claude-code'
    t.toolName = 'Claude Code'
  }

  // Launched tasks: fold live process state into their threads, or stand in until they have one.
  const tasks = DEMO ? [...demoTasks.values()] : listTasks()
  const byId = new Map(threads.map((t) => [t.id, t]))
  for (const task of tasks) {
    const thread = task.sessionId && byId.get(task.sessionId)
    if (thread) {
      thread.taskId = task.id
      if (task.alive) {
        thread.status = 'running'
        thread.activity = task.activity || thread.activity
      } else if (task.status === 'error') {
        thread.status = 'error'
      }
    } else if (task.alive || !tool(task.tool)?.watches || now - task.updatedAt < 60000) {
      // Tools we cannot read the history of are shown from the task for as long as we have it.
      threads.push({
        id: task.sessionId || `task-${task.id}`,
        taskId: task.id,
        tool: task.tool,
        toolName: task.toolName,
        repo: task.repo,
        cwd: task.cwd,
        worktree: task.worktree,
        title: task.title,
        branch: task.branch,
        model: '',
        activity: task.activity,
        reply: (task.log || []).slice(-12).map((l) => l.line).join('\n').slice(-6000),
        status: task.alive ? 'running' : task.status,
        live: task.alive,
        startedAt: task.startedAt,
        updatedAt: task.updatedAt,
        size: 1,
        pct: 0.05,
        errands: [],
        source: 'task',
      })
    }
  }

  // Archive: hidden until the thread does something newer than the moment it was archived.
  const archivedCount = threads.filter((t) => state.archived[t.id] && t.updatedAt <= state.archived[t.id] + 5000).length
  threads = threads.filter((t) => !(state.archived[t.id] && t.updatedAt <= state.archived[t.id] + 5000))

  const repos = new Map()
  // Repos you added by hand get a plot even before anything has run in them.
  for (const dir of state.pinned || []) repos.set(dir, [])
  for (const t of threads) {
    if (!repos.has(t.repo)) repos.set(t.repo, [])
    repos.get(t.repo).push(t)
  }

  const wants = {}
  for (const [repo, list] of repos) wants[repo] = tilesNeeded(list.length)
  const zones = layout(state.zones, wants)
  if (JSON.stringify(zones) !== JSON.stringify(state.zones)) {
    state.zones = zones
    save()
  }

  const used = new Set(Object.values(state.colors))
  for (const repo of repos.keys()) {
    if (state.colors[repo]) continue
    const color = PALETTE.find((c) => !used.has(c)) || PALETTE[Object.keys(state.colors).length % PALETTE.length]
    state.colors[repo] = color
    used.add(color)
    save()
  }

  const rank = { error: 0, waiting: 1, running: 2, idle: 3, sleeping: 4 }
  const out = []
  for (const [repo, list] of repos) {
    list.sort((a, b) => a.startedAt - b.startedAt)
    out.push({
      key: repo,
      name: path.basename(repo) || repo,
      path: repo,
      color: state.colors[repo],
      tiles: zones[repo],
      threads: list.slice().sort((a, b) => rank[a.status] - rank[b.status] || b.updatedAt - a.updatedAt),
      // Stable slot order for buildings: oldest thread gets the first plot.
      slots: list.map((t) => t.id),
      allowedTools: state.allowed?.[repo] || [],
      suggestedTools: DEMO ? [] : (await suggestedTools(repo)).filter((x) => !(state.allowed?.[repo] || []).includes(x)),
      prompts: DEMO ? [] : await repoPrompts(repo),
      allowedDirs: state.allowedDirs?.[repo] || [],
      suggestedDirs: DEMO ? [] : (await repoDirs(repo)).filter((x) => !(state.allowedDirs?.[repo] || []).includes(x)),
      schedules: DEMO ? [] : (await repoSchedules(repo)).map((x) => {
        const mine = scheduleState(repo, x.id)
        return { ...x, enabled: !!mine.enabled, lastRun: mine.lastRun || 0, lastResult: mine.lastResult || '' }
      }),
      pages: DEMO ? [] : await repoPages(repo),
      tag: repoTag(repo),
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return { now, demo: DEMO, claude: CLAUDE_VERSION, tools: describeTools(ALLOW_BYPASS || DEMO), archivedCount, repos: out }
}

/**
 * Commands a repo's own .claude/settings.json asks to allow. Claude Code ignores these in folders
 * you haven't trusted (and every worktree is a new folder), so the colony shows them and applies
 * them only once you press Allow for that repo.
 */
const RULE = /^[A-Za-z]+(\([^()]{1,200}\))?$/
async function suggestedTools(repo) {
  try {
    const s = JSON.parse(await fs.readFile(path.join(repo, '.claude', 'settings.json'), 'utf8'))
    const allow = s?.permissions?.allow
    return Array.isArray(allow) ? allow.filter((x) => typeof x === 'string' && RULE.test(x)).slice(0, 20) : []
  } catch {
    return []
  }
}

/** Start one agent in a repo: the one path used by the composer, dispatch and the scheduler. */
async function launchTask({ repoPath, prompt, toolId = 'claude-code', permissionMode = 'acceptEdits', worktree: wantWorktree = true }) {
  const repo = knownRepo(repoPath)
  if (!repo) return { code: 400, error: 'Unknown repo' }
  if (!existsSync(repo.path) && !DEMO) return { code: 400, error: `Folder not found: ${repo.path}` }
  prompt = String(prompt || '').trim()
  if (!prompt) return { code: 400, error: 'Tell the agent what to do' }
  const t = tool(String(toolId || 'claude-code'))
  if (!t) return { code: 400, error: `Unknown tool: ${toolId}` }
  if (DEMO) {
    const task = startDemoTask({ repo: repo.path, prompt, toolId: t.id, worktree: wantWorktree })
    return { ok: true, taskId: task.id }
  }
  if (!t.available) return { code: 400, error: `${t.name} (${t.bin}) was not found on PATH` }
  let worktree = null
  let note = ''
  if (wantWorktree) {
    try {
      worktree = await createWorktree(repo.path, prompt)
      if (!worktree) note = 'Not a git repo, so this agent is working in the folder itself.'
    } catch (err) {
      return { code: 500, error: `Could not create a worktree: ${String(err.stderr || err.message).trim()}` }
    }
  }
  const task = startTask({
    toolId: t.id, repo: repo.path, cwd: worktree ? worktree.path : repo.path, prompt, worktree,
    permissionMode, allowedTools: state.allowed?.[repo.path] || [], addDirs: state.allowedDirs?.[repo.path] || [],
  })
  return { ok: true, taskId: task.id, worktree, note }
}

// ---------------------------------------------------------------------------------------------
// Schedules: a repo lists recurring prompts in .colony/schedule.json. Each is off until switched on
// in the colony, and runs while the colony is running (a missed time runs once when it next starts
// that day).

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

async function repoSchedules(repo) {
  try {
    const list = JSON.parse(await fs.readFile(path.join(repo, '.colony', 'schedule.json'), 'utf8'))
    return (Array.isArray(list) ? list : [])
      .filter((x) => x && /^[\w-]{1,40}$/.test(x.id || '') && typeof x.prompt === 'string' && /^\d{1,2}:\d{2}$/.test(x.at || ''))
      .slice(0, 12)
      .map((x) => ({ id: x.id, label: String(x.label || x.id).slice(0, 40), prompt: x.prompt.slice(0, 2000),
        at: x.at, days: String(x.days || 'daily').toLowerCase() }))
  } catch {
    return []
  }
}

function scheduleState(repoPath, id) {
  state.schedules = state.schedules || {}
  state.schedules[repoPath] = state.schedules[repoPath] || {}
  return (state.schedules[repoPath][id] = state.schedules[repoPath][id] || { enabled: false, lastRun: 0 })
}

function runsOn(days, date) {
  const d = DAY_NAMES[date.getDay()]
  if (days === 'daily') return true
  if (days === 'weekdays') return d !== 'sat' && d !== 'sun'
  return days.split(/[\s,]+/).includes(d)
}

/** The most recent time this schedule should have run, or 0 if not yet today. */
function dueTime(entry, now = new Date()) {
  const [h, m] = entry.at.split(':').map(Number)
  const t = new Date(now)
  t.setHours(h, m, 0, 0)
  return runsOn(entry.days, now) && t <= now ? t.getTime() : 0
}

async function runSchedule(repoPath, entry) {
  const mine = scheduleState(repoPath, entry.id)
  const running = mine.taskId && listTasks().some((t) => t.id === mine.taskId && t.alive)
  if (running) return { code: 409, error: 'The last run is still going' }
  mine.lastRun = Date.now()
  const r = await launchTask({ repoPath, prompt: entry.prompt })
  if (r.ok) mine.taskId = r.taskId
  mine.lastResult = r.ok ? 'started' : r.error
  save()
  return r
}

async function tickSchedules() {
  if (DEMO || !lastColony) return
  for (const repo of lastColony.repos) {
    for (const entry of repo.schedules || []) {
      const mine = scheduleState(repo.path, entry.id)
      const due = dueTime(entry)
      if (mine.enabled && due && mine.lastRun < due) {
        console.log(`schedule: running "${entry.label}" in ${repo.name}`)
        await runSchedule(repo.path, entry)
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Pages: folders a repo lets you browse from the colony (e.g. Clip Factory's review pages), so they
// work from a phone too. Declared in .colony/pages.json; nothing outside those folders is served.

const repoTag = (p) => crypto.createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 10)

/** A folder named in a repo's .colony files: {env, default, sub} or {dir}. "~" is the home folder. */
function resolveRepoDir(repo, x) {
  let base = (x.env && process.env[x.env]) || x.default || x.dir || ''
  base = base.replace(/^~(?=$|[\\/])/, os.homedir())
  return path.resolve(repo, base, x.sub || '')
}

/** Extra folders a repo's agents need to read and write (.colony/dirs.json), granted with Allow. */
async function repoDirs(repo) {
  try {
    const list = JSON.parse(await fs.readFile(path.join(repo, '.colony', 'dirs.json'), 'utf8'))
    return (Array.isArray(list) ? list : []).filter((x) => x && typeof x === 'object').slice(0, 4).map((x) => resolveRepoDir(repo, x))
  } catch {
    return []
  }
}

async function repoPages(repo) {
  try {
    const list = JSON.parse(await fs.readFile(path.join(repo, '.colony', 'pages.json'), 'utf8'))
    return (Array.isArray(list) ? list : []).filter((x) => x && typeof x.label === 'string').slice(0, 8)
      .map((x) => ({ label: x.label.slice(0, 40), dir: resolveRepoDir(repo, x) }))
  } catch {
    return []
  }
}

async function servePage(req, res, base, rel, prefix) {
  const file = path.resolve(base, '.' + path.posix.normalize('/' + rel))
  if (!file.startsWith(base + path.sep) && file !== base) return send(res, 404, { error: 'not found' })
  let st
  try { st = await fs.stat(file) } catch { return send(res, 404, 'Nothing here yet.', 'text/plain; charset=utf-8') }
  if (st.isDirectory()) {
    if (!req.url.split('?')[0].endsWith('/')) {
      res.writeHead(302, { location: req.url.split('?')[0] + '/' })
      return res.end()
    }
    if (existsSync(path.join(file, 'index.html'))) return servePage(req, res, base, path.posix.join(rel, 'index.html'), prefix)
    const items = (await fs.readdir(file, { withFileTypes: true }))
      .filter((d) => !d.name.startsWith('.'))
      .sort((a, b) => (b.isDirectory() - a.isDirectory()) || b.name.localeCompare(a.name))
    const esc = (x) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const rows = items.map((d) => `<li><a href="${encodeURIComponent(d.name)}${d.isDirectory() ? '/' : ''}">${esc(d.name)}${d.isDirectory() ? '/' : ''}</a></li>`).join('')
    return send(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>body{font:16px system-ui;background:#1d2419;color:#e8eee2;padding:20px}a{color:#9fd18b;line-height:2}</style>
<h2>${esc(path.basename(file))}</h2><ul>${rows || '<li>Empty</li>'}</ul>`, 'text/html; charset=utf-8')
  }
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'
  // Videos need byte ranges, or phones (Safari especially) refuse to play them.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  if (range) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1
    if (!range[1] && !range[2]) { start = 0; end = st.size - 1 }
    if (start >= st.size || start < 0 || end < start) {
      res.writeHead(416, { 'content-range': `bytes */${st.size}` })
      return res.end()
    }
    end = Math.min(end, st.size - 1)
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${st.size}`,
      'accept-ranges': 'bytes', 'content-length': end - start + 1, 'cache-control': 'no-store' })
    return createReadStream(file, { start, end }).pipe(res)
  }
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' })
  createReadStream(file).pipe(res)
}

/** Ready-made prompts a repo offers in its .colony/prompts.json: [{ label, prompt }]. */
async function repoPrompts(repo) {
  try {
    const list = JSON.parse(await fs.readFile(path.join(repo, '.colony', 'prompts.json'), 'utf8'))
    return (Array.isArray(list) ? list : [])
      .filter((x) => x && typeof x.label === 'string' && typeof x.prompt === 'string')
      .slice(0, 12)
      .map((x) => ({ label: x.label.slice(0, 40), prompt: x.prompt.slice(0, 2000) }))
  } catch {
    return []
  }
}

let lastColony = null
async function colony() {
  lastColony = await buildColony()
  return lastColony
}

function findThread(id) {
  for (const repo of lastColony?.repos || []) {
    const t = repo.threads.find((x) => x.id === id)
    if (t) return t
  }
  return null
}

// Compare folders the way the OS does: git on Windows reports C:/Users/..., Node C:\\Users\\...
const samePath = (a, b) => {
  const norm = (x) => (process.platform === 'win32' ? path.resolve(x).toLowerCase() : path.resolve(x))
  return norm(a) === norm(b)
}
function knownRepo(p) {
  if (!p) return null
  return (lastColony?.repos || []).find((r) => samePath(r.path, String(p))) || null
}

// ---------------------------------------------------------------------------------------------
// HTTP

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

async function readJson(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 64 * 1024) throw new Error('too large')
  }
  return body ? JSON.parse(body) : {}
}

async function serveFile(res, base, rel) {
  const file = path.resolve(base, '.' + path.posix.normalize('/' + rel))
  if (!file.startsWith(base + path.sep) && file !== base) return send(res, 404, { error: 'not found' })
  try {
    const data = await fs.readFile(file)
    send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream')
  } catch {
    send(res, 404, { error: 'not found' })
  }
}

// Only answer our own page: blocks DNS rebinding and other sites posting to localhost.
let PHONE_KEY = ''
if (PHONE) {
  const keyFile = path.join(ROOT, 'data', 'phone-key.txt')
  try { PHONE_KEY = (await fs.readFile(keyFile, 'utf8')).trim() } catch { /* first time */ }
  if (!/^[0-9a-f]{32}$/.test(PHONE_KEY)) {
    PHONE_KEY = crypto.randomBytes(16).toString('hex')
    await fs.mkdir(path.dirname(keyFile), { recursive: true })
    await fs.writeFile(keyFile, PHONE_KEY)
  }
}

const isLocalHost = (req) => ['localhost', '127.0.0.1', '[::1]'].includes((req.headers.host || '').replace(/:\d+$/, ''))

function hasPhoneKey(req) {
  if (!PHONE) return false
  const m = /(?:^|;\s*)colony_key=([0-9a-f]{32})/.exec(req.headers.cookie || '')
  return !!m && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(PHONE_KEY))
}

// Only our own page may drive this: requests must be addressed to localhost (blocks DNS rebinding),
// or carry the phone key. Changes also need a custom header, which other sites can't send.
function allowed(req) {
  if (!isLocalHost(req) && !hasPhoneKey(req)) return false
  if (req.method !== 'GET' && req.headers['x-colony'] !== '1') return false
  return true
}

/** Addresses a phone can use to reach this computer: home network first, then Tailscale. */
function phoneUrls() {
  const urls = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue
      if (a.internal) continue
      const kind = /^100\./.test(a.address) ? 'Tailscale (works away from home)' : 'Home Wi-Fi'
      urls.push({ kind, url: `http://${a.address}:${PORT}/?key=${PHONE_KEY}` })
    }
  }
  return urls.sort((x, y) => (x.kind > y.kind ? 1 : -1))
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local')
    const p = url.pathname
    // Arriving from the phone link: swap the key in the address for a cookie, then load the page.
    const key = url.searchParams.get('key')
    if (PHONE && key && req.method === 'GET' && key.length === 32 &&
        crypto.timingSafeEqual(Buffer.from(key), Buffer.from(PHONE_KEY))) {
      res.writeHead(302, {
        location: '/',
        'set-cookie': `colony_key=${PHONE_KEY}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`,
        'cache-control': 'no-store',
      })
      return res.end()
    }
    if (!allowed(req)) {
      if (req.method === 'GET' && !p.startsWith('/api/')) {
        return send(res, 403, '<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;padding:24px">' +
          '<h2>Agent Colony</h2><p>Open the link or QR code from the colony on your computer: ⚙ Settings → <b>Open on your phone</b>.</p>', 'text/html; charset=utf-8')
      }
      return send(res, 403, { error: 'forbidden' })
    }

    if (req.method === 'GET' && p === '/api/phone') {
      // The link contains the key, so only the computer itself may ask for it.
      if (!isLocalHost(req)) return send(res, 403, { error: 'forbidden' })
      return send(res, 200, { enabled: PHONE, urls: PHONE ? phoneUrls() : [] })
    }

    if (req.method === 'GET' && p === '/api/state') return send(res, 200, await colony())
    if (req.method === 'POST' && !lastColony) await colony()

    if (req.method === 'GET' && p.startsWith('/api/tasks/')) {
      const id = p.split('/')[3]
      const t = DEMO ? demoTasks.get(id) : getTask(id)
      return t ? send(res, 200, t) : send(res, 404, { error: 'no such task' })
    }

    if (req.method === 'POST' && p === '/api/tasks') {
      const body = await readJson(req)
      const r = await launchTask({
        repoPath: body.repo, prompt: body.prompt, toolId: body.tool, permissionMode: body.permissionMode,
        worktree: body.worktree !== false,
      })
      return send(res, r.code || 200, r)
    }

    if (req.method === 'POST' && (p === '/api/repos/schedule' || p === '/api/repos/schedule/run')) {
      const body = await readJson(req)
      const repo = knownRepo(body.repo)
      const entry = repo?.schedules?.find((x) => x.id === body.id)
      if (!repo || !entry) return send(res, 400, { error: 'Unknown schedule' })
      const mine = scheduleState(repo.path, entry.id)
      if (p.endsWith('/run')) {
        const r = await runSchedule(repo.path, entry)
        return send(res, r.code || 200, r)
      }
      mine.enabled = !!body.enabled
      save()
      await colony()
      return send(res, 200, { ok: true, enabled: mine.enabled })
    }

    const pm = /^\/pages\/([0-9a-f]{10})\/(\d+)(\/.*)?$/.exec(p)
    if (req.method === 'GET' && pm) {
      const repo = (lastColony?.repos || []).find((r) => repoTag(r.path) === pm[1])
      const page = repo?.pages?.[Number(pm[2])]
      if (!page) return send(res, 404, { error: 'not found' })
      return servePage(req, res, page.dir, decodeURIComponent(pm[3] || '/'), `/pages/${pm[1]}/${pm[2]}`)
    }

    const tm = /^\/api\/tasks\/([\w-]+)\/stop$/.exec(p)
    if (req.method === 'POST' && tm) return send(res, 200, { ok: stopTask(tm[1]) })

    const wm = /^\/api\/threads\/([\w-]+)\/worktree$/.exec(p)
    if (req.method === 'GET' && wm) {
      const thread = findThread(wm[1])
      if (!thread || !thread.worktree) return send(res, 200, null)
      if (DEMO) return send(res, 200, { branch: thread.branch, changed: 3, commits: 1 })
      return send(res, 200, await worktreeSummary(thread.repo, thread.cwd))
    }

    const m = /^\/api\/threads\/([\w-]+)\/(open|archive|unarchive|viewed|reply|remove-worktree)$/.exec(p)
    if (req.method === 'POST' && m) {
      const [, id, action] = m
      const thread = findThread(id)
      if (action === 'unarchive') {
        delete state.archived[id]
        save()
        return send(res, 200, { ok: true })
      }
      if (!thread) return send(res, 404, { error: 'Unknown thread' })
      if (action === 'archive') {
        state.archived[id] = Date.now()
        if (thread.taskId && !thread.id.match(/^[0-9a-f]{8}-/)) forgetTask(thread.taskId)
        save()
        return send(res, 200, { ok: true })
      }
      if (action === 'remove-worktree') {
        const body = await readJson(req)
        if (thread.status === 'running') return send(res, 409, { error: 'That agent is still working in it' })
        if (DEMO) {
          state.archived[id] = Date.now()
          save()
          return send(res, 200, { ok: true })
        }
        if (!isColonyWorktree(thread.repo, thread.cwd)) return send(res, 400, { error: 'This thread is not in a colony worktree' })
        const r = await removeWorktree(thread.repo, thread.cwd, { force: !!body.force })
        if (r.ok) {
          state.archived[id] = Date.now()
          if (thread.taskId) forgetTask(thread.taskId)
          save()
        }
        return send(res, r.ok ? 200 : 409, r)
      }
      if (action === 'viewed') {
        state.viewed[id] = Date.now()
        save()
        return send(res, 200, { ok: true })
      }
      const t = tool(thread.tool) || tool('claude-code')
      if (action === 'open' && !(t.resumeCommand && isSessionId(id))) {
        // No session to resume (another tool, or not started yet): open a terminal in its folder.
        const body = await readJson(req)
        const command = 'git status'
        if (DEMO || body.mode === 'copy' || !existsSync(thread.cwd)) return send(res, 200, { ok: false, command, cwd: thread.cwd, demo: DEMO })
        return send(res, 200, { ok: await openTerminal(thread.cwd, command), command, cwd: thread.cwd })
      }
      if (!isSessionId(id)) return send(res, 400, { error: 'This thread has no session yet' })
      if (action === 'open') {
        const body = await readJson(req)
        state.viewed[id] = Date.now()
        save()
        const command = t.resumeCommand(id)
        if (DEMO) return send(res, 200, { ok: false, command, cwd: thread.cwd, demo: true })
        let ok = false
        if (body.mode === 'app') ok = await openUrl(`claude://resume?session=${id}`)
        else if (body.mode !== 'copy') ok = existsSync(thread.cwd) && (await openTerminal(thread.cwd, command))
        return send(res, 200, { ok, command, cwd: thread.cwd })
      }
      if (action === 'reply') {
        const body = await readJson(req)
        const prompt = String(body.prompt || '').trim()
        if (!prompt) return send(res, 400, { error: 'Empty message' })
        if (thread.status === 'running' && thread.taskId) return send(res, 409, { error: 'That agent is still working' })
        if (DEMO) {
          const dt = startDemoTask({ repo: thread.repo, prompt, title: thread.title, worktree: false })
          return send(res, 200, { ok: true, taskId: dt.id })
        }
        if (!t.canResume || !t.available) return send(res, 400, { error: `${t.name} cannot take follow-ups here` })
        state.viewed[id] = Date.now()
        save()
        const task = startTask({
          toolId: t.id, repo: thread.repo, cwd: thread.cwd, prompt, resume: id, permissionMode: body.permissionMode, title: thread.title,
          worktree: thread.worktree ? { path: thread.cwd, branch: thread.branch } : null,
          allowedTools: state.allowed?.[thread.repo] || [], addDirs: state.allowedDirs?.[thread.repo] || [],
        })
        return send(res, 200, { ok: true, taskId: task.id })
      }
    }

    if (req.method === 'POST' && (p === '/api/repos/add' || p === '/api/repos/unpin')) {
      const body = await readJson(req)
      const dir = path.resolve(String(body.path || '').replace(/^~(?=$|[\\/])/, os.homedir()))
      if (p === '/api/repos/unpin') {
        state.pinned = (state.pinned || []).filter((x) => x !== dir)
      } else {
        let st = null
        try { st = await fs.stat(dir) } catch { /* missing */ }
        if (!st || !st.isDirectory()) return send(res, 400, { error: `No such folder: ${dir}` })
        state.pinned = [...new Set([...(state.pinned || []), dir])]
      }
      save()
      await colony()
      return send(res, 200, { ok: true, path: dir })
    }

    if (req.method === 'POST' && p === '/api/repos/allow') {
      const body = await readJson(req)
      const repo = knownRepo(body.repo)
      if (!repo) return send(res, 400, { error: 'Unknown repo' })
      const tools = Array.isArray(body.tools) ? body.tools.filter((x) => typeof x === 'string' && RULE.test(x)) : []
      if (!state.allowed) state.allowed = {}
      if (tools.length) state.allowed[repo.path] = [...new Set(tools)]
      else delete state.allowed[repo.path]
      // Folders: only ones the repo itself declares can be granted.
      const declared = await repoDirs(repo.path)
      const dirs = Array.isArray(body.dirs) ? body.dirs.filter((d) => declared.includes(d)) : []
      if (!state.allowedDirs) state.allowedDirs = {}
      if (dirs.length) state.allowedDirs[repo.path] = [...new Set(dirs)]
      else delete state.allowedDirs[repo.path]
      save()
      await colony()
      return send(res, 200, { ok: true, tools: state.allowed[repo.path] || [] })
    }

    if (req.method === 'POST' && p === '/api/repos/reveal') {
      const body = await readJson(req)
      const repo = knownRepo(body.repo)
      if (!repo) return send(res, 400, { error: 'Unknown repo' })
      const ok = !DEMO && existsSync(repo.path) && (await revealFolder(repo.path))
      return send(res, 200, { ok })
    }

    if (req.method === 'POST' && p === '/api/archive/clear') {
      state.archived = {}
      save()
      return send(res, 200, { ok: true })
    }

    if (req.method === 'GET' && p.startsWith('/vendor/three/')) return serveFile(res, THREE, p.slice('/vendor/three/'.length))
    if (req.method === 'GET' && p === '/vendor/qrcode.js') return serveFile(res, QRCODE, 'qrcode.js')
    if (req.method === 'GET' && p.startsWith('/lib/hex.mjs')) return serveFile(res, path.join(ROOT, 'lib'), 'hex.mjs')
    if (req.method === 'GET') return serveFile(res, PUBLIC, p === '/' ? 'index.html' : p.slice(1))
    send(res, 404, { error: 'not found' })
  } catch (err) {
    send(res, 500, { error: err.message })
  }
})

if (!existsSync(THREE)) {
  console.error('three.js is missing — run `npm install` in tools/agent-colony first.')
  process.exit(1)
}

setInterval(() => { tickSchedules().catch((err) => console.error('schedule:', err.message)) }, 30000)

server.listen(PORT, HOST, () => {
  console.log(`Agent Colony → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`)
  if (PHONE) console.log('Phone access on: open Settings → "Open on your phone" in the colony for the QR code.')
  if (DEMO) console.log('Demo mode: a made-up colony, nothing real is launched.')
  else {
    const found = describeTools(ALLOW_BYPASS).filter((t) => t.available).map((t) => t.name)
    console.log(found.length ? `Can launch: ${found.join(', ')}` : 'No agent CLIs found on PATH: watching only.')
  }
})
