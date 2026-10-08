---
description: "Check the channel's creators for new uploads and start clipping the good ones"
argument-hint: "[channel] [max videos, default: until all 6 agents are busy]"
---
Run **workflow B (Inbox rounds)** from CLAUDE.md for: $ARGUMENTS

- Channel: as given, or the only one from `./clipper channels`. If there are several and none was
  given, do the rounds for each channel.
- For each new video, decide from its title and length whether it fits the channel.
  - Not worth it: `./clipper skip <id> --channel <ch> --reason "…"`.
  - Worth it, up to the max (default: until all 6 clipping agents are busy): hand it to its own
    agent with `./clipper dispatch <url> --channel <ch>`. A new bot walks out in the colony for each
    one. When dispatch says all 6 are busy, stop and leave the rest for the next round.
  - If dispatch says the colony isn't running, clip the first one yourself (workflow A) and list the rest.
- Report what you dispatched, skipped and left for later.
