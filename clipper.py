#!/usr/bin/env python3
"""
clipper: the mechanical half of Clip Factory. An agent (or you) decides *what* to clip;
this does the downloading, cutting, reframing, captioning and bookkeeping.

    clipper doctor                                   check ffmpeg / yt-dlp / folders
    clipper channels                                 list your channels
    clipper new-channel [--name N --title T --niche "..." --creator @h --permission "..."]
    clipper add-creator CHANNEL @handle --permission "how and when they said yes"
    clipper fetch URL --channel NAME                 download a video + timed transcript
    clipper import FILE --channel NAME [--subs F]    use a local video (your own footage)
    clipper inbox --channel NAME                     new uploads from the channel's creators, not yet clipped
    clipper skip VIDEO_ID --channel NAME             hide a video from the inbox (not worth clipping)
    clipper transcript VIDEO_ID [--from S] [--to S]  the transcript, with chapters and 🔥 most-replayed parts
    clipper hotspots VIDEO_ID                        the most-replayed moments, with what is said in them
    clipper frames VIDEO_ID --at 83,1:40 | --clip ID see the video: stills to look at
    clipper sheet VIDEO_ID [--from S --to S]         one contact-sheet image of a stretch of the video
    clipper feedback --channel NAME                  what you approved and rejected, and why
    clipper cut VIDEO_ID --channel NAME --format short|long --start S --end S --title "..."
    clipper queue [--channel NAME] [--status pending]
    clipper recut CLIP_ID [--start S --end S --title ...]   redo a clip with changes
    clipper approve CLIP_ID [--note "..."] / clipper reject CLIP_ID --reason "..."

Times accept seconds (83.5) or mm:ss / hh:mm:ss. Your channels, downloads and clips live under
$CLIP_FACTORY_HOME (default ~/ClipFactory), outside git: private, and shared by every agent's
worktree. The repo's channels/ folder only holds the template.
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TEMPLATES = ROOT / "channels"
HOME = Path(os.environ.get("CLIP_FACTORY_HOME", Path.home() / "ClipFactory")).expanduser()
CHANNELS_DIR = HOME / "channels"
VIDEOS = HOME / "videos"
REVIEW = HOME / "review"
FRAMES = HOME / "frames"
INBOX = HOME / "inbox"

RIGHTS = {
    "own": "Your own footage",
    "permission": "The creator allows clipping (clip program, written OK, or stated policy)",
    "licensed": "Licensed for reuse (e.g. Creative Commons BY)",
}


# ---------------------------------------------------------------------------------------------
# helpers

def die(msg: str, code: int = 1):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def ffmpeg_bin() -> str:
    exe = os.environ.get("FFMPEG") or shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg  # pip install imageio-ffmpeg: a static ffmpeg with libass
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        die("ffmpeg not found. Install it (brew/apt/winget install ffmpeg) or `pip install imageio-ffmpeg`.")


def parse_time(v) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if re.fullmatch(r"\d+(\.\d+)?", s):
        return float(s)
    parts = s.split(":")
    if not all(re.fullmatch(r"\d+(\.\d+)?", p) for p in parts) or len(parts) > 3:
        die(f"bad time: {v!r}")
    total = 0.0
    for p in parts:
        total = total * 60 + float(p)
    return total


def fmt_time(t: float) -> str:
    t = max(0, t)
    h, rem = divmod(int(t), 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def slugify(text: str, n: int = 48) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (s[:n].rstrip("-") or "clip")


def channel_files() -> dict[str, Path]:
    """Your channels (~/ClipFactory/channels), plus the repo's templates where names don't clash."""
    found = {p.stem: p for p in sorted(TEMPLATES.glob("*.json"))}
    found.update({p.stem: p for p in sorted(CHANNELS_DIR.glob("*.json"))})
    return found


def load_channel(name: str) -> dict:
    path = channel_files().get(name)
    if not path:
        mine = ", ".join(sorted(p.stem for p in CHANNELS_DIR.glob("*.json"))) or "none yet"
        die(f"no channel '{name}'. Your channels: {mine}. Make one with: clipper new-channel")
    ch = json.loads(path.read_text(encoding="utf-8"))
    ch.setdefault("name", name)
    ch.setdefault("style", {})
    return ch


DEFAULT_FORMATS = {
    "short": {"layout": "fit", "minSeconds": 15, "maxSeconds": 59, "captionMode": "words"},
    "long": {"layout": "wide", "minSeconds": 120, "maxSeconds": 3600, "captionMode": "lines", "preset": "veryfast"},
}


def formats(ch: dict) -> dict:
    """A channel's formats. Old configs with just "style" behave as a single "short" format."""
    if "formats" in ch:
        return ch["formats"]
    return {"short": {**DEFAULT_FORMATS["short"], **ch.get("style", {})}}


def format_style(ch: dict, name: str | None) -> tuple[str, dict]:
    fm = formats(ch)
    name = name or ch.get("defaultFormat") or next(iter(fm))
    if name not in fm:
        die(f"channel '{ch['name']}' has no format '{name}' (has: {', '.join(fm)})")
    base = DEFAULT_FORMATS.get(name, DEFAULT_FORMATS["short"])
    return name, {**base, **ch.get("style", {}), **fm[name]}


def video_dir(video_id: str) -> Path:
    d = VIDEOS / video_id
    if not (d / "info.json").exists():
        die(f"unknown video '{video_id}'. Fetch or import it first.")
    return d


def read_json(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def write_json(p: Path, data):
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)


# ---------------------------------------------------------------------------------------------
# transcripts: everything becomes a flat list of timed words [{"t": start, "e": end, "w": text}]

def words_from_json3(data: dict) -> list[dict]:
    """YouTube's json3 captions. Auto-captions carry per-word offsets; manual ones per line."""
    words = []
    for ev in data.get("events", []):
        segs = ev.get("segs")
        if not segs:
            continue
        t0 = ev.get("tStartMs", 0) / 1000
        dur = ev.get("dDurationMs", 0) / 1000
        pieces = [(t0 + s.get("tOffsetMs", 0) / 1000, s.get("utf8", "")) for s in segs]
        pieces = [(t, txt) for t, txt in pieces if txt.strip() and txt != "\n"]
        if len(pieces) == 1 and len(pieces[0][1].split()) > 1:
            # A whole line with one timestamp: spread its words across the event.
            toks = pieces[0][1].split()
            step = (dur or len(toks) * 0.3) / len(toks)
            pieces = [(t0 + i * step, w) for i, w in enumerate(toks)]
        for t, txt in pieces:
            for w in txt.split():
                words.append({"t": round(t, 3), "w": w})
    return finish_words(words)


def words_from_cues(cues: list[tuple[float, float, str]]) -> list[dict]:
    """Line cues (SRT/VTT) → words, spread evenly over each cue."""
    words = []
    for start, end, text in cues:
        toks = text.split()
        if not toks:
            continue
        step = max(0.05, (end - start) / len(toks))
        for i, w in enumerate(toks):
            words.append({"t": round(start + i * step, 3), "w": w})
    return finish_words(words)


