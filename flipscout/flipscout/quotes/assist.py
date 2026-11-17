"""Instant-offer quotes: conservative condition answers, the needs-quote list, and
recording REAL offers.

Automated form-filling on Carvana/CarMax/KBB is deliberately not attempted until
it can be built and verified against the live pages on your machine. Until then
`flipscout quote assist <id>` opens all three sell pages in your browser profile
with the VIN and the answers on screen, and `flipscout quote add` records them.
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Optional

from ..db import DB, dec, now_iso

SELL_PAGES = {
    "carvana": "https://www.carvana.com/sell-my-car",
    "carmax": "https://www.carmax.com/sell-my-car",
    "kbb_ico": "https://www.kbb.com/instant-cash-offer/",
    "peddle": "https://www.peddle.com/",
    "cargurus": "https://www.cargurus.com/sell-car",
    "driveway": "https://www.driveway.com/sell-your-car",
}


def conservative_answers(listing: dict) -> dict:
    """Answer condition questions from the listing; unknowns get the worse plausible answer."""
    text = f"{listing.get('title') or ''}\n{listing.get('description') or ''}".lower()
    flags = [f[0] for f in (dec(listing.get("flags"), []) if isinstance(listing.get("flags"), str) else listing.get("flags") or [])]
    llm = dec(listing.get("llm_extract"), {}) if isinstance(listing.get("llm_extract"), str) else (listing.get("llm_extract") or {})
    issues = llm.get("known_issues") or []

    def says(*words):
        return any(w in text for w in words)

    return {
        "mileage": listing.get("mileage") or "UNKNOWN: ask seller; do not guess low",
        "accidents": "No accidents reported" if says("no accidents", "accident free", "accident-free", "clean carfax")
                     else "Answer 'Yes / unsure' (listing doesn't say)",
        "warning_lights": "Yes" if says("check engine", "cel", "warning light", "abs light", "airbag light") or "needs_minor_work" in flags
                          else "Unsure; answer 'Yes' unless confirmed at inspection",
        "mechanical_issues": ("Yes: " + "; ".join(issues[:3])) if issues else
                             ("Yes (listing mentions work needed)" if "needs_minor_work" in flags else "Answer 'minor issues'"),
        "exterior_damage": "Yes: rust/dents mentioned" if says("rust", "dent", "scratch", "hail", "fender bender") else
                           "Answer 'minor wear' (not 'like new')",
        "interior_damage": "Yes" if says("tear", "stain", "rip", "smell", "smoke") else "Answer 'minor wear'",
        "tires": "Need replacing" if says("needs tires", "bald", "worn tires") else "Answer 'some wear'",
        "keys": "1 key (assume one unless seller confirms two)",
        "modifications": "Yes" if says("lifted", "lift kit", "aftermarket", "tuned", "lowered") else "No",
        "smoked_in": "Yes" if says("smoke", "smoker") else "Unknown; answer per seller",
        "title": "Clean, in my name (after you title it)",
        "loan": "No (you'll own it outright)",
        "zip": "your home ZIP",
    }


def needs_quote_items(db: DB, cfg) -> list[dict]:
    """Listings with a VIN, in an active stage, lacking a live REAL offer from every configured buyer."""
    buyers = cfg.get("valuation.instant.buyers", ["carvana", "carmax", "kbb_ico"])
    rows = db.q("SELECT * FROM listings WHERE vin IS NOT NULL AND vin != '' AND status IN "
                "('candidate','contacted','negotiating','agreed','awaiting_quote','info','watch')")
    out = []
    today = date.today().isoformat()
    for r in rows:
        have = {q["buyer"] for q in db.q("SELECT buyer FROM quotes WHERE listing_pk = ? AND kind = 'REAL' "
                                         "AND (expires_at IS NULL OR expires_at >= ?)", (r["id"], today))}
        missing = [b for b in buyers if b not in have]
        if missing:
            d = dict(r)
            out.append({"listing": d, "missing": missing, "answers": conservative_answers(d)})
    return out


def record_quote(db: DB, cfg, listing_pk: int, buyer: str, amount: int, expires: Optional[str] = None,
                 note: str = "", answers: Optional[dict] = None) -> int:
    listing = db.listing(listing_pk)
    if expires is None:
        days = (cfg.get("valuation.instant.offer_validity_days_default", {}) or {}).get(buyer, 7)
        expires = (date.today() + timedelta(days=int(days))).isoformat()
    ev = db.latest_eval(listing_pk) or {}
    market = ((ev.get("valuation") or {}).get("market") or {}).get("value")
    meta = dict(answers or {})
    meta["market_at_quote"] = market
    qid = db.insert("quotes", {"listing_pk": listing_pk, "vin": listing["vin"] if listing else None, "buyer": buyer,
                               "amount": int(amount), "kind": "REAL", "confidence": "REAL", "answers": meta,
                               "obtained_at": now_iso(), "expires_at": expires, "note": note})
    db.x("UPDATE needs_owner SET resolved_at = ? WHERE listing_pk = ? AND kind = 'needs_quote' AND resolved_at IS NULL",
         (now_iso(), listing_pk))
    return qid


def open_sell_pages(fetcher, buyers: list[str]) -> None:
    """Open each buyer's sell page in a new tab of the logged-in browser profile."""
    ctx = fetcher.context
    for b in buyers:
        url = SELL_PAGES.get(b)
        if url:
            pg = ctx.new_page()
            pg.goto(url, wait_until="domcontentloaded", timeout=45000)


def format_answers(answers: dict) -> str:
    return "\n".join(f"  {k.replace('_', ' ').title():<18} {v}" for k, v in answers.items())
