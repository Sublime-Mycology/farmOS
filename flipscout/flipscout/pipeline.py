"""The 6:00 AM run: collect -> filter -> value -> score -> plan first contacts -> report."""
from __future__ import annotations

import json
import traceback
from dataclasses import asdict
from datetime import datetime, time as dtime, timezone
from pathlib import Path
from typing import Callable, Optional
from zoneinfo import ZoneInfo

from . import costs, filters, geo, scoring, valuation
from .db import DB, dec, now_iso
from .guardrails import dealer_status
from .llm import LLM
from .messaging import guard, templates
from .messaging.negotiate import opening_offer
from .parsing import Listing, parse_ymm
from .sources import craigslist, facebook
from .sources.fetch import SourceBlocked

ACTIVE = ("contacted", "info", "negotiating", "awaiting_quote", "agreed", "paused", "stalled")


class Ctx:
    def __init__(self, cfg, db: DB, dry_run: bool, log: Callable[[str], None], allow_network: bool,
                 deadline: Optional[datetime], now: Optional[datetime] = None):
        self.cfg, self.db, self.dry_run, self.log = cfg, db, dry_run, log
        self.allow_network = allow_network
        self.deadline = deadline
        self.now = now or datetime.now(timezone.utc)
        self.stats = {"craigslist": _blank(), "facebook": _blank()}
        self.errors: list[str] = []
        self.blocks: list[str] = []
        self.processed: list[int] = []
        self.rejected_now: list[int] = []
        self.llm = LLM(cfg, db, log)
        self.model = None
        self.run_id: Optional[int] = None
        self.dealer = dealer_status(db, cfg)

    def out_of_time(self) -> bool:
        return self.deadline is not None and datetime.now(timezone.utc) >= self.deadline


def _blank() -> dict:
    return {"search_pages": 0, "seen": 0, "new": 0, "price_changed": 0, "details": 0, "blocked": False}


def hard_stop_deadline(cfg, now: Optional[datetime] = None) -> datetime:
    tz = ZoneInfo(cfg.get("schedule.timezone", "America/New_York"))
    hh, mm = map(int, str(cfg.get("schedule.hard_stop", "06:50")).split(":"))
    local_now = (now or datetime.now(timezone.utc)).astimezone(tz)
    stop = datetime.combine(local_now.date(), dtime(hh, mm), tz)
    if stop <= local_now:  # running off-schedule: give it 45 minutes
        from datetime import timedelta
        stop = local_now + timedelta(minutes=45)
    return stop.astimezone(timezone.utc)


# ---- storage ---------------------------------------------------------------------
def _in_band(price: Optional[int], cfg) -> bool:
    if price is None:
        return True
    return cfg.get("search.min_asking_price", 1000) <= price <= cfg.get("search.max_asking_price", 9500)


def upsert_stub(ctx: Ctx, source: str, stub: dict) -> tuple[int, bool]:
    db, cfg = ctx.db, ctx.cfg
    st = ctx.stats[source]
    st["seen"] += 1
    year, make, model, trim = parse_ymm(stub.get("title") or "")
    row = db.get_listing(source, stub["listing_id"])
    now = now_iso()
    price = stub.get("price")
    if row is None:
        st["new"] += 1
        pk = db.insert("listings", {
            "source": source, "listing_id": stub["listing_id"], "url": stub["url"], "title": stub.get("title"),
            "year": year, "make": make, "model": model, "trim": trim, "mileage": stub.get("mileage"),
            "price": price, "prev_price": stub.get("prev_price"), "location_text": stub.get("location") or "",
            "first_seen": now, "last_seen": now, "status": "new" if _in_band(price, cfg) else "comp",
        })
        db.record_price(pk, price)
        too_old = year is not None and year < cfg.get("search.min_year", 1992)
        return pk, _in_band(price, cfg) and not too_old
    pk = row["id"]
    upd = {"last_seen": now}
    changed = price is not None and row["price"] is not None and price != row["price"]
    if changed:
        st["price_changed"] += 1
        upd.update({"prev_price": row["price"], "price": price})
    elif price is not None and row["price"] is None:
        upd["price"] = price
    if stub.get("mileage") and not row["mileage"]:
        upd["mileage"] = stub["mileage"]
    db.update("listings", "id", pk, upd)
    db.record_price(pk, price)
    if row["status"] in ("dead", "bought", "sold"):
        return pk, False
    eff_price = price if price is not None else row["price"]
    needs = _in_band(eff_price, cfg) and (not row["detail_fetched"] or row["last_processed_price"] != eff_price)
    if needs and row["status"] == "comp":
        db.update("listings", "id", pk, {"status": "new"})
    return pk, needs


