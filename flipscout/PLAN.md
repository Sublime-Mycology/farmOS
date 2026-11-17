# flipscout: build plan (v0, waiting for your OK)

flipscout finds privately listed used cars that can be bought within budget and
resold for at least the minimum net profit. It handles first contact and
negotiation inside strict limits, and emails a daily report.

It lives in `flipscout/` and does not touch any farmOS code. Your personal
details (name, email, phone, home ZIP) go in `config.local.yaml`. That file is
gitignored, so it is never pushed. The database, reports, photos and browser
profile are gitignored too.

---

> "NEEDS-YOU" below is your custom label from `config.local.yaml` (your "NEEDS <name>" flag).

## 1. Where it runs, and why

**It runs on your own computer, not in the cloud.**

- Facebook Marketplace needs your logged-in session. flipscout uses a dedicated
  browser profile on your machine (`~/.flipscout/browser-profile`). You log into
  Facebook once, yourself, with `flipscout login`. flipscout never sees or stores
  your password.
  - Why not your everyday Chrome profile: Chrome 136 and later refuses automation
    on the default profile, and it would also lock your normal browser.
- It uses your home internet connection. Marketplace and Craigslist block
  datacenter IPs. The cloud sandbox this was built in cannot reach either site
  (its network policy returns a 403).
- Seller conversations, your quotes and your transaction history stay on your
  disk in SQLite. They are never pushed to GitHub.
- Scheduling uses your OS scheduler: launchd on Mac, Task Scheduler on Windows,
  cron on Linux. `flipscout schedule install` sets it up, and the computer must
  be awake at 6:00 AM.
  - On a Mac, the installer can also set a 5:55 AM wake with `pmset`.
  - On Windows, it ticks "wake the computer to run this task".
- Email goes out through Gmail SMTP using a Gmail **App Password**, which needs
  2-Step Verification. The password is kept in your OS keychain, never in a file.

**Things flipscout will never do:** use proxies, fake accounts, "stealth" or
fingerprint-spoofing plugins, CAPTCHA solvers, or retries meant to get past a
block.

When a site shows a login wall, checkpoint, CAPTCHA, "you're temporarily
blocked", or an HTTP 403/429, flipscout:

- stops that source for the day,
- logs it as `BLOCKED`,
- puts it at the top of Run Health in the report.

## 2. Daily timeline (America/New_York)

| Time | Job | What happens |
|---|---|---|
| 06:00 | `flipscout run` | Collect, filter, value, score, plan messages (queued, not sent), write the report |
| ≤06:50 | (same job) | Hard time budget. If collection runs long, it stops and sends a partial report that says so |
| ≤07:00 | (same job) | Email the report and save `reports/YYYY-MM-DD.html` |
| 08:00 | `flipscout outreach` | Send queued first contacts and negotiation replies (nothing goes to sellers at 6 AM), read new replies, re-plan |
| optional | `flipscout inbox` | Inbox-only follow-up passes (e.g. 12:30 and 18:30). No listing scans. **Off by default**, see decision #6 |

Each day there is one scan pass per source. Page views are spaced 4–9 seconds
apart and capped per run: 60 Craigslist detail pages and 40 Marketplace detail
pages.

## 3. Pipeline

### 3.1 Collect

- **Craigslist:** the `cto` category, which is "cars & trucks: by owner" and
  already excludes dealers.
  - It searches each nearby Craigslist site with `postal=<home ZIP>`,
    `search_distance=100`, `min_auto_year=1992`, and the price band set in config.
  - It opens a detail page only for listings it hasn't seen, or whose price
    changed.
  - Detail pages give the year, make, model, odometer, **title status**
    (Craigslist has a field for it), VIN when posted, description, photos,
    posted and updated dates, and map coordinates.
- **Facebook Marketplace:** the Vehicles category, sorted newest first, filtered
  by max price and min year.
  - Radius and location are set once during `flipscout login` (Marketplace keeps
    them in the profile).
  - Detail pages give "About this vehicle" (mileage, transmission, title status,
    owners), description, photos, "Listed N days ago", and seller-profile signals
    used for dealer detection.
