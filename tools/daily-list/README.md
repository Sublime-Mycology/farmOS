# Mycelia — a spoken daily list

A single self-contained HTML page. Open it on your phone, tap the mic, talk
through your day, and it turns the rambling into a structured list.

Nothing is sent anywhere. Speech recognition is your phone's own; the list is
saved in that browser's local storage on that device.

## Using it

- **Mic button** — talk through everything at once. Say "next" between tasks,
  or just pause. Nothing is saved until you review the parsed list and tap Add.
- **Type it instead** — same parser, from the keyboard.
- **Swipe left/right** or the arrows — move between days.
- **Tap a task** — priority, time, repeat, notes, steps, push to tomorrow.
- **History** — every day is kept, searchable.
- **Settings** — theme, repeating tasks, backup and restore.

## What it understands when you speak

| You say | It records |
| --- | --- |
| "every day", "weekdays", "every Tuesday", "twice a day" | a repeating task |
| "tomorrow", "next Monday", "on Friday", "in 3 days", "this weekend" | a due date |
| "at 3", "by 2pm", "around 10:30", "at noon" | a time (bare hours 1–6 read as afternoon) |
| "first thing", "this afternoon", "tonight", "before bed" | a time-of-day block |
| "urgent", "asap", "important" | must-do |
| "if I have time", "sometime", "no rush" | can wait |
| "note that …" | a note on the previous task |
| "next", "and then", "also", "and I need to", "and call …" | a task boundary |

Filler ("um", "so", "I need to", "remember to") is stripped.

## Day to day

Unfinished tasks roll to today automatically, tagged with how long they have
been sitting. Repeating tasks appear fresh each morning they are due. Completed
tasks stay on the day you finished them, which is what History reads.

## Backup

The list lives in one browser on one device. **Settings → Save a backup file**
writes a JSON file; **Restore from a backup** reads it back. Worth doing
occasionally — clearing browser data will otherwise take the list with it.

## Development

No build step, no dependencies. Edit `index.html` and reload.
