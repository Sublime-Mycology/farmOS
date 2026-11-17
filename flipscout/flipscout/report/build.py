"""Assemble and render the daily report (HTML + plain text)."""
from __future__ import annotations

from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

from jinja2 import Environment, FileSystemLoader, select_autoescape

from ..db import DB, dec
from ..guardrails import dealer_status
from ..quotes.assist import needs_quote_items

ACTIVE = ("contacted", "info", "negotiating", "awaiting_quote", "agreed", "paused", "stalled")
STAGE_LABEL = {
    None: "Not contacted", "planned": "Not contacted", "contacted": "Asked about car, waiting on seller",
    "info": "Getting VIN/title info", "awaiting_quote": "Waiting on instant-offer quotes",
    "negotiating": "Negotiating", "agreed": "Agreed (pending inspection)", "paused": "Paused: needs you",
    "stalled": "Seller above walk-away", "dead": "Closed",
}


def _money(v) -> str:
    return "—" if v is None else f"${float(v):,.0f}"


def _days_between(iso: Optional[str]) -> Optional[int]:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).days
    except ValueError:
        return None


def _deal_row(db: DB, cfg, row, needs_by_listing: dict, dry: bool) -> dict:
    ev = db.latest_eval(row["id"]) or {}
    best = ev.get("best") or {}
    neg = db.one("SELECT * FROM negotiations WHERE listing_pk = ?", (row["id"],))
    conv = db.one("SELECT * FROM conversations WHERE listing_pk = ?", (row["id"],))
    stage = neg["stage"] if neg and neg["stage"] else (conv["status"] if conv else None)
    pending = db.one("SELECT status, kind FROM messages WHERE listing_pk = ? AND direction = 'out' ORDER BY id DESC LIMIT 1", (row["id"],))
    threshold = int(cfg.get("scoring.auto_contact_threshold", 60))
    label = cfg.needs_label

    if row["id"] in needs_by_listing:
        action = f"{label}: " + needs_by_listing[row["id"]][0]["summary"].split(": ", 1)[-1]
    elif neg and neg["stage"] == "agreed":
        action = f"{label}: schedule a viewing (agreed {_money(neg['agreed_price'])} pending inspection)"
    elif row["vin"] and best.get("kind") != "REAL":
        action = f"Get instant offers for VIN {row['vin']}: run `flipscout quote assist {row['id']}`"
    elif pending and pending["status"] == "planned":
        what = "first message" if pending["kind"] == "first_contact" else f"{pending['kind'].replace('_', ' ')} reply"
        action = f"Dry run: {what} drafted, not sent (see section 3)" if dry else f"{what.capitalize()} drafted (messaging is off)"
    elif pending and pending["status"] == "queued":
        action = f"Message goes out at {cfg.get('schedule.outreach_time', '08:00')}"
    elif pending and pending["status"] in ("draft", "blocked"):
        action = f"{label}: send the saved draft yourself (section 3)"
    elif stage in ("contacted", "info", "negotiating"):
        action = "Waiting on seller's reply"
    elif (ev.get("score") or 0) < threshold:
        action = f"Watching (score under {threshold}). Message the seller yourself if you like it"
    else:
        action = "Review listing"

    target = None
    if neg and neg["agreed_price"]:
        target = ("agreed", neg["agreed_price"])
    elif neg and neg["our_last_offer"]:
        target = ("offered", neg["our_last_offer"])
    elif best.get("target"):
        target = ("target", best["target"])
    flags = dec(row["flags"], []) or []
    return {
        "id": row["id"], "title": row["title"], "url": row["url"], "source": row["source"],
        "asking": row["price"], "prev_price": row["prev_price"], "target": target, "walk_away": best.get("walk_away"),
        "offer": best.get("offer"), "offer_mid": best.get("offer_mid"), "offer_kind": best.get("kind"),
        "offer_conf": best.get("confidence"), "offer_buyer": best.get("buyer"), "offer_exit": best.get("exit"),
        "offer_expires": best.get("expires"), "net": best.get("net"), "net_at_asking": best.get("net_at_asking"),
        "net_at_target": best.get("net_at_target"), "buy_at": best.get("buy_at"),
        "close_fast": best.get("close_fast"), "distance": row["distance_mi"], "distance_approx": bool(row["distance_approx"]),
        "stage": STAGE_LABEL.get(stage, stage or "Not contacted"), "action": action, "score": ev.get("score"),
        "score_parts": ev.get("score_parts") or {}, "flags": flags, "mileage": row["mileage"],
        "age": row["listing_age_days"], "market": (ev.get("valuation") or {}).get("market") or {},
        "breakdown": best.get("breakdown") or {}, "vin": row["vin"],
    }


