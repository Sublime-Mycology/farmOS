"""Craigslist 'cars & trucks - by owner' (cto) collector and parsers."""
from __future__ import annotations

import json
import re
import urllib.parse
from datetime import datetime, timezone
from typing import Optional

from bs4 import BeautifulSoup

from ..parsing import Listing, find_vin, parse_mileage, parse_price, parse_ymm

POST_RE = re.compile(r"https?://([a-z0-9]+)\.craigslist\.org/(?:[a-z]{3}/)?(?:cto|cta)/d/[^/]+/(\d{8,12})\.html")


def search_url(site: str, cfg, page: int = 0) -> str:
    owner = cfg.owner
    params = {
        "postal": owner.get("home_zip", ""),
        "search_distance": cfg.get("search.radius_miles", 100),
        "min_auto_year": cfg.get("search.min_year", 1992),
        "min_price": cfg.get("search.min_asking_price", 1000),
        "max_price": cfg.get("search.comps_max_price", cfg.get("search.max_asking_price", 9500)),
        "sort": "date",
    }
    if page:
        params["s"] = 120 * page
    return f"https://{site}.craigslist.org/search/cto?" + urllib.parse.urlencode(params)


def parse_search(html: str) -> list[dict]:
    """Return stubs: listing_id, url, title, price, location, mileage (if shown)."""
    soup = BeautifulSoup(html, "html.parser")
    out: dict[str, dict] = {}

    # 1) static no-JS list
    for li in soup.select("li.cl-static-search-result"):
        a = li.find("a", href=True)
        if not a:
            continue
        m = POST_RE.search(a["href"])
        if not m:
            continue
        title = (li.select_one(".title") or a).get_text(" ", strip=True)
        price = parse_price((li.select_one(".price") or li).get_text(" ", strip=True))
        loc = (li.select_one(".location").get_text(" ", strip=True) if li.select_one(".location") else "")
        out[m.group(2)] = {"listing_id": m.group(2), "url": a["href"], "title": title,
                           "price": price, "location": loc, "mileage": None}

    # 2) JS-rendered list/gallery cards
    for card in soup.select("[data-pid], li.cl-search-result, div.cl-search-result"):
        a = card.find("a", href=POST_RE)
        if not a:
            continue
        m = POST_RE.search(a["href"])
        pid = m.group(2)
        if pid in out:
            continue
        label = card.select_one(".label, .posting-title, .titlestring")
        title = (label or a).get_text(" ", strip=True)
        pinfo = card.select_one(".priceinfo, .price")
        meta = card.select_one(".meta")
        meta_text = meta.get_text(" · ", strip=True) if meta else ""
        out[pid] = {"listing_id": pid, "url": a["href"], "title": title,
                    "price": parse_price(pinfo.get_text() if pinfo else card.get_text(" ")),
                    "location": meta_text.split(" · ")[-1] if meta_text else "",
                    "mileage": parse_mileage(meta_text)}

    # 3) anything else that links to a posting
    if not out:
        for a in soup.find_all("a", href=POST_RE):
            m = POST_RE.search(a["href"])
            text = a.get_text(" ", strip=True)
            out.setdefault(m.group(2), {"listing_id": m.group(2), "url": a["href"], "title": text,
                                        "price": parse_price(text), "location": "", "mileage": None})
    return list(out.values())


def _attrs(soup: BeautifulSoup) -> tuple[dict, str]:
    attrs: dict[str, str] = {}
    header = ""
    # 2023+ format: <div class="attr"><span class="labl">odometer:</span><span class="valu">..</span></div>
    for div in soup.select(".attrgroup .attr"):
        lab, val = div.select_one(".labl"), div.select_one(".valu")
        if lab and val:
            attrs[lab.get_text(" ", strip=True).rstrip(":").lower()] = val.get_text(" ", strip=True).lower()
        elif not header:
            header = div.get_text(" ", strip=True)
    # older format: <p class="attrgroup"><span>odometer: <b>123000</b></span>
    for grp in soup.select("p.attrgroup, div.attrgroup"):
        for span in grp.find_all("span", recursive=False):
            t = span.get_text(" ", strip=True)
            if ":" in t:
                k, v = t.split(":", 1)
                attrs.setdefault(k.strip().lower(), v.strip().lower())
            elif not header and re.search(r"\b(19|20)\d\d\b", t):
                header = t
    yr = soup.select_one(".attrgroup .attr.important, .attrgroup .year")
    if yr and not header:
        header = yr.get_text(" ", strip=True)
    return attrs, header


