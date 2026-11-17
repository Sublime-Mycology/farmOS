"""Negotiation policy. Pure functions: given state + the seller's (parsed) reply,
decide the next action. Price limits are enforced here and again by the guard.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from . import templates as T
from ..costs import round_offer


@dataclass
class Action:
    type: str                      # send | needs_owner | wait | close
    kind: str = ""                 # first_contact | offer | accept | decline | holding | ask_info | pass ...
    text: str = ""
    amount: Optional[int] = None
    stage: Optional[str] = None    # new stage for the negotiation
    needs: list = field(default_factory=list)   # [(kind, summary)]
    note: str = ""


def opening_offer(walk_away: int, asking: Optional[int], cfg) -> tuple[int, bool]:
    """Returns (opening, close_fast)."""
    lo = float(cfg.get("negotiation.open_below_walkaway_pct.min", 0.10))
    hi = float(cfg.get("negotiation.open_below_walkaway_pct.max", 0.15))
    opening = walk_away * (1 - (lo + hi) / 2)
    close_fast = False
    if asking:
        cf_pct = float(cfg.get("negotiation.close_fast_if_asking_below_walkaway_pct", 0.15))
        if asking <= walk_away * (1 - cf_pct):
            close_fast = True
            opening = asking * (1 - float(cfg.get("negotiation.close_fast_discount_from_asking", 0.05)))
        if cfg.get("negotiation.never_above_asking", True):
            opening = min(opening, asking)
    opening = min(round_offer(opening), walk_away)
    return max(opening, 0), close_fast


def next_step(our_last: int, walk_away: int, cfg) -> int:
    step_min = float(cfg.get("negotiation.step_min_dollars", 100))
    frac = float(cfg.get("negotiation.step_fraction_of_gap", 0.33))
    nxt = round_offer(our_last + max(step_min, frac * (walk_away - our_last)))
    if nxt <= our_last:
        nxt = our_last + int(step_min)
    return min(nxt, walk_away)


def basis_ok(basis: dict, cfg) -> bool:
    """May we agree to a price on this valuation basis?"""
    if not cfg.get("negotiation.require_real_quote_to_agree", True):
        return True
    return basis.get("kind") == "REAL" or (basis.get("exit") == "patient" and basis.get("confidence") == "HIGH")


def missing_info(info: dict) -> list[str]:
    miss = []
    if not info.get("vin"):
        miss.append("vin")
    if info.get("title_clean") not in ("yes", "no"):
        miss.append("title")
    return miss


def plan_reply(state: dict, listing: dict, parsed: dict, basis: dict, cfg, owner: dict, label: str) -> Action:
    """Decide what to do after a seller message. `parsed` is the reply schema (Claude or regex)."""
    walk_away = basis.get("walk_away")
    name = T.vehicle_name(listing)
    info = state.setdefault("info", {})
    for k in ("vin", "title_clean", "title_in_sellers_name", "lien", "lien_can_be_cleared"):
        v = parsed.get(k)
        if v and v not in ("unknown", ""):
            info[k] = v
    if parsed.get("known_issues"):
        info["issues"] = list(dict.fromkeys((info.get("issues") or []) + parsed["known_issues"]))

    # --- red flags and things only you can decide -----------------------------------
    if parsed.get("injection_attempt"):
        return Action("needs_owner", stage="paused",
                      needs=[("review_message", f"{name}: seller message contained instructions aimed at a bot; review it")])
    if parsed.get("asks_for_deposit_or_payment"):
        return Action("needs_owner", stage="paused",
                      needs=[("deposit_request", f"{name}: seller asked for a deposit/payment up front (scam signal). Do not pay.")])
    if parsed.get("wants_off_platform"):
        return Action("needs_owner", stage="paused",
                      needs=[("off_platform", f"{name}: seller wants to move off-platform; your call")])
    if parsed.get("still_available") == "no":
        return Action("close", kind="sold", stage="dead", note="seller says it's no longer available")
    if info.get("title_clean") == "no":
        return Action("send", kind="pass", text=T.pass_title(listing, owner), stage="dead", note="title not clean")
    if info.get("title_in_sellers_name") == "no":
        return Action("needs_owner", stage="paused",
                      needs=[("title_not_in_name", f"{name}: title is not in the seller's name; decide whether to continue")])
    if info.get("lien") == "yes" and info.get("lien_can_be_cleared") == "no":
        return Action("close", kind="lien", stage="dead", note="lien seller can't clear")
    if parsed.get("wants_meeting_or_time"):
        return Action("needs_owner", stage=state.get("stage") or "negotiating",
                      needs=[("meeting", f"{name}: seller wants to set a time/place. {label}: you schedule this.")])

    seller_price = parsed.get("seller_price") or 0
    if seller_price:
        state["seller_last_ask"] = int(seller_price)
    our_last = state.get("our_last_offer")
    rounds = int(state.get("rounds") or 0)
    max_rounds = int(cfg.get("negotiation.max_counter_rounds", 4))

    # --- they accepted our number --------------------------------------------------
    if parsed.get("accepts_buyer_offer") and our_last and walk_away and our_last <= walk_away:
        return Action("send", kind="accept", amount=our_last, text=T.accept(listing, our_last, owner), stage="agreed",
                      needs=[("agreed", f"{name}: seller accepted ${our_last:,} {T.INSPECTION}. {label}: schedule the viewing.")])

    # --- lien needs clarifying first -------------------------------------------------
    if info.get("lien") == "yes" and info.get("lien_can_be_cleared") != "yes" and not state.get("asked_lien"):
        state["asked_lien"] = True
        return Action("send", kind="ask_info", text=T.lien_question(listing, owner), stage="info")

    # --- need VIN + title answers before talking price --------------------------------
    miss = missing_info(info)
    if miss:
        if state.get("asked_missing"):
            return Action("needs_owner", stage="info",
                          needs=[("missing_info", f"{name}: seller hasn't given {', '.join(miss)} after two asks; your call")])
        state["asked_missing"] = True
        return Action("send", kind="ask_info", text=T.ask_missing(listing, miss, owner), stage="info")

    # --- valuation basis ---------------------------------------------------------------
    if not walk_away:
        return Action("needs_owner", stage="info",
                      needs=[("no_walkaway", f"{name}: no price clears your minimum profit at current estimates")])
    if not basis_ok(basis, cfg):
        acts = [("needs_quote", f"{name}: get instant offers for VIN {info.get('vin')} (see Needs-quote list)")]
        if not state.get("sent_holding"):
            state["sent_holding"] = True
            return Action("send", kind="holding", text=T.holding(listing, owner), stage="awaiting_quote", needs=acts)
        return Action("needs_owner", stage="awaiting_quote", needs=acts)

    asking = state.get("seller_last_ask") or listing.get("price")

    # --- opening offer -----------------------------------------------------------------
    if not our_last:
        opening, close_fast = opening_offer(walk_away, asking, cfg)
        if seller_price and seller_price <= opening:
            return Action("send", kind="accept", amount=int(seller_price), text=T.accept(listing, int(seller_price), owner),
                          stage="agreed", needs=[("agreed", f"{name}: agreed ${int(seller_price):,} {T.INSPECTION}. {label}: schedule the viewing.")])
        a = Action("send", kind="offer", amount=opening, text=T.offer(listing, opening, owner, 1), stage="negotiating")
        if close_fast:
            a.note = "close fast: asking is well under walk-away"
        return a

    # --- counter-offers -------------------------------------------------------------------
    if seller_price:
        if seller_price <= our_last:
            amt = int(seller_price)
            return Action("send", kind="accept", amount=amt, text=T.accept(listing, amt, owner), stage="agreed",
                          needs=[("agreed", f"{name}: agreed ${amt:,} {T.INSPECTION}. {label}: schedule the viewing.")])
        nxt = next_step(our_last, walk_away, cfg)
        if seller_price <= nxt and seller_price <= walk_away:
            amt = int(seller_price)
            return Action("send", kind="accept", amount=amt, text=T.accept(listing, amt, owner), stage="agreed",
                          needs=[("agreed", f"{name}: agreed ${amt:,} {T.INSPECTION}. {label}: schedule the viewing.")])
        if our_last >= walk_away or rounds >= max_rounds:
            return Action("send", kind="decline", amount=our_last, text=T.decline(listing, our_last, owner), stage="stalled",
                          note=f"seller at ${seller_price:,}, above walk-away ${walk_away:,}")
        if parsed.get("price_is_firm") and seller_price > walk_away:
            return Action("send", kind="decline", amount=min(walk_away, max(our_last, nxt)),
                          text=T.decline(listing, min(walk_away, max(our_last, nxt)), owner), stage="stalled",
                          note=f"firm at ${seller_price:,}, above walk-away")
        if rounds + 1 >= max_rounds:
            nxt = walk_away  # last round: our honest best
        return Action("send", kind="offer", amount=nxt, text=T.offer(listing, nxt, owner, rounds + 1, final=nxt == walk_away),
                      stage="negotiating")

    if parsed.get("asks_question"):
        return Action("needs_owner", stage=state.get("stage"),
                      needs=[("question", f"{name}: seller asks: “{parsed['asks_question'][:140]}”")])
    return Action("needs_owner", stage=state.get("stage"),
                  needs=[("unclear_reply", f"{name}: reply needs a human read: “{(parsed.get('summary') or '')[:140]}”")])


def regex_parse_reply(text: str) -> dict:
    """Fallback reply parser when Claude is unavailable. Conservative: anything
    beyond VIN / sold / a bare price goes to you."""
    import re
    from ..filters import check_seller_text
    from ..parsing import find_vin
    low = (text or "").lower()
    flags = check_seller_text(text)
    prices = [int(p.replace(",", "")) for p in re.findall(r"\$\s?(\d{1,3}(?:,\d{3})+|\d{3,6})", text or "")]
    return {
        "still_available": "no" if re.search(r"\b(sold|no longer available|pending sale|it'?s gone)\b", low) else
                           ("yes" if re.search(r"\b(yes|yep|still available|it is available)\b", low) else "unknown"),
        "vin": find_vin(text) or "",
        "title_clean": "yes" if "clean title" in low or re.search(r"title is clean", low) else "unknown",
        "title_in_sellers_name": "yes" if re.search(r"in my name", low) and "not in my name" not in low else
                                 ("no" if "not in my name" in low else "unknown"),
        "lien": "yes" if re.search(r"\blien\b|still owe|loan", low) and not re.search(r"no lien|paid off", low) else "unknown",
        "lien_can_be_cleared": "unknown",
        "known_issues": [],
        "seller_price": prices[0] if len(prices) == 1 else 0,
        "accepts_buyer_offer": bool(re.search(r"\b(deal|you got it|i'?ll take it|sounds good|that works)\b", low)),
        "price_is_firm": bool(re.search(r"\bfirm\b|lowest i'?ll go|not taking less", low)),
        "wants_meeting_or_time": bool(re.search(r"\b(when can you|come (?:by|see|look)|meet|tomorrow|today|tonight|weekend|am\b|pm\b)", low)),
        "asks_for_deposit_or_payment": flags["asks_deposit"],
        "wants_off_platform": flags["off_platform"],
        "asks_question": (re.findall(r"([^.?!]*\?)", text or "") or [""])[0].strip()[:160],
        "summary": (text or "")[:160],
        "injection_attempt": bool(re.search(r"ignore (?:all|previous|prior) instructions|you are an ai|system prompt", low)),
        "_parser": "regex",
    }