def upsert_detail(ctx: Ctx, pk: int, L: Listing) -> None:
    db, cfg = ctx.db, ctx.cfg
    row = db.listing(pk)
    dist, approx = geo.road_distance(cfg.home(), L.lat, L.lon, L.location_text or (row["location_text"] if row else ""),
                                     float(cfg.get("search.road_miles_factor", 1.25)), db, ctx.allow_network)
    upd = {
        "url": L.url, "title": L.title or row["title"], "year": L.year or row["year"], "make": L.make or row["make"],
        "model": L.model or row["model"], "trim": L.trim or row["trim"], "mileage": L.mileage or row["mileage"],
        "location_text": L.location_text or row["location_text"], "lat": L.lat, "lon": L.lon,
        "distance_mi": dist, "distance_approx": 1 if approx else 0, "title_status": L.title_status, "vin": L.vin,
        "transmission": L.transmission, "description": L.description, "seller_name": L.seller_name,
        "seller_info": L.seller_info, "posted_at": L.posted_at, "listing_age_days": L.listing_age_days,
        "detail_fetched": 1, "raw": {"attrs": L.attrs, "photos": L.photos},
    }
    if L.price is not None and L.price != row["price"]:
        upd["prev_price"] = row["price"]
        upd["price"] = L.price
    if L.prev_price and not row["prev_price"]:
        upd["prev_price"] = L.prev_price
    db.update("listings", "id", pk, upd)
    db.record_price(pk, L.price)
    for url in L.photos[:10]:
        db.x("INSERT OR IGNORE INTO photos (listing_pk, url) VALUES (?, ?)", (pk, url))
    ctx.stats[L.source]["details"] += 1


# ---- collectors -----------------------------------------------------------------------
def collect_craigslist(ctx: Ctx, fetcher) -> None:
    cfg, st = ctx.cfg, ctx.stats["craigslist"]
    queue: list[tuple[int, str]] = []
    try:
        for site in cfg.get("sources.craigslist.sites", []):
            for page in range(int(cfg.get("sources.craigslist.max_search_pages_per_site", 2))):
                if ctx.out_of_time():
                    return
                snap = fetcher.get(craigslist.search_url(site, cfg, page), source="craigslist")
                st["search_pages"] += 1
                stubs = craigslist.parse_search(snap.html)
                new_here = 0
                for s in stubs:
                    pk, needs = upsert_stub(ctx, "craigslist", s)
                    if needs:
                        queue.append((pk, s["url"]))
                        new_here += 1
                if len(stubs) < 100 or new_here == 0:
                    break
        seen = set()
        limit = int(cfg.get("sources.craigslist.max_detail_pages_per_run", 60))
        for pk, url in queue:
            if pk in seen or len(seen) >= limit or ctx.out_of_time():
                continue
            seen.add(pk)
            snap = fetcher.get(url, source="craigslist")
            if snap.status == 404 or "This posting has been deleted" in snap.text or "This posting has expired" in snap.text:
                ctx.db.update("listings", "id", pk, {"status": "dead", "reject_reason": "posting removed"})
                continue
            L = craigslist.parse_detail(snap.html, url, ctx.now)
            upsert_detail(ctx, pk, L)
            ctx.processed.append(pk)
    except SourceBlocked as e:
        st["blocked"] = True
        ctx.blocks.append(f"Craigslist: {e}. Stopped Craigslist for today (no retry).")
        ctx.log(f"[craigslist] BLOCKED: {e}")


