"""The 8:00 AM job (and optional inbox passes): read seller replies, decide next
steps, and send queued messages. Inactive unless mode.messaging_enabled is true
and mode.dry_run is false."""
from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, time as dtime, timezone
from typing import Callable, Optional
from zoneinfo import ZoneInfo

from .db import DB, dec, now_iso
from .llm import LLM
from .messaging import guard
from .messaging.negotiate import Action, plan_reply, regex_parse_reply


def in_quiet_hours(cfg, now: Optional[datetime] = None) -> bool:
    tz = ZoneInfo(cfg.get("schedule.timezone", "America/New_York"))
    t = (now or datetime.now(timezone.utc)).astimezone(tz).time()
    q = cfg.get("messaging.quiet_hours", {}) or {}
    start = dtime(*map(int, str(q.get("start", "21:00")).split(":")))
    end = dtime(*map(int, str(q.get("end", "08:00")).split(":")))
    return t >= start or t < end if start > end else start <= t < end


def sent_today(db: DB) -> int:
    today = datetime.now(timezone.utc).date().isoformat()
    return db.one("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND status = 'sent' AND substr(sent_at,1,10) = ?",
                  (today,))["n"]


def basis_for(db: DB, pk: int) -> dict:
    ev = db.latest_eval(pk) or {}
    best = ev.get("best") or {}
    return {"walk_away": best.get("walk_away"), "kind": best.get("kind"), "confidence": best.get("confidence"),
            "exit": best.get("exit")}


def _neg_state(db: DB, pk: int) -> dict:
    n = db.one("SELECT * FROM negotiations WHERE listing_pk = ?", (pk,))
    if not n:
        return {"stage": "contacted", "rounds": 0, "info": {}}
    d = dict(n)
    hist = dec(d.get("history"), {}) or {}
    d["info"] = hist.get("info", {})
    for k in ("asked_lien", "asked_missing", "sent_holding"):
        d[k] = hist.get(k, False)
    return d


def _save_state(db: DB, pk: int, st: dict, basis: dict, action: Action) -> None:
    hist = {"info": st.get("info", {}), "asked_lien": st.get("asked_lien", False),
            "asked_missing": st.get("asked_missing", False), "sent_holding": st.get("sent_holding", False)}
    row = {
        "stage": action.stage or st.get("stage"), "walk_away": basis.get("walk_away"),
        "our_last_offer": action.amount if action.kind in ("offer", "accept") and action.amount else st.get("our_last_offer"),
        "seller_last_ask": st.get("seller_last_ask"),
        "rounds": (st.get("rounds") or 0) + (1 if action.kind == "offer" else 0),
        "agreed_price": action.amount if action.stage == "agreed" else st.get("agreed_price"),
        "basis": json.dumps(basis), "history": json.dumps(hist), "updated_at": now_iso(),
    }
    if action.kind == "offer" and not st.get("opening"):
        row["opening"] = action.amount
    if db.one("SELECT 1 FROM negotiations WHERE listing_pk = ?", (pk,)):
        db.update("negotiations", "listing_pk", pk, row)
    else:
        db.insert("negotiations", {"listing_pk": pk, **row})
    if row["stage"]:
        db.update("listings", "id", pk, {"status": row["stage"] if row["stage"] != "dead" else "dead"})
    if (st.get("info") or {}).get("vin"):
        db.x("UPDATE listings SET vin = COALESCE(NULLIF(vin,''), ?) WHERE id = ?", (st["info"]["vin"], pk))