- **Storage:** every listing is stored with all requested fields and keyed by
  `(source, listing_id)`.
  - A `price_history` table records every price seen.
  - **A listing is reprocessed only when its price changes.** Updates to
    conversations and quotes on cars already in the pipeline don't count as
    reprocessing.
- **Distance:** computed by haversine from your home coordinates to the
  listing's map pin (or its city centroid), then multiplied by 1.25 to
  approximate road miles. Anything over 100 miles is dropped.
- **Photos:** photo URLs are stored, and the first three photos are downloaded
  for duplicate and stock-photo checks. Marketplace photo URLs expire, so
  keeping local copies matters.

### 3.2 Filter (hard rejects, each logged with a reason)

| Rule | How it's detected |
|---|---|
| Salvage / rebuilt / branded title | Title-status field plus keywords: salvage, rebuilt, reconstructed, flood, junk, lemon/buyback, bonded, "branded" |
| No title in hand | "no title", "lost title", "bill of sale only", "title in transit", "parts only", "waiting on title" |
| Lien the seller can't clear | "Lien" or "loan" alone is **not** a reject. It becomes a soft flag ("confirm payoff at the bank"). It's a reject if the seller says they owe more than the price or can't pay it off |
| Pre-1992 | year < 1992 |
| Not running | "doesn't run", "won't start", "needs engine/transmission", "blown", "mechanic special", "project", "parts car", "tow only" |
| Dealer listing | Marketplace seller with many vehicle listings or a business page; text like "financing", "buy here pay here", "doc fee", "stock #", "warranty available", "+ tax/tags"; a phone number reused across listings |
| Scam signals | Asking price below 55% of estimated market; photos that duplicate another seller's listing (perceptual hash across the DB); a stock/press photo (Claude image check on photo #1); text asking for a deposit, shipping/escrow, gift cards, Zelle up front, "text/email me at…", or "deployed/overseas" stories. **Scam-flagged listings are never contacted** |

Rejected listings appear in report section 4 with their reason, so you can catch
a filter that's wrong.

### 3.3 Value

There are two ways out of every car, and both are estimated:

- **Instant exit:** Carvana, CarMax, and one comparison buyer (KBB Instant Cash
  Offer by default).
- **Patient exit:** you list the car and sell it to a private buyer.

**Before a VIN: ESTIMATE**

- **Comparable sales:** comps are private-party asking prices for the same make
  and model, ±2 model years, ±30k miles, from the last 90 days of listings
  flipscout has stored.
  - That data is free and builds up every morning.
  - From the comps, flipscout computes a mileage-adjusted median and a
    25th–75th percentile band.
- **Instant offer estimate** = market value × `instant_offer_ratio`.
  - The ratio starts at a configured default.
  - It **recalibrates itself from every REAL quote you record** (per make or
    segment, once there are 5 or more quotes).
- **Patient estimate** = market value × `patient_sale_ratio`, minus holding
  costs.
- **Confidence levels:**
  - **HIGH:** at least 8 close comps, a tight spread, and a calibrated ratio.
  - **MEDIUM:** at least 4 comps.
  - **LOW:** anything else.
  - Expect mostly LOW for the first couple of weeks while comps accumulate.
- For walk-away math on an ESTIMATE, flipscout uses the **low end** of the band,
  not the midpoint.

**With a VIN: REAL offers**

- **VIN decode:** the free NHTSA vPIC API checks the VIN against the listing.
  A mismatch in year, make, model or trim is a red flag. Open NHTSA recalls are
  noted too.
- **Quote automation:** Carvana, CarMax and KBB ICO sell flows run in the same
  browser profile.
  - They fill in the VIN, mileage, your ZIP, and condition answers taken from
    the listing.
  - Answers are **conservative**. Anything the listing doesn't state gets the
    worse plausible answer, and nothing is ever answered better than the listing
    supports.
  - These forms want contact details. Your quote email and phone from
    `config.local.yaml` go **only** to these three sites.