def collect_facebook(ctx: Ctx, fetcher) -> None:
    cfg, st = ctx.cfg, ctx.stats["facebook"]
    try:
        snap = fetcher.get(facebook.search_url(cfg), scrolls=int(cfg.get("sources.facebook.max_scrolls", 6)), source="facebook")
        st["search_pages"] += 1
        if not facebook.logged_in(snap.text, snap.html):
            raise SourceBlocked("not logged in to Facebook (run `flipscout login`)")
        queue = []
        for s in facebook.parse_search(snap.links):
            pk, needs = upsert_stub(ctx, "facebook", s)
            if needs:
                queue.append((pk, s["url"]))
        limit = int(cfg.get("sources.facebook.max_detail_pages_per_run", 40))
        for pk, url in queue[:limit]:
            if ctx.out_of_time():
                break
            snap = fetcher.get(url, source="facebook")
            L = facebook.parse_detail(snap.text, url, snap.images)
            if not L.title and not L.price:
                ctx.errors.append(f"Marketplace item {url}: page had no recognizable listing (removed or layout changed)")
                continue
            upsert_detail(ctx, pk, L)
            ctx.processed.append(pk)
    except SourceBlocked as e:
        st["blocked"] = True
        ctx.blocks.append(f"Facebook Marketplace: {e}. Stopped Marketplace for today (no retry).")
        ctx.log(f"[facebook] BLOCKED: {e}")


# ---- evaluation -------------------------------------------------------------------------
def _row_dict(row) -> dict:
    d = dict(row)
    d["seller_info"] = dec(d.get("seller_info"), {}) or {}
    raw = dec(d.get("raw"), {}) or {}
    d["attrs"] = raw.get("attrs", {})
    d["photos"] = raw.get("photos", [])
    return d


def _photo_checks(ctx: Ctx, d: dict, res: filters.FilterResult) -> None:
    """Duplicate-photo check across listings (cross-post vs. reused photos) and optional Claude stock check."""
    if not ctx.allow_network or not d.get("photos"):
        return
    from . import photos as ph
    pdir = ctx.cfg.path("storage.photos_dir", "data/photos")
    maxd = int(ctx.cfg.get("filters.scam.duplicate_photo_hamming_max", 6))
    first_bytes = None
    for url in d["photos"][:3]:
        got = ph.download(url, pdir / str(d["id"]))
        if not got:
            continue
        path, data = got
        first_bytes = first_bytes or data
        h = ph.dhash_bytes(data)
        if not h:
            continue
        ctx.db.x("UPDATE photos SET local_path = ?, phash = ? WHERE listing_pk = ? AND url = ?", (str(path), h, d["id"], url))
        for other in ctx.db.q("SELECT p.listing_pk, p.phash, l.make, l.model, l.year, l.price, l.source, l.distance_mi "
                              "FROM photos p JOIN listings l ON l.id = p.listing_pk WHERE p.phash IS NOT NULL AND p.listing_pk != ?", (d["id"],)):
            if ph.hamming(h, other["phash"]) > maxd:
                continue
            same_car = (other["make"] == d.get("make") and other["year"] == d.get("year") and other["price"] and d.get("price")
                        and abs(other["price"] - d["price"]) <= 0.15 * d["price"])
            if same_car:
                res.soft("cross_posted", f"same photos as listing #{other['listing_pk']} ({other['source']}), likely the same seller cross-posting")
            else:
                res.hard("scam", f"photo reused from a different listing (#{other['listing_pk']})")
            break
    if first_bytes and ctx.cfg.get("filters.scam.stock_photo_check", True) and ctx.llm.available and res.reject is None:
        out = ctx.llm.check_photo(first_bytes)
        if out and out.get("looks_like_stock_or_press_photo"):
            res.hard("scam", "first photo looks like a stock/press image (Claude)")
        elif out and out.get("dealer_lot_or_watermark"):
            res.hard("dealer", "photo shows dealer lot/watermark (Claude)")


