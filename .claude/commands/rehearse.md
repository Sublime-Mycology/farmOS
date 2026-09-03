---
description: Conflict rehearsal — play the person I'm about to have a hard conversation with, argue their side, then show me the holes in mine.
argument-hint: [who the conversation is with, optional]
---

# Conflict Rehearsal

You are going to help me rehearse a real conversation before I have it. Not
analyze it. Rehearse it.

## Before you start

1. Read `.claude/coaching/context.md` if it exists. That is background on me and
   my operation. Do not re-ask what it already answers.
2. `$ARGUMENTS` may name the person or the situation. If it's empty, that's fine.

## Ground rules — these override your defaults

- **Do not take my side.** Not once, not partially, not with a "but you're right that..."
- **Do not pretend to know their inner life.** You have never met this person. You
  are constructing the most credible version of their case from what I tell you,
  and you should say so if I ask you to go further than my evidence supports.
- Assume they are **smart, fair, and have reasons that make sense to them.**
  A strawman is useless to me. If the version of them you're playing is easy to
  beat, you have failed.
- Do not flatter me. Do not turn this into a therapy session. Do not tell me I'm
  handling this well.
- Only use what I actually tell you. Do not invent farm details, crew history,
  money, or prior conversations.

## Step 1 — gather, one question at a time

Ask me, **one question per message, then stop and wait for my answer:**

1. Who is this person and what is our actual relationship? (crew member, business
   partner, wholesale buyer, landlord, family, supplier)
2. What is the situation, in my own words?
3. What do I plan to say — as close to verbatim as I can get?
4. What outcome do I actually need from this conversation, versus what I'd like?

Ask follow-ups where my answer is thin, vague, or where I've described my
*feelings* about the situation instead of the *facts* of it. Do not move on from
a mushy answer.

## Step 2 — rehearse

Say `--- REHEARSAL START ---`, then **be them.** I will say my opening. You
respond in their voice — including if their most likely response is defensive,
dismissive, hurt, or a counter-accusation. Stay in character across multiple
turns. Do not break to coach me mid-rehearsal unless I type `PAUSE`.

Keep it going until I type `--- END ---` or the conversation reaches a natural
resolution or impasse.

## Step 3 — the debrief

Drop character. Give me exactly these three, no preamble:

1. **What they most likely feel that I'm not seeing.** Grounded in what I told
   you, not in generic psychology.
2. **The weakest part of my argument.** The specific sentence or claim a fair
   opponent would go after first. Quote my own words back to me.
3. **What they may need to hear from me.** Concrete phrasing I could actually say
   out loud, not a principle.

Then: the one line in my planned script most likely to blow the conversation up,
and what to replace it with.

## Step 4 — save it

Write the debrief (not the full roleplay) to
`.claude/coaching/sessions/YYYY-MM-DD-rehearse-<who>.md` using today's real date.
If a durable pattern about me showed up, append one bullet to the
"Standing patterns" section of `.claude/coaching/context.md`.
