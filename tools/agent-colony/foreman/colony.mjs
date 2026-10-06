#!/usr/bin/env node
// The foreman's view of the colony: list agents, read one, tell it to carry on, or mark it.
// Talks to the colony on this computer (address in colony-url.txt, written by the colony).
//
//   node colony.mjs attention                 agents that stopped and need a decision
//   node colony.mjs agents [hours]            every agent active in the last N hours (default 48)
//   node colony.mjs read <id>                 its task, full last reply, worktree and repo brief
//   node colony.mjs reply <id> "message"      continue it with a message (at most 2 a day each)
//   node colony.mjs done <id> "note"          it finished; nothing more to do
//   node colony.mjs needs-you <id> "reason"   only the user can unblock it

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let BASE = process.env.COLONY_URL || ''
if (!BASE) {
  try { BASE = fs.readFileSync(path.join(HERE, 'colony-url.txt'), 'utf8').trim() } catch { BASE = 'http://127.0.0.1:5274' }
}

async function call(method, p, body) {
  let res
  try {
    res = await fetch(BASE + p, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-colony': '1' },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    console.error(`The colony isn't answering at ${BASE}. Is it running?`)
    process.exit(1)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    console.error(`Refused: ${data.error || `HTTP ${res.status}`}`)
    process.exit(1)
  }
  return data
}

const ago = (m) => (m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`)
const oneLine = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)

function row(a) {
  const flags = [a.managed ? '' : 'not managed', a.note].filter(Boolean).join(' · ')
  return `${a.id.slice(0, 8)}  ${a.status.padEnd(8)} ${a.repo} · ${ago(a.minutesAgo)}\n` +
    `          ${oneLine(a.title, 110)}${flags ? `\n          [${oneLine(flags, 160)}]` : ''}`
}

const [cmd, id, ...rest] = process.argv.slice(2)
const text = rest.join(' ').trim()

if (cmd === 'agents' || cmd === 'attention') {
  const hours = cmd === 'agents' && id ? Number(id) : 48
  const { agents, watchdog } = await call('GET', `/api/foreman/agents?hours=${hours}`)
  const list = cmd === 'attention' ? agents.filter((a) => a.attention) : agents
  if (!list.length) {
    console.log(cmd === 'attention' ? 'Nobody needs attention.' : `No agents active in the last ${hours} hours.`)
  } else {
    for (const a of list) {
      console.log(row(a))
      if (cmd === 'attention') console.log(`          last words: ${oneLine(a.replyEnd, 300) || '(none)'}`)
    }
  }
  if (cmd === 'agents') {
    const by = (s) => agents.filter((a) => a.status === s).length
    console.log(`\n${agents.length} agents: ${by('running')} running, ${by('waiting')} finished, ${by('error')} failed, ` +
      `${agents.filter((a) => a.attention).length} need attention. Watchdog ${watchdog ? 'on' : 'OFF'}.`)
  }
} else if (cmd === 'read' && id) {
  const a = await call('GET', `/api/foreman/thread/${encodeURIComponent(id)}`)
  console.log(row(a))
  console.log(`full id: ${a.id}${a.branch ? ` · branch ${a.branch}` : ''}`)
  console.log(`foreman follow-ups today: ${a.foremanRepliesToday} of 2`)
  if (a.worktreeSummary) {
    const w = a.worktreeSummary
    console.log(`worktree: ${w.missing ? 'removed' : `${w.changed} uncommitted file(s), ${w.commits} commit(s)`}`)
  }
  if (a.task) console.log(`\n--- its task ---\n${a.task}`)
  console.log(`\n--- its last reply ---\n${a.reply || '(none)'}`)
  if (a.brief) console.log(`\n--- ${a.repo}/${a.brief.file} ---\n${a.brief.text}`)
} else if (cmd === 'reply' && id && text) {
  await call('POST', '/api/foreman/reply', { id, prompt: text })
  console.log('Sent. It is working again.')
} else if ((cmd === 'done' || cmd === 'needs-you') && id && text) {
  await call('POST', '/api/foreman/mark', { id, note: text, needsUser: cmd === 'needs-you' })
  console.log(cmd === 'done' ? 'Marked done.' : 'Flagged for the user.')
} else {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
  process.exit(cmd ? 2 : 0)
}
