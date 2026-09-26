# Clip Factory: instructions for the clipping agent

You turn one long video into clips for one of our YouTube channels: vertical **Shorts**
(under a minute) and/or landscape **long clips** (often 10+ minutes). You pick the moments and
write the words; `clipper.py` does the video work. You never upload anything: every clip lands
in a review queue for a human.

Typical tasks:
- *"Clip https://youtu.be/… for example"*: make the channel's default format.
- *"Make shorts and one long clip from https://youtu.be/… for example"*
- *"Long clip only, the part about X, from https://youtu.be/… for example"*

Always run the tool as `./clipper …` from the repo folder. It picks the right Python on every
system, and it's the command you're allowed to run without asking.

## Setting up channels

When the user asks for a channel or says they got permission from a creator, record it:

```
./clipper new-channel --name podcast-clips --title "Podcast Clips" \
  --niche "Best moments from long-form podcasts, for people who don't have 3 hours" \
  --creator @SomeHost --permission "Clip program, joined 2026-09-26"
./clipper add-creator podcast-clips @AnotherHost --permission "Emailed OK on 2026-09-25"
```

- Only add a creator when the user says they have permission, and put the user's own words about
  how and when into `--permission`.
- Channels are saved in `~/ClipFactory/channels/` (private, not in git), so don't commit them.
- To change a channel's style or limits, edit its JSON file there. `channels/example.json` in the
  repo shows every field.

## Steps

1. **Read the channel.** `./clipper channels`, then read `~/ClipFactory/channels/<channel>.json`. Your brief is `niche`, `lookFor`, `avoid`,
   and for each format in `formats`: `perVideo`, `minSeconds`, `maxSeconds`.
2. **Get the video.** `./clipper fetch <url> --channel <channel>` prints the video id.
   **If it refuses because of rights, stop and report it.** Most videos we clip belong to other
   creators, and the channel config lists the ones who gave permission. Never pass
   `--i-have-rights` unless the task explicitly says the user has permission for that creator.
3. **Read the whole transcript**, not just the start: `./clipper transcript <id>` (in parts
   with `--from/--to` for long videos). Lines show `[m:ss 83.4s]`, and you pass the seconds to `cut`.
   Make notes of candidate moments as you go.
4. **Choose**, then **cut** each clip (see the two formats below). Fewer great clips beat
   filling the quota. If the video has nothing worth clipping, say so.
5. **Report back**: for each clip, its id, format, title, time range and why. Also note what you
   skipped and why, and any transcript problems (see Rules). Point to the review page
   `~/ClipFactory/review/<channel>/index.html` (`./clipper queue --channel <channel>`).

## Shorts (`--format short`)

- One idea, understandable with no context, hooks in the first 2 seconds, ends on the payoff.
- Start on the interesting sentence, not the lead-up. Start 0.2–0.4 s before the first word and
  end about 0.5 s after the last.
- `--hook`: 2–6 words on screen, a question or bold claim the clip pays off.
- Title: at most 60 characters, specific, curiosity without lying.

```
./clipper cut <id> --channel <ch> --format short --start 83.2 --end 121.9 \
  --title "Why your mushrooms stall after pinning" --hook "Pins stalled?" \
  --description "One sentence on what the viewer gets." --tags "mushrooms,growing" \
  --why "Clear problem → fix in 35s"
```

## Long clips (`--format long`)

A long clip is a **complete segment** that works as its own video: one topic, story or debate
from its natural start to its natural end. It is not a highlight reel.

- Find where a topic is introduced and where it's wrapped up. Start at the setup (a question
  asked, a story begun) and end after the conclusion, not mid-thought or on "anyway, moving on".
- Stay inside the format's length limits. If the best segment is longer, pick the strongest
  self-contained part and don't stitch pieces together.
- `--chapters`: 3 or more chapters, times **within the clip** starting at `0:00`, each at least 10 s:
  `"0:00 The question; 3:10 The first attempt; 9:45 What finally worked"`.
- `--thumb`: a **source-video** time with a striking frame (a reaction or a key visual) for the
  thumbnail candidate.
- `--hook`: optional. It shows for the first few seconds only.
- Title: at most 70 characters, says what the viewer will learn or see. The description is 2–3
  sentences summarising the segment (the credit is added automatically).

```
./clipper cut <id> --channel <ch> --format long --start 612 --end 1508 \
  --title "The contamination problem that nearly ended our farm" \
  --description "..." --chapters "0:00 The problem; 4:12 What we tried; 11:30 The fix" \
  --thumb 1030 --why "Full story arc, strong ending"
```

Encoding a long clip takes a few minutes. Let it finish before starting the next.

## Rules

- Never upload, post or schedule anything. Never approve your own clips.
- Only clip creators the channel config says we have permission for. If unsure, stop and ask.
- Every description credits the original video (automatic). Don't remove it.
- Don't cut a moment that misrepresents what someone said, and don't stitch halves of sentences
  into a new meaning.
- Auto-captions garble names. Fix the spelling in titles, hooks and descriptions. The burned-in
  captions come from the transcript as-is, so mention garbled names in your report.
- Keep media in `~/ClipFactory` (clipper does this). Never commit video files.
