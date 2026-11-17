"""Last-line check on every automated outbound message. If anything trips, the
message is NOT sent; it becomes an item for you to review instead."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

from .templates import INSPECTION

WEEKDAYS = r"(?:mon|tues|wednes|thurs|fri|satur|sun)day"
TIME_PATTERNS = [
    rf"\b{WEEKDAYS}\b", r"\btomorrow\b", r"\btonight\b", r"\bthis (?:morning|afternoon|evening|weekend)\b",
    r"\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)\b", r"\bat noon\b", r"\b\d{1,2}/\d{1,2}\b",
    r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]* \d{1,2}\b",
    r"\bsee you (?:at|on)\b", r"\bmeet (?:you )?(?:at|on)\b",
]
ADDRESS_RE = re.compile(r"\b\d{2,6}\s+(?:[a-z]+\s){1,4}(?:st|street|rd|road|ave|avenue|ln|lane|dr|drive|ct|court|blvd|"
                        r"boulevard|hwy|highway|pike|way|pl|place|cir|circle|ter|terrace|pkwy|parkway)\b", re.I)
PHONE_RE = re.compile(r"(?<!\d)\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}(?!\d)")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
MONEY_TRANSFER = [r"\bdeposit\b", r"\bzelle\b", r"\bvenmo\b", r"\bcash ?app\b", r"\bpaypal\b", r"\bwire\b",
                  r"\bsend (?:you|the) (?:money|payment|funds)\b", r"\bpay you (?:now|today|first)\b",
                  r"\bbank account\b", r"\brouting number\b", r"\bcashier'?s check\b"]
COMPETING = [r"another (?:offer|buyer|seller|car)", r"other (?:offers|buyers|cars i'?m looking at)", r"someone else",
             r"a better deal elsewhere", r"other sellers"]
PRESSURE = [r"today only", r"act fast", r"last chance", r"offer expires", r"right now or", r"take it or leave it",
            r"\bfinal offer\b(?! is)", r"won'?t last"]
AGREEMENT = [r"\bdeal\b", r"\bagreed\b", r"i'?ll take it", r"\bworks for me\b", r"\bsounds good at\b", r"\bsold\b",
             r"\bi can do\b"]
BINDING = [r"\bguarantee\b", r"\bpromise to buy\b", r"\bbinding\b", r"\bno matter what\b", r"\bsight unseen\b"]
PRICE_RE = re.compile(r"\$\s?(\d{1,3}(?:,\d{3})+|\d{3,6})(?:\.\d{2})?|\b(\d{1,2}(?:\.\d)?)\s?k\b", re.I)


@dataclass
class GuardResult:
    ok: bool
    reasons: list = field(default_factory=list)


def prices_in(text: str) -> list[int]:
    out = []
    for m in PRICE_RE.finditer(text or ""):
        if m.group(1):
            out.append(int(m.group(1).replace(",", "")))
        elif m.group(2):
            out.append(int(float(m.group(2)) * 1000))
    return out


def check(text: str, walk_away: Optional[int], owner: dict | None = None, max_len: int = 700) -> GuardResult:
    reasons: list[str] = []
    low = (text or "").lower().replace("’", "'")
    owner = owner or {}

    for p in TIME_PATTERNS:
        if re.search(p, low):
            reasons.append("mentions a meeting time/date")
            break
    if ADDRESS_RE.search(text or ""):
        reasons.append("contains a street address")
    zip_ = str(owner.get("home_zip") or "")
    if zip_ and zip_ in low:
        reasons.append("contains your ZIP code")
    if PHONE_RE.search(text or ""):
        reasons.append("contains a phone number")
    if EMAIL_RE.search(text or ""):
        reasons.append("contains an email address")
    for p in MONEY_TRANSFER:
        if re.search(p, low):
            reasons.append("mentions money transfer / deposit / payment details")
            break
    for p in COMPETING:
        if re.search(p, low):
            reasons.append("claims a competing offer or buyer")
            break
    for p in PRESSURE:
        if re.search(p, low):
            reasons.append("uses pressure wording")
            break
    for p in BINDING:
        if re.search(p, low):
            reasons.append("sounds like a binding commitment")
            break
    prices = prices_in(text)
    if walk_away is not None and any(pr > walk_away for pr in prices):
        reasons.append(f"names a price above the walk-away (${walk_away:,})")
    if prices and walk_away is None:
        reasons.append("names a price but no walk-away price is set")
    if any(re.search(p, low) for p in AGREEMENT) and INSPECTION not in low:
        reasons.append(f"agreement wording without “{INSPECTION}”")
    if len(text or "") > max_len:
        reasons.append("message is unusually long")
    return GuardResult(ok=not reasons, reasons=reasons)
