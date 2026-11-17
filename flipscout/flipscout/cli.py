"""flipscout command line."""
from __future__ import annotations

import argparse
import getpass
import json
import shutil
import sys
import webbrowser
from datetime import date, datetime
from pathlib import Path

import yaml

from .config import load_config, project_root
from .db import DB, dec, now_iso


# ---- helpers ------------------------------------------------------------------------
def _logger(cfg):
    log_dir = cfg.path("storage.log_dir", "data/logs")
    log_dir.mkdir(parents=True, exist_ok=True)
    f = log_dir / f"{date.today().isoformat()}.log"

    def log(msg: str) -> None:
        line = f"{datetime.now():%H:%M:%S} {msg}"
        print(line, flush=True)
        with f.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    return log


def _db(cfg) -> DB:
    return DB(cfg.path("storage.db_path", "data/flipscout.db"))


def _fetcher_factory(cfg, args, log):
    fixtures = getattr(args, "fixtures", None)

    def make(_kind: str):
        if fixtures:
            from .sources.fetch import FixtureFetcher
            return FixtureFetcher(Path(fixtures))
        from .sources.fetch import BrowserFetcher
        import os
        headless = cfg.get("browser.headless", False) if getattr(args, "headless", None) is None else args.headless
        return BrowserFetcher(cfg.path("sources.facebook.browser_profile_dir", "~/.flipscout/browser-profile"),
                              headless=headless, min_delay=float(cfg.get("sources.politeness.min_delay_seconds", 4)),
                              max_delay=float(cfg.get("sources.politeness.max_delay_seconds", 9)),
                              executable_path=os.environ.get("FLIPSCOUT_CHROMIUM") or cfg.get("browser.executable_path") or None,
                              log=log)
    return make


def _listing_or_die(db: DB, ref: str):
    row = db.listing(int(str(ref).lstrip("#")))
    if not row:
        sys.exit(f"No listing #{ref}")
    return row


def _write_local(cfg, updates: dict) -> None:
    p = cfg.root / "config.local.yaml"
    data = yaml.safe_load(p.read_text()) if p.exists() else {}
    data = data or {}
    for k, v in updates.items():
        cur = data
        parts = k.split(".")
        for part in parts[:-1]:
            cur = cur.setdefault(part, {})
        cur[parts[-1]] = v
    p.write_text("# Local only (gitignored). Overrides config.yaml.\n" + yaml.safe_dump(data, sort_keys=False))


def _email_report(cfg, path: Path, data: dict, log) -> None:
    from .mailer import send_email
    from .report.build import render_text
    to = cfg.owner.get("report_email")
    n_need = len(data["needs"]) + len(data["needs_quote"]) + len([d for d in data["drafts"] if d["status"] in ("draft", "blocked")])
    subj = f"flipscout {date.today():%b %d}: {len(data['top'])} deal(s), {n_need} need you" + (" [DRY RUN]" if data["dry_run"] else "")
    if data["blocks"]:
        subj += " [BLOCKED]"
    send_email(cfg, to, subj, render_text(data), path.read_text(encoding="utf-8"))
    log(f"[report] emailed to {to}")


# ---- commands --------------------------------------------------------------------------
def cmd_setup(args) -> int:
    root = project_root()
    local = root / "config.local.yaml"
    print(f"flipscout lives in {root}")
    data = yaml.safe_load(local.read_text()) if local.exists() else {}
    data = data or {}
    owner = data.get("owner", {}) or {}

    def ask(key, prompt, default=""):
        cur = owner.get(key) or default
        val = input(f"{prompt}{f' [{cur}]' if cur else ''}: ").strip()
        owner[key] = val or cur

    ask("first_name", "Your first name (signs seller messages)")
    ask("report_email", "Gmail address for the daily report")
    ask("home_zip", "Home ZIP code")
    owner["needs_owner_label"] = owner.get("needs_owner_label") or f"NEEDS {owner['first_name'].upper()}"
    owner["quote_contact_email"] = owner.get("quote_contact_email") or owner["report_email"]
    if not owner.get("home_lat"):
        from .geo import lookup_place
        ll = lookup_place(owner["home_zip"], None, allow_network=True)
        if ll:
            owner["home_lat"], owner["home_lon"] = ll
        else:
            owner["home_lat"] = float(input("Couldn't look up that ZIP. Home latitude: "))
            owner["home_lon"] = float(input("Home longitude: "))
    owner.setdefault("quote_contact_phone", "")
    data["owner"] = owner
    local.write_text("# Local only (gitignored). Overrides config.yaml.\n" + yaml.safe_dump(data, sort_keys=False))
    cfg = load_config(root)
    _db(cfg)
    print(f"\nSaved {local}\nDatabase ready at {cfg.path('storage.db_path')}\n")
    print("Next steps:\n  flipscout doctor\n  flipscout login\n  flipscout run --dry-run")
    return 0


