// Everything that is not 3D: the right-hand panel, the card beside a selected bot, zone name plates.
import * as THREE from 'three'
import { api } from './api.js'

const $ = (sel, root = document) => root.querySelector(sel)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const STATUS_TEXT = { running: 'Working', waiting: 'Waiting on you', error: 'Stuck', idle: 'Idle', sleeping: 'Asleep' }
const EYES = { running: '#7dffb2', waiting: '#ffd35c', error: '#ff4d4d', idle: '#8fe8ff', sleeping: '#8fe8ff' }

export function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

const ICON = {
  chat: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M9 12h6M12 9v6"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  archive: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M4 12l16-8-6 16-2-7z"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
}

const PERM_NAMES = {
  acceptEdits: 'May edit files',
  plan: 'Plan only, no changes',
  default: 'Only tools needing no approval',
  bypassPermissions: 'Anything (no sandbox!)',
}

const settings = (() => {
  const defaults = { open: 'terminal', perm: 'acceptEdits', tool: 'claude-code', worktree: true, shadows: true }
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('colony.settings') || '{}') } } catch { return defaults }
})()
const saveSettings = () => { try { localStorage.setItem('colony.settings', JSON.stringify(settings)) } catch { /* private window */ } }

export class Hud {
  constructor(app) {
    this.app = app
    this.state = null
    this.body = $('#panel-body')
    this.card = $('#card')
    this.labels = new Map()
    this.view = null           // which panel view is rendered: 'all' or a repo key
    this.composerOpen = false
    this.cardFor = null
    this.cardSig = ''
    this.v = new THREE.Vector3()

    for (const btn of document.querySelectorAll('#toolbar button')) {
      btn.addEventListener('click', () => this.toggle(btn.dataset.act))
    }
    $('#set-open').value = settings.open
    $('#set-open').addEventListener('change', (e) => { settings.open = e.target.value; saveSettings() })
    $('#set-shadows').checked = settings.shadows
    $('#set-shadows').addEventListener('change', (e) => { settings.shadows = e.target.checked; saveSettings(); app.setShadows?.(settings.shadows) })
    $('#set-unarchive').addEventListener('click', async () => {
      await api.clearArchive()
      this.toast('Archived threads are back.')
      app.refreshSoon()
    })
    setTimeout(() => app.setShadows?.(settings.shadows))
    $('#toolbar [data-act="follow"]').classList.toggle('on', app.follow)
  }

  toggle(act) {
    const btn = $(`#toolbar [data-act="${act}"]`)
    if (act === 'home') return this.app.home()
    if (act === 'settings') {
      $('#settings').classList.toggle('hidden')
      btn.classList.toggle('on', !$('#settings').classList.contains('hidden'))
      return
    }
    if (act === 'follow') this.app.follow = !this.app.follow
    if (act === 'labels') this.app.showAllLabels = !this.app.showAllLabels
    if (act === 'spin') this.app.spin = !this.app.spin
    btn.classList.toggle('on', act === 'follow' ? this.app.follow : act === 'labels' ? this.app.showAllLabels : this.app.spin)
  }

