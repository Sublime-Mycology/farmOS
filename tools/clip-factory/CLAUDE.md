# Clip Factory: instructions for the clipping agent

You turn one long video into a few strong short clips for one of our YouTube channels. You pick
the moments and write the words; `clipper.py` does the video work. Nothing is ever uploaded by
you: every clip lands in a review queue for a human.

A task usually looks like: *"Clip https://youtu.be/… for shroom-shorts"* or *"Clip the new video
from @Creator for example"*.

## Steps

1. **Read the channel.** `cat channels/<channel>.json`. `niche`, `lookFor`, `avoid`,
   `clipsPerVideo` and `style.minSeconds`/`maxSeconds` are your brief.
2. **Get the video.**
   `python3 clipper.py fetch <url> --channel <channel>` prints the video id.
   (For a local file: `python3 clipper.py import <file> --channel <channel> --subs <file.srt>`.)
   If it stops with a rights error, **stop and report it**. Do not pass `--i-have-rights` unless
   the task says the user has permission for that creator.
3. **Read the whole transcript.** `python3 clipper.py transcript <id>`, in parts with
   `--from/--to` if it is long. Each line shows `[m:ss 83.4s]`, and the seconds are what you pass to `cut`.
4. **Choose moments**: up to `clipsPerVideo`, fewer if the video doesn't have them. A good clip:
   - makes sense to someone who has not seen the video,
   - hooks in the first 2 seconds (start on the interesting sentence, not the lead-up),
   - ends on the payoff (the punchline, the answer, the result), not trailing off,
   - fits the channel's length limits.
   Start a beat (0.2–0.4 s) before the first word and end about 0.5 s after the last.
5. **Cut each one.**
   ```
   python3 clipper.py cut <id> --channel <channel> --start 83.2 --end 121.9 \
     --title "Why your mushrooms stall after pinning" \
     --hook "Your pins stopped growing?" \
     --description "One sentence on what the viewer gets." \
     --tags "mushroom growing,fruiting" \
     --why "Clear problem → fix in 35s; strong visual at the end"
   ```
   - **title**: at most 60 characters, specific, curiosity without lying. No ALL CAPS, no emoji spam.
   - **hook**: 2–6 words on screen at the top. A question or a bold claim the clip pays off.
   - **why**: one line for the reviewer on why this moment works.
   The source credit and hashtags are added automatically from the channel config.
6. **Report back**: a short list of the clips (id, title, time range, why), plus anything you
   skipped and why. Point to the review page `~/ClipFactory/review/<channel>/index.html`
   (`python3 clipper.py queue --channel <channel>` shows it).

## Rules

- Never upload, post or schedule anything. Never approve your own clips.
- Only clip content the channel config says we have rights to. If unsure, stop and ask.
- Don't cut a moment that misrepresents what someone said (no stitching halves of sentences
  into a new meaning).
- If the transcript looks wrong (auto-captions garbling names), fix the spelling in the title and
  hook. The burned-in captions come from the transcript as-is, so mention it in your report.
- Keep all media in `~/ClipFactory` (clipper does this). Don't commit video files.
