# Agent Colony

Watch your Claude Code agents work, as a little colony of bots on a Mars-coloured plain, and
launch new ones from the same screen.

- **Each repo is a hex zone**, with a coloured kerb. A repo gets one more tile for every seven threads.
- **Each thread (session) is a building plus a bot.** The bigger the transcript, the more finished
  the building looks.
- **Subagents** show up as smaller bots helping at their parent's building.
- **New agents walk out of the ship** in the middle. Archived threads walk back in.

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
npm install          # only dependency is three.js, served to the browser
npm start            # http://127.0.0.1:5274/
```

`npm run demo` shows a made-up colony, so you can try it without spending anything. If
`~/.claude/projects` has no sessions yet, the demo starts on its own.

Needs Node 20+ and, to launch agents, the `claude` CLI on your `PATH`.

## Running several agents at once

1. Click a zone, or a repo in the right-hand panel.
2. **New conversation** (or press `C`). Type the task and press **Launch agent** (Ctrl+Enter).
3. A bot walks out of the ship to that repo and starts building. Launch as many as you like.
   Each one is its own headless `claude -p` process, working in parallel.
4. Click any bot or building to see a card beside it with its title, branch, model and latest action:
   - **Open** resumes the thread in a terminal (`claude --resume <id>`), in the Claude desktop app, or
     copies the command. Choose which in ⚙ Settings.
   - **Archive** sends the bot home. This only hides the thread here and never touches Claude Code.
   - **Follow-up box**: give a finished agent its next task. It resumes the same session.
   - **Stop this agent** interrupts a running agent that was launched from here.

Sessions you start yourself in the terminal, VS Code or the desktop app show up too. The colony
reads `~/.claude/projects/*.jsonl` (read-only) every 2.5 seconds.

### What launched agents are allowed to do

Headless agents can't ask you for permission, so choose up front in ⚙ Settings → *New agents may*:

- **Edit files (acceptEdits)**: the default. Agents can read and edit files. Shell commands
  that need approval are refused.
- **Plan only**: agents look and plan but change nothing.
- **Ask**: only tools that need no approval.

`bypassPermissions` (anything goes) is hidden unless you start the server with
`COLONY_ALLOW_BYPASS=1`. Use it only in a sandbox or a throwaway worktree.

Tip: for agents editing the same repo at once, give each its own git worktree so they don't trip over
each other. Worktree sessions under `<repo>/.claude/worktrees/…` are grouped into their repo.

## Controls

| | |
| --- | --- |
| Drag / right-drag / scroll | Orbit / pan / zoom |
| Click bot, building or zone | Select |
| `H` | Whole colony |
| `F` | Toggle following the selected bot |
| `L` | Show every zone name (by default only busy zones are labelled) |
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
| `COLONY_ALLOW_BYPASS=1` | Offer `bypassPermissions` for launched agents |

The server listens on localhost only. It answers only requests addressed to localhost, and state
changes need a custom header, so other websites can't drive it. The only file it writes is
`data/colony.json`: the map layout (zones stay put between runs), plus what you archived or viewed.

## Layout of the code

```
server.mjs          HTTP server + API (no dependencies)
lib/scan.mjs        reads Claude Code transcripts → threads with a status
lib/hex.mjs         sticky hex-zone layout (shared with the browser)
lib/agents.mjs      launches/stops headless `claude -p` agents, opens terminals
lib/demo.mjs        the made-up colony
public/js/main.js   renderer, camera, picking, sync with the server
public/js/world.js  terrain, rocks, the ship
public/js/zones.js  hex decks and kerbs
public/js/buildings.js  habitat pods, domes, water towers, depots, solar farms, labs
public/js/bots.js   the crew: steering, animation, sparks
public/js/hud.js    side panel, thread card, zone labels
```

## Credit

Inspired by [Bot Crossing](https://github.com/jarrenrocks/bot-crossing) by Jarren Rocks (MIT).
This is a separate, smaller implementation written from scratch. It adds launching and steering
agents from inside the colony.