def _responsiveness(db: DB, pk: int) -> str:
    c = db.one("SELECT * FROM conversations WHERE listing_pk = ?", (pk,))
    if not c or not c["first_contact_at"]:
        return "none"
    if c["last_inbound_at"]:
        first_in = db.one("SELECT created_at FROM messages WHERE listing_pk = ? AND direction = 'in' ORDER BY id LIMIT 1", (pk,))
        try:
            delta = (datetime.fromisoformat(first_in["created_at"]) - datetime.fromisoformat(c["first_contact_at"])).total_seconds()
            return "fast" if delta <= 12 * 3600 else "slow"
        except (TypeError, ValueError):
            return "slow"
    try:
        waited = (datetime.now(timezone.utc) - datetime.fromisoformat(c["first_contact_at"])).total_seconds()
    except ValueError:
        waited = 0
    return "silent" if waited > 48 * 3600 else "none"


def evaluate(ctx: Ctx, pk: int, use_llm: bool = True) -> dict:
    db, cfg = ctx.db, ctx.cfg
    d = _row_dict(db.listing(pk))
    prior_llm = dec(d.get("llm_extract"), None)

    res = filters.check_listing(d, cfg)
    llm_out = None
    if res.reject is None and use_llm and d.get("detail_fetched"):
        if prior_llm and prior_llm.get("_price") == d.get("price"):
            llm_out = prior_llm
        elif ctx.llm.available:
            llm_out = ctx.llm.extract_listing(d.get("title") or "", d.get("description") or "", d.get("attrs") or {})
            if llm_out:
                llm_out["_price"] = d.get("price")
                db.update("listings", "id", pk, {"llm_extract": llm_out})
                if llm_out.get("vin") and not d.get("vin"):
                    from .parsing import vin_check_ok
                    if vin_check_ok(llm_out["vin"]):
                        d["vin"] = llm_out["vin"].upper()
                        db.update("listings", "id", pk, {"vin": d["vin"]})
        if llm_out:
            res = filters.check_listing(d, cfg, llm_out)
    if llm_out and llm_out.get("injection_attempt"):
        res.soft("possible_scam_signal", "listing text contains instructions aimed at bots")

    # phone number reused across many listings -> dealer/curbstoner
    for phone in res.phones:
        n = db.one("SELECT COUNT(DISTINCT id) AS n FROM listings WHERE description LIKE ? AND id != ?", (f"%{phone[-4:]}%", pk))["n"]
        if n >= int(cfg.get("filters.dealer_max_vehicle_listings_by_seller", 3)):
            res.hard("dealer", f"phone number appears in {n + 1} listings (dealer/curbstoner)")

    # VIN decode
    vin_info = None
    if d.get("vin") and res.reject is None and ctx.allow_network:
        from .quotes import vin as vinmod
        vin_info = vinmod.decode(db, d["vin"], allow_network=True)
        mm = vinmod.mismatch(d, vin_info.get("decoded") or {})
        if mm:
            res.soft("vin_mismatch", mm)
        if vin_info.get("recalls"):
            res.soft("open_recall", f"{len(vin_info['recalls'])} NHTSA recall campaign(s) for this model year")

    if res.reject is None and d.get("detail_fetched"):
        _photo_checks(ctx, d, res)

    val = valuation.value_listing(db, d, cfg, ctx.model)
    mkt = val["market"]
    hard_price, soft_price = filters.price_scam_check(d.get("price"), mkt.get("value"), mkt.get("confidence", "NONE"), cfg)
    if hard_price:
        res.hard("scam", f"price far below market: {hard_price}")
    elif soft_price:
        res.soft("suspiciously_cheap", soft_price)

    # ---- exits and profit ------------------------------------------------------------
    asking = d.get("price")
    dist = d.get("distance_mi")
    use_low = cfg.get("valuation.estimate_uses", "low_band") == "low_band"
    exits = []
    for q in val.get("real_offers", []):
        wa = costs.walk_away(q["amount"], dist, q["buyer"], "instant", cfg)
        exits.append({"exit": "instant", "buyer": q["buyer"], "kind": "REAL", "confidence": "REAL", "offer": q["amount"],
                      "offer_mid": q["amount"], "expires": q.get("expires_at"), "walk_away": wa})
    ie = val.get("instant_estimate")
    primary = (cfg.get("valuation.instant.buyers") or ["carvana"])[0]
    if ie and not val.get("real_offers"):
        offer = ie["low"] if use_low else ie["value"]
        exits.append({"exit": "instant", "buyer": primary, "kind": "ESTIMATE", "confidence": ie["confidence"],
                      "offer": offer, "offer_mid": ie["value"], "expires": None,
                      "walk_away": costs.walk_away(offer, dist, primary, "instant", cfg)})
    pe = val.get("patient_estimate")
    if pe and "patient" in (cfg.get("valuation.exit_strategies") or ["instant", "patient"]):
        offer = pe["low"] if use_low else pe["value"]
        exits.append({"exit": "patient", "buyer": "private buyer", "kind": "ESTIMATE", "confidence": pe["confidence"],
                      "offer": offer, "offer_mid": pe["value"], "expires": None,
                      "walk_away": costs.walk_away(offer, dist, "private", "patient", cfg)})
    neg = db.one("SELECT agreed_price FROM negotiations WHERE listing_pk = ?", (pk,))
    agreed = neg["agreed_price"] if neg and neg["agreed_price"] else None
    for e in exits:
        if asking:
            e["net_at_asking"], e["breakdown_at_asking"] = costs.net_profit(asking, e["offer"], dist, e["buyer"], e["exit"], cfg)
            e["net_at_asking_mid"], _ = costs.net_profit(asking, e["offer_mid"], dist, e["buyer"], e["exit"], cfg)
        wa = e["walk_away"]
        if wa:
            buy_at = agreed or (min(asking, wa) if asking else wa)
            e["buy_at"] = buy_at
            e["net"], e["breakdown"] = costs.net_profit(buy_at, e["offer"], dist, e["buyer"], e["exit"], cfg)
            opening, close_fast = opening_offer(wa, asking, cfg)
            e["target"], e["close_fast"] = opening, close_fast
            e["net_at_target"], _ = costs.net_profit(opening, e["offer"], dist, e["buyer"], e["exit"], cfg)
        else:
            e["net"] = e.get("net_at_asking")
    rank = {"REAL": 2, "ESTIMATE": 1}

    def _key(e: dict) -> tuple:
        # viable first; then profit if bought at the asking price (net at walk-away is pegged
        # to the minimum, so it can't rank exits); REAL beats ESTIMATE on ties
        net = e.get("net_at_asking", e.get("net"))
        return (1 if e.get("walk_away") else 0, net if net is not None else -1e9, rank[e["kind"]])

    best = max(exits, key=_key) if exits else None

    min_profit = float(cfg.get("profit.min_net_profit", 1000))
    gap_max = float(cfg.get("negotiation.max_negotiation_gap_pct", 0.15))
    dstatus = ctx.dealer
    price_dropped = bool(d.get("prev_price") and asking and asking < d["prev_price"])
    conf = best["confidence"] if best else "NONE"
    sc, parts = scoring.score(best.get("net") if best and best.get("walk_away") else None, conf, _responsiveness(db, pk),
                              d.get("listing_age_days"), price_dropped, dist, res.flags, cfg)

    reasons = []
    if res.reject:
        status = "rejected"
    elif not best:
        status, reasons = "watch", ["not enough market data to value yet"]
    elif not best.get("walk_away"):
        status, reasons = "watch", [f"no purchase price clears ${min_profit:,.0f} net at the {best['kind'].lower()} resale value"]
    else:
        gap = (asking - best["walk_away"]) / asking if asking else 0
        if gap > gap_max:
            status, reasons = "watch", [f"asking is {gap:.0%} above walk-away ${best['walk_away']:,}; too far to negotiate"]
        else:
            status = "candidate"
    if status == "candidate" and dstatus.stop:
        status, reasons = "watch", ["dealer-threshold stop: watch-only"]
    if any(f[0] == "title_not_in_name" for f in res.flags) and status == "candidate":
        reasons.append("title may not be in seller's name; confirm first")

    ev = {"listing_id": pk, "status": status, "reject": res.reject, "reject_category": res.category,
          "flags": res.flags, "valuation": val, "exits": exits, "best": best, "score": sc, "score_parts": parts,
          "watch_reasons": reasons, "vin_info": vin_info, "price_dropped": price_dropped,
          "llm_used": bool(llm_out), "evaluated_at": now_iso()}
    db.insert("evaluations", {"listing_pk": pk, "run_id": ctx.run_id, "created_at": now_iso(), "result": status, "data": ev})

    cur = db.listing(pk)
    new_status = status
    if cur["status"] in ACTIVE:
        new_status = cur["status"]  # don't overwrite an active conversation's stage
        if res.reject:
            db.add_need(pk, "red_flag", f"{d.get('title')}: now fails a filter: {res.reject}")
    comp_ok = 0 if res.category in ("scam", "dealer", "title", "not_running", "no_title") else 1
    db.update("listings", "id", pk, {"status": new_status, "reject_reason": res.reject, "flags": res.flags,
                                     "last_processed_price": d.get("price"), "comp_ok": comp_ok})
    if status == "rejected" and cur["status"] not in ACTIVE:
        ctx.rejected_now.append(pk)
    return ev


