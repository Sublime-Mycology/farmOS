"""Outbound message templates. Code fills them; the model never free-writes to sellers.

Every template is honest: written as a private buyer, no invented competing offers,
no claims about the car, no pressure. Agreed prices always carry the inspection
condition.
"""
from __future__ import annotations

INSPECTION = "pending in-person inspection"


def vehicle_name(listing: dict) -> str:
    parts = [str(listing.get("year") or ""), listing.get("make") or "", listing.get("model") or ""]
    name = " ".join(p for p in parts if p).strip()
    if name:
        return name
    title = (listing.get("title") or "car").strip()
    return title[:40]


def _sig(owner: dict) -> str:
    n = (owner or {}).get("first_name") or ""
    return f"\n\nThanks,\n{n}" if n else "\n\nThanks!"


def _pick(options: list[str], key: str) -> str:
    return options[sum(map(ord, key or "x")) % len(options)]


def first_contact(listing: dict, owner: dict) -> str:
    name = vehicle_name(listing)
    opener = _pick([f"Hi! Is your {name} still available?",
                    f"Hi there, is the {name} still available?",
                    f"Hello! Is your {name} still for sale?"], str(listing.get("listing_id")))
    return (f"{opener} I'm a private buyer in the area. Could you send me the VIN, and is the title "
            f"clean and in your name? Any known issues I should know about?" + _sig(owner))


def ask_missing(listing: dict, missing: list[str], owner: dict) -> str:
    asks = {"vin": "the VIN", "title": "whether the title is clean and in your name", "issues": "any known issues"}
    items = [asks[m] for m in missing if m in asks]
    if not items:
        items = ["a couple of details"]
    joined = items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]
    return f"Thanks for getting back to me! Could you also share {joined}?" + _sig(owner)


def lien_question(listing: dict, owner: dict) -> str:
    return ("Thanks! Is there a loan on it? If so, would it be paid off and the title released "
            "as part of the sale (for example, at your bank)?" + _sig(owner))


def holding(listing: dict, owner: dict) -> str:
    return ("Thanks so much for the info! Let me look at the numbers and I'll get back to you soon." + _sig(owner))


def offer(listing: dict, amount: int, owner: dict, round_no: int, final: bool = False) -> str:
    a = f"${amount:,}"
    if final:
        body = f"I appreciate you working with me. I can do {a}, {INSPECTION}. That's honestly the most I can do."
    elif round_no <= 1:
        body = f"Thanks for the details! Would you consider {a} for the {vehicle_name(listing)}, {INSPECTION}?"
    else:
        body = _pick([f"I appreciate that. I could go up to {a}, {INSPECTION}.",
                      f"Thanks. Would {a} work for you, {INSPECTION}?"], f"{listing.get('listing_id')}{round_no}")
    return body + _sig(owner)


def accept(listing: dict, amount: int, owner: dict) -> str:
    return (f"Great, {f'${amount:,}'} works for me, {INSPECTION}. "
            f"I'll follow up shortly about a time to come take a look." + _sig(owner))


def decline(listing: dict, best: int, owner: dict) -> str:
    return (f"Thanks for getting back to me. That's more than I can do; {f'${best:,}'} ({INSPECTION}) is my max. "
            f"If anything changes, feel free to reach out. Good luck with the sale!" + _sig(owner))


def pass_title(listing: dict, owner: dict) -> str:
    return ("Thanks for letting me know. I'm only looking for clean-title cars, so I'll pass. "
            "Good luck with the sale!" + _sig(owner))
