"""Virginia dealer-threshold tracking.

Virginia presumes a person is a dealer once they offer for sale, sell, or display
for sale 5+ vehicles in any 12 consecutive months. flipscout counts every vehicle
you sold or listed for sale in the trailing 12 months, plus cars you hold now
(each will be offered). This is a planning aid, not legal advice.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Optional

from .db import DB


@dataclass
class DealerStatus:
    count: int
    warn: bool
    stop: bool
    vehicles: list
    next_rolloff: Optional[str]
    message: str


def _vehicle_key(row) -> str:
    if row["vin"]:
        return row["vin"].upper()
    if row["listing_pk"]:
        return f"pk{row['listing_pk']}"
    return "v:" + (row["vehicle"] or "").strip().lower()


def dealer_status(db: DB, cfg, today: Optional[date] = None) -> DealerStatus:
    today = today or date.today()
    start = (today - timedelta(days=365)).isoformat()
    t = cfg.get("virginia.dealer_threshold", {}) or {}
    warn_at, stop_at, presume = int(t.get("warn_at", 3)), int(t.get("stop_recommending_at", 4)), int(t.get("presumption_at", 5))
    rows = db.q("SELECT * FROM ledger ORDER BY event_date")
    by_vehicle: dict[str, dict] = {}
    for r in rows:
        k = _vehicle_key(r)
        v = by_vehicle.setdefault(k, {"vehicle": r["vehicle"], "events": {}})
        v["events"][r["event"]] = r["event_date"]
    counted = []
    for k, v in by_vehicle.items():
        ev = v["events"]
        offered_dates = [d for e, d in ev.items() if e in ("sold", "listed") and d and d >= start]
        if t.get("count_offered_for_sale", True) is False:
            offered_dates = [d for e, d in ev.items() if e == "sold" and d and d >= start]
        held = "bought" in ev and "sold" not in ev
        if offered_dates or (held and t.get("count_currently_held", True)):
            first = min(offered_dates) if offered_dates else None
            counted.append({"vehicle": v["vehicle"], "first_offered": first, "held": held})
    count = len(counted)
    roll = sorted(c["first_offered"] for c in counted if c["first_offered"])
    next_roll = (date.fromisoformat(roll[0]) + timedelta(days=366)).isoformat() if roll else None
    if count >= stop_at:
        msg = (f"{count} vehicles sold/offered/held in the last 12 months. Virginia presumes dealer status at {presume}. "
               f"flipscout has STOPPED recommending purchases (watch-only)."
               + (f" Earliest roll-off: {next_roll}." if next_roll else ""))
    elif count >= warn_at:
        msg = f"Warning: {count} vehicles sold/offered/held in the last 12 months (Virginia presumption at {presume})."
    else:
        msg = f"{count} vehicle(s) sold/offered/held in the last 12 months (warn at {warn_at}, stop at {stop_at})."
    return DealerStatus(count, count >= warn_at, count >= stop_at, counted, next_roll, msg)