- **Fallback:** if a flow hits a bot check, an unexpected page, or a required
  field it can't answer honestly, it stops. The VIN goes on the **"Needs quote"**
  list, with the condition answers pre-filled so you can enter them in about two
  minutes.
- **Expiry:** each offer is stored with its amount, buyer, the answers used, and
  its **expiry date** (read from the page when shown, otherwise the configured
  default).
  - Expired offers are flagged and re-quoted.
- **Timing:** Carvana and CarMax require the title in your name, and offers last
  about 7 days. A pre-purchase quote may therefore expire before your new title
  arrives. The report flags this, and flipscout re-quotes after titling.

### 3.4 Net profit and walk-away price

```
net = best_offer
      − purchase_price
      − VA sales & use tax       (rate × price, with a minimum)
      − title fee  [+ registration if enabled] + trip permit
      − travel                   (round-trip road miles × $/mile × trips)
      − delivery to buyer        (CarMax/KBB need a drive; Carvana picks up)
      − condition-risk buffer    (10% × best_offer)
      − insurance × hold days  − personal-property tax (if configured)
      [patient exit: also listing/detail costs]
```

`best_offer` is the best unexpired REAL offer, or the low end of the ESTIMATE if
there is no real offer yet.

**Walk-away price** is the highest purchase price that still nets the minimum
profit, capped at the $8,000 budget.

Worked example: REAL offer $9,000, 80 road-miles round trip at $0.70, $15 title,
$5 trip permit.

```
walk_away = (9000 × 0.90 − 15 − 5 − 56 − 1000) / 1.0415 = $6,744
opening offer ≈ $5,730 – $6,070
```

That example shows the reality: **the instant offer has to be about 33% above
the purchase price.** Spreads like that are uncommon, so most real candidates
will be underpriced, motivated-seller listings or patient-exit flips.

All tax and fee figures live in `config.yaml` and are marked `# VERIFY`.

### 3.5 Score (0–100, weights in config)

| Factor | Points | Rule |
|---|---|---|
| Net profit | 35 | $1,000 → 10 pts, scaling to full marks at $3,000+. Below $1,000 means watch list only |
| Confidence in resale number | 20 | REAL 20 · HIGH 16 · MEDIUM 10 · LOW 4 |
| Seller responsiveness | 10 | Not contacted 5 · replied <12h 10 · slow 3 · silent 48h 0 |
| Days listed | 10 | <48h 10 · 2–7d 7 · 8–30d 5 · >30d 3; +3 (capped at 10) if price dropped |
| Distance | 10 | ≤25 mi 10, scaling down to 2 at 100 mi |
| Red flags | 15 | Starts at 15. Soft flags subtract: lien, >200k mi, 1–2 photos, vague description, VIN mismatch, open recall, "needs minor work" |

A score of **60 or more** queues an automatic first contact (once messaging is
enabled).

## 4. Messaging and negotiation

**Channels**

- **Marketplace:** messages go through the listing's Messenger thread in the
  browser profile, and replies are read from the Marketplace inbox.
- **Craigslist:** email goes to the Craigslist relay address from your Gmail,
  and replies are read over IMAP.
- **Phone or text only:** if a Craigslist seller lists only a phone number, you
  get a **draft text** to send yourself. flipscout does not send SMS.
- **If sending fails or is blocked**, the message is saved as a draft in the
  report with the listing link, ready to copy and paste.

**First contact** (score of 60 or more, at most 5 per day). It's a short
template:

> Hi! Is your 2011 Honda Accord still available? I'm a private buyer in the
> area. Could you send me the VIN, and is the title clean and in your name? Any
> known issues I should know about? Thanks, <your first name>

**Negotiation** (only after the VIN and title questions are answered)