def finish_words(words: list[dict]) -> list[dict]:
    words.sort(key=lambda w: w["t"])
    # Drop the rolling duplicates auto-captions produce, then give every word an end time.
    out = []
    for w in words:
        if out and out[-1]["w"] == w["w"] and w["t"] - out[-1]["t"] < 0.05:
            continue
        out.append(w)
    for i, w in enumerate(out):
        nxt = out[i + 1]["t"] if i + 1 < len(out) else w["t"] + 0.6
        w["e"] = round(min(nxt, w["t"] + 1.2), 3)
    return out


def parse_cue_file(path: Path) -> list[tuple[float, float, str]]:
    text = path.read_text(encoding="utf-8", errors="replace")
    cues = []
    ts = r"(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}"
    for block in re.split(r"\n\s*\n", text.replace("\r", "")):
        lines = [l for l in block.strip().split("\n") if l.strip()]
        for i, line in enumerate(lines):
            m = re.match(rf"\s*({ts})\s*-->\s*({ts})", line)
            if m:
                start = parse_time(m.group(1).replace(",", "."))
                end = parse_time(m.group(3).replace(",", "."))
                body = " ".join(lines[i + 1:])
                body = re.sub(r"<[^>]+>", "", html.unescape(body)).strip()
                if body:
                    cues.append((start, end, body))
                break
    # VTT auto-captions repeat the previous line; keep only what is new in each cue.
    dedup = []
    for s, e, b in cues:
        if dedup and b.startswith(dedup[-1][2]):
            b = b[len(dedup[-1][2]):].strip()
        if b:
            dedup.append((s, e, b))
    return dedup


def transcript_lines(words: list[dict], max_gap: float = 1.2, max_len: int = 18) -> list[dict]:
    """Group words into readable lines, breaking on pauses and sentence ends."""
    lines, cur = [], []
    for w in words:
        if cur and (w["t"] - cur[-1]["e"] > max_gap or len(cur) >= max_len or re.search(r"[.?!]$", cur[-1]["w"])):
            lines.append(cur)
            cur = []
        cur.append(w)
    if cur:
        lines.append(cur)
    return [{"t": l[0]["t"], "e": l[-1]["e"], "text": " ".join(x["w"] for x in l)} for l in lines]


# ---------------------------------------------------------------------------------------------
# commands

def cmd_doctor(_):
    ok = True
    try:
        exe = ffmpeg_bin()
        out = subprocess.run([exe, "-hide_banner", "-filters"], capture_output=True, text=True).stdout
        has_ass = " ass " in out
        print(f"ffmpeg      {exe}")
        print(f"  captions  {'yes (libass)' if has_ass else 'NO — this ffmpeg lacks libass; captions will be skipped'}")
    except SystemExit:
        ok = False
    try:
        import yt_dlp  # noqa: F401
        print(f"yt-dlp      {yt_dlp.version.__version__}")
    except Exception:
        print("yt-dlp      missing (needed for `fetch`; `import` works without it): pip install yt-dlp")
    print(f"media home  {HOME}")
    chans = sorted(p.stem for p in CHANNELS_DIR.glob("*.json"))
    print(f"channels    {', '.join(chans) or 'none yet: clipper new-channel'}  ({CHANNELS_DIR})")
    family, font = pick_font({})
    print(f"font        {family} ({font or 'not found: captions use libass default'})")
    sys.exit(0 if ok else 1)


def cmd_channels(_):
    files = channel_files()
    if not any(p.parent == CHANNELS_DIR for p in files.values()):
        print("You have no channels yet. Make one with: clipper new-channel")
    for name, p in files.items():
        ch = read_json(p)
        if p.parent == TEMPLATES:
            print(f"{name:20} (template: copy it with `clipper new-channel`)")
            continue
        fmts = ", ".join(f"{k} {v.get('minSeconds', '?')}-{v.get('maxSeconds', '?')}s" for k, v in formats(ch).items())
        who = ", ".join(c.get("handle", "?") for c in creator_entries(ch)) or "-"
        print(f"{name:20} {ch.get('title', ''):28} rights={ch.get('rights', '?'):10} {fmts}  creators: {who}")


def creator_entries(ch: dict) -> list[dict]:
    """allowedCreators entries may be plain strings or {"handle", "name", "permission", ...}."""
    out = []
    for c in ch.get("allowedCreators", []):
        out.append({"handle": c} if isinstance(c, str) else dict(c))
    return out


def find_creator(ch: dict, uploader: str, uploader_id: str, channel_id: str = "") -> dict | None:
    seen = {x.lower().lstrip("@") for x in (uploader, uploader_id, channel_id) if x}
    for c in creator_entries(ch):
        keys = {str(c.get(k, "")).lower().lstrip("@") for k in ("handle", "name", "channelId")} - {""}
        if keys & seen:
            return c
    return None


def check_rights(ch: dict, uploader: str, uploader_id: str, override: bool, channel_id: str = "", license_: str = "") -> dict:
    """Stop before downloading anything this channel has no right to clip. Returns the creator entry."""
    rights = ch.get("rights")
    if rights not in RIGHTS:
        die(f"channel '{ch['name']}' must say what rights it has: \"rights\": one of {', '.join(RIGHTS)}")
    creator = find_creator(ch, uploader, uploader_id, channel_id)
    if override:
        return creator or {"handle": uploader_id or uploader, "permission": "one-off override (--i-have-rights)"}
    if rights == "licensed":
        if "creative commons" not in (license_ or "").lower() and not creator:
            die(f"'{uploader}' is not marked Creative Commons on YouTube and isn't in allowedCreators.")
        return creator or {"handle": uploader_id or uploader, "permission": license_}
    if rights == "permission" and not creator:
        die(f"'{uploader}' ({uploader_id}) is not in channel '{ch['name']}' allowedCreators. Add them with a note "
            f"of where their OK came from, or pass --i-have-rights for a one-off you are sure about.")
    if rights == "own" and creator_entries(ch) and not creator:
        die(f"'{uploader}' is not one of this channel's own accounts (allowedCreators).")
    return creator or {"handle": uploader_id or uploader}


def ask(prompt: str, default: str = "") -> str:
    try:
        v = input(f"{prompt}{f' [{default}]' if default else ''}: ").strip()
    except EOFError:
        v = ""
    return v or default


def cmd_new_channel(a):
    interactive = sys.stdin.isatty() and not a.name
    if interactive:
        print("New channel. Press Enter to accept the [default].")
        a.title = ask("Channel name as viewers see it", a.title or "My Clips")
        a.name = slugify(ask("Short id for commands", slugify(a.title, 24)), 24)
        a.niche = ask("What is it about, and who watches it", a.niche or "")
        kind = ask("Whose videos? 1 = other creators who gave permission, 2 = your own", "1")
        a.rights = "own" if kind.strip() == "2" else "permission"
        if a.rights == "permission":
            print("Creators you have permission from, one at a time. Leave the handle empty to finish.")
            while True:
                h = ask("  YouTube handle (e.g. @SomeCreator)")
                if not h:
                    break
                a.creator.append(h)
                a.permission.append(ask("  How and when did they say yes", f"Permission noted {dt.date.today()}"))
    if not a.name:
        die("--name is required")
    name = slugify(a.name, 24)
    path = CHANNELS_DIR / f"{name}.json"
    if path.exists() and not a.force:
        die(f"channel '{name}' already exists ({path}). Use add-creator, or --force to replace it.")
    ch = read_json(TEMPLATES / "example.json")
    for k in ("about", "allowedCreators"):
        ch.pop(k, None)
    ch["title"] = a.title or name
    ch["rights"] = a.rights
    if a.niche:
        ch["niche"] = a.niche
    if a.accent:
        ch.setdefault("style", {})["accent"] = a.accent
    ch["allowedCreators"] = []
    for i, h in enumerate(a.creator):
        note = a.permission[i] if i < len(a.permission) else (a.permission[-1] if a.permission else "")
        ch["allowedCreators"].append(creator_entry(h, note))
    write_json(path, {"title": ch.pop("title"), **ch})
    print(f"created {name}  ({path})")
    if a.rights == "permission" and not ch["allowedCreators"]:
        print(f"next: clipper add-creator {name} @handle --permission \"how they said yes\"")