# ---- first contacts ---------------------------------------------------------------------
def plan_first_contacts(ctx: Ctx) -> list[int]:
    db, cfg = ctx.db, ctx.cfg
    threshold = int(cfg.get("scoring.auto_contact_threshold", 60))
    today = datetime.now(timezone.utc).date().isoformat()
    already = db.one("SELECT COUNT(*) AS n FROM messages WHERE kind = 'first_contact' AND substr(created_at,1,10) = ?", (today,))["n"]
    room = max(0, int(cfg.get("messaging.max_first_contacts_per_day", 5)) - already)
    rows = db.q("SELECT l.id FROM listings l LEFT JOIN conversations c ON c.listing_pk = l.id "
                "WHERE l.status = 'candidate' AND c.id IS NULL")
    scored = []
    for r in rows:
        ev = db.latest_eval(r["id"]) or {}
        if (ev.get("score") or 0) >= threshold:
            scored.append((ev["score"], r["id"]))
    planned = []
    status = "planned" if (ctx.dry_run or not cfg.get("mode.messaging_enabled")) else "queued"
    for _, pk in sorted(scored, reverse=True)[:room]:
        d = _row_dict(db.listing(pk))
        text = templates.first_contact(d, cfg.owner)
        g = guard.check(text, walk_away=None, owner=cfg.owner)
        cid = db.insert("conversations", {"listing_pk": pk, "channel": d["source"], "status": "planned"})
        db.insert("messages", {"conversation_id": cid, "listing_pk": pk, "direction": "out", "channel": d["source"],
                               "kind": "first_contact", "body": text, "status": status if g.ok else "blocked",
                               "guard": asdict(g), "created_at": now_iso()})
        if not g.ok:
            db.add_need(pk, "draft", f"{d.get('title')}: first message blocked by guard ({'; '.join(g.reasons)})", text)
        planned.append(pk)
    return planned