def cmd_doctor(args) -> int:
    cfg = load_config()
    ok = True

    def line(good, msg, fix=""):
        nonlocal ok
        ok = ok and good
        print(f"  [{'ok' if good else '!!'}] {msg}" + (f"\n        fix: {fix}" if fix and not good else ""))

    print(f"flipscout at {cfg.root}")
    line(sys.version_info >= (3, 10), f"Python {sys.version.split()[0]}", "install Python 3.10+")
    line(bool(cfg.owner.get("report_email") and cfg.home()), "config.local.yaml has your email + home location", "flipscout setup")
    try:
        db = _db(cfg)
        line(True, f"database {cfg.path('storage.db_path')} ({db.one('SELECT COUNT(*) n FROM listings')['n']} listings)")
    except Exception as e:
        line(False, f"database: {e}")
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            exe = Path(p.chromium.executable_path)
        line(exe.exists(), "Playwright Chromium installed", "python -m playwright install chromium")
    except Exception as e:
        line(False, f"Playwright: {e}", "pip install playwright && python -m playwright install chromium")
    prof = cfg.path("sources.facebook.browser_profile_dir")
    line(prof.exists() and any(prof.iterdir()), f"browser profile {prof}", "flipscout login")
    from .llm import api_key
    line(bool(api_key(cfg)), "Claude API key (env var or keychain)", "flipscout llm setup   (optional; without it replies come to you)")
    from .mailer import app_password
    line(bool(app_password(cfg)), "Gmail App Password in keychain", "flipscout email setup   (needed to email the report)")
    print(f"  mode: dry_run={cfg.dry_run} messaging_enabled={cfg.get('mode.messaging_enabled')} email_report={cfg.get('mode.email_report')}")
    unv = cfg.unverified()
    if unv:
        print(f"  VERIFY items still open ({len(unv)}): {', '.join(unv)}")
    return 0 if ok else 1


def cmd_login(args) -> int:
    cfg = load_config()
    log = _logger(cfg)
    from .sources.fetch import BrowserFetcher
    import os
    f = BrowserFetcher(cfg.path("sources.facebook.browser_profile_dir"), headless=False, min_delay=0, max_delay=0,
                       executable_path=os.environ.get("FLIPSCOUT_CHROMIUM") or None, log=log)
    try:
        f.page.goto("https://www.facebook.com/marketplace/category/vehicles", wait_until="domcontentloaded")
        print("""
A browser window opened with flipscout's own profile.
  1. Log into Facebook yourself (flipscout never sees your password).
  2. In Marketplace > Vehicles, click the location filter and set your ZIP with a 100-mile radius.
  3. Come back here and press Enter.""")
        input()
        from .sources.facebook import logged_in
        txt = f.page.inner_text("body")
        print("Logged in to Facebook: " + ("yes" if logged_in(txt, f.page.content()) else "NO, try again"))
    finally:
        f.close()
    return 0


def cmd_run(args) -> int:
    overrides = {}
    if args.dry_run:
        overrides["mode"] = {"dry_run": True}
    if args.live:
        overrides["mode"] = {"dry_run": False}
    cfg = load_config(overrides=overrides or None)
    log = _logger(cfg)
    db = _db(cfg)
    from .pipeline import run_morning
    from .report.build import write_report
    sources = args.sources.split(",") if args.sources else None
    log(f"[run] starting ({'DRY RUN' if cfg.dry_run else 'LIVE'})")
    ctx = run_morning(cfg, db, _fetcher_factory(cfg, args, log), dry_run=cfg.dry_run, sources=sources,
                      allow_network=not args.fixtures, use_deadline=not args.fixtures, log=log)
    path, data = write_report(cfg, db, ctx.run_id, sample=bool(args.sample))
    log(f"[run] report saved: {path}")
    want_email = args.email or (cfg.get("mode.email_report") and not cfg.dry_run and not args.no_email)
    if want_email:
        try:
            _email_report(cfg, path, data, log)
        except Exception as e:
            log(f"[report] email failed: {e}")
    if args.open:
        webbrowser.open(path.resolve().as_uri())
    return 0


def cmd_outreach(args) -> int:
    cfg = load_config()
    log = _logger(cfg)
    from .outreach import run_outreach
    res = run_outreach(cfg, _db(cfg), _fetcher_factory(cfg, args, log), log, force_hours=args.force_hours)
    print(json.dumps(res, indent=2))
    return 0