def creator_entry(handle: str, permission: str, name: str = "") -> dict:
    handle = handle.strip()
    if handle and not handle.startswith("@") and not handle.startswith("UC"):
        handle = "@" + handle
    entry = {"handle": handle, "permission": permission or f"Permission noted {dt.date.today()}"}
    if name:
        entry["name"] = name
    return entry


def cmd_add_creator(a):
    path = CHANNELS_DIR / f"{a.channel}.json"
    if not path.exists():
        die(f"no channel '{a.channel}' in {CHANNELS_DIR}. Make it with: clipper new-channel")
    ch = read_json(path)
    entry = creator_entry(a.handle, a.permission, a.name or "")
    creators = [c for c in creator_entries(ch)
                if str(c.get("handle", "")).lower().lstrip("@") != entry["handle"].lower().lstrip("@")]
    creators.append(entry)
    ch["allowedCreators"] = creators
    write_json(path, ch)
    print(f"{a.channel}: may clip {entry['handle']} ({entry['permission']})")


def cmd_fetch(a):
    ch = load_channel(a.channel)
    try:
        import yt_dlp
    except ImportError:
        die("yt-dlp is not installed: pip install yt-dlp")

    # Look before downloading, so the rights check happens first.
    with yt_dlp.YoutubeDL({"quiet": True, "skip_download": True}) as y:
        info = y.extract_info(a.url, download=False)
    vid = info["id"]
    creator = check_rights(ch, info.get("uploader") or "", info.get("uploader_id") or "", a.i_have_rights,
                           info.get("channel_id") or "", info.get("license") or "")

    d = VIDEOS / vid
    d.mkdir(parents=True, exist_ok=True)
    opts = {
        "outtmpl": str(d / "source.%(ext)s"),
        "format": "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]/b",
        "merge_output_format": "mp4",
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": [a.lang, f"{a.lang}.*"],
        "subtitlesformat": "json3/vtt/best",
        "quiet": not a.verbose,
        "noprogress": not a.verbose,
    }
    ff = ffmpeg_bin()
    opts["ffmpeg_location"] = ff
    with yt_dlp.YoutubeDL(opts) as y:
        info = y.extract_info(a.url, download=True)

    words = []
    for f in sorted(d.glob("source.*.json3")):
        words = words_from_json3(read_json(f))
        if words:
            break
    if not words:
        for f in sorted(d.glob("source.*.vtt")) + sorted(d.glob("source.*.srt")):
            words = words_from_cues(parse_cue_file(f))
            if words:
                break
    if not words:
        words = whisper_words(d / "source.mp4")

    write_json(d / "words.json", words)
    write_json(d / "info.json", {
        "id": vid, "url": info.get("webpage_url", a.url), "title": info.get("title", ""),
        "uploader": info.get("uploader", ""), "uploaderUrl": info.get("uploader_url", ""),
        "duration": info.get("duration", 0), "license": info.get("license", ""),
        "channel": ch["name"], "fetched": dt.datetime.now().isoformat(timespec="seconds"),
        "permission": creator.get("permission", ""),
        "uploadDate": info.get("upload_date", ""), "views": info.get("view_count"),
        "description": (info.get("description") or "")[:2000],
        # YouTube's "Most replayed" graph: where viewers rewatch. The strongest single clue to a good clip.
        "heatmap": [{"start": h.get("start_time", 0), "end": h.get("end_time", 0), "value": h.get("value", 0)}
                    for h in (info.get("heatmap") or [])],
        "chapters": [{"start": c.get("start_time", 0), "end": c.get("end_time", 0), "title": c.get("title", "")}
                     for c in (info.get("chapters") or [])],
    })
    mark_inbox(ch["name"], vid, "fetched")
    print(f"{vid}  {info.get('title', '')}  ({fmt_time(info.get('duration', 0))}, {len(words)} words of transcript)")
    extras = []
    if info.get("heatmap"):
        extras.append("most-replayed data: yes (see `clipper hotspots`)")
    if info.get("chapters"):
        extras.append(f"{len(info['chapters'])} chapters")
    if extras:
        print("  " + "; ".join(extras))
    if not words:
        print("warning: no transcript found; `pip install faster-whisper` to transcribe locally.", file=sys.stderr)


def whisper_words(path: Path) -> list[dict]:
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return []
    print("no captions; transcribing locally with faster-whisper…", file=sys.stderr)
    model = WhisperModel(os.environ.get("WHISPER_MODEL", "small"), compute_type="int8")
    segments, _ = model.transcribe(str(path), word_timestamps=True)
    words = []
    for seg in segments:
        for w in seg.words or []:
            words.append({"t": round(w.start, 3), "w": w.word.strip()})
    return finish_words(words)


def cmd_import(a):
    ch = load_channel(a.channel)
    src = Path(a.file).expanduser().resolve()
    if not src.exists():
        die(f"no such file: {src}")
    vid = a.id or slugify(src.stem, 32)
    d = VIDEOS / vid
    d.mkdir(parents=True, exist_ok=True)
    dest = d / f"source{src.suffix.lower()}"
    if not dest.exists():
        shutil.copy2(src, dest)
    words = []
    if a.subs:
        words = words_from_cues(parse_cue_file(Path(a.subs).expanduser()))
    else:
        words = whisper_words(dest)
    write_json(d / "words.json", words)
    write_json(d / "info.json", {
        "id": vid, "url": a.url or "", "title": a.title or src.stem, "uploader": a.uploader or ch.get("title", ""),
        "uploaderUrl": "", "duration": probe_duration(dest), "license": "", "channel": ch["name"],
        "fetched": dt.datetime.now().isoformat(timespec="seconds"), "local": True,
    })
    print(f"{vid}  {a.title or src.stem}  ({len(words)} words of transcript)")


def probe_duration(path: Path) -> float:
    r = subprocess.run([ffmpeg_bin(), "-hide_banner", "-i", str(path)], capture_output=True, text=True)
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", r.stderr)
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else 0.0


def cmd_transcript(a):
    d = video_dir(a.video)
    info = read_json(d / "info.json")
    words = read_json(d / "words.json")
    lo = parse_time(a.from_) if a.from_ else 0
    hi = parse_time(a.to) if a.to else float("inf")
    heat = info.get("heatmap") or []
    hot = heat_threshold(heat)
    chapters = list(info.get("chapters") or [])
    print(f"# {info['title']} — {info.get('uploader', '')} ({fmt_time(info.get('duration', 0))})")
    if heat:
        print("# 🔥 = in YouTube's most-replayed stretch")
    for line in transcript_lines([w for w in words if lo <= w["t"] <= hi]):
        while chapters and chapters[0]["start"] <= line["t"]:
            c = chapters.pop(0)
            print(f"\n## Chapter {fmt_time(c['start'])}: {c['title']}")
        mark = "🔥 " if heat and heat_at(heat, line["t"]) >= hot else ""
        print(f"[{fmt_time(line['t'])} {line['t']:.1f}s] {mark}{line['text']}")