def flag_offer_expiry(ctx: Ctx) -> None:
    from datetime import date, timedelta
    soon = (date.today() + timedelta(days=2)).isoformat()
    today = date.today().isoformat()
    for q in ctx.db.q("SELECT q.*, l.title, l.status FROM quotes q JOIN listings l ON l.id = q.listing_pk WHERE q.kind = 'REAL'"):
        if q["status"] not in ACTIVE + ("candidate", "bought"):
            continue
        if q["expires_at"] and q["expires_at"] < today:
            ctx.db.add_need(q["listing_pk"], "requote", f"{q['title']}: {q['buyer']} offer ${q['amount']:,} expired {q['expires_at']}; re-quote")
        elif q["expires_at"] and q["expires_at"] <= soon:
            ctx.db.add_need(q["listing_pk"], "expiring", f"{q['title']}: {q['buyer']} offer ${q['amount']:,} expires {q['expires_at']}")


def reset_planned(db: DB) -> None:
    """Drafts from earlier dry runs are re-planned fresh each morning."""
    for c in db.q("SELECT id FROM conversations WHERE status = 'planned'"):
        if not db.one("SELECT 1 FROM messages WHERE conversation_id = ? AND status IN ('sent','received','queued')", (c["id"],)):
            db.x("DELETE FROM messages WHERE conversation_id = ?", (c["id"],))
            db.x("DELETE FROM conversations WHERE id = ?", (c["id"],))