def build_report_data(cfg, db: DB, run_id: Optional[int] = None, sample: bool = False) -> dict:
    tz = ZoneInfo(cfg.get("schedule.timezone", "America/New_York"))
    run = db.one("SELECT * FROM runs WHERE id = ?", (run_id,)) if run_id else db.one(
        "SELECT * FROM runs WHERE kind = 'morning' ORDER BY id DESC LIMIT 1")
    dry = bool(run["dry_run"]) if run else cfg.dry_run
    needs = [dict(n) for n in db.open_needs()]
    needs_by_listing: dict[int, list] = {}
    for n in needs:
        if n["listing_pk"]:
            needs_by_listing.setdefault(n["listing_pk"], []).append(n)

    rows = db.q(f"SELECT * FROM listings WHERE status IN ('candidate', {','.join('?' * len(ACTIVE))})", ACTIVE)
    deals = [_deal_row(db, cfg, r, needs_by_listing, dry) for r in rows if r["status"] not in ("dead",)]
    deals.sort(key=lambda d: (d["score"] or 0), reverse=True)
    top_n = int(cfg.get("scoring.top_n_in_report", 5))
    top = [d for d in deals if d["stage"] not in (STAGE_LABEL["stalled"],)][:top_n]

    negotiations = []
    for nrow in db.q("SELECT n.*, l.title, l.url, l.price FROM negotiations n JOIN listings l ON l.id = n.listing_pk "
                     "WHERE n.stage NOT IN ('dead') ORDER BY n.updated_at DESC"):
        last_in = db.one("SELECT body, created_at FROM messages WHERE listing_pk = ? AND direction = 'in' ORDER BY id DESC LIMIT 1", (nrow["listing_pk"],))
        last_out = db.one("SELECT body, created_at, status FROM messages WHERE listing_pk = ? AND direction = 'out' ORDER BY id DESC LIMIT 1", (nrow["listing_pk"],))
        conv = db.one("SELECT first_contact_at FROM conversations WHERE listing_pk = ?", (nrow["listing_pk"],))
        negotiations.append({
            "id": nrow["listing_pk"], "title": nrow["title"], "url": nrow["url"], "asking": nrow["price"],
            "stage": STAGE_LABEL.get(nrow["stage"], nrow["stage"]), "walk_away": nrow["walk_away"],
            "our_last": nrow["our_last_offer"], "seller_ask": nrow["seller_last_ask"], "rounds": nrow["rounds"],
            "agreed": nrow["agreed_price"], "last_in": dict(last_in) if last_in else None,
            "last_out": dict(last_out) if last_out else None,
            "days_open": _days_between(conv["first_contact_at"]) if conv else None,
        })

    drafts = [dict(m) | {"title": (db.listing(m["listing_pk"]) or {"title": ""})["title"],
                         "url": (db.listing(m["listing_pk"]) or {"url": ""})["url"], "guard": dec(m["guard"], {})}
              for m in db.q("SELECT * FROM messages WHERE direction = 'out' AND status IN ('planned','draft','blocked','queued') ORDER BY id")]
    nq = needs_quote_items(db, cfg)

    watch, dropped = [], []
    if run:
        evs = db.q("SELECT e.data, l.title, l.url, l.price, l.source FROM evaluations e JOIN listings l ON l.id = e.listing_pk "
                   "WHERE e.run_id = ? ORDER BY e.id", (run["id"],))
        for e in evs:
            d = dec(e["data"], {})
            item = {"id": d.get("listing_id"), "title": e["title"], "url": e["url"], "price": e["price"], "source": e["source"]}
            if d.get("status") == "rejected":
                dropped.append(item | {"reason": d.get("reject"), "category": d.get("reject_category")})
            elif d.get("status") == "watch":
                b = d.get("best") or {}
                watch.append(item | {"reason": "; ".join(d.get("watch_reasons") or []) or "under score threshold",
                                     "score": d.get("score"), "net": b.get("net"), "conf": b.get("confidence")})
            elif d.get("status") == "candidate" and (d.get("score") or 0) < int(cfg.get("scoring.auto_contact_threshold", 60)):
                b = d.get("best") or {}
                watch.append(item | {"reason": f"candidate, score {d.get('score')} (under contact threshold)",
                                     "score": d.get("score"), "net": b.get("net"), "conf": b.get("confidence")})
    watch.sort(key=lambda w: (w.get("score") or 0), reverse=True)

    stats = dec(run["stats"], {}) if run else {}
    errors = dec(run["errors"], []) if run else []
    blocks = dec(run["blocks"], []) if run else []
    llm_today = db.one("SELECT COUNT(*) AS n, COALESCE(SUM(cost),0) AS c FROM llm_usage WHERE day = ?", (date.today().isoformat(),))
    ds = dealer_status(db, cfg)
    started = run["started_at"] if run else None
    finished = run["finished_at"] if run else None
    now_local = datetime.now(tz)
    return {
        "date": f"{now_local:%A, %B} {now_local.day}, {now_local.year}",
        "generated": f"{(now_local.hour % 12) or 12}:{now_local.minute:02d} {'AM' if now_local.hour < 12 else 'PM'} {now_local.tzname()}",
        "dry_run": dry, "sample": sample, "label": cfg.needs_label, "top": top, "negotiations": negotiations,
        "needs": needs, "needs_quote": nq, "drafts": drafts, "watch": watch[:25], "watch_total": len(watch),
        "dropped": dropped, "stats": stats, "errors": errors, "blocks": blocks,
        "llm_calls": llm_today["n"] if llm_today else 0, "llm_cost": llm_today["c"] if llm_today else 0.0,
        "dealer": ds, "unverified": cfg.unverified(), "run_started": started, "run_finished": finished,
        "min_profit": cfg.get("profit.min_net_profit", 1000), "threshold": cfg.get("scoring.auto_contact_threshold", 60),
        "budget": cfg.get("search.budget_max_purchase", 8000), "outreach_time": cfg.get("schedule.outreach_time", "08:00"),
    }