def heat_at(heat: list[dict], t: float) -> float:
    for h in heat:
        if h["start"] <= t < h["end"]:
            return h["value"]
    return 0.0


def heat_threshold(heat: list[dict]) -> float:
    """"Hot" means in the top 30% of the graph, and at least half the peak."""
    if not heat:
        return 1.1
    vals = sorted(h["value"] for h in heat)
    return max(vals[int(len(vals) * 0.7)], 0.5 * vals[-1])


def hot_segments(heat: list[dict], top: int = 8) -> list[dict]:
    """Merge neighbouring hot buckets into segments, strongest first."""
    hot = heat_threshold(heat)
    segs = []
    for h in sorted(heat, key=lambda h: h["start"]):
        if h["value"] < hot:
            continue
        if segs and h["start"] - segs[-1]["end"] < 1.0:
            segs[-1]["end"] = h["end"]
            segs[-1]["peak"] = max(segs[-1]["peak"], h["value"])
        else:
            segs.append({"start": h["start"], "end": h["end"], "peak": h["value"]})
    return sorted(segs, key=lambda s: -s["peak"])[:top]


def cmd_hotspots(a):
    d = video_dir(a.video)
    info = read_json(d / "info.json")
    words = read_json(d / "words.json") if (d / "words.json").exists() else []
    heat = info.get("heatmap") or []
    if not heat:
        print("No most-replayed data for this video (YouTube only shows it once a video has enough views).")
        print("Read the whole transcript instead.")
        return
    print(f"# Most-replayed moments in {info['title']}, strongest first")
    for i, sgm in enumerate(hot_segments(heat, a.top), 1):
        # Viewers rewind to the payoff, so show some lead-up too.
        lo, hi = max(0, sgm["start"] - 20), sgm["end"] + 10
        text = " ".join(w["w"] for w in words if lo <= w["t"] <= hi)
        print(f"\n{i}. {fmt_time(sgm['start'])}–{fmt_time(sgm['end'])} ({sgm['start']:.0f}s–{sgm['end']:.0f}s), "
              f"strength {sgm['peak']:.2f}")
        print(f"   context {fmt_time(lo)}–{fmt_time(hi)}: {text[:400]}{'…' if len(text) > 400 else ''}")


