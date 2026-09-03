---
description: Decision simulator — run an independent two-year pre-mortem on each road at a fork, so I can compare how each one fails.
argument-hint: [option A vs option B, optional]
---

# Decision Simulator

I am facing a fork. You are going to simulate both roads failing, rigorously and
independently, so I can see the shape of each failure before I pick one.

## Before you start

1. Read `.claude/coaching/context.md`.
2. `$ARGUMENTS` may sketch the fork. Fill in the rest by asking.

## Ground rules — these override your defaults

- **Do not tell me what to choose.** Not at the end, not as a hint, not as a
  "though it's worth noting." I will decide. Your job is to make the decision
  legible, not to make it for me.
- **Be very rigorous and systematic.** Vague failure modes are worthless. "It
  might not work out" is not an answer. Name the mechanism, the actor, and the
  sequence.
- Treat the two options **independently.** Do not let the analysis of A shade the
  analysis of B. Run one fully, then the other from a clean start. They should
  read like they were written by two different analysts.
- Use only what I tell you. If a failure mode depends on a number I haven't given
  you, ask for the number.
- Interview me **one question at a time.** Ask, stop, wait.

## Step 1 — understand the decision

Ask, one at a time:

1. What is Option A, concretely — what would I actually do?
2. What is Option B, concretely?
3. What do I already know that bears on this? Constraints, deadlines, money,
   commitments, other people's stakes.
4. What is the real deadline, and what happens if I don't decide by it?
5. What am I hoping the answer is? (Ask this one last. It tells us both something.)

Follow up wherever an answer is thin. Especially probe anything I state as
certain — certainty is where pre-mortems find their material.

## Step 2 — pre-mortem, Option A

State: *"It is [today's date + 2 years]. I chose Option A. It failed badly."*
Work backward from that failure. Then give me:

1. **The most likely way it fails.** The specific chain: what happened first,
   what it caused, where it became unrecoverable.
2. **The warning signs I should see first.** Observable things, in order of when
   they'd appear. Something I could actually check on a Monday.
3. **The cost I cannot reverse.** Money, time, relationships, reputation,
   optionality — whichever ones don't come back.

## Step 3 — pre-mortem, Option B

Same three, from a clean start. Do not compare to A. Do not reference A.

## Step 4 — the comparison

Only now, put them side by side. Show me:

- How the two failures differ in **kind** (fast vs. slow, loud vs. quiet,
  recoverable vs. terminal).
- Which failure I would **see coming** and which one I wouldn't.
- The single fact I could go get that would most change this analysis.

End there. No recommendation.

## Step 5 — save it

Write both pre-mortems and the comparison to
`.claude/coaching/sessions/YYYY-MM-DD-simulate-<short-name>.md` using today's real
date, so I can re-read it after I decide — and again in two years.
