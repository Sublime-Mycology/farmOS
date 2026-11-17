"""Facebook Marketplace (Vehicles) collector and text parsers.

Marketplace class names are obfuscated and change often, so parsing works on
the page's visible text and links, not CSS classes.
"""
from __future__ import annotations

import re
import urllib.parse
from typing import Optional

from ..parsing import Listing, age_from_relative, find_vin, parse_mileage, parse_price, parse_ymm

ITEM_RE = re.compile(r"/marketplace/item/(\d+)")
CITY_RE = re.compile(r"^([A-Z][A-Za-z.' -]+),\s*([A-Z]{2})$")
PRICE_LINE_RE = re.compile(r"^\$\s?[\d,]+$")


def item_url(item_id: str) -> str:
    return f"https://www.facebook.com/marketplace/item/{item_id}/"


def search_url(cfg) -> str:
    slug = (cfg.get("sources.facebook.location_slug") or "category").strip("/")
    params = {
        "minPrice": cfg.get("search.min_asking_price", 1000),
        "maxPrice": cfg.get("search.comps_max_price", cfg.get("search.max_asking_price", 9500)),
        "minYear": cfg.get("search.min_year", 1992),
        "maxMileage": cfg.get("search.max_mileage", 250000),
        "sortBy": cfg.get("sources.facebook.sort", "creation_time_descend"),
        "exact": "false",
        "topLevelVehicleType": "car_truck",
    }
    return f"https://www.facebook.com/marketplace/{slug}/vehicles?" + urllib.parse.urlencode(params)


def parse_card_text(text: str) -> dict:
    lines = [ln.strip() for ln in (text or "").split("\n") if ln.strip()]
    prices = [parse_price(ln) for ln in lines if PRICE_LINE_RE.match(ln.replace(" ", ""))]
    title = next((ln for ln in lines if re.match(r"^(19|20)\d\d\b", ln)), "")
    loc = next((ln for ln in lines if CITY_RE.match(ln)), "")
    miles = next((parse_mileage(ln) for ln in lines if re.search(r"\b(miles|mi|km)\b", ln, re.I)), None)
    price = prices[0] if prices else None
    prev = prices[1] if len(prices) > 1 and prices[1] and price and prices[1] > price else None
    return {"title": title, "price": price, "prev_price": prev, "location": loc, "mileage": miles}


def parse_search(links: list) -> list[dict]:
    out: dict[str, dict] = {}
    for href, text in links:
        m = ITEM_RE.search(href or "")
        if not m or m.group(1) in out:
            continue
        card = parse_card_text(text)
        if not card["title"] and not card["price"]:
            continue
        out[m.group(1)] = {"listing_id": m.group(1), "url": item_url(m.group(1)), **card}
    return list(out.values())


_DESC_END = ("See less", "Location is approximate", "Seller information", "Seller details",
             "Today's picks", "Send seller a message", "Sponsored")


def parse_detail(text: str, url: str, images: list | None = None) -> Listing:
    lines = [ln.strip() for ln in (text or "").split("\n") if ln.strip()]
    m = ITEM_RE.search(url)
    item_id = m.group(1) if m else ""

    title_idx = next((i for i, ln in enumerate(lines) if re.match(r"^(19|20)\d\d\s+\S+", ln)), None)
    title = lines[title_idx] if title_idx is not None else ""
    price = prev = None
    if title_idx is not None:
        ps: list[int] = []
        for ln in lines[title_idx + 1:title_idx + 5]:
            found = [int(x.replace(",", "")) for x in re.findall(r"\$([\d,]+)", ln.replace(" ", ""))]
            if found:
                ps += found
            elif ps:
                break   # prices are consecutive; stop at the first non-price line after them
        if ps:
            price = ps[0]
            if len(ps) > 1 and ps[1] > ps[0]:
                prev = ps[1]

    joined = "\n".join(lines)
    age = None
    loc = ""
    lm = re.search(r"Listed\s+(.+?)\s+ago\s+in\s+([^\n]+)", joined, re.I)
    if lm:
        age = age_from_relative(lm.group(1) + " ago")
        loc = lm.group(2).strip()
    else:
        lm2 = re.search(r"Listed\s+(.+?ago)", joined, re.I)
        if lm2:
            age = age_from_relative(lm2.group(1))

    mileage = None
    dm = re.search(r"Driven\s+([\d,]+)\s+(miles|kilometers)", joined, re.I)
    if dm:
        mileage = int(dm.group(1).replace(",", ""))
        if dm.group(2).lower().startswith("kilo"):
            mileage = int(mileage * 0.621)
    trans = None
    tm = re.search(r"\b(Automatic|Manual)\s+transmission", joined, re.I)
    if tm:
        trans = tm.group(1).lower()

    title_status = None
    if re.search(r"^Clean title$", joined, re.I | re.M):
        title_status = "clean"
    ts = re.search(r"Title(?: status)?:\s*([A-Za-z ]+)", joined)
    if ts:
        title_status = ts.group(1).strip().lower()
    if re.search(r"(salvage|rebuilt) title", joined, re.I) and title_status in (None, "clean"):
        title_status = re.search(r"(salvage|rebuilt) title", joined, re.I).group(1).lower()

    owners = None
    om = re.search(r"^(\d+)\s+owners?$", joined, re.I | re.M)
    if om:
        owners = int(om.group(1))

    desc = ""
    if "Seller's description" in lines or "Description" in lines:
        start = lines.index("Seller's description") if "Seller's description" in lines else lines.index("Description")
        buf = []
        for ln in lines[start + 1:]:
            if ln in _DESC_END:
                break
            if ln == "See more":
                continue
            buf.append(ln)
        desc = "\n".join(buf)

    seller = ""
    joined_year = None
    for marker in ("Seller information", "Seller details"):
        if marker in lines:
            i = lines.index(marker)
            nxt = [ln for ln in lines[i + 1:i + 6] if ln not in ("Seller details", "See more")]
            if nxt:
                seller = nxt[0]
            jm = re.search(r"Joined Facebook in (\d{4})", "\n".join(lines[i:i + 8]))
            if jm:
                joined_year = int(jm.group(1))
            break

    photos = []
    for src, alt in images or []:
        if src and (alt or "").lower().startswith("product photo"):
            photos.append(src)
    if not photos:
        photos = [s for s, a in (images or []) if s and "scontent" in s][:10]
    photos = list(dict.fromkeys(photos))[:10]

    year, make, model, trim = parse_ymm(title)
    # Only the header area (before the seller's description) can carry a dealership label;
    # "dealer maintained" in the description must not count.
    desc_start = next((i for i, ln in enumerate(lines) if ln in ("Seller's description", "Description")), min(len(lines), 30))
    dealer_hint = any(re.match(r"^(?:dealership|dealer)\b", ln, re.I) or "· Dealership" in ln
                      for ln in lines[:desc_start])
    return Listing(
        source="facebook", listing_id=item_id, url=item_url(item_id) if item_id else url, title=title,
        price=price, prev_price=prev, year=year, make=make, model=model, trim=trim, mileage=mileage,
        location_text=loc, title_status=title_status, vin=find_vin(desc), transmission=trans,
        description=desc, seller_name=seller,
        seller_info={"joined_year": joined_year, "owners": owners, "dealer_hint": dealer_hint},
        listing_age_days=age, photos=photos, detail_fetched=True,
        attrs={"owners": owners} if owners else {},
    )


def logged_in(snapshot_text: str, html: str) -> bool:
    if 'name="pass"' in html and 'name="email"' in html:
        return False
    return "Marketplace" in snapshot_text
