# Agent Colony

Watch your coding agents work: a little colony of bots on wooden plots in a clearing in the woods.
Launch new agents from the same screen, each in its own copy of the repo.

- **Each repo is a hex plot**, with a coloured border. A repo gets one more tile for every seven threads.
- **Each thread (session) is a building plus a bot.** The bigger the transcript, the more finished
  the building looks.
- **Subagents** show up as smaller bots helping at their parent's building.
- **New agents walk out of the log cabin** in the middle. Archived threads walk back in.

| Bot is… | Meaning |
| --- | --- |
| Hammering, with scaffolding and sparks | Working right now |
| Waving, with a yellow `?` | Finished its turn and is waiting on you |
| Slumped, red eyes, `!` | Hit an error |
| Sitting, with a `z` | Nothing for 3+ days |
| Wandering around | Idle |

## Run it

```bash
cd tools/agent-colony
npm install          # the only dependency is three.js, served to the browser
npm start            # http://127.0.0.1:5274/
```

`npm run demo` shows a made-up colony, so you can try it without spending anything. If
`~/.claude/projects` has no sessions yet, the demo starts on its own.

Needs Node 20+ and git. To launch agents you also need at least one agent CLI on your `PATH`
(see [Tools](#tools)).

## What a repo can offer the colony

Optional files in a repo's `.colony/` folder:

| File | What it adds to the repo's plot |
| --- | --- |
| `prompts.json` | One-click prompt buttons: `[{ "label", "prompt" }]` |
| `schedule.json` | Recurring runs, each off until ticked: `[{ "id", "label", "prompt", "at": "09:00", "days": "daily" \| "weekdays" \| "mon,thu" }]`. They run while the colony runs; a time missed earlier that day runs once when it next starts |
| `pages.json` | Folders to browse from the colony, and from a phone: `[{ "label", "env", "default", "sub" }]` |
| `dirs.json` | Folders outside the repo its agents need. They're passed as `--add-dir`, and only after you press **Allow** |

Commands a repo's `.claude/settings.json` asks for are granted the same way, with **Allow**.

## On your phone

Start the colony with `node server.mjs --phone` (the Windows desktop shortcut does). Then on the
computer, open ⚙ **Settings → Open on your phone** and scan the QR code with your phone's camera.
The phone must be on the same Wi-Fi. The first time, Windows may ask whether Node.js can use the
network: tick **Private networks** and click **Allow**.

The link carries a secret key (kept in `data/phone-key.txt`), and the colony answers nobody without
it. Delete that file and restart to issue a new key, which cuts off every phone that had the old one.
Away from home, install [Tailscale](https://tailscale.com/download) on both the computer and the
phone, signed in to the same account. A *Tailscale* link then appears under the Wi-Fi one.

## Adding a repo

A plot appears for every repo that has Claude Code sessions. To add one that doesn't have any yet
(a brand-new project, say), type its folder into the box under **All repos**, e.g.
`~/code/clip-factory`. It stays on the map until you remove it from `data/colony.json` (`pinned`).

## Running several agents at once

1. Click a plot, or a repo in the right-hand panel.
2. **New conversation** (or press `C`). Type the task, and pick the **tool** and what it **may do**.
3. Leave **Own worktree** ticked and press **Launch agent** (Ctrl+Enter). Launch as many as you like.

### Every agent gets its own worktree

Each launched agent works in a fresh git worktree, so agents running at the same time never edit
the same files:

```
<repo>/.claude/worktrees/<task-slug>     on a new branch  colony/<task-slug>, cut from your current HEAD
```

- It is added to `.git/info/exclude` (local only), so your main checkout stays clean.
- Claude Code keeps its own worktrees in the same place, so those sessions join the same plot.
- The card for the thread shows its branch, how many files are uncommitted and how many commits
  it has made.
- When you're done, **Remove worktree** deletes the folder but **keeps the branch**, so you can
  merge it, open a PR or delete it as usual. If there are uncommitted changes, you're asked first.
- If the folder isn't a git repo, the agent works in the folder itself, and you're told so.

### The card beside a bot

- **Open**: Claude Code threads resume in a terminal (`claude --resume <id>`), in the desktop app,
  or by copying the command (choose in ⚙ Settings). Threads from other tools open a terminal in their worktree.
- **Archive**: sends the bot home. This only hides the thread here.
- **Follow-up box**: give a finished Claude Code agent its next task, in the same session and worktree.
- **Stop this agent**: interrupts a run launched from here.

## Tools

The colony talks to each coding-agent CLI through a small **adapter** in `lib/tools.mjs`. An
adapter has two independent halves, so support can grow one tool and one half at a time:

| Half | What it does | Needed for |
| --- | --- | --- |
| **launch** | How to start a headless run, and how to read its output into "what is it doing / is it done" | Launching from the colony |
| **watch** | Reading the tool's own session history from disk | Seeing sessions you started *outside* the colony, and ones from before the server started |

| Tool | Launch | Watch | Follow-ups |
| --- | --- | --- | --- |
| Claude Code | ✅ `claude -p` | ✅ `~/.claude/projects` | ✅ |
| Codex | ✅ `codex exec` | — | — |
| Aider | ✅ `aider --message` | — | — |
| Anything else | ✅ via `data/tools.json` | — | — |

Only tools actually on your `PATH` are offered. Runs of tools without a *watch* half are shown
from the running process: live activity while they work, then done or error. They stay on the map
for 24 hours or until you archive them (only while the server keeps running).

**Adding any other CLI, no code needed:** create `data/tools.json`:

```json
[
  { "id": "gemini", "name": "Gemini", "command": ["gemini", "-p", "{prompt}"] },
  { "id": "goose",  "name": "Goose",  "command": ["goose", "run", "-t", "{prompt}"] }
]
```

**Growing a tool to full support** is one adapter entry in `lib/tools.mjs`:

1. `args()` and `parse()`: the launch half. `parse` gets each output line and sets `task.activity`,
   `task.status` and `task.sessionId`. JSON output modes are much better than plain text here.
2. `canResume` + `resume`: for follow-ups in the same session.
3. `watches` + a scanner like `lib/scan.mjs`: turn the tool's session files into threads
   (`{ id, repo, cwd, title, status, updatedAt, size, … }`). The server just merges every tool's
   list. This is the most work, because every tool stores history differently.

The Codex and Aider adapters haven't been run against the real tools yet. If one misbehaves
(for example, a flag renamed in a newer version), the fix is a line or two in its adapter.

### What launched agents are allowed to do

Headless agents can't stop to ask you, so choose up front in the composer:

- **May edit files**: the default. Claude Code uses `acceptEdits` (shell commands needing approval
  are refused). Codex uses `--full-auto` (sandboxed to the worktree).
- **Plan only**: look and plan, change nothing.
- **Anything (no sandbox!)**: hidden unless the server is started with `COLONY_ALLOW_BYPASS=1`.
  The worktree limits the damage to your files, but not to the rest of your machine.

## Controls

| | |
| --- | --- |
| Drag / right-drag / scroll | Orbit / pan / zoom |
| Click bot, building or plot | Select |
| `H` | Whole colony |
| `F` | Toggle following the selected bot |
| `L` | Show every plot name (by default only busy plots are labelled) |
| `C` | New conversation in the selected repo |
| `V` | Mark the selected thread as viewed |
| `Esc` | Deselect |

## Options

```
node server.mjs [--demo] [--port 5274] [--host 127.0.0.1] [--no-auto-demo]
```

| Env var | |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | Where Claude Code keeps its data (default `~/.claude`) |
| `COLONY_CLAUDE_BIN` | Path to the `claude` binary |
| `COLONY_ALLOW_BYPASS=1` | Offer unsandboxed runs |

The server listens on localhost only. It answers only requests addressed to localhost, and state
changes need a custom header, so other websites can't drive it. It writes `data/colony.json` (the
map, plus what you archived or viewed) and creates and removes worktrees under
`<repo>/.claude/worktrees/`. Nothing else.

## Layout of the code

```
server.mjs              HTTP server + API (no dependencies)
lib/tools.mjs           tool adapters: how to launch/parse/resume each agent CLI
lib/agents.mjs          runs tasks (one process per agent), opens terminals
lib/worktrees.mjs       one git worktree per task; summary; safe removal
lib/scan.mjs            Claude Code "watch": transcripts → threads with a status
lib/hex.mjs             sticky hex-plot layout (shared with the browser)
lib/demo.mjs            the made-up colony
public/js/main.js       renderer, camera, picking, sync with the server
public/js/world.js      forest floor, trees, rocks, mushrooms, the cabin
public/js/zones.js      wooden plots and their borders
public/js/buildings.js  habitat pods, domes, water towers, depots, solar farms, labs
public/js/bots.js       the crew: steering, animation, sparks
public/js/hud.js        side panel, composer, thread card, plot labels
```

## Credit

Inspired by [Bot Crossing](https://github.com/jarrenrocks/bot-crossing) by Jarren Rocks (MIT).
This is a separate, smaller implementation written from scratch. It adds launching agents from
several tools, each in its own worktree.
