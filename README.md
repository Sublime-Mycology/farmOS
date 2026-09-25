# Clip Factory

Turn long YouTube videos into clips for one or more clips channels: vertical **Shorts** and
landscape **long clips** (10+ minutes). A Claude Code agent reads the video and picks the
moments. `clipper.py` cuts them with captions, writes the title, description, chapters and
credit, and puts them in a review queue. **You** approve before anything goes out.

```
video URL ──fetch (rights check)──▶ video + timed transcript ──agent picks moments──▶ cut ×N ──▶ review page ──▶ you approve ──▶ upload
```

## Setup

```bash
pip install -r requirements.txt     # yt-dlp, plus a bundled ffmpeg if you don't have one
python3 clipper.py doctor           # checks ffmpeg (with caption support), yt-dlp, folders
python3 -m unittest discover -s tests
```

Clips and downloads live in `~/ClipFactory/` (set `CLIP_FACTORY_HOME` to change it), never in git.

## Channels

One JSON file per channel in `channels/`. Start from `example.json`.

**Who you may clip:** `rights` and `allowedCreators`. `fetch` refuses any creator not listed.
Keep a record of each permission:

```json
"rights": "permission",
"allowedCreators": [
  { "handle": "@SomeCreator", "name": "Some Creator",
    "permission": "Clip program, joined 2026-09-01 (screenshot in permissions/)" }
]
```

`rights` can also be `"own"` (your own footage) or `"licensed"` (Creative Commons; checked
against the video's license on YouTube).

**What to make:** `formats`. Each channel can have both:

| | `short` | `long` |
| --- | --- | --- |
| Frame | 1080×1920 vertical | 1920×1080 landscape |
| `layout` | `fit` (whole frame over a blurred copy) or `fill` (crop to fill) | `wide` |
| Length (`minSeconds`–`maxSeconds`) | 15–59 s | e.g. 8–30 min |
| Captions (`captionMode`) | `words`: big, a few words at a time, active word lit | `lines`: normal subtitles |
| Extras | hook text on top | hook for the first seconds, chapters, thumbnail candidate |

`perVideo` says how many of each to aim for per source video. `hashtags` can be set per format.
Shared caption style (`accent`, `font`) goes in `style`. `niche`, `lookFor` and `avoid` are the
agent's brief for picking moments.

## Using it

**From Agent Colony (several videos at once).** Add this repo's folder in the colony (the box
under *All repos*). Then on the Clip Factory plot: **New conversation**, Claude Code, *May edit
files*, and type something like:

> Make shorts and one long clip from https://youtu.be/XXXX for example

Launch one agent per video. They run side by side, and each follows `CLAUDE.md`.

**From any Claude Code session** in this folder: the same sentence works.

**By hand:**

```bash
python3 clipper.py fetch https://youtu.be/XXXX --channel example         # prints the video id
python3 clipper.py transcript XXXX
python3 clipper.py cut XXXX --channel example --format short --start 83.2 --end 121.9 \
    --title "Why your pins stall" --hook "Pins stalled?"
python3 clipper.py cut XXXX --channel example --format long --start 612 --end 1508 \
    --title "The contamination problem that nearly ended our farm" \
    --chapters "0:00 The problem; 4:12 What we tried; 11:30 The fix" --thumb 1030
python3 clipper.py queue                       # and open the review page it prints
python3 clipper.py approve <clip-id>           # or: reject <clip-id> --reason "..."
```

For your own footage, skip YouTube: `python3 clipper.py import video.mp4 --channel <ch> --subs video.srt`.
Without a subtitle file, `pip install faster-whisper` transcribes it locally.

Encoding a 9-minute long clip took about 2 minutes on a modest 4-core machine. Shorts take seconds.

## Clipping other creators' videos

Clipping without permission gets Content ID claims and copyright strikes, and three strikes
deletes a channel. Downloading someone else's video also breaks YouTube's terms unless you have
the rights. What keeps a clips channel safe:

- **Only clip creators who said yes.** Many run clip programs, some pay clippers, and others
  allow it publicly. Get it in writing, and record where the OK came from in their
  `allowedCreators` entry.
- **Credit every clip.** The source link goes into each description automatically.
- **Add something.** A good hook, title, chapters and choice of moment make a clip worth
  watching on its own. Permission is what makes it allowed, though, not the edit.

## Not built yet

1. **Upload**: YouTube Data API, one Google sign-in per channel. It would upload only `approved`
   clips, as private or scheduled first, with the thumbnail and chapters.
2. **Watch creators**: check each channel's allowed creators for new uploads and start agents
   automatically.
3. **Learn from results**: pull views and retention per clip back in, per channel and format.

## Files

```
clipper.py        the CLI (fetch, import, transcript, cut, queue, approve, reject, channels, doctor)
CLAUDE.md         the playbook the clipping agent follows
channels/*.json   one per channel
tests/            unit tests
```
