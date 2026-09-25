# Clip Factory

Turn long YouTube videos into short clips for one or more clips channels. A Claude Code agent
watches (reads) the video and picks the moments. `clipper.py` cuts them to vertical 9:16 with
word-by-word captions and a hook, writes the title and description, and puts them in a review
queue. **You** approve before anything goes out.

```
long video ──fetch──▶ video + timed transcript ──agent picks moments──▶ cut ×N ──▶ review page ──▶ you approve ──▶ upload
```

## Setup

```bash
cd tools/clip-factory
pip install -r requirements.txt     # yt-dlp, plus a bundled ffmpeg if you don't have one
python3 clipper.py doctor           # checks ffmpeg (with caption support), yt-dlp, folders
```

Clips and downloads live in `~/ClipFactory/` (set `CLIP_FACTORY_HOME` to change it), never in git.

## Channels

One JSON file per channel in `channels/`. Copy `example.json`:

| Field | What it's for |
| --- | --- |
| `rights` + `allowedCreators` | Whose videos this channel may clip. `fetch` refuses anyone not listed |
| `niche`, `lookFor`, `avoid`, `clipsPerVideo` | The agent's brief for choosing moments |
| `style.layout` | `fill` (crop to fill the screen), `fit` (whole frame over a blurred copy), `wide` (16:9) |
| `style.minSeconds` / `maxSeconds` | Clip length limits. Under 60 s for Shorts |
| `style.accent`, `font`, `wordsPerCaption`, `uppercase` | Caption look |
| `credit`, `hashtags`, `tags` | Added to every description |

`shroom-shorts.json` is a sample for clipping your own videos.

## Using it

**From Agent Colony (several videos at once).** Pick the Clip Factory plot, **New conversation**,
Claude Code, *May edit files*, then type something like:

> Clip https://youtu.be/XXXX for shroom-shorts

Launch one per video. They run side by side, and the agents follow the playbook in `CLAUDE.md`.

> Clip Factory needs to be **its own git repo** for this. The colony makes one plot per repo and
> gives each agent a worktree of that repo. Inside farmOS, agents would start at the farmOS root
> and miss `CLAUDE.md`. To move it: copy this folder out, `git init`, and push it to its own repo.

**From any Claude Code session** in this folder: the same sentence works.

**By hand:**

```bash
python3 clipper.py fetch https://youtu.be/XXXX --channel shroom-shorts   # prints the video id
python3 clipper.py transcript XXXX
python3 clipper.py cut XXXX --channel shroom-shorts --start 83.2 --end 121.9 \
    --title "Why your pins stall" --hook "Pins stalled?"
python3 clipper.py queue                       # and open the review page it prints
python3 clipper.py approve <clip-id>           # or: reject <clip-id> --reason "..."
```

Your own footage without YouTube: `python3 clipper.py import video.mp4 --channel shroom-shorts --subs video.srt`.
With no subtitle file, `pip install faster-whisper` transcribes it locally.

## Whose videos you can clip

This matters more than any code here. Clipping other people's videos without permission gets
Content ID claims and copyright strikes, and three strikes deletes a channel. Downloading from
YouTube is also against its terms unless you have the rights. Safe sources:

- **Your own videos**: `"rights": "own"`.
- **Creators who allow clipping**: many run clip programs, or say so publicly, and some pay
  clippers. Get it in writing, list them in `allowedCreators`, and note where the permission
  came from in `rightsNote`.
- **Licensed content**: e.g. Creative Commons BY. Credit is added automatically.

Every clip's description credits the source video.

## Not built yet

1. **Upload**: YouTube Data API, one Google sign-in per channel. It would upload only `approved`
   clips, as private or scheduled first.
2. **Watch sources**: check each channel's allowed creators for new uploads and clip them
   automatically on a schedule.
3. **Learn from results**: pull views and retention per clip back in, so the agent learns what
   works for each channel.

## Files

```
clipper.py        the CLI (fetch, import, transcript, cut, queue, approve, reject, doctor)
CLAUDE.md         the playbook the clipping agent follows
channels/*.json   one per channel
tests/            python3 -m unittest discover -s tests
```