def cmd_report(args) -> int:
    cfg = load_config()
    log = _logger(cfg)
    db = _db(cfg)
    from .report.build import write_report
    path, data = write_report(cfg, db)
    print(path)
    if args.email:
        _email_report(cfg, path, data, log)
    if args.open:
        webbrowser.open(path.resolve().as_uri())
    return 0


def cmd_demo(args) -> int:
    """Build a sample report from the bundled made-up fixtures (temp database)."""
    import tempfile
    from .demo import build_demo
    cfg = load_config()
    out = build_demo(cfg, Path(tempfile.mkdtemp()))
    dest = cfg.path("storage.reports_dir", "reports") / "sample-report.html"
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(out, dest)
    print(dest)
    if args.open:
        webbrowser.open(dest.resolve().as_uri())
    return 0


def cmd_listing(args) -> int:
    cfg = load_config()
    db = _db(cfg)
    row = _listing_or_die(db, args.id)
    ev = db.latest_eval(row["id"]) or {}
    print(f"#{row['id']} {row['title']}  [{row['source']}]  {row['url']}")
    print(f"  asking ${row['price'] or 0:,}  miles {row['mileage']}  title {row['title_status']}  VIN {row['vin']}")
    print(f"  status {row['status']}  score {ev.get('score')}  {row['reject_reason'] or ''}")
    for e in ev.get("exits", []):
        print(f"  exit {e['exit']:8} {e['kind']:8} {e['confidence']:6} offer ${e['offer']:,}  walk-away {e.get('walk_away')}  net {e.get('net')}")
    for m in db.q("SELECT * FROM messages WHERE listing_pk = ? ORDER BY id", (row["id"],)):
        print(f"  [{m['direction']}/{m['status']}] {m['body'][:200]!r}")
    return 0


def cmd_reply(args) -> int:
    cfg = load_config()
    db = _db(cfg)
    row = _listing_or_die(db, args.id)
    text = Path(args.file).read_text() if args.file else args.text
    from .llm import LLM
    from .outreach import handle_inbound
    live = (not cfg.dry_run) and bool(cfg.get("mode.messaging_enabled"))
    act = handle_inbound(cfg, db, LLM(cfg, db), row["id"], text, live=live)
    print(f"Decision: {act.type} {act.kind} {act.amount or ''} -> stage {act.stage}")
    if act.text:
        print(f"Reply ({'queued for next outreach' if live else 'planned only; messaging is off'}):\n{act.text}")
    for k, s in act.needs:
        print(f"{cfg.needs_label}: {s}")
    return 0


def cmd_quote(args) -> int:
    cfg = load_config()
    db = _db(cfg)
    from .quotes import assist
    if args.action == "list":
        for item in assist.needs_quote_items(db, cfg):
            L = item["listing"]
            print(f"#{L['id']} {L['title']}  VIN {L['vin']}  need: {', '.join(item['missing'])}")
        return 0
    row = _listing_or_die(db, args.id)
    if args.action == "add":
        if not (args.buyer and args.amount):
            sys.exit("quote add needs --buyer and --amount")
        qid = assist.record_quote(db, cfg, row["id"], args.buyer, int(args.amount), args.expires, args.note or "")
        print(f"Recorded REAL {args.buyer} offer ${int(args.amount):,} for #{row['id']} (quote {qid}). Re-scoring...")
        from .pipeline import Ctx, evaluate
        ctx = Ctx(cfg, db, cfg.dry_run, print, True, None)
        from . import valuation
        ctx.model = valuation.fit_market_model(db, cfg)
        ev = evaluate(ctx, row["id"])
        b = ev.get("best") or {}
        print(f"  best exit: {b.get('exit')} {b.get('kind')} ${b.get('offer') or 0:,}, walk-away {b.get('walk_away')}, net {b.get('net')}")
        return 0
    if args.action == "assist":
        d = dict(row)
        ans = assist.conservative_answers(d)
        print(f"#{row['id']} {row['title']}\n  VIN: {row['vin'] or '(none yet: ask the seller)'}\n  Answer conservatively:")
        print(assist.format_answers(ans))
        buyers = cfg.get("valuation.instant.buyers", ["carvana", "carmax", "kbb_ico"])
        if not args.no_browser:
            from .sources.fetch import BrowserFetcher
            import os
            f = BrowserFetcher(cfg.path("sources.facebook.browser_profile_dir"), headless=False, min_delay=0, max_delay=0,
                               executable_path=os.environ.get("FLIPSCOUT_CHROMIUM") or None)
            try:
                assist.open_sell_pages(f, buyers)
                print("\nSell pages opened in the browser. Enter each offer below (blank to skip).")
                for b in buyers:
                    amt = input(f"  {b} offer $: ").strip().replace(",", "").replace("$", "")
                    if amt:
                        exp = input(f"  {b} offer expires (YYYY-MM-DD, blank = default): ").strip() or None
                        assist.record_quote(db, cfg, row["id"], b, int(float(amt)), exp, answers=ans)
            finally:
                f.close()
        return 0
    return 1


