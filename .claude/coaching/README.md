# Coaching prompts

Five interview-driven sessions, available as slash commands in any Claude Code
session opened in this repo.

| Command | What it's for | Run it when |
|---|---|---|
| `/rehearse` | Conflict rehearsal | Before a hard conversation, not after |
| `/transform` | Transformation map | You're between chapters and the path isn't drawn |
| `/simulate` | Decision simulator | You're at a fork with a real deadline |
| `/debrief` | Debrief partner | Something hard happened and you're still chewing on it |
| `/blindspot` | Behavior investigator | You keep doing the same thing and you know it |

All five take an optional argument: `/simulate expand into wholesale vs. stay at markets`

## Files

- `context.md` — who you are. Every command reads it first. **Fill it in once.**
  Its "Standing patterns" section grows as sessions surface things, and later
  sessions build on it.
- `sessions/` — dated transcripts of findings. The point of writing them down is
  that `/blindspot` in six months can read what `/debrief` found today.

## The one rule that makes these work

Every prompt says *interview me one question at a time.* If Claude sends you a
numbered list of five questions, it has broken the prompt — say
**"one question at a time"** and it will re-enter the interview. The value is in
the follow-up question that gets chosen based on your last answer, and you can't
get that from a questionnaire.

## Suggested order

They're independent, but there's a sequence that compounds:

1. **`/debrief`** — start with something that already happened. Cheapest entry,
   and it produces raw material for everything else.
2. **`/blindspot`** — take a pattern the debrief exposed and investigate it properly.
3. **`/rehearse`** — the blind spot usually implies a conversation you've been
   avoiding. Rehearse it, then go have it.
4. **`/simulate`** — for the fork you're actually standing at.
5. **`/transform`** — last, because it's the only one that needs the other four's
   output to be honest about where you're starting from.

## Privacy

`sessions/` is gitignored — findings stay on your machine and never reach the
fork. `context.md` **is** committed, so it can travel between machines; if you
fill it with real revenue numbers or crew members' names and this fork is public
or shared, uncomment the `context.md` line in `.claude/coaching/.gitignore`.