- **Opening offer:** 10–15% under walk-away. It's never above the asking price.
  If the asking price is already far under walk-away, flipscout offers a little
  under asking rather than lowballing a great deal, and flags it "close fast".
- **Steps:** each counter moves toward walk-away by the larger of $100 or a
  third of the remaining gap. There are at most 4 rounds.
- **Hard ceiling:** a counter **never exceeds walk-away.** This is enforced in
  code, not left to the model.
- **Wording:** every agreed price is stated as "**pending in-person
  inspection**".
- **No agreeing on an ESTIMATE alone.** Before agreeing, flipscout needs a REAL
  quote, or a patient exit with HIGH confidence. Otherwise it pauses at "needs
  quote".
- **Honesty rules:** messages are written as you, a private buyer. No invented
  competing offers, no claims about the car beyond what the seller said, and no
  pressure or urgency tactics.
  - When the walk-away really is reached, it may honestly say "that's the most I
    can do."

**Outbound guard (code, runs on every message).** A message is blocked and
turned into a **NEEDS-YOU** item if it contains any of these:

- a meeting time or date,
- an address,
- your phone number or payment details,
- money, deposit, Zelle/Venmo or cash-transfer terms,
- a price above walk-away,
- an agreement without "pending in-person inspection",
- a competing-offer claim,
- a binding phrase such as "deal" or "I'll take it" without the inspection
  condition.

**Seller asks to meet, wants a deposit, or asks for anything on that list:**
flipscout pauses the thread and marks it NEEDS-YOU with a suggested reply. A
deposit request also adds a scam flag.

**Logging:** every message, sent and received, is logged in the database along
with its direction, channel, status (sent, draft, failed or blocked) and the
guard result.

**Daily caps:** 5 first contacts and 25 messages in total. No sending between
9 PM and 8 AM.

## 5. Guardrails

- **Virginia dealer threshold.** Virginia presumes you're a dealer once you
  *offer for sale, sell, or display* 5 or more vehicles in any 12 consecutive
  months. That counts vehicles listed for sale, not only completed sales.
  - flipscout keeps a ledger: `flipscout ledger add …`, plus automatic entries
    when you mark a car bought, listed or sold.
  - **Count** = vehicles sold or offered for sale in the trailing 12 months,
    plus cars you hold now (each will be offered).
  - **At 3:** a warning banner in every report.
  - **At 4:** flipscout stops recommending purchases and switches to watch-only.
    The report shows the date the oldest entry rolls off.
  - This is not legal advice; confirm with the Virginia Motor Vehicle Dealer
    Board.
- **Title in your name before resale.** Every car's sell checklist starts with
  "title in your name at DMV". flipscout never suggests open titles, title
  skipping, or reselling on the seller's title.
- **Listing text and seller messages are data, never instructions.**
  - Untrusted text reaches Claude only inside delimited blocks.
  - Claude's output must match a fixed JSON schema (structured outputs).
  - Every action (sending, pricing, walk-away, approvals) is decided by code
    from those fields. Nothing in a listing or message can change config, raise
    a price, or trigger an action.

## 6. Daily report (HTML email plus `reports/YYYY-MM-DD.html`)

1. **Close these first:** the top 5 deals by score. Each shows asking price,
   agreed or target price, best offer (REAL or ESTIMATE, with confidence and
   expiry), net profit, distance, conversation status, and **one next action**
   for you.
2. **Active negotiations:** each thread's stage, last message from each side,
   current offer versus walk-away, and days open.
3. **Needs you:**
   - NEEDS-YOU approvals (meeting, deposit, final commitment),
   - VINs that need a quote (with pre-filled answers),
   - drafts to send,
   - offers that expire within 48 hours.
4. **Under watch and dropped:** new candidates under the threshold, and every
   rejection with its reason.
5. **Run health:**
   - listings scanned per source, new, price-dropped and detail pages opened,
   - errors, **blocks**,
   - Claude API calls and cost,
   - dealer-threshold count,
   - config values still marked VERIFY.

## 7. Data model (SQLite, `data/flipscout.db`)