# ---- orchestration ---------------------------------------------------------------------------
def run_morning(cfg, db: DB, fetcher_factory: Callable[[str], object], dry_run: bool = True,
                sources: Optional[list[str]] = None, allow_network: bool = True, use_deadline: bool = True,
                log: Callable[[str], None] = print, now: Optional[datetime] = None) -> Ctx:
    deadline = hard_stop_deadline(cfg) if use_deadline else None
    ctx = Ctx(cfg, db, dry_run, log, allow_network, deadline, now)
    ctx.run_id = db.insert("runs", {"kind": "morning", "started_at": now_iso(), "dry_run": 1 if dry_run else 0})
    reset_planned(db)
    if ctx.llm.disabled_reason:
        ctx.errors.append(ctx.llm.disabled_reason + " (keyword rules only)")
    sources = sources or [s for s in ("craigslist", "facebook") if cfg.get(f"sources.{s}.enabled", True)]

    fetcher = None
    try:
        fetcher = fetcher_factory("browser")
        if "craigslist" in sources:
            log("[run] Craigslist ...")
            collect_craigslist(ctx, fetcher)
        if "facebook" in sources:
            log("[run] Facebook Marketplace ...")
            collect_facebook(ctx, fetcher)
    except Exception as e:
        ctx.errors.append(f"collector crashed: {e.__class__.__name__}: {e}")
        log(traceback.format_exc())
    finally:
        if fetcher is not None:
            try:
                fetcher.close()
            except Exception:
                pass

    ctx.model = valuation.fit_market_model(db, cfg)
    todo = list(dict.fromkeys(ctx.processed))
    todo += [r["id"] for r in db.q(f"SELECT id FROM listings WHERE status IN ({','.join('?' * (len(ACTIVE) + 1))})",
                                   ACTIVE + ("candidate",)) if r["id"] not in todo]
    log(f"[run] evaluating {len(todo)} listings ...")
    for pk in todo:
        try:
            evaluate(ctx, pk)
        except Exception as e:
            ctx.errors.append(f"listing #{pk}: {e.__class__.__name__}: {e}")
            log(traceback.format_exc())
    plan_first_contacts(ctx)
    flag_offer_expiry(ctx)

    db.update("runs", "id", ctx.run_id, {"finished_at": now_iso(), "stats": ctx.stats, "errors": ctx.errors,
                                         "blocks": ctx.blocks})
    return ctx
