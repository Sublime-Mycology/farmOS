---
description: Clip one YouTube video for a channel (Shorts and/or a long clip)
argument-hint: <youtube-link> [channel] [short|long|both] [notes]
---
Run **workflow A (Clip a video)** from CLAUDE.md for: $ARGUMENTS

- The first argument is the video link. The channel is the next word if it matches one from
  `./clipper channels`. If no channel is given and exactly one exists, use it. If several exist and
  none was given, stop and list them.
- Format: `short`, `long` or `both` if given; otherwise the channel's default format.
- Anything after that is a note from the user (e.g. "only the part about pricing"). Follow it.
- Work through every step, including reading `./clipper feedback`, opening the stills to check
  framing, and looking at the finished-clip stills. End with the report from step 8.
