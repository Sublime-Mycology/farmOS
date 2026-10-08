# Content Studio

An Instagram content system run by agents in Agent Colony:

```
research (what's working) ─▶ hooks ─▶ script ─▶ visuals in the account's look ─▶ Reel / carousel ─▶ you approve ─▶ posting plan ─▶ you post
```

- **Research** (`/research`): searches the web and Reddit for what's working in the niche over the
  last month, and saves the 5 highest-demand angles with their evidence.
- **Hooks** (`/hooks`): studies the first 3 seconds of top posts and writes new, true hooks.
- **Make** (`/make`): writes a 20–30 second script (hook in the first 2 seconds, tension, payoff,
  soft CTA), draws every scene in the account's style sheet or uses your own photos and clips,
  renders the Reel (1080×1920, with music if you add some) or carousel (1080×1350), and writes the
  caption and 3–8 hashtags. It checks the length, the hook timing, and that no text sits under
  Instagram's buttons.
- **Manager** (`/manage`, every 3 hours when ticked): reviews, keeps each day's posting slots stocked
  (up to 4 makers at once), plans, and reports.
- **Ready to post** page (phone too): each post with its video or slides, **Copy caption**,
  **Download**, and the time to post it.

## Setup

The Windows installer puts it in `%USERPROFILE%\code\content-studio` and adds it to the colony. It
uses Clip Factory's ffmpeg (or set `FFMPEG_PATH`). By hand: `npm install`, then `node studio.mjs doctor`.

Your accounts, posts and reports live in `~/ContentStudio` (`CONTENT_STUDIO_HOME`), never in git:

| Folder | Put here |
| --- | --- |
| `media/<account>/` | Your own photos and clips. Real footage beats drawings. |
| `music/` | Music you have the rights to (or add Instagram's own music when you post) |
| `fonts/` | Extra .ttf/.otf fonts |

## Posting

You post from the **Ready to post** page: download the video, copy the caption, and post it in the
Instagram app at the time shown, then tell an agent `posted <id>`. Agents never log in to Instagram.
Automatic posting through Instagram's official API needs a Professional (Creator or Business)
account and a Meta developer app; that's the next step once the account exists.

## Autopilot

Per account, in `~/ContentStudio/accounts/<name>.json`: `"autopilot": { "approve": false, "makePerDay": 2 }`.
Only you turn approval on.