`listings`, `price_history`, `photos` (with perceptual hash), `evaluations`
(filter result, valuation, net and score for each run), `comps`, `quotes`
(buyer, amount, REAL or ESTIMATE, confidence, answers, expiry), `conversations`,
`messages`, `negotiations` (walk-away, opening, steps, status), `needs_owner`
(action items), `ledger` (bought, listed and sold dates), `runs` (run health,
errors, blocks).

## 8. Where Claude (the model) is used

| Use | Why | Without an API key |
|---|---|---|
| Extracting soft fields from listings (title statements, issues, dealer and scam hints) | Free text is messy; regex misses things | Keyword rules only |
| Parsing seller replies into a schema (available, VIN, title clean or in name, lien, issues, counter price, meeting request, deposit request) | Needed for automatic negotiation | Replies go to NEEDS-YOU; no automatic negotiation |
| Stock-photo check on photo #1 | Scam filter | Duplicate-hash check only |

- **Who writes the messages:** outbound messages are **templates filled by
  code**, not free-written by the model, which keeps them honest and
  predictable.
- **Model:** default `claude-opus-5-5` at low effort, roughly **$1–2 a day** at
  around 50 calls. `claude-haiku-5-5` would cost pennies. That's your choice,
  set in config.
- **Cap:** a daily call cap prevents runaway spend.

## 9. Code layout

```
flipscout/
  PLAN.md  config.yaml  config.local.example.yaml  pyproject.toml
  flipscout/
    cli.py            run | outreach | inbox | login | quote | ledger | report | schedule
    config.py db.py   llm.py  geo.py  timebudget.py
    sources/          browser.py (persistent profile, block detection) craigslist.py facebook.py
    filters.py valuation.py costs.py scoring.py
    quotes/           carvana.py carmax.py kbb_ico.py vin.py (NHTSA)
    messaging/        templates.py guard.py negotiate.py fb_messenger.py cl_relay.py inbox.py
    guardrails.py     dealer-threshold ledger logic
    report/           render.py report.html.j2 emailer.py
    schedule/         launchd.plist.j2 windows_task.xml.j2 cron.txt
  tests/              unit tests and recorded HTML fixtures
  reports/  data/     (gitignored)
```

Python 3.11+, Playwright (Chromium), Jinja2, `anthropic`, `keyring`, `imagehash`
and `pyyaml`.

## 10. Build phases

| Phase | What I build | Gate |
|---|---|---|
| **0 (now)** | This plan and config | **Your OK** |
| 1 | DB, Craigslist and Marketplace collectors, filters, valuation, costs, scoring, report, `--dry-run`. Unit-tested here against recorded sample pages, since this sandbox can't reach the sites | — |
| 1b | **Dry run on your computer**: `flipscout login` once, then `flipscout run --dry-run`. Nothing is sent and no quotes are submitted. You can run that one command, or connect your computer to this session through Remote Control and I'll run it | **Your approval of the sample report** |
| 2 | Messaging, negotiation, quote automation, email, `flipscout schedule install` (06:00 run, 08:00 outreach) | Enabled only after 1b approval |

## 11. Risks and limits

- **Platform terms.** Meta's terms prohibit automated data collection and
  automated messaging on Facebook, and Craigslist's terms prohibit automated
  access.
  - Low volume and your real account and IP lower the chance of enforcement, but
    don't remove it. The realistic worst case is a restricted Facebook account.
  - If that happens, flipscout stops and reports it. It does not work around it.
- **Quote automation is fragile.** Carvana, CarMax and KBB change their flows
  often and use bot protection. Expect the "Needs quote" list to be used
  regularly.
- **Valuations start thin.** They are LOW confidence until a few weeks of comps
  and some real quotes have built up.
- **Tax and fee figures** are my best understanding as of this writing. Verify
  every `# VERIFY` value before go-live.
- **Your computer must be awake** at 06:00 and 08:00. If it isn't, the run
  happens at the next wake, and the report says so.
