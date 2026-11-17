"""Hard rejects and soft flags. Every decision carries a human-readable reason.

Plain keyword lists live in config.yaml (filters.*). The regex rules below handle
phrasing that a keyword list can't (negations, "title in my dad's name", ...).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

# Phrases that contain a reject keyword but mean the opposite; removed before matching.
SAFE_PHRASES = [
    r"no title (?:issues?|problems?)", r"not (?:a )?salvage", r"never (?:been )?salvage[d]?",
    r"no salvage", r"not (?:a )?rebuilt", r"never rebuilt", r"no rebuilt",
    r"never (?:been )?flood(?:ed)?", r"no flood(?: damage)?", r"not flood(?:ed)?",
    r"no deposits?", r"(?:will )?not ship", r"no shipping", r"won'?t ship", r"no liens?",
    r"lien[- ]free", r"no financing", r"not a dealer", r"no dealers?", r"dealer[- ](?:maintained|serviced)",
    r"title in hand", r"clean title", r"no lemon", r"not a lemon", r"no scam(?:mer)?s?", r"no ebay",
    r"no zelle", r"no start(?:ing)? (?:issues?|problems?)", r"no (?:trades?|lowball(?:er)?s?)",
]
NEGATION = re.compile(r"\b(?:no|not|never|isn'?t|wasn'?t|without|zero|nothing|doesn'?t|don'?t|won'?t)\b[\w' ]{0,12}$")

PHONE_RE = re.compile(r"(?<!\d)(?:\(?\d{3}\)?[\s.\-]?)\d{3}[\s.\-]?\d{4}(?!\d)")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")

HARD_TITLE_STATUSES = {"salvage", "rebuilt", "parts only", "missing", "junk", "flood", "rebuildable",
                       "non-repairable", "certificate of destruction", "branded"}

MINOR_WORK = [r"needs minor", r"needs some work", r"check engine light", r"\bcel\b", r"needs tlc",
              r"minor issues?", r"needs (?:brakes|tires|battery|ac|a/c)", r"small oil leak", r"leaks? oil",
              r"some rust", r"rust spots?", r"surface rust"]
NOT_IN_NAME = [r"(?:title|it'?s) (?:is )?in my (?:dad|mom|father|mother|wife|husband|brother|sister|son|daughter|grand\w+|friend|uncle|aunt)'?s name",
               r"not in my name", r"selling (?:it )?for a (?:friend|relative|family member|neighbor)"]
LIEN = [r"\blien\b", r"still owe", r"loan on it", r"pay ?off", r"bank (?:holds|has) the title", r"still financed"]
LIEN_HARD = [r"owe more than", r"upside down", r"can'?t pay (?:it )?off", r"cannot pay (?:it )?off"]

DEFAULT_DEALER = ["buy here pay here", "doc fee", "dealer fee", "stock #", "stock number", "we finance",
                  "in-house financing", "financing available", "warranty available", "plus tax and tags",
                  "+ tax", "+tax", "trade-ins welcome", "visit our lot", "our inventory"]
DEFAULT_SCAM_HARD = ["deposit", "escrow", "shipping", "ship it", "will ship", "gift card", "ebay motors",
                     "deployed", "overseas", "moving abroad", "my late husband", "transport company"]
DEFAULT_SCAM_SOFT = ["zelle", "cash app", "cashapp", "venmo", "paypal"]
DEFAULT_OFFPLATFORM_FB = ["email me at", "only by email", "text only", "don't check facebook",
                          "don't use messenger", "do not message here", "@gmail.com", "@yahoo.com"]


@dataclass
class FilterResult:
    reject: Optional[str] = None          # hard reject reason (None = passes)
    category: Optional[str] = None        # title|no_title|lien|year|not_running|dealer|scam|mileage|price
    flags: list = field(default_factory=list)      # soft flags: [name, detail]
    scam_signals: list = field(default_factory=list)
    phones: list = field(default_factory=list)

    def hard(self, category: str, reason: str) -> "FilterResult":
        if self.reject is None:
            self.reject, self.category = reason, category
        return self

    def soft(self, name: str, detail: str = "") -> None:
        if name not in [f[0] for f in self.flags]:
            self.flags.append([name, detail])


def _clean(text: str) -> str:
    t = " " + (text or "").lower().replace("’", "'") + " "
    for p in SAFE_PHRASES:
        t = re.sub(p, " ", t)
    return re.sub(r"\s+", " ", t)


def has_phrase(text_clean: str, pattern: str, allow_negated: bool = False) -> Optional[str]:
    """Regex search with word-ish boundaries; skips matches preceded by a negation."""
    for m in re.finditer(r"(?<![a-z0-9])(?:" + pattern + r")(?![a-z0-9])", text_clean):
        if not allow_negated and NEGATION.search(text_clean[max(0, m.start() - 30):m.start()]):
            continue
        return m.group(0).strip()
    return None


def _phrases(cfg, key: str, default: list) -> list[str]:
    vals = cfg.get(key) if cfg is not None else None
    return [re.escape(str(v).lower()) for v in (vals if vals else default)]


def check_listing(listing: dict, cfg, llm: Optional[dict] = None) -> FilterResult:
    """Pre-valuation checks on a listing dict (DB row dict or Listing.__dict__)."""
    r = FilterResult()
    source = listing.get("source", "")
    title = listing.get("title") or ""
    desc = listing.get("description") or ""
    text = _clean(f"{title}\n{desc}")
    ts = (listing.get("title_status") or "").lower().strip()
    g = (lambda k, d=None: cfg.get(k, d)) if cfg is not None else (lambda k, d=None: d)

    # ---- year / price band / mileage ------------------------------------
    year = listing.get("year")
    min_year = g("search.min_year", 1992)
    if year and year < min_year:
        r.hard("year", f"{year} is older than {min_year}")
    if not year:
        r.soft("unknown_year", "year not found in listing")
    price = listing.get("price")
    if price is not None:
        hi, lo = g("search.max_asking_price", 9500), g("search.min_asking_price", 1000)
        if price > hi:
            r.hard("price", f"asking ${price:,} is above the ${hi:,} search ceiling")
        elif price < lo:
            r.hard("price", f"asking ${price:,} is below ${lo:,} (junk/scam band)")
    miles = listing.get("mileage")
    if miles and miles > g("search.max_mileage", 250000):
        r.hard("mileage", f"{miles:,} miles is over the {g('search.max_mileage', 250000):,} limit")

    # ---- title -------------------------------------------------------------
    if ts in HARD_TITLE_STATUSES:
        r.hard("title", f"title status: {ts}")
    elif ts == "lien":
        r.soft("lien", "title status says lien; confirm payoff at the bank")
    for kw in _phrases(cfg, "filters.reject_title_keywords", ["salvage", "rebuilt"]):
        hit = has_phrase(text, kw)
        if hit:
            r.hard("title", f"branded-title wording: “{hit}”")
            break
    for kw in _phrases(cfg, "filters.reject_no_title_keywords", ["no title", "lost title"]):
        hit = has_phrase(text, kw, allow_negated=True)
        if hit:
            r.hard("no_title", f"no title in hand: “{hit}”")
            break
    for p in NOT_IN_NAME:
        if has_phrase(text, p, allow_negated=True):
            r.soft("title_not_in_name", "listing suggests the title isn't in the seller's name")
            break

    # ---- lien ----------------------------------------------------------------
    for p in LIEN_HARD:
        hit = has_phrase(text, p, allow_negated=True)
        if hit:
            r.hard("lien", f"lien the seller may not be able to clear: “{hit}”")
            break
    for p in LIEN:
        if has_phrase(text, p):
            r.soft("lien", "mentions a lien/loan; confirm payoff at the bank before buying")
            break

    # ---- running ----------------------------------------------------------------
    for kw in _phrases(cfg, "filters.reject_not_running_keywords", ["doesn't run", "won't start"]):
        hit = has_phrase(text, kw)
        if hit:
            r.hard("not_running", f"not running: “{hit}”")
            break
    attrs = listing.get("attrs") if isinstance(listing.get("attrs"), dict) else {}
    if (attrs or {}).get("condition") == "salvage":
        r.hard("not_running", "Craigslist condition: salvage")

    # ---- dealer ---------------------------------------------------------------
    for p in _phrases(cfg, "filters.dealer_keywords", DEFAULT_DEALER):
        hit = has_phrase(text, p)
        if hit:
            r.hard("dealer", f"dealer wording: “{hit}”")
            break
    seller_info = listing.get("seller_info") if isinstance(listing.get("seller_info"), dict) else {}
    if (seller_info or {}).get("dealer_hint"):
        r.hard("dealer", "Marketplace marks this as a dealership listing")

    # ---- scam -------------------------------------------------------------------
    for p in _phrases(cfg, "filters.scam.hard_keywords", DEFAULT_SCAM_HARD):
        hit = has_phrase(text, p)
        if hit:
            r.scam_signals.append(f"“{hit}”")
    if source == "facebook":
        for p in _phrases(cfg, "filters.scam.facebook_offplatform_keywords", DEFAULT_OFFPLATFORM_FB):
            hit = has_phrase(text, p, allow_negated=True)
            if hit:
                r.scam_signals.append(f"pushes off-platform contact: “{hit}”")
                break
    if r.scam_signals:
        r.hard("scam", "scam signals: " + ", ".join(r.scam_signals[:3]))
    for p in _phrases(cfg, "filters.scam.soft_keywords", DEFAULT_SCAM_SOFT):
        if has_phrase(text, p):
            r.soft("payment_app_mention", "mentions a payment app; pay only in person after inspection")
            break

    r.phones = sorted(set(re.sub(r"\D", "", p)[-10:] for p in PHONE_RE.findall(desc)))
    if source == "facebook" and r.phones:
        r.soft("offplatform_phone", "phone number in a Marketplace listing")

    # ---- soft flags ----------------------------------------------------------------
    if miles and miles > 200000:
        r.soft("over_200k_miles", f"{miles:,} miles")
    if not miles:
        r.soft("unknown_mileage", "mileage not stated")
    photos = listing.get("photos") or []
    if listing.get("detail_fetched") and isinstance(photos, list) and len(photos) <= 2:
        r.soft("two_or_fewer_photos", f"{len(photos)} photo(s)")
    if listing.get("detail_fetched") and len(desc.strip()) < 60:
        r.soft("vague_description", "very short description")
    for p in MINOR_WORK:
        hit = has_phrase(text, p)
        if hit:
            r.soft("needs_minor_work", f"“{hit}”")
            break

    # ---- Claude extraction: can add rejects/flags, never remove them ------------------
    if llm:
        claim = (llm.get("title_status_claim") or "unknown").lower()
        if claim in HARD_TITLE_STATUSES:
            r.hard("title", f"listing text says title is {claim} (Claude)")
        elif claim == "lien":
            r.soft("lien", "listing mentions a lien (Claude)")
        if (llm.get("runs") or "").lower() == "no":
            r.hard("not_running", "listing says it doesn't run (Claude)")
        if (llm.get("title_in_hand") or "").lower() == "no":
            r.hard("no_title", "listing says the title isn't in hand (Claude)")
        if llm.get("seller_is_dealer") is True:
            r.hard("dealer", "reads like a dealer listing (Claude)")
        if (llm.get("title_in_sellers_name") or "").lower() == "no":
            r.soft("title_not_in_name", "title not in seller's name (Claude)")
        for s in (llm.get("scam_signals") or [])[:2]:
            r.soft("possible_scam_signal", str(s)[:120])
        issues = [str(i)[:80] for i in (llm.get("known_issues") or [])[:4]]
        if issues:
            r.soft("needs_minor_work", "; ".join(issues))
    return r


def price_scam_check(price: Optional[int], market: Optional[float], confidence: str, cfg) -> tuple[Optional[str], Optional[str]]:
    """Returns (hard_reason, soft_reason) for 'price far below market'."""
    if not price or not market:
        return None, None
    ratio = cfg.get("filters.scam.price_below_market_ratio", 0.55) if cfg else 0.55
    if price < market * ratio:
        msg = f"asking ${price:,} is under {int(ratio * 100)}% of est. market ${market:,.0f}"
        if confidence in ("HIGH", "MEDIUM"):
            return msg, None
        return None, msg + " (market estimate is LOW confidence; verify, possible scam)"
    return None, None


def check_seller_text(text: str) -> dict:
    """Deterministic red-flag scan of a seller's message (runs alongside Claude)."""
    t = _clean(text)
    return {
        "asks_deposit": bool(has_phrase(t, r"deposit") or has_phrase(t, r"hold (?:it|the car) (?:for you|with)")),
        "payment_app": any(has_phrase(t, re.escape(p)) for p in DEFAULT_SCAM_SOFT),
        "off_platform": bool(EMAIL_RE.search(text or "") or has_phrase(t, r"email me") or has_phrase(t, r"text me")),
        "shipping": bool(has_phrase(t, r"shipping") or has_phrase(t, r"ship it")),
    }