def handle_inbound(cfg, db: DB, llm: Optional[LLM], pk: int, text: str, live: bool, log=print) -> Action:
    """Store a seller message, parse it, decide, and queue (live) or plan (dry) the response."""
    listing = dict(db.listing(pk))
    conv = db.one("SELECT * FROM conversations WHERE listing_pk = ?", (pk,))
    if conv is None:
        cid = db.insert("conversations", {"listing_pk": pk, "channel": listing["source"], "status": "contacted",
                                          "first_contact_at": now_iso()})
        conv = db.one("SELECT * FROM conversations WHERE id = ?", (cid,))
    last_out = db.one("SELECT body FROM messages WHERE listing_pk = ? AND direction = 'out' AND status = 'sent' ORDER BY id DESC LIMIT 1", (pk,))
    parsed = None
    if llm is not None and llm.available:
        parsed = llm.parse_reply(listing.get("title") or "", last_out["body"] if last_out else "", text)
    if parsed is None:
        parsed = regex_parse_reply(text)
    db.insert("messages", {"conversation_id": conv["id"], "listing_pk": pk, "direction": "in", "channel": conv["channel"],
                           "kind": "seller", "body": text, "status": "received", "parsed": parsed, "created_at": now_iso()})
    db.update("conversations", "id", conv["id"], {"last_inbound_at": now_iso()})

    st = _neg_state(db, pk)
    basis = basis_for(db, pk)
    if parsed.get("_parser") == "regex":
        # Without Claude, only act on unambiguous facts; everything else goes to you.
        if parsed.get("still_available") == "no":
            action = Action("close", kind="sold", stage="dead", note="seller says sold (regex)")
        else:
            if parsed.get("vin"):
                st.setdefault("info", {})["vin"] = parsed["vin"]
            action = Action("needs_owner", stage=st.get("stage"),
                            needs=[("read_reply", f"{listing['title']}: seller replied; read and decide (Claude off): “{text[:140]}”")])
    else:
        action = plan_reply(st, listing, parsed, basis, cfg, cfg.owner, cfg.needs_label)

    for kind, summary in action.needs:
        db.add_need(pk, kind, summary)
    if action.type == "send" and action.text:
        g = guard.check(action.text, basis.get("walk_away"), cfg.owner)
        status = ("queued" if live else "planned") if g.ok else "blocked"
        db.insert("messages", {"conversation_id": conv["id"], "listing_pk": pk, "direction": "out", "channel": conv["channel"],
                               "kind": action.kind, "body": action.text, "status": status, "guard": asdict(g),
                               "created_at": now_iso()})
        if not g.ok:
            db.add_need(pk, "draft", f"{listing['title']}: reply blocked by guard ({'; '.join(g.reasons)}); review the draft",
                        action.text)
    if action.type == "close":
        db.update("conversations", "id", conv["id"], {"status": "dead"})
    _save_state(db, pk, st, basis, action)
    return action


def _send_one(cfg, db: DB, msg, fetcher, log) -> None:
    listing = dict(db.listing(msg["listing_pk"]))
    conv = db.one("SELECT * FROM conversations WHERE id = ?", (msg["conversation_id"],))
    walk = basis_for(db, msg["listing_pk"]).get("walk_away")
    g = guard.check(msg["body"], walk if msg["kind"] != "first_contact" else None, cfg.owner)
    if not g.ok:
        db.update("messages", "id", msg["id"], {"status": "blocked", "guard": asdict(g)})
        db.add_need(msg["listing_pk"], "draft", f"{listing['title']}: message blocked by guard at send time", msg["body"])
        return
    ok, detail, ext, thread, relay = False, "", None, None, None
    try:
        if listing["source"] == "facebook":
            from .messaging.fb_messenger import send_message
            ok, thread, detail = send_message(fetcher.page, listing["url"], msg["body"])
        else:
            from .mailer import send_email
            from .sources.craigslist import reply_relay_email
            relay = conv["relay_email"]
            if not relay:
                fetcher.polite_pause()
                fetcher.page.goto(listing["url"], wait_until="domcontentloaded", timeout=45000)
                relay = reply_relay_email(fetcher.page)
            if relay:
                prior = db.one("SELECT external_id FROM messages WHERE conversation_id = ? AND external_id IS NOT NULL ORDER BY id DESC LIMIT 1", (conv["id"],))
                ext = send_email(cfg, relay, f"{listing['title']} (Craigslist)", msg["body"],
                                 in_reply_to=prior["external_id"] if prior else None)
                ok, detail = True, "emailed via Craigslist relay"
            else:
                detail = "no relay email (phone-only listing or CAPTCHA)"
    except Exception as e:
        detail = f"{e.__class__.__name__}: {str(e)[:160]}"
    if ok:
        db.update("messages", "id", msg["id"], {"status": "sent", "sent_at": now_iso(), "external_id": ext})
        upd = {"last_outbound_at": now_iso(), "status": "contacted" if msg["kind"] == "first_contact" else conv["status"]}
        if msg["kind"] == "first_contact":
            upd["first_contact_at"] = now_iso()
            db.update("listings", "id", msg["listing_pk"], {"status": "contacted"})
            if not db.one("SELECT 1 FROM negotiations WHERE listing_pk = ?", (msg["listing_pk"],)):
                db.insert("negotiations", {"listing_pk": msg["listing_pk"], "stage": "contacted", "rounds": 0,
                                           "walk_away": walk, "updated_at": now_iso()})
        if thread:
            upd["thread_ref"] = thread
        if relay:
            upd["relay_email"] = relay
        db.update("conversations", "id", conv["id"], upd)
        log(f"[outreach] sent {msg['kind']} for #{msg['listing_pk']}")
    else:
        db.update("messages", "id", msg["id"], {"status": "draft"})
        db.add_need(msg["listing_pk"], "draft", f"{listing['title']}: couldn't send automatically ({detail}); send the draft yourself",
                    msg["body"])
        log(f"[outreach] draft saved for #{msg['listing_pk']}: {detail}")


