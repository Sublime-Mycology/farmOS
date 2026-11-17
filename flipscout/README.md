# flipscout

flipscout finds privately listed used cars near you that you can buy and resell
for at least your minimum net profit. It talks to sellers within strict limits
and emails you a report every morning. See [PLAN.md](PLAN.md) for the full design
and [config.yaml](config.yaml) for every number it uses.

**It runs on your own computer, not in the cloud.** Facebook Marketplace needs
your logged-in session, and the sites block cloud servers.

**Out of the box it sends nothing.** `config.yaml` ships in dry-run mode: it
scans, values, scores and writes a report, and every seller message is only a
draft.

---

## 1. Get the code onto your laptop

Pick one.

**A. Download a ZIP (no tools needed)**

1. While logged into GitHub, open
   https://github.com/Sublime-Mycology/farmOS/tree/claude/flipscout-car-arbitrage-gkz75b
2. Click **Code ▸ Download ZIP** and unzip it.
3. Open the `flipscout` folder inside it.

**B. Git**

```bash
git clone -b claude/flipscout-car-arbitrage-gkz75b https://github.com/Sublime-Mycology/farmOS.git
cd farmOS/flipscout
```

You need **Python 3.10 or newer** from https://www.python.org/downloads/. On
Windows, tick "Add python.exe to PATH" during install.

## 2. Run setup (one time, about 5 minutes)

- **Mac:** open Terminal in the `flipscout` folder, then run `bash setup.sh`.
  - Tip: in Finder, right-click the folder, then choose Services ▸ New Terminal
    at Folder.
- **Windows:** open PowerShell in the `flipscout` folder, then run
  `powershell -ExecutionPolicy Bypass -File setup.ps1`.
  - Tip: Shift + right-click inside the folder, then choose "Open PowerShell
    window here".

Setup does the following:

1. Creates a private Python environment (`.venv`).
2. Installs everything, including a Chromium browser.
3. Runs the tests.
4. Asks for your first name, Gmail address and home ZIP. These are saved in
   `config.local.yaml`, which never leaves your laptop.
5. Opens a **sample report** built from made-up listings.

## 3. Log into Facebook (one time)

First activate the environment:

- **Mac:** `source .venv/bin/activate`
- **Windows:** `.\.venv\Scripts\Activate.ps1`

Then run:

```
flipscout login
```

A browser window opens using flipscout's own profile. Log into Facebook
yourself; flipscout never sees your password. Then set Marketplace's location
to your ZIP with a 100-mile radius, and press Enter in the terminal.

## 4. Dry run (the real scan; nothing is sent)

```
flipscout run --dry-run --open
```

This takes 10–25 minutes because pages are spaced out on purpose. The report
opens in your browser when it's done, and a copy is saved in `reports/`.

Send me the report (or screenshots) so we can tune it together. Expect mostly
LOW-confidence valuations for the first week or two, while flipscout builds up
its own comparable-sales data.

## 5. Optional extras, then go live (only after you approve the dry run)

```
flipscout email setup      # Gmail App Password (Google Account > Security > App passwords)
flipscout llm setup        # Anthropic API key; without it, seller replies come to you instead
flipscout doctor           # checks everything
flipscout mode live        # turns on automatic seller messaging (asks you to type "yes")
flipscout schedule install # 6:00 AM scan + report, 8:00 AM outreach, Eastern time
```

There's also `flipscout mode report-only`: daily emailed reports, no messaging.

On a Mac, `schedule install` prints one `sudo pmset …` command that wakes the
Mac at 5:55 AM. Run it once.

## Everyday commands

| Command | What it does |
|---|---|
| `flipscout report --open` | Rebuild and open today's report |
| `flipscout listing 42` | Everything about listing #42 (the number shown in the report) |
| `flipscout quote assist 42` | Opens the Carvana, CarMax and KBB sell pages with the VIN and conservative answers, then records the offers you get |
| `flipscout quote add 42 --buyer carvana --amount 9100 --expires 2026-11-24` | Record an offer by hand |
| `flipscout reply 42 "seller's message"` | Log a reply you got by text or phone, and get flipscout's next step |
| `flipscout needs` / `flipscout needs --resolve 7` | Items waiting on you |
| `flipscout mark 42 --status bought` | Updates the dealer-threshold ledger, and reminds you to title it in your name |
| `flipscout ledger add --event sold --date 2026-06-01 --vehicle "2009 Honda Fit"` | Record past sales (counts toward Virginia's 5-in-12-months rule) |
| `flipscout mode dry` | Back to dry run |
| `flipscout schedule remove` | Stop the daily jobs |

## What's automated, and what's best-effort

- **Solid and tested:**
  - the database,
  - the filters (with negation handling),
  - valuation and profit math,
  - the walk-away and negotiation limits (never exceeded; tested 300 random
    negotiations),
  - the outbound message guard,
  - the dealer-threshold tracking,
  - the report.
- **Built, but only proven against sample pages:** the Craigslist and
  Marketplace page readers.
  - The dry run on your laptop is their first contact with the real sites.
    They may need a tune-up, and the report's Run Health section will show it.
- **Best-effort:** sending Marketplace messages and reading Marketplace inbox
  threads.
  - Facebook's page structure changes often.
  - Every send checks itself; anything that fails becomes a draft for you to
    send.
- **Not automated yet:** filling in the Carvana, CarMax and KBB quote forms.
  `flipscout quote assist` does the legwork, and you type in the offer.
  - Automating those forms can be built once we can see the live pages on your
    machine.

## Files

| Path | What it is |
|---|---|
| `config.yaml` | All tunable numbers. Anything marked `# VERIFY` is an assumption to confirm |
| `config.local.yaml` | Your name, email, ZIP. Gitignored |
| `data/flipscout.db` | Everything flipscout knows (SQLite). Gitignored |
| `reports/` | Daily HTML reports. Gitignored |
| `data/logs/` | Run logs |
