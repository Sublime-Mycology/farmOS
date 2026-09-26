#!/usr/bin/env node
// Add a repo to the colony from the command line, the same as the "Add" box in the side panel.
// With --allow, also grant the commands the repo's .claude/settings.json asks for (the "Allow"
// button). Used by installers; run it before starting the server, or restart the server after.
//
//   node scripts/add-repo.mjs <folder> [--allow]

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const STATE = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'data', 'colony.json')
const RULE = /^[A-Za-z]+(\([^()]{1,200}\))?$/

const [arg, ...flags] = process.argv.slice(2)
if (!arg) {
  console.error('usage: node scripts/add-repo.mjs <folder> [--allow]')
  process.exit(2)
}
const dir = path.resolve(arg.replace(/^~(?=$|[\\/])/, os.homedir()))
const st = await fs.stat(dir).catch(() => null)
if (!st?.isDirectory()) {
  console.error(`No such folder: ${dir}`)
  process.exit(1)
}

let state = {}
try { state = JSON.parse(await fs.readFile(STATE, 'utf8')) } catch { /* first run */ }
state.pinned = [...new Set([...(state.pinned || []), dir])]
console.log(`Added ${dir}`)

if (flags.includes('--allow')) {
  let asks = []
  try {
    const s = JSON.parse(await fs.readFile(path.join(dir, '.claude', 'settings.json'), 'utf8'))
    asks = (s?.permissions?.allow || []).filter((x) => typeof x === 'string' && RULE.test(x))
  } catch { /* the repo asks for nothing */ }
  state.allowed = state.allowed || {}
  state.allowed[dir] = [...new Set([...(state.allowed[dir] || []), ...asks])]
  if (asks.length) console.log(`Agents launched there may run: ${asks.join(', ')}`)
}

await fs.mkdir(path.dirname(STATE), { recursive: true })
await fs.writeFile(STATE, JSON.stringify(state, null, 2))