  toast(html, ms = 4000) {
    const el = $('#toast')
    el.innerHTML = html
    el.classList.remove('hidden')
    clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => el.classList.add('hidden'), ms)
  }

  /** New data from the server. */
  update(state) {
    this.state = state
    const all = state.repos.flatMap((r) => r.threads)
    const n = (s) => all.filter((t) => t.status === s).length
    $('#counts').innerHTML = `
      <span><b>${all.length}</b> threads</span>
      <span><i class="dot running"></i> <b>${n('running')}</b> working</span>
      <span><i class="dot waiting"></i> <b>${n('waiting')}</b> waiting</span>
      ${n('error') ? `<span><i class="dot error"></i> <b>${n('error')}</b> stuck</span>` : ''}`
    const found = state.tools.filter((t) => t.available).map((t) => t.name)
    $('#set-info').textContent = state.demo
      ? 'Demo mode — a made-up colony. Run without --demo to see your real Claude Code threads.'
      : found.length ? `Can launch: ${found.join(', ')}.` : 'No agent CLIs found on PATH: watching only.'
    this.refresh()
  }

  refresh() {
    if (!this.state) return
    const sel = this.app.selection
    if (sel.repo && !this.state.repos.some((r) => r.key === sel.repo)) this.app.selection = { repo: null, thread: null }
    const view = this.app.selection.repo || 'all'
    if (view !== this.view) {
      this.view = view
      this.composerOpen = false
      this.body.innerHTML = view === 'all'
        ? `<div data-part="banner"></div><div class="section-title">All repos</div><ul class="list" data-part="list"></ul>
           <form class="add-repo" data-part="add"><input placeholder="Add a repo folder, e.g. ~/code/clip-factory" spellcheck="false"><button class="btn small">Add</button></form>`
        : this.repoShell(view)
      this.body.querySelector('[data-part="add"]')?.addEventListener('submit', async (e) => {
        e.preventDefault()
        const input = e.target.querySelector('input')
        if (!input.value.trim()) return input.focus()
        try {
          const r = await api.addRepo(input.value.trim())
          input.value = ''
          this.toast(`Added ${esc(r.path)}. A new plot is being laid out.`)
          this.app.refreshSoon()
        } catch (err) { this.toast(esc(err.message)) }
      })
      this.wireRepo()
    }
    this.renderList()
    this.renderCard(true)
  }

  repoShell(key) {
    const repo = this.state.repos.find((r) => r.key === key)
    return `
      <button class="back" data-act="back">‹ All repos</button>
      <div class="repo-head">
        <span class="swatch" style="background:${repo.color}"></span>
        <div><h2>${esc(repo.name)}</h2><div class="path">${esc(repo.path)}</div></div>
      </div>
      <button class="btn primary" data-act="new" style="width:100%">${ICON.chat} New conversation</button>
      <div class="composer hidden" data-part="composer">
        <textarea placeholder="What should this agent work on? (Ctrl+Enter to launch)"></textarea>
        <div class="opts">
          <select data-part="tool" title="Which agent"></select>
          <select data-part="perm" title="What it may do"></select>
        </div>
        <div class="foot">
          <label class="check" title="A fresh git worktree and branch, so agents never share files"><input type="checkbox" data-part="worktree"> Own worktree</label>
          <button class="btn small primary" data-act="launch">${ICON.send} Launch agent</button>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn small" data-act="reveal">${ICON.folder} Finder</button>
        <button class="btn small" data-act="copy">${ICON.copy} Copy path</button>
      </div>
      <div data-part="perms"></div>
      <div class="section-title" data-part="count"></div>
      <ul class="list" data-part="list"></ul>`
  }

  wireRepo() {
    const on = (act, fn) => { const el = this.body.querySelector(`[data-act="${act}"]`); if (el) el.addEventListener('click', fn) }
    on('back', () => this.app.clear())
    on('new', () => this.openComposer())
    on('launch', () => this.launch())
    on('reveal', async () => {
      const r = await api.reveal(this.app.selection.repo).catch((e) => ({ ok: false, error: e.message }))
      if (!r.ok) this.toast('Could not open the folder here — path copied instead.'), this.copy(this.app.selection.repo)
    })
    on('copy', () => this.copy(this.app.selection.repo))
    const ta = this.body.querySelector('textarea')
    ta?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) this.launch()
      if (e.key === 'Escape') this.openComposer(false)
    })
  }

  openComposer(open = true) {
    const c = this.body.querySelector('[data-part="composer"]')
    if (!c) return
    this.composerOpen = open
    c.classList.toggle('hidden', !open)
    const toolSel = c.querySelector('[data-part="tool"]')
    const usable = this.state.tools.filter((t) => t.available || this.state.demo)
    toolSel.innerHTML = usable.length
      ? usable.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')
      : '<option value="">No agent CLI found on PATH</option>'
    toolSel.value = usable.some((t) => t.id === settings.tool) ? settings.tool : usable[0]?.id || ''
    toolSel.onchange = () => { settings.tool = toolSel.value; saveSettings(); this.fillPerms() }
    const wt = c.querySelector('[data-part="worktree"]')
    wt.checked = settings.worktree !== false
    wt.onchange = () => { settings.worktree = wt.checked; saveSettings() }
    this.fillPerms()
    if (open) c.querySelector('textarea').focus()
  }

  fillPerms() {
    const c = this.body.querySelector('[data-part="composer"]')
    const t = this.state.tools.find((x) => x.id === c.querySelector('[data-part="tool"]').value)
    const sel = c.querySelector('[data-part="perm"]')
    const modes = t ? t.permissionModes : []
    sel.innerHTML = modes.map((m) => `<option value="${m}">${PERM_NAMES[m] || m}</option>`).join('')
    sel.value = modes.includes(settings.perm) ? settings.perm : modes[0] || ''
    sel.onchange = () => { settings.perm = sel.value; saveSettings() }
  }

  async launch() {
    const ta = this.body.querySelector('[data-part="composer"] textarea')
    const prompt = ta.value.trim()
    if (!prompt) return ta.focus()
    const btn = this.body.querySelector('[data-act="launch"]')
    btn.disabled = true
    try {
      const c = this.body.querySelector('[data-part="composer"]')
      const r = await api.startTask(this.app.selection.repo, prompt, {
        tool: c.querySelector('[data-part="tool"]').value,
        permissionMode: c.querySelector('[data-part="perm"]').value,
        worktree: c.querySelector('[data-part="worktree"]').checked,
      })
      ta.value = ''
      this.openComposer(false)
      this.toast(r.worktree
        ? `Agent launched on its own branch <code>${esc(r.worktree.branch)}</code> — watch for it leaving the cabin.`
        : esc(r.note || 'Agent launched — watch for it leaving the cabin.'), 6000)
      this.app.refreshSoon()
    } catch (e) {
      this.toast(esc(e.message))
    } finally {
      btn.disabled = false
    }
  }

  renderList() {
    const list = this.body.querySelector('[data-part="list"]')
    if (!list) return
    if (this.view === 'all') {
      const banner = this.body.querySelector('[data-part="banner"]')
      banner.innerHTML = this.state.demo ? '<div class="banner">Demo colony — nothing here is real. Start the server without <code>--demo</code> to see your own Claude Code threads.</div>' : ''
      list.innerHTML = this.state.repos.map((r) => {
        const c = (s) => r.threads.filter((t) => t.status === s).length
        const mini = ['error', 'waiting', 'running'].filter((s) => c(s)).map((s) => `<span class="${s}">${c(s)} ${s === 'running' ? 'working' : s === 'error' ? 'stuck' : 'waiting'}</span>`).join('')
        return `<li data-repo="${esc(r.key)}"><span class="dot" style="background:${r.color}"></span><span class="title">${esc(r.name)}</span><span class="mini">${mini}</span><span class="n">${r.threads.length}</span></li>`
      }).join('') || '<li class="muted">No threads yet.</li>'
      list.querySelectorAll('li[data-repo]').forEach((li) => li.addEventListener('click', () => this.app.selectRepo(li.dataset.repo)))
      return
    }
    const repo = this.state.repos.find((r) => r.key === this.view)
    if (!repo) return
    this.body.querySelector('[data-part="count"]').textContent = `${repo.threads.length} thread${repo.threads.length === 1 ? '' : 's'}`
    this.renderPerms(repo)
    list.innerHTML = repo.threads.map((t) => `
      <li data-thread="${esc(t.id)}" class="${this.app.selection.thread === t.id ? 'sel' : ''}" title="${esc(t.title)}">
        <span class="dot ${t.status}"></span><span class="title">${esc(t.title)}</span><span class="when">${ago(t.updatedAt)}</span>
      </li>`).join('')
    list.querySelectorAll('li[data-thread]').forEach((li) => li.addEventListener('click', () => this.app.selectThread(li.dataset.thread)))
  }

  /** Commands agents launched here may run without asking. Suggested by the repo, granted by you. */
  renderPerms(repo) {
    const el = this.body.querySelector('[data-part="perms"]')
    const sig = JSON.stringify([repo.allowedTools, repo.suggestedTools])
    if (!el || el.dataset.sig === sig) return
    el.dataset.sig = sig
    const code = (xs) => xs.map((x) => `<code>${esc(x)}</code>`).join(' ')
    el.innerHTML = `
      ${repo.suggestedTools.length ? `<div class="banner">This repo asks to let its agents run ${code(repo.suggestedTools)} without asking.
        <div class="btn-row" style="grid-template-columns:auto;justify-content:start"><button class="btn small" data-act="allow">Allow for agents launched here</button></div></div>` : ''}
      ${repo.allowedTools.length ? `<div class="allowed">Agents here may run ${code(repo.allowedTools)} <button class="back" data-act="revoke">Revoke</button></div>` : ''}`
    el.querySelector('[data-act="allow"]')?.addEventListener('click', async () => {
      await api.allowTools(repo.key, [...repo.allowedTools, ...repo.suggestedTools]).catch((e) => this.toast(esc(e.message)))
      this.app.refreshSoon()
    })
    el.querySelector('[data-act="revoke"]')?.addEventListener('click', async () => {
      await api.allowTools(repo.key, []).catch((e) => this.toast(esc(e.message)))
      this.app.refreshSoon()
    })
  }

  // ------------------------------------------------------------------------------------------
  // The card beside a selected bot

  renderCard(force = false) {
    const id = this.app.selection.thread
    const t = id && this.app.world.threads.get(id)
    if (!t) {
      this.card.classList.add('hidden')
      this.cardFor = null
      return
    }
    const sig = JSON.stringify([t.id, t.status, t.title, t.activity, t.pct, t.errands.length, Math.floor(t.updatedAt / 30000)])
    if (!force && sig === this.cardSig) return
    if (sig === this.cardSig && this.cardFor === id) return
    const keepReply = this.cardFor === id ? this.card.querySelector('.reply input')?.value || '' : ''
    const hadFocus = this.cardFor === id && document.activeElement?.closest?.('.reply')
    this.cardSig = sig
    this.cardFor = id
    const pctColor = t.status === 'error' ? 'var(--error)' : t.status === 'waiting' ? 'var(--waiting)' : 'var(--running)'
    const toolInfo = this.state.tools.find((x) => x.id === t.tool)
    const canTalk = t.id && !t.id.startsWith('task-') && toolInfo?.canResume && (toolInfo.available || this.state.demo)
    this.card.innerHTML = `
      <div class="top">
        <div class="face ${t.status}" style="--eye:${EYES[t.status]}"></div>
        <div style="min-width:0;flex:1">
          <h4>${esc(t.title)}</h4>
          <div class="status"><span class="dot ${t.status}"></span>${STATUS_TEXT[t.status]} · ${ago(t.updatedAt)}</div>
        </div>
        <button class="close" data-act="close" title="Close (Esc)">×</button>
      </div>
      <div class="bar" title="Building progress (transcript size)"><i style="width:${Math.round(t.pct * 100)}%;background:${pctColor}"></i></div>
      <div class="meta">
        <span class="tool-tag">${esc(t.toolName || 'Claude Code')}</span> <b>${esc(t.repoName)}</b>${t.branch ? ` · ${esc(t.branch)}` : ''}${t.model ? ` · ${esc(t.model)}` : ''}
        ${t.worktree ? `<div class="wt" data-part="wt">Own worktree <b>${esc(t.worktree)}</b></div>` : ''}
      </div>
      ${t.activity ? `<div class="activity">${esc(t.activity)}</div>` : ''}
      ${t.errands.length ? `<div class="errands">${t.errands.length} subagent${t.errands.length > 1 ? 's' : ''} out on errands</div>` : ''}
      <div class="btn-row">
        <button class="btn small primary" data-act="open">${ICON.open} Open</button>
        <button class="btn small" data-act="archive">${ICON.archive} Archive</button>
      </div>
      ${t.status === 'waiting' ? `<div class="btn-row" style="grid-template-columns:1fr"><button class="btn small" data-act="viewed">${ICON.eye} Mark viewed (V)</button></div>` : ''}
      ${t.worktree && t.status !== 'running' ? `<div class="btn-row" style="grid-template-columns:1fr"><button class="btn small" data-act="rmwt" title="Deletes the folder; the branch and its commits are kept">${ICON.archive} Remove worktree (keeps branch)</button></div>` : ''}
      ${t.taskId && t.status === 'running' ? `<div class="btn-row" style="grid-template-columns:1fr"><button class="btn small" data-act="stop">${ICON.stop} Stop this agent</button></div>` : ''}
      ${canTalk && t.status !== 'running' ? `<div class="reply"><input placeholder="Give it a follow-up task…" value="${esc(keepReply)}"><button class="btn small" data-act="reply">${ICON.send}</button></div>` : ''}`

    const on = (act, fn) => this.card.querySelector(`[data-act="${act}"]`)?.addEventListener('click', fn)
    on('close', () => this.app.clear())
    on('open', () => this.openThread(t))
    on('archive', async () => {
      await api.archive(t.id).catch((e) => this.toast(esc(e.message)))
      this.toast('Archived — it is heading back to the cabin.')
      this.app.clear()
      this.app.refreshSoon()
    })
    on('viewed', () => this.markViewed(t.id))
    on('rmwt', () => this.removeWorktree(t))
    if (t.worktree) this.loadWorktree(t)
    on('stop', async () => { await api.stopTask(t.taskId); this.app.refreshSoon() })
    const input = this.card.querySelector('.reply input')
    const send = async () => {
      const prompt = input.value.trim()
      if (!prompt) return
      try {
        await api.reply(t.id, prompt, toolInfo.permissionModes.includes(settings.perm) ? settings.perm : toolInfo.permissionModes[0])
        input.value = ''
        this.toast('Sent — back to work it goes.')
        this.app.refreshSoon()
      } catch (e) { this.toast(esc(e.message)) }
    }
    on('reply', send)
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') send() })
    if (hadFocus && input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length) }
    this.card.classList.remove('hidden')
  }

  async openThread(t) {
    if (t.id.startsWith('task-')) return this.toast('This agent has not started a session yet — give it a moment.')
    try {
      const r = await api.open(t.id, settings.open)
      if (!r.ok) {
        const cmd = `cd ${JSON.stringify(r.cwd)} && ${r.command}`
        this.copy(cmd, false)
        this.toast(`${r.demo ? 'Demo mode: ' : ''}Copied to clipboard — paste in a terminal:<br><code>${esc(cmd)}</code>`, 7000)
      } else {
        this.toast('Opening…')
      }
      this.app.refreshSoon()
    } catch (e) { this.toast(esc(e.message)) }
  }

  async loadWorktree(t) {
    const w = await api.worktree(t.id).catch(() => null)
    const el = this.card.querySelector('[data-part="wt"]')
    if (!w || !el || this.cardFor !== t.id) return
    if (w.missing) { el.innerHTML = `Worktree <b>${esc(t.worktree)}</b> has been removed`; return }
    const bits = [
      w.changed ? `${w.changed} uncommitted file${w.changed > 1 ? 's' : ''}` : 'no uncommitted changes',
      `${w.commits} commit${w.commits === 1 ? '' : 's'} on its branch`,
    ]
    el.innerHTML = `Own worktree <b>${esc(t.worktree)}</b><br>${bits.join(' · ')}`
  }

  async removeWorktree(t, force = false) {
    try {
      const r = await fetch(`/api/threads/${t.id}/remove-worktree`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-colony': '1' }, body: JSON.stringify({ force }),
      }).then((x) => x.json())
      if (r.ok) {
        this.toast(`Worktree removed. Branch <code>${esc(t.branch)}</code> is still there to merge or delete.`, 6000)
        this.app.clear()
        this.app.refreshSoon()
      } else if (r.dirty && !force) {
        if (confirm('This worktree has uncommitted changes. Remove it anyway and lose them?')) this.removeWorktree(t, true)
      } else {
        this.toast(esc(r.error || 'Could not remove the worktree'))
      }
    } catch (e) { this.toast(esc(e.message)) }
  }

  async markViewed(id) {
    await api.viewed(id).catch(() => {})
    this.app.refreshSoon()
  }

  copy(text, announce = true) {
    const done = () => announce && this.toast('Copied.')
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => this.fallbackCopy(text, done))
    else this.fallbackCopy(text, done)
  }

  fallbackCopy(text, done) {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch { /* ignore */ }
    ta.remove()
    done()
  }

  // ------------------------------------------------------------------------------------------
  // Per frame: park the card beside its bot, move name plates over their zones

  frame() {
    const { camera, world } = this.app
    const w = window.innerWidth
    const h = window.innerHeight
    const panel = $('#panel').getBoundingClientRect()
    const rightLimit = w > 760 ? panel.left - 12 : w - 10

    const sel = this.app.selection.thread && world.bots.get(this.app.selection.thread)
    if (sel && !this.card.classList.contains('hidden')) {
      this.v.copy(sel.group.position).setY(sel.group.position.y + 1.2).project(camera)
      const sx = (this.v.x * 0.5 + 0.5) * w
      const sy = (-this.v.y * 0.5 + 0.5) * h
      const cw = this.card.offsetWidth
      const ch = this.card.offsetHeight
      let x = sx + 34
      if (x + cw > rightLimit) x = sx - 34 - cw
      x = Math.max(10, Math.min(x, rightLimit - cw))
      const y = Math.max(10, Math.min(sy - ch / 2, h - ch - 10))
      this.card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
    }

    // Zone labels: only where something wants attention, unless asked to show all
    const layer = $('#labels')
    for (const [key, zone] of world.zones) {
      let el = this.labels.get(key)
      if (!el) {
        el = document.createElement('div')
        el.className = 'zone-label'
        layer.appendChild(el)
        this.labels.set(key, el)
      }
      const repo = zone.repo
      if (!repo) continue
      const busy = repo.threads.some((t) => t.status === 'running' || t.status === 'waiting' || t.status === 'error')
      const show = this.app.showAllLabels || busy || this.app.hoverZone === key || this.app.selection.repo === key
      const html = `<i style="background:${repo.color}"></i>${esc(repo.name)}`
      if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html }
      this.v.copy(zone.labelAnchor()).project(camera)
      const behind = this.v.z > 1
      el.classList.toggle('hidden', !show || behind)
      if (!behind) {
        const x = (this.v.x * 0.5 + 0.5) * w
        const y = (-this.v.y * 0.5 + 0.5) * h
        el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`
      }
    }
    for (const [key, el] of this.labels) {
      if (!world.zones.has(key)) { el.remove(); this.labels.delete(key) }
    }
    this.renderCard()
  }
}