def read_inbound(cfg, db: DB, fetcher, log) -> list[tuple[int, str]]:
    new: list[tuple[int, str]] = []
    # Marketplace threads
    from .messaging.fb_messenger import read_thread
    for c in db.q("SELECT * FROM conversations WHERE channel = 'facebook' AND thread_ref IS NOT NULL AND status != 'dead'"):
        fetcher.polite_pause()
        msgs = read_thread(fetcher.page, c["thread_ref"])
        if msgs is None:
            db.add_need(c["listing_pk"], "check_inbox", "Couldn't read a Marketplace thread automatically; check it and log replies "
                        "with `flipscout reply <id> \"text\"`")
            continue
        known = {r["body"].strip() for r in db.q("SELECT body FROM messages WHERE conversation_id = ? AND direction = 'in'", (c["id"],))}
        for m in msgs:
            if m["direction"] == "in" and m["text"].strip() and m["text"].strip() not in known:
                new.append((c["listing_pk"], m["text"].strip()))
    # Craigslist email replies
    from .mailer import fetch_replies
    ids = {r["external_id"]: r["conversation_id"] for r in db.q(
        "SELECT external_id, conversation_id FROM messages WHERE channel = 'craigslist' AND external_id IS NOT NULL")}
    try:
        for rep in fetch_replies(cfg, ids):
            conv = db.one("SELECT listing_pk FROM conversations WHERE id = ?", (rep["conversation_id"],))
            seen = db.one("SELECT 1 FROM messages WHERE external_id = ?", (rep["message_id"],))
            if conv and not seen and rep["body"]:
                new.append((conv["listing_pk"], rep["body"]))
                db.x("UPDATE conversations SET relay_email = COALESCE(relay_email, ?) WHERE id = ?", (rep["from"], rep["conversation_id"]))
    except Exception as e:
        log(f"[outreach] email read failed: {e}")
    return new


def run_outreach(cfg, db: DB, fetcher_factory: Callable[[str], object], log: Callable[[str], None] = print,
                 force_hours: bool = False) -> dict:
    live = (not cfg.dry_run) and bool(cfg.get("mode.messaging_enabled"))
    result = {"live": live, "inbound": 0, "sent": 0, "skipped": ""}
    if not live:
        result["skipped"] = "messaging disabled or dry run: nothing sent (see the report for planned messages)"
        log("[outreach] " + result["skipped"])
        return result
    if in_quiet_hours(cfg) and not force_hours:
        result["skipped"] = "quiet hours"
        log("[outreach] quiet hours; not sending")
        return result
    llm = LLM(cfg, db, log)
    fetcher = fetcher_factory("browser")
    try:
        for pk, text in read_inbound(cfg, db, fetcher, log):
            handle_inbound(cfg, db, llm, pk, text, live=True, log=log)
            result["inbound"] += 1
        cap = int(cfg.get("messaging.max_messages_per_day", 25))
        for msg in db.q("SELECT * FROM messages WHERE direction = 'out' AND status = 'queued' ORDER BY id"):
            if sent_today(db) >= cap:
                log("[outreach] daily message cap reached")
                break
            fetcher.polite_pause()
            _send_one(cfg, db, msg, fetcher, log)
            result["sent"] += 1
    finally:
        fetcher.close()
    return result
