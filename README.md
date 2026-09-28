# Clip Factory

Turn long YouTube videos into clips for one or more clips channels: vertical **Shorts** and
landscape **long clips** (10+ minutes). A Claude Code agent reads the video and picks the
moments. `clipper.py` cuts them with captions, writes the title, description, chapters and
credit, and puts them in a review queue. **You** approve before anything goes out.

```
video URL ──fetch (rights check)──▶ video + timed transcript ──agent picks moments──▶ cut ×N ──▶ review page ──▶ you approve ──▶ upload
```

## Setup

**Windows, one step.** Paste into PowerShell:

```powershell
irm https://raw.githubusercontent.com/Sublime-Mycology/farmOS/clip-factory/setup-windows.ps1 | iex
```

This installs what's missing (Git, Node.js, Python, Claude Code) and downloads Agent Colony and
Clip Factory into `%USERPROFILE%\code`. It adds Clip Factory to the colony, allowed to run its
clipper, asks a few questions to make your first channel, and puts an **Agent Colony** shortcut
on your desktop. You can run it again at any time to update.

**By hand (any system):**

```bash
pip install -r requirements.txt     # yt-dlp, plus a bundled ffmpeg if you don't have one
./clipper doctor                    # checks ffmpeg (with caption support), yt-dlp, folders
./clipper new-channel               # asks a few questions
python3 -m unittest discover -s tests
```

Your channels, downloads and clips live in `~/ClipFactory/` (set `CLIP_FACTORY_HOME` to change
it), never in git.

## Channels

Make channels with `./clipper new-channel`, and add creators with
`./clipper add-creator <channel> @handle --permission "how they said yes"`, or just ask an agent to.
Each channel is a JSON file in `~/ClipFactory/channels/`. `channels/example.json` shows every field.

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
./clipper fetch https://youtu.be/XXXX --channel example         # prints the video id
./clipper transcript XXXX
./clipper cut XXXX --channel example --format short --start 83.2 --end 121.9 \
    --title "Why your pins stall" --hook "Pins stalled?"
./clipper cut XXXX --channel example --format long --start 612 --end 1508 \
    --title "The contamination problem that nearly ended our farm" \
    --chapters "0:00 The problem; 4:12 What we tried; 11:30 The fix" --thumb 1030
./clipper queue                       # and open the review page it prints
./clipper approve <clip-id>           # or: reject <clip-id> --reason "..."
```

For your own footage, skip YouTube: `./clipper import video.mp4 --channel <ch> --subs video.srt`.
Without a subtitle file, `pip install faster-whisper` transcribes it locally.

Encoding a 9-minute long clip took about 2 minutes on a modest 4-core machine. Shorts take seconds.

## What the agent can do

| Command | What it's for |
| --- | --- |
| `./clipper inbox --channel C` | New uploads from the channel's creators that aren't clipped yet |
| `./clipper skip ID --channel C` | Hide a video from the inbox |
| `./clipper hotspots ID` | YouTube's *most replayed* moments, with the words spoken there |
| `./clipper transcript ID` | Full transcript with chapters, and 🔥 on most-replayed lines |
| `./clipper sheet ID --from 4:00 --to 6:00` | One image of stills across a stretch, to *see* the video |
| `./clipper frames ID --at 5:03` / `--clip CLIP` | Stills of the source or of a finished clip |
| `./clipper cut … --focus left` | Where to crop for vertical `fill` clips; edges snap to words |
| `./clipper recut CLIP --hook … --reason …` | Redo a clip from review feedback |
| `./clipper feedback --channel C` | Your approvals and rejections, which the agent reads before picking |
| `./clipper approve CLIP --note …` / `reject CLIP --reason …` | Review. The notes teach the agent. |
| `./clipper connect --channel C` / `upload --approved --channel C` | Post approved clips to YouTube |

The workflows the agent follows (clip a video, inbox rounds, redo from review, channels) are
spelled out in `CLAUDE.md`.

## Autopilot and the head manager

The **manager agent** (`/manage`) runs the operation:
- checks every channel;
- unsticks clipping agents;
- reviews new clips against a written checklist, looking at stills of each one;
- sends weak clips back;
- starts new clips from your creators' uploads;
- schedules approved clips into publish slots;
- writes a short report.

**/checkin** writes a daily or weekly summary.

What the manager may do alone is set per channel, in `~/ClipFactory/channels/<ch>.json`:

```json
"autopilot": {
  "approve": false,          // may the manager approve clips that pass its checklist?
  "upload": false,           // may it schedule approved clips on YouTube?
  "privacy": "public",       // what they become at their publish time
  "slots": ["12:00", "18:00"],
  "holdHours": 12,           // never schedule sooner than this, so you can veto in YouTube Studio
  "maxClipsPerDay": 4,
  "maxUploadsPerRun": 6
}
```

Everything starts **off**. Turn things on as you come to trust it, or ask any agent:
*"/channel turn on auto-approve for grow-clips"*. Even with everything on:
- a clip goes public no sooner than `holdHours` after it's scheduled;
- only approved clips are uploaded;
- the manager never changes rights, creators or these settings.

In Agent Colony, the clip-factory plot has an **Autopilot schedule** with a morning and evening
manager shift and a Monday check-in. Tick the ones you want. They run while the colony is running,
and the Windows installer starts it when you log in. Tap the manager's bot and choose
**Read full reply** for its report. **Review clips** and **Reports** open the clip pages and
saved reports, on your phone too.

## Posting to YouTube

One-time setup per computer (a Google Cloud project with the YouTube API), then one sign-in per
channel with `./clipper connect --channel C`. After that:

```bash
./clipper upload --approved --channel C                              # private, for a last look in Studio
./clipper upload --approved --channel C --at "2026-10-01 18:00" --every 24h   # one a day, public at 6 pm
```

Only clips you approved can be uploaded. YouTube allows about 6 uploads a day per Google project.
Until Google approves the project in its free audit (https://support.google.com/youtube/contact/yt_api_form),
YouTube keeps API uploads private. Until then, the review page has *Copy title*, *Copy
description* and *Download* buttons for posting by hand in YouTube Studio.

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