def _env() -> Environment:
    env = Environment(loader=FileSystemLoader(str(Path(__file__).parent)), autoescape=select_autoescape(["html", "j2"]))
    env.filters["money"] = _money
    env.filters["miles"] = lambda v: "—" if v is None else f"{v:,.0f}"
    return env


def render_html(data: dict) -> str:
    return _env().get_template("report.html.j2").render(**data)


def render_text(data: dict) -> str:
    lines = [f"flipscout daily report: {data['date']}"]
    if data["sample"]:
        lines.append("SAMPLE DATA: not real listings.")
    if data["dry_run"]:
        lines.append("DRY RUN: no messages were sent.")
    for b in data["blocks"]:
        lines.append(f"BLOCKED: {b}")
    lines.append(data["dealer"].message)
    lines.append("\n1. CLOSE THESE FIRST")
    for i, d in enumerate(data["top"], 1):
        offer = f"{_money(d['offer'])} {d['offer_kind'] or ''} ({d['offer_conf'] or ''}, {d['offer_buyer'] or ''})"
        tgt = f"{d['target'][0]} {_money(d['target'][1])}" if d["target"] else "—"
        lines.append(f"{i}. [{d['score']}] {d['title']}: asking {_money(d['asking'])}, {tgt}, best offer {offer}, "
                     f"net {_money(d['net'])}, {d['distance'] or '?'} mi, {d['stage']}\n   NEXT: {d['action']}\n   {d['url']}")
    if not data["top"]:
        lines.append("Nothing clears your criteria today.")
    lines.append("\n2. ACTIVE NEGOTIATIONS")
    for n in data["negotiations"]:
        lines.append(f"- {n['title']}: {n['stage']}; our last {_money(n['our_last'])}, seller {_money(n['seller_ask'])}, walk-away {_money(n['walk_away'])}")
    if not data["negotiations"]:
        lines.append("None.")
    lines.append(f"\n3. NEEDS YOU ({data['label']})")
    for n in data["needs"]:
        lines.append(f"- {n['summary']}")
    for q in data["needs_quote"]:
        lines.append(f"- Quote needed: VIN {q['listing']['vin']} ({q['listing']['title']}) from {', '.join(q['missing'])}")
    for m in data["drafts"]:
        lines.append(f"- Draft ({m['status']}) for {m['title']}:\n    {m['body'].replace(chr(10), chr(10) + '    ')}")
    lines.append("\n4. UNDER WATCH / DROPPED")
    for w in data["watch"][:10]:
        lines.append(f"- watch: {w['title']} {_money(w['price'])}: {w['reason']}")
    for d in data["dropped"][:15]:
        lines.append(f"- dropped: {d['title']} {_money(d['price'])}: {d['reason']}")
    lines.append("\n5. RUN HEALTH")
    for src, st in (data["stats"] or {}).items():
        lines.append(f"- {src}: {st.get('seen', 0)} seen, {st.get('new', 0)} new, {st.get('price_changed', 0)} price changes, "
                     f"{st.get('details', 0)} detail pages{' BLOCKED' if st.get('blocked') else ''}")
    for e in data["errors"]:
        lines.append(f"- error: {e}")
    lines.append(f"- Claude calls today: {data['llm_calls']} (${data['llm_cost']:.2f})")
    if data["unverified"]:
        lines.append(f"- Config values still marked VERIFY: {', '.join(data['unverified'])}")
    return "\n".join(lines)


def write_report(cfg, db: DB, run_id: Optional[int] = None, sample: bool = False, name: Optional[str] = None) -> tuple[Path, dict]:
    data = build_report_data(cfg, db, run_id, sample)
    out_dir = cfg.path("storage.reports_dir", "reports")
    out_dir.mkdir(parents=True, exist_ok=True)
    fname = name or (datetime.now(ZoneInfo(cfg.get("schedule.timezone", "America/New_York"))).strftime("%Y-%m-%d") + ".html")
    path = out_dir / fname
    path.write_text(render_html(data), encoding="utf-8")
    return path, data