def cmd_ledger(args) -> int:
    cfg = load_config()
    db = _db(cfg)
    from .guardrails import dealer_status
    if args.action == "add":
        if not (args.event and args.date and args.vehicle):
            sys.exit("ledger add needs --event, --date and --vehicle")
        db.insert("ledger", {"vehicle": args.vehicle, "vin": (args.vin or "").upper() or None, "event": args.event,
                             "event_date": args.date, "price": args.price, "listing_pk": args.listing, "note": args.note})
    for r in db.q("SELECT * FROM ledger ORDER BY event_date"):
        print(f"  {r['event_date']}  {r['event']:7} {r['vehicle']}  {r['vin'] or ''}  {('$' + format(r['price'], ',')) if r['price'] else ''}")
    print(dealer_status(db, cfg).message)
    return 0


def cmd_needs(args) -> int:
    cfg = load_config()
    db = _db(cfg)
    if args.resolve:
        db.x("UPDATE needs_owner SET resolved_at = ? WHERE id = ?", (now_iso(), args.resolve))
    for n in db.open_needs():
        print(f"  [{n['id']}] {n['summary']}")
        if n["detail"]:
            print("      " + n["detail"].replace("\n", "\n      "))
    return 0


def cmd_mark(args) -> int:
    cfg = load_config()
    db = _db(cfg)
    row = _listing_or_die(db, args.id)
    db.update("listings", "id", row["id"], {"status": args.status})
    if args.status in ("bought", "listed", "sold"):
        db.insert("ledger", {"vehicle": row["title"], "vin": row["vin"], "event": args.status, "listing_pk": row["id"],
                             "event_date": args.date or date.today().isoformat(), "price": args.price})
        from .guardrails import dealer_status
        print(dealer_status(db, cfg).message)
    if args.status == "bought":
        print("Reminder: title it in your name at DMV before reselling, then re-quote (offers expire).")
    print(f"#{row['id']} marked {args.status}")
    return 0


def cmd_email(args) -> int:
    cfg = load_config()
    from .mailer import send_email, store_app_password
    if args.action == "setup":
        print("Create a Gmail App Password: Google Account > Security > 2-Step Verification > App passwords.")
        pw = getpass.getpass("Paste the 16-character App Password (hidden): ")
        store_app_password(cfg, pw)
        print("Saved to your OS keychain.")
    if args.action in ("setup", "test"):
        send_email(cfg, cfg.owner.get("report_email"), "flipscout test email", "flipscout can send you email.")
        print(f"Test email sent to {cfg.owner.get('report_email')}")
    return 0


def cmd_llm(args) -> int:
    cfg = load_config()
    if args.action == "setup":
        import keyring
        key = getpass.getpass("Paste your Anthropic API key (hidden): ").strip()
        keyring.set_password("flipscout-anthropic", "api_key", key)
        print("Saved to your OS keychain.")
    from .llm import LLM
    db = _db(cfg)
    llm = LLM(cfg, db)
    out = llm.extract_listing("2010 Honda Civic LX", "Runs great, clean title in hand, new tires. Small dent on bumper.", {})
    print("Claude test:", "OK" if out else f"FAILED ({llm.disabled_reason or 'see log'})")
    return 0 if out else 1


def cmd_schedule(args) -> int:
    cfg = load_config()
    from .schedule import install as sch
    fn = {"install": sch.install, "remove": sch.remove, "status": sch.status}[args.action]
    if args.action == "install" and cfg.dry_run:
        print("Note: mode.dry_run is true, so scheduled runs will scan and report but send nothing.")
    for m in fn(cfg):
        print(m)
    return 0


