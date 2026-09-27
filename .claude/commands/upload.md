---
description: Upload the approved clips of a channel to YouTube
argument-hint: [channel] [private|unlisted|public] [schedule, e.g. "daily at 18:00 from tomorrow"]
---
The user asked you to upload. Run **workflow E (Upload)** from CLAUDE.md for: $ARGUMENTS

- Channel: as given, or the only one from `./clipper channels`.
- Privacy: as given, otherwise private.
- A schedule in plain words ("daily at 6pm from tomorrow") becomes
  `--at "<YYYY-MM-DD HH:MM>" --every 24h` in the user's local time. Today is the date on this computer.
- Upload approved clips only, and report every link.