def grab_frame(src: Path, t: float, dest: Path, width: int, label: str = "") -> bool:
    """One still at time t, with an optional time label (drawn with the caption engine, which every
    ffmpeg we use has; drawtext is missing from some builds). Falls back to no label."""
    ff = ffmpeg_bin()
    base = [ff, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{max(0, t):.2f}", "-i", str(src), "-frames:v", "1"]
    with tempfile.TemporaryDirectory() as tmp:
        if label:
            family, font = pick_font({})
            opt = ""
            if font:
                shutil.copy(font, Path(tmp, "f" + Path(font).suffix))
                opt = ":fontsdir=."
            size = max(14, width // 20)
            Path(tmp, "label.ass").write_text(f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {width * 9 // 16}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: L,{family},{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H99000000,-1,0,0,0,100,100,0,0,3,4,0,7,8,8,8,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,L,,0,0,0,,{label}
""", encoding="utf-8")
            r = subprocess.run(base + ["-vf", f"scale={width}:-2,ass=label.ass{opt}", "-q:v", "4", str(dest)],
                               cwd=tmp, capture_output=True)
            if r.returncode == 0 and dest.exists():
                return True
        r = subprocess.run(base + ["-vf", f"scale={width}:-2", "-q:v", "4", str(dest)], cwd=tmp, capture_output=True)
    return r.returncode == 0 and dest.exists()


def cmd_frames(a):
    if a.clip:
        _, m = find_clip(a.clip)
        src = REVIEW / m["channel"] / m["file"]
        times = [m["duration"] * f for f in (0.08, 0.5, 0.92)]
        out = FRAMES / "clips" / m["id"]
    else:
        if not a.video or not a.at:
            die("use: frames VIDEO_ID --at 83,1:40  or  frames --clip CLIP_ID")
        d = video_dir(a.video)
        src = source_file(d)
        times = [parse_time(x) for x in a.at.split(",") if x.strip()][:12]
        out = FRAMES / a.video
    out.mkdir(parents=True, exist_ok=True)
    for t in times:
        dest = out / f"{int(t * 10):06d}.jpg"
        ok = grab_frame(src, t, dest, a.width, fmt_time(t))
        print(f"{fmt_time(t):>8}  {dest if ok else '(could not read a frame here)'}")
    print("Open these images to look at them.")


def cmd_sheet(a):
    """A grid of stills across a stretch of the video, to see it at a glance."""
    d = video_dir(a.video)
    info = read_json(d / "info.json")
    src = source_file(d)
    lo = parse_time(a.from_) if a.from_ else 0.0
    hi = parse_time(a.to) if a.to else float(info.get("duration") or probe_duration(src))
    n = max(4, min(a.count, 24))
    cols = 4
    out = FRAMES / a.video
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for i in range(n):
            t = lo + (hi - lo) * (i + 0.5) / n
            if not grab_frame(src, t, Path(tmp, f"s{i:02d}.jpg"), 320, fmt_time(t)):
                die(f"could not read a frame at {fmt_time(t)}")
        rows = (n + cols - 1) // cols
        dest = out / f"sheet-{int(lo)}-{int(hi)}.jpg"
        r = subprocess.run([ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-y", "-framerate", "1",
                            "-i", "s%02d.jpg", "-vf", f"tile={cols}x{rows}:padding=4:color=black",
                            "-frames:v", "1", "-q:v", "4", str(dest)], cwd=tmp, capture_output=True, text=True)
        if r.returncode != 0:
            die(f"could not build the contact sheet: {r.stderr.strip()[-300:]}")
    print(f"{dest}\n{n} stills from {fmt_time(lo)} to {fmt_time(hi)}, left to right, top to bottom. Open it to look.")


def snap_to_words(words: list[dict], start: float, end: float, duration: float = 0) -> tuple[float, float]:
    """Start just before the first word and end just after the last, so nothing is cut mid-word.
    Moves each edge by at most 1.5 s; the agent's choice of moment stands."""
    inside = [w for w in words if w["e"] > start + 0.05 and w["t"] < end - 0.05]
    if not inside:
        return start, end
    first, last = inside[0], inside[-1]
    new_start = first["t"] - 0.25
    after = [w for w in words if w["t"] >= last["e"] - 0.01 and w is not last]
    new_end = last["e"] + 0.35
    if after:
        new_end = min(new_end, max(last["e"] + 0.05, after[0]["t"] - 0.05))
    if duration:
        new_end = min(new_end, duration)
    if abs(new_start - start) > 1.5:
        new_start = start
    if abs(new_end - end) > 1.5:
        new_end = end
    return max(0.0, round(new_start, 2)), round(new_end, 2)


def focus_value(v) -> float:
    names = {"left": 0.2, "center": 0.5, "centre": 0.5, "middle": 0.5, "right": 0.8}
    if v is None:
        return 0.5
    if str(v).lower() in names:
        return names[str(v).lower()]
    try:
        return min(1.0, max(0.0, float(v)))
    except ValueError:
        die(f"--focus must be left, center, right or a number from 0 to 1, not {v!r}")


def inbox_file(channel: str) -> Path:
    return INBOX / f"{channel}.json"


def mark_inbox(channel: str, video_id: str, status: str, reason: str = ""):
    p = inbox_file(channel)
    data = read_json(p) if p.exists() else {}
    data[video_id] = {"status": status, "reason": reason, "at": dt.datetime.now().isoformat(timespec="seconds")}
    write_json(p, data)


def clips_by_video(channel: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for _, m in all_clips(channel):
        if m.get("status") != "replaced":
            v = m.get("source", {}).get("video", "")
            counts[v] = counts.get(v, 0) + 1
    return counts


def inbox_rows(entries: list[dict], seen: dict, clipped: dict) -> list[dict]:
    """Label each upload new / fetched / clipped / skipped."""
    rows = []
    for e in entries:
        vid = e.get("id")
        if not vid:
            continue
        status = "new"
        if clipped.get(vid):
            status = f"clipped ×{clipped[vid]}"
        elif vid in seen:
            status = seen[vid]["status"]
        rows.append({**e, "status": status})
    return rows


def creator_url(c: dict) -> str:
    if c.get("url"):
        return c["url"]
    h = str(c.get("handle", ""))
    if h.startswith("UC"):
        return f"https://www.youtube.com/channel/{h}/videos"
    return f"https://www.youtube.com/{h if h.startswith('@') else '@' + h}/videos"


def cmd_inbox(a):
    ch = load_channel(a.channel)
    try:
        import yt_dlp
    except ImportError:
        die("yt-dlp is not installed: pip install yt-dlp")
    sources = [(c.get("handle", "?"), creator_url(c)) for c in creator_entries(ch)]
    sources += [(u, u) for u in ch.get("sources", [])]
    if not sources:
        die(f"channel '{ch['name']}' has no creators or sources to check. Add one: clipper add-creator {ch['name']} @handle --permission ...")
    seen = read_json(inbox_file(ch["name"])) if inbox_file(ch["name"]).exists() else {}
    clipped = clips_by_video(ch["name"])
    opts = {"quiet": True, "skip_download": True, "extract_flat": "in_playlist", "playlistend": a.limit}
    total_new = 0
    for name, url in sources:
        try:
            with yt_dlp.YoutubeDL(opts) as y:
                info = y.extract_info(url, download=False)
        except Exception as err:  # one bad creator shouldn't hide the rest
            print(f"\n{name}: could not list uploads ({str(err).splitlines()[0][:160]})")
            continue
        entries = [{"id": e.get("id"), "title": e.get("title") or "", "duration": e.get("duration") or 0,
                    "url": e.get("url") or f"https://www.youtube.com/watch?v={e.get('id')}"}
                   for e in (info.get("entries") or [])]
        rows = inbox_rows(entries, seen, clipped)
        shown = [r for r in rows if a.all or r["status"] == "new"]
        total_new += sum(r["status"] == "new" for r in rows)
        print(f"\n{name}  ({len(shown)} of {len(rows)} recent uploads shown)")
        for r in shown:
            print(f"  {r['status']:11} {fmt_time(r['duration']):>8}  {r['url']}  {r['title'][:80]}")
    print(f"\n{total_new} new video(s). Clip one with: clipper fetch URL --channel {ch['name']}; "
          f"hide one with: clipper skip VIDEO_ID --channel {ch['name']} --reason \"...\"")


def cmd_skip(a):
    load_channel(a.channel)
    mark_inbox(a.channel, a.video, "skipped", a.reason)
    print(f"skipped {a.video} for {a.channel}" + (f": {a.reason}" if a.reason else ""))


def cmd_feedback(a):
    clips = [m for _, m in all_clips(a.channel) if m.get("status") in ("approved", "rejected", "replaced")]
    clips.sort(key=lambda m: m.get("reviewed", m["created"]), reverse=True)
    if not clips:
        print(f"No reviewed clips for '{a.channel}' yet. Nothing to learn from so far.")
        return
    counts = {s: sum(m["status"] == s for m in clips) for s in ("approved", "rejected", "replaced")}
    print(f"# {a.channel}: {counts['approved']} approved, {counts['rejected']} rejected, {counts['replaced']} redone")
    print("# Use this to choose moments, titles and hooks more like the approved ones.")
    for m in clips[:a.limit]:
        note = m.get("reason") or m.get("note") or ""
        print(f"\n{m['status'].upper():8} [{m.get('format', '')} {fmt_time(m['duration'])}] {m['title']}")
        if m.get("hook"):
            print(f"         hook: {m['hook']}")
        if m.get("why"):
            print(f"         agent's reason: {m['why']}")
        if note:
            print(f"         reviewer: {note}")


def source_file(d: Path) -> Path:
    for p in sorted(d.glob("source.*")):
        if p.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov", ".m4v"):
            return p
    die(f"no video file in {d}")


WINDIR = os.environ.get("WINDIR", "C:/Windows")
FONTS = [  # (family, candidate files): a bold face that exists on each system
    ("Arial", [f"{WINDIR}/Fonts/arialbd.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
               "/Library/Fonts/Arial Bold.ttf"]),
    ("DejaVu Sans", ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
                     "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"]),
    ("Liberation Sans", ["/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"]),
]


def pick_font(style: dict) -> tuple[str, str | None]:
    """The caption font. It is copied next to the subtitles so libass finds it on every system."""
    if style.get("fontFile") and Path(style["fontFile"]).expanduser().exists():
        return style.get("font", "Custom"), str(Path(style["fontFile"]).expanduser())
    wanted = style.get("font")
    ordered = sorted(FONTS, key=lambda f: f[0] != wanted)
    for family, files in ordered:
        for f in files:
            if Path(f).exists():
                return family, f
    return wanted or "Arial", None


def ass_color(hex_color: str) -> str:
    h = hex_color.lstrip("#")
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H00{b}{g}{r}".upper()


def build_ass(words: list[dict], start: float, end: float, hook: str, style: dict, w: int, h: int) -> str:
    font = style.get("font", "Arial")
    size = int(style.get("captionSize", 84 if h > w else 60))
    accent = ass_color(style.get("accent", "#FFD400"))
    per = int(style.get("wordsPerCaption", 3))
    margin = int(style.get("captionMargin", 560 if h > w else 80))
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,{font},{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,2,2,60,60,{margin},1
Style: Line,{font},{int(size * 0.8)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,0,0,3,10,0,2,160,160,{int(margin * 0.6)},1
Style: Hook,{font},{int(size * 0.72)},&H00111111,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,3,18,0,8,80,80,{int(h * 0.12)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    def ts(t):
        t = max(0.0, t)
        return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"

    def esc(s):
        return s.replace("\\", "").replace("{", "(").replace("}", ")")

    events = []
    dur = end - start
    if hook:
        hook_secs = float(style.get("hookSeconds", dur))
        events.append(f"Dialogue: 1,{ts(0)},{ts(min(dur, hook_secs))},Hook,,0,0,0,,{esc(hook)}")
    mode = style.get("captionMode", "words") if style.get("captions", True) else "off"
    if mode == "lines":
        # Plain subtitles for long clips: a line at a time, sentence case, no highlight.
        clip_words = [x for x in words if start <= x["t"] < end]
        for line in transcript_lines(clip_words, max_len=int(style.get("wordsPerLine", 9))):
            t0, t1 = line["t"] - start, min(line["e"], end) - start
            events.append(f"Dialogue: 0,{ts(t0)},{ts(max(t1, t0 + 0.4))},Line,,0,0,0,,{esc(line['text'])}")
    if mode == "words":
        clip_words = [x for x in words if start <= x["t"] < end]
        upper = style.get("uppercase", True)
        for i in range(0, len(clip_words), per):
            chunk = clip_words[i:i + per]
            for j, cw in enumerate(chunk):
                t0 = cw["t"] - start
                # A word stays lit until the next one starts; the last of a chunk until it ends.
                t1 = (chunk[j + 1]["t"] if j + 1 < len(chunk) else cw["e"]) - start
                if t1 <= t0:
                    t1 = t0 + 0.2
                parts = []
                for k, x in enumerate(chunk):
                    word = esc(x["w"].upper() if upper else x["w"])
                    parts.append(f"{{\\c{accent}&}}{word}{{\\c&H00FFFFFF&}}" if k == j else word)
                events.append(f"Dialogue: 0,{ts(t0)},{ts(min(t1, dur))},Cap,,0,0,0,,{' '.join(parts)}")
    return head + "\n".join(events) + "\n"


def video_filter(layout: str, w: int, h: int, focus: float = 0.5) -> str:
    if layout == "fill":  # crop to fill the screen; focus 0 = left edge of the frame, 1 = right edge
        return (f"[0:v]scale={w}:{h}:force_original_aspect_ratio=increase,"
                f"crop={w}:{h}:(iw-{w})*{focus:.3f}:(ih-{h})/2,setsar=1[v0]")
    if layout == "wide":  # plain landscape clip
        return f"[0:v]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v0]"
    # fit: whole frame in the middle, blurred copy of itself behind
    return (f"[0:v]split[a][b];[a]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},"
            f"boxblur=24:2,eq=brightness=-0.12[bg];[b]scale={w}:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v0]")


def parse_chapters(text: str, duration: float) -> str:
    """"0:00 Intro; 2:15 The mistake; 7:40 The fix" -> YouTube chapter lines (times within the clip)."""
    items = []
    for part in re.split(r"[;\n]", text):
        part = part.strip()
        if not part:
            continue
        m = re.match(r"(\d+(?::\d{1,2}){0,2}(?:\.\d+)?)\s+(.+)", part)
        if not m:
            die(f"bad chapter {part!r}; use 'm:ss Title; m:ss Title'")
        items.append((parse_time(m.group(1)), m.group(2).strip()))
    items.sort()
    if not items or items[0][0] != 0:
        die("chapters must start at 0:00 (YouTube's rule)")
    if len(items) < 3:
        die("YouTube needs at least 3 chapters")
    for (t0, _), (t1, _) in zip(items, items[1:] + [(duration, "")]):
        if t1 - t0 < 10:
            die("each chapter must be at least 10 seconds long")
    return "Chapters:\n" + "\n".join(f"{fmt_time(t)} {title}" for t, title in items)


def cmd_cut(a):
    ch = load_channel(a.channel)
    fmt, style = format_style(ch, a.format)
    d = video_dir(a.video)
    info = read_json(d / "info.json")
    words = read_json(d / "words.json") if (d / "words.json").exists() else []
    start, end = parse_time(a.start), parse_time(a.end)
    if end <= start:
        die("--end must be after --start")
    lo, hi = float(style.get("minSeconds", 5)), float(style.get("maxSeconds", 180))
    if words and not getattr(a, "exact", False):
        s2, e2 = snap_to_words(words, start, end, float(info.get("duration") or 0))
        if lo <= e2 - s2 <= hi and (s2, e2) != (start, end):
            print(f"snapped to word edges: {start:.2f}–{end:.2f}s → {s2:.2f}–{e2:.2f}s (use --exact to keep yours)")
            start, end = s2, e2
    if not lo <= end - start <= hi:
        die(f"clip is {fmt_time(end - start)}; '{ch['name']}' {fmt} clips must be {fmt_time(lo)}–{fmt_time(hi)} "
            f"(formats.{fmt}.minSeconds/maxSeconds)")
    if info.get("duration") and end > info["duration"] + 0.5:
        die(f"--end is past the end of the video ({fmt_time(info['duration'])})")

    layout = a.layout or style.get("layout", "fit")
    w, h = (1920, 1080) if layout == "wide" else (1080, 1920)
    clip_id = f"{dt.datetime.now():%Y%m%d-%H%M%S}-{slugify(a.title, 40)}"
    out_dir = REVIEW / ch["name"]
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{clip_id}.mp4"

    ff = ffmpeg_bin()
    has_ass = " ass " in subprocess.run([ff, "-hide_banner", "-filters"], capture_output=True, text=True).stdout
    with tempfile.TemporaryDirectory() as tmp:
        focus = focus_value(getattr(a, "focus", None))
        vf = video_filter(layout, w, h, focus)
        if has_ass and (a.hook or (style.get("captions", True) and style.get("captionMode") != "off")):
            family, font_file = pick_font(style)
            style["font"] = family
            fonts_opt = ""
            if font_file:
                shutil.copy(font_file, Path(tmp, "font" + Path(font_file).suffix))
                fonts_opt = ":fontsdir=."
            Path(tmp, "subs.ass").write_text(build_ass(words, start, end, a.hook or "", style, w, h), encoding="utf-8")
            vf += f";[v0]ass=subs.ass{fonts_opt}[v]"
        else:
            vf += ";[v0]null[v]"
        cmd = [
            ff, "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{start:.3f}", "-i", str(source_file(d)), "-t", f"{end - start:.3f}",
            "-filter_complex", vf, "-map", "[v]", "-map", "0:a?",
            "-c:v", "libx264", "-preset", style.get("preset", "medium"), "-crf", str(style.get("crf", 20)),
            "-pix_fmt", "yuv420p", "-r", "30",
            "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "160k",
            "-movflags", "+faststart", str(out),
        ]
        if end - start > 300:
            print(f"encoding {fmt_time(end - start)} of video, this takes a while…", file=sys.stderr)
        r = subprocess.run(cmd, cwd=tmp, capture_output=True, text=True)
        if r.returncode != 0:
            die(f"ffmpeg failed:\n{r.stderr.strip()[-2000:]}")

    # A thumbnail candidate for landscape clips (Shorts don't get custom thumbnails).
    thumb = ""
    if layout == "wide":
        at = parse_time(a.thumb) - start if a.thumb else (end - start) / 3
        tp = out_dir / f"{clip_id}.jpg"
        subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{max(0, at):.2f}", "-i", str(out),
                        "-frames:v", "1", "-vf", "scale=1280:720", "-q:v", "3", str(tp)], capture_output=True)
        thumb = tp.name if tp.exists() else ""

    chapters = parse_chapters(a.chapters, end - start) if a.chapters else ""

    credit_tpl = ch.get("credit", "Original: {title} by {uploader} — {url}")
    credit = credit_tpl.format(title=info.get("title", ""), uploader=info.get("uploader", ""), url=info.get("url", ""),
                               start=fmt_time(start), end=fmt_time(end))
    tags = list(dict.fromkeys((a.tags.split(",") if a.tags else []) + ch.get("tags", [])))
    hashtags = " ".join(style.get("hashtags", ch.get("hashtags", [])))
    desc = "\n\n".join(x for x in [a.description or "", chapters, credit, hashtags] if x)
    meta = {
        "id": clip_id, "channel": ch["name"], "status": "pending", "file": out.name,
        "title": a.title[:100], "description": desc, "tags": [t.strip() for t in tags if t.strip()],
        "format": fmt, "hook": a.hook or "", "layout": layout, "duration": round(end - start, 2), "thumbnail": thumb,
        "source": {"video": info["id"], "url": info.get("url", ""), "title": info.get("title", ""),
                   "uploader": info.get("uploader", ""), "start": start, "end": end},
        "rights": ch.get("rights"), "permission": info.get("permission", ""), "why": a.why or "",
        "created": dt.datetime.now().isoformat(timespec="seconds"),
        # What was asked for, so `recut` can redo the clip with a change or two.
        "request": {"summary": a.description or "", "tags": a.tags or "", "chapters": a.chapters or "",
                    "thumb": a.thumb or "", "focus": getattr(a, "focus", None), "layout": a.layout},
    }
    write_json(out_dir / f"{clip_id}.json", meta)
    write_review_page(ch["name"])
    print(f"{clip_id}  {out}")
    # Stills of the finished clip, for the agent to check captions, crop and hook actually look right.
    previews = FRAMES / "clips" / clip_id
    previews.mkdir(parents=True, exist_ok=True)
    shots = []
    for i, f in enumerate((0.08, 0.5, 0.92), 1):
        dest = previews / f"{i}.jpg"
        if grab_frame(out, (end - start) * f, dest, 360):
            shots.append(str(dest))
    if shots:
        print("check the result by looking at: " + "  ".join(shots))
    return clip_id


def all_clips(channel: str | None = None) -> list[tuple[Path, dict]]:
    dirs = [REVIEW / channel] if channel else sorted(p for p in REVIEW.glob("*") if p.is_dir())
    out = []
    for d in dirs:
        for p in sorted(d.glob("*.json")):
            out.append((p, read_json(p)))
    return out


def cmd_queue(a):
    clips = [(p, m) for p, m in all_clips(a.channel) if not a.status or m.get("status") == a.status]
    for _, m in clips:
        print(f"{m['status']:8} {m['channel']:14} {m.get('format', ''):5} {fmt_time(m['duration']):>7}  {m['id']}  {m['title']}")
    if not clips:
        print("nothing here")
    else:
        for ch in sorted({m["channel"] for _, m in clips}):
            print(f"review page: {REVIEW / ch / 'index.html'}")


def find_clip(clip_id: str) -> tuple[Path, dict]:
    for p, m in all_clips():
        if m["id"] == clip_id or m["id"].startswith(clip_id):
            return p, m
    die(f"no clip '{clip_id}'")


def cmd_recut(a):
    """Cut a clip again with some changes; the old one is marked replaced."""
    import argparse
    p, m = find_clip(a.clip)
    req = m.get("request", {})
    src = m["source"]
    args = argparse.Namespace(
        video=src["video"], channel=m["channel"], format=a.format or m.get("format"),
        start=a.start if a.start is not None else src["start"], end=a.end if a.end is not None else src["end"],
        title=a.title or m["title"], hook=a.hook if a.hook is not None else m.get("hook", ""),
        description=a.description if a.description is not None else req.get("summary", ""),
        tags=a.tags if a.tags is not None else req.get("tags", ""),
        layout=a.layout or req.get("layout"), focus=a.focus if a.focus is not None else req.get("focus"),
        chapters=a.chapters if a.chapters is not None else req.get("chapters", ""),
        thumb=a.thumb if a.thumb is not None else req.get("thumb", ""),
        why=a.why or m.get("why", ""), exact=a.exact,
    )
    new_id = cmd_cut(args)
    m = read_json(p)
    m["status"] = "replaced"
    m["replacedBy"] = new_id
    m["reviewed"] = dt.datetime.now().isoformat(timespec="seconds")
    if a.reason:
        m["reason"] = a.reason
    write_json(p, m)
    write_review_page(m["channel"])
    print(f"replaced {m['id']} with {new_id}")


def set_status(clip_id: str, status: str, reason: str = "", note: str = ""):
    p, m = find_clip(clip_id)
    m["status"] = status
    if reason:
        m["reason"] = reason
    if note:
        m["note"] = note
    m["reviewed"] = dt.datetime.now().isoformat(timespec="seconds")
    write_json(p, m)
    write_review_page(m["channel"])
    print(f"{status}: {m['id']}")


def write_review_page(channel: str):
    """A plain page per channel to watch the clips before anything is posted."""
    clips = [m for _, m in all_clips(channel)]
    clips.sort(key=lambda m: m["created"], reverse=True)
    cards = []
    for m in clips:
        e = html.escape
        cards.append(f"""<article class="{e(m['status'])}">
  <video src="{e(m['file'])}" controls preload="metadata"{f' poster="{e(m["thumbnail"])}"' if m.get('thumbnail') else ''}></video>
  <div><span class="st">{e(m['status'])}</span> <b>{e(m['title'])}</b> <small>{e(m.get('format', ''))} · {fmt_time(m['duration'])} · {e(m['layout'])}</small>
  <p>{e(m.get('why', ''))}</p>
  <details><summary>Description &amp; source</summary><pre>{e(m['description'])}</pre>
  <p>Tags: {e(', '.join(m.get('tags', [])))}</p>
  <p>From <a href="{e(m['source']['url'])}">{e(m['source']['title'])}</a> by {e(m['source']['uploader'])}, {fmt_time(m['source']['start'])}–{fmt_time(m['source']['end'])}</p>
  <p>Permission: {e(m.get('permission') or m.get('rights', ''))}</p></details>
  <code>python3 clipper.py approve {e(m['id'])}</code></div>
</article>""")
    page = f"""<!doctype html><meta charset="utf-8"><title>{html.escape(channel)} — clips to review</title>
<style>
body{{font:14px system-ui,sans-serif;background:#1d2419;color:#e8eee2;margin:0;padding:24px}}
h1{{margin:0 0 16px}} main{{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px}}
article{{background:#2a3325;border-radius:14px;padding:10px;display:flex;flex-direction:column;gap:8px}}
video{{width:100%;border-radius:10px;background:#000;max-height:460px}}
.st{{font-size:11px;padding:2px 7px;border-radius:99px;background:#555}} .pending .st{{background:#b98a1b}}
.approved .st{{background:#3f8a4a}} .rejected{{opacity:.55}} .rejected .st{{background:#8a3f3f}}
pre{{white-space:pre-wrap;font-size:12px}} code{{font-size:11px;color:#b7c4ad}} a{{color:#9fd18b}}
</style><h1>{html.escape(channel)} <small>({sum(m['status'] == 'pending' for m in clips)} to review)</small></h1>
<main>{''.join(cards) or '<p>No clips yet.</p>'}</main>"""
    (REVIEW / channel / "index.html").write_text(page, encoding="utf-8")


# ---------------------------------------------------------------------------------------------

def use_own_python():
    """Re-run under Clip Factory's own Python (made by the installer, has yt-dlp) if it exists."""
    venv = HOME / ".venv"
    if os.environ.get("CLIPPER_REEXEC") or not venv.exists():
        return
    try:
        if Path(sys.prefix).resolve() == venv.resolve():
            return
    except OSError:
        return
    for rel in ("Scripts/python.exe", "bin/python"):
        py = venv / rel
        if py.exists():
            env = {**os.environ, "CLIPPER_REEXEC": "1"}
            sys.exit(subprocess.call([str(py), str(Path(__file__).resolve()), *sys.argv[1:]], env=env))


def main():
    use_own_python()
    for stream in (sys.stdout, sys.stderr):  # Windows consoles default to cp1252; titles have emoji
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    p = argparse.ArgumentParser(prog="clipper", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("doctor").set_defaults(fn=cmd_doctor)
    sub.add_parser("channels").set_defaults(fn=cmd_channels)

    n = sub.add_parser("new-channel", help="create a channel (asks questions when run with no options)")
    n.add_argument("--name", help="short id used in commands, e.g. my-clips")
    n.add_argument("--title", help="channel name as viewers see it")
    n.add_argument("--niche", help="what the channel is about and who watches it")
    n.add_argument("--rights", choices=list(RIGHTS), default="permission")
    n.add_argument("--creator", action="append", default=[], help="@handle of a creator who allows clipping (repeatable)")
    n.add_argument("--permission", action="append", default=[], help="how/when they said yes (one per --creator)")
    n.add_argument("--accent", help="caption highlight colour, e.g. #FFD400")
    n.add_argument("--force", action="store_true")
    n.set_defaults(fn=cmd_new_channel)

    ac = sub.add_parser("add-creator", help="record a creator's permission on a channel")
    ac.add_argument("channel")
    ac.add_argument("handle")
    ac.add_argument("--permission", required=True, help="how and when they said yes")
    ac.add_argument("--name")
    ac.set_defaults(fn=cmd_add_creator)

    f = sub.add_parser("fetch")
    f.add_argument("url")
    f.add_argument("--channel", required=True)
    f.add_argument("--lang", default="en")
    f.add_argument("--i-have-rights", action="store_true", help="skip the allowedCreators check for this one video")
    f.add_argument("--verbose", action="store_true")
    f.set_defaults(fn=cmd_fetch)

    i = sub.add_parser("import")
    i.add_argument("file")
    i.add_argument("--channel", required=True)
    i.add_argument("--subs", help=".srt or .vtt transcript")
    i.add_argument("--id")
    i.add_argument("--title")
    i.add_argument("--uploader")
    i.add_argument("--url")
    i.set_defaults(fn=cmd_import)

    t = sub.add_parser("transcript")
    t.add_argument("video")
    t.add_argument("--from", dest="from_")
    t.add_argument("--to")
    t.set_defaults(fn=cmd_transcript)

    c = sub.add_parser("cut")
    c.add_argument("video")
    c.add_argument("--channel", required=True)
    c.add_argument("--start", required=True)
    c.add_argument("--end", required=True)
    c.add_argument("--title", required=True)
    c.add_argument("--hook", help="short text shown at the top of the clip")
    c.add_argument("--description")
    c.add_argument("--tags", help="comma-separated")
    c.add_argument("--format", help="which of the channel's formats (e.g. short, long)")
    c.add_argument("--layout", choices=["fit", "fill", "wide"], help="override the format's layout")
    c.add_argument("--chapters", help="long clips: '0:00 Intro; 2:15 Topic; 7:40 Payoff' (times within the clip)")
    c.add_argument("--thumb", help="long clips: source time for the thumbnail frame")
    c.add_argument("--why", help="one line on why this moment works (shown on the review page)")
    c.add_argument("--focus", help="fill layout: where to crop, left/center/right or 0-1 (default center)")
    c.add_argument("--exact", action="store_true", help="keep start/end exactly (default: snap to word edges)")
    c.set_defaults(fn=cmd_cut)

    rc = sub.add_parser("recut", help="redo a clip with changes (the old one is marked replaced)")
    rc.add_argument("clip")
    for opt in ("--start", "--end", "--title", "--hook", "--description", "--tags", "--format", "--focus",
                "--chapters", "--thumb", "--why", "--reason"):
        rc.add_argument(opt)
    rc.add_argument("--layout", choices=["fit", "fill", "wide"])
    rc.add_argument("--exact", action="store_true")
    rc.set_defaults(fn=cmd_recut)

    ib = sub.add_parser("inbox", help="recent uploads from the channel's creators that aren't clipped yet")
    ib.add_argument("--channel", required=True)
    ib.add_argument("--limit", type=int, default=10, help="uploads to check per creator")
    ib.add_argument("--all", action="store_true", help="also show ones already fetched, clipped or skipped")
    ib.set_defaults(fn=cmd_inbox)

    sk = sub.add_parser("skip", help="hide a video from the inbox")
    sk.add_argument("video")
    sk.add_argument("--channel", required=True)
    sk.add_argument("--reason", default="")
    sk.set_defaults(fn=cmd_skip)

    hs = sub.add_parser("hotspots", help="YouTube's most-replayed moments, with the words in them")
    hs.add_argument("video")
    hs.add_argument("--top", type=int, default=8)
    hs.set_defaults(fn=cmd_hotspots)

    fr = sub.add_parser("frames", help="stills to look at: --at times in a source video, or --clip for a finished clip")
    fr.add_argument("video", nargs="?")
    fr.add_argument("--at", help="comma-separated times, e.g. 83,1:40,2:05")
    fr.add_argument("--clip", help="a clip id: three stills of the finished clip")
    fr.add_argument("--width", type=int, default=480)
    fr.set_defaults(fn=cmd_frames)

    sh = sub.add_parser("sheet", help="one grid image of stills across a stretch of the video")
    sh.add_argument("video")
    sh.add_argument("--from", dest="from_")
    sh.add_argument("--to")
    sh.add_argument("--count", type=int, default=12)
    sh.set_defaults(fn=cmd_sheet)

    fb = sub.add_parser("feedback", help="what the reviewer approved and rejected, and why")
    fb.add_argument("--channel", required=True)
    fb.add_argument("--limit", type=int, default=15)
    fb.set_defaults(fn=cmd_feedback)

    q = sub.add_parser("queue")
    q.add_argument("--channel")
    q.add_argument("--status", choices=["pending", "approved", "rejected"])
    q.set_defaults(fn=cmd_queue)

    ap = sub.add_parser("approve")
    ap.add_argument("clip")
    ap.add_argument("--note", default="", help="what was good about it (the agent learns from this)")
    ap.set_defaults(fn=lambda a: set_status(a.clip, "approved", note=a.note))
    rj = sub.add_parser("reject")
    rj.add_argument("clip")
    rj.add_argument("--reason", default="", help="what was wrong (the agent learns from this)")
    rj.set_defaults(fn=lambda a: set_status(a.clip, "rejected", a.reason))

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