def cmd_mode(args) -> int:
    cfg = load_config()
    if args.mode == "live":
        print("Live mode: seller messages are sent automatically (within all guardrails) and the report is emailed.")
        if input("Type 'yes' to turn messaging on: ").strip().lower() != "yes":
            print("Unchanged.")
            return 1
        _write_local(cfg, {"mode.dry_run": False, "mode.messaging_enabled": True, "mode.email_report": True})
    elif args.mode == "report-only":
        _write_local(cfg, {"mode.dry_run": False, "mode.messaging_enabled": False, "mode.email_report": True})
    else:
        _write_local(cfg, {"mode.dry_run": True, "mode.messaging_enabled": False})
    cfg = load_config()
    print(f"mode: dry_run={cfg.dry_run} messaging_enabled={cfg.get('mode.messaging_enabled')} email_report={cfg.get('mode.email_report')}")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="flipscout", description="Private-party car flip scout")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("setup", help="first-time setup (writes config.local.yaml)")
    sub.add_parser("doctor", help="check that everything is installed and configured")
    sub.add_parser("login", help="open the browser profile so you can log into Facebook")

    r = sub.add_parser("run", help="the morning scan + report")
    r.add_argument("--dry-run", action="store_true", help="force dry run (nothing sent)")
    r.add_argument("--live", action="store_true", help="force live mode (respects messaging_enabled)")
    r.add_argument("--sources", help="craigslist,facebook")
    r.add_argument("--fixtures", help=argparse.SUPPRESS)
    r.add_argument("--sample", action="store_true", help=argparse.SUPPRESS)
    r.add_argument("--headless", action="store_true", default=None)
    r.add_argument("--email", action="store_true", help="email the report even in dry run")
    r.add_argument("--no-email", action="store_true")
    r.add_argument("--open", action="store_true", help="open the report in your browser")

    o = sub.add_parser("outreach", help="read replies + send queued messages (8:00 job)")
    o.add_argument("--force-hours", action="store_true")
    o.add_argument("--headless", action="store_true", default=None)

    rp = sub.add_parser("report", help="rebuild today's report from the database")
    rp.add_argument("--email", action="store_true")
    rp.add_argument("--open", action="store_true")

    d = sub.add_parser("demo", help="build a sample report from made-up listings")
    d.add_argument("--open", action="store_true")

    li = sub.add_parser("listing", help="show one listing")
    li.add_argument("id")

    rr = sub.add_parser("reply", help="log a seller reply you received (e.g. by text) and get the next step")
    rr.add_argument("id")
    rr.add_argument("text", nargs="?", default="")
    rr.add_argument("--file")

    q = sub.add_parser("quote", help="instant-offer quotes")
    q.add_argument("action", choices=["assist", "add", "list"])
    q.add_argument("id", nargs="?")
    q.add_argument("--buyer")
    q.add_argument("--amount")
    q.add_argument("--expires")
    q.add_argument("--note")
    q.add_argument("--no-browser", action="store_true")

    lg = sub.add_parser("ledger", help="cars bought/listed/sold (Virginia dealer threshold)")
    lg.add_argument("action", choices=["add", "list"])
    lg.add_argument("--event", choices=["bought", "listed", "sold"])
    lg.add_argument("--date")
    lg.add_argument("--vehicle")
    lg.add_argument("--vin")
    lg.add_argument("--price", type=int)
    lg.add_argument("--listing", type=int)
    lg.add_argument("--note")

    n = sub.add_parser("needs", help="items that need you")
    n.add_argument("--resolve", type=int)

    m = sub.add_parser("mark", help="mark a listing dead/bought/listed/sold")
    m.add_argument("id")
    m.add_argument("--status", required=True, choices=["dead", "bought", "listed", "sold", "watch"])
    m.add_argument("--date")
    m.add_argument("--price", type=int)

    e = sub.add_parser("email", help="Gmail App Password setup/test")
    e.add_argument("action", choices=["setup", "test"])

    lm = sub.add_parser("llm", help="Anthropic API key setup/test")
    lm.add_argument("action", choices=["setup", "test"])

    s = sub.add_parser("schedule", help="install/remove the daily jobs")
    s.add_argument("action", choices=["install", "remove", "status"])

    md = sub.add_parser("mode", help="switch dry-run / report-only / live")
    md.add_argument("mode", choices=["dry", "report-only", "live"])

    args = p.parse_args(argv)
    fn = {"setup": cmd_setup, "doctor": cmd_doctor, "login": cmd_login, "run": cmd_run, "outreach": cmd_outreach,
          "report": cmd_report, "demo": cmd_demo, "listing": cmd_listing, "reply": cmd_reply, "quote": cmd_quote,
          "ledger": cmd_ledger, "needs": cmd_needs, "mark": cmd_mark, "email": cmd_email, "llm": cmd_llm,
          "schedule": cmd_schedule, "mode": cmd_mode}[args.cmd]
    return fn(args) or 0


if __name__ == "__main__":
    raise SystemExit(main())