def parse_detail(html: str, url: str, now: Optional[datetime] = None) -> Listing:
    now = now or datetime.now(timezone.utc)
    soup = BeautifulSoup(html, "html.parser")
    m = POST_RE.search(url)
    pid = m.group(2) if m else re.sub(r"\D", "", url)[-10:]
    title_el = soup.select_one("#titletextonly")
    title = title_el.get_text(" ", strip=True) if title_el else (soup.title.get_text(strip=True) if soup.title else "")
    price_el = soup.select_one(".postingtitletext .price, span.price")
    price = parse_price(price_el.get_text() if price_el else "")
    loc = ""
    ptt = soup.select_one(".postingtitletext")
    if ptt:
        lm = re.search(r"\(([^)]+)\)\s*$", ptt.get_text(" ", strip=True))
        loc = lm.group(1) if lm else ""
    lat = lon = None
    mp = soup.select_one("#map[data-latitude]")
    if mp:
        try:
            lat, lon = float(mp["data-latitude"]), float(mp["data-longitude"])
        except (KeyError, ValueError):
            pass
    attrs, header = _attrs(soup)
    body_el = soup.select_one("#postingbody")
    if body_el:
        for junk in body_el.select(".print-qrcode-container, .print-information"):
            junk.decompose()
    body = body_el.get_text("\n", strip=True) if body_el else ""

    year, make, model, trim = parse_ymm(header) if header else (None, None, None, None)
    ty, tmk, tmd, ttr = parse_ymm(title)
    year = year or ty
    make = make or tmk
    model = model or tmd
    trim = trim or ttr

    mileage = None
    if "odometer" in attrs:
        digits = re.sub(r"\D", "", attrs["odometer"])
        mileage = int(digits) if digits else None
    mileage = mileage or parse_mileage(body) or parse_mileage(title)

    posted = None
    t = soup.select_one(".postinginfos time[datetime], time.date.timeago[datetime], time[datetime]")
    if t:
        posted = t["datetime"]
    age = None
    if posted:
        try:
            iso = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", posted.replace("Z", "+00:00"))
            dt = datetime.fromisoformat(iso)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            age = round((now - dt).total_seconds() / 86400, 2)
        except ValueError:
            pass

    photos: list[str] = []
    for script in soup.find_all("script"):
        s = script.string or ""
        jm = re.search(r"var imgList = (\[.*?\]);", s, re.S)
        if jm:
            try:
                photos = [x.get("url") for x in json.loads(jm.group(1)) if x.get("url")]
            except ValueError:
                pass
    if not photos:
        photos = [i.get("src") for i in soup.find_all("img") if "images.craigslist.org" in (i.get("src") or "")]
    photos = list(dict.fromkeys(photos))

    vin = (attrs.get("vin") or "").upper() or None
    vin = vin if vin and len(vin) == 17 else find_vin(body)

    return Listing(
        source="craigslist", listing_id=pid, url=url, title=title, price=price, year=year, make=make,
        model=model, trim=trim, mileage=mileage, location_text=loc, lat=lat, lon=lon,
        title_status=attrs.get("title status"), vin=vin, transmission=attrs.get("transmission"),
        description=body, posted_at=posted, listing_age_days=age, photos=photos, attrs=attrs,
        detail_fetched=True,
    )


def reply_relay_email(page) -> Optional[str]:
    """Click 'reply' on a live posting page and read the relay address, if shown
    without a challenge. Returns None if a CAPTCHA or anything unexpected shows."""
    try:
        btn = page.locator("button.reply-button, .reply-button, a.reply-button").first
        if btn.count() == 0:
            return None
        btn.click(timeout=5000)
        page.wait_for_timeout(2500)
        if page.locator("iframe[src*='captcha'], .h-captcha, #hcaptcha").count() > 0:
            return None
        link = page.locator(".reply-email-address a[href^='mailto:'], a.mailapp[href^='mailto:']").first
        if link.count() == 0:
            return None
        href = link.get_attribute("href") or ""
        addr = href.replace("mailto:", "").split("?")[0]
        return addr if "@" in addr else None
    except Exception:
        return None
