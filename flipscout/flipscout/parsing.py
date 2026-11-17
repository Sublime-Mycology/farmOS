"""Text helpers shared by the Craigslist and Marketplace parsers."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

MAKES = {
    "acura": "Acura", "audi": "Audi", "bmw": "BMW", "buick": "Buick", "cadillac": "Cadillac",
    "chevrolet": "Chevrolet", "chevy": "Chevrolet", "chrysler": "Chrysler", "dodge": "Dodge",
    "fiat": "Fiat", "ford": "Ford", "gmc": "GMC", "honda": "Honda", "hyundai": "Hyundai",
    "infiniti": "Infiniti", "isuzu": "Isuzu", "jaguar": "Jaguar", "jeep": "Jeep", "kia": "Kia",
    "land rover": "Land Rover", "landrover": "Land Rover", "lexus": "Lexus", "lincoln": "Lincoln",
    "mazda": "Mazda", "mercedes-benz": "Mercedes-Benz", "mercedes": "Mercedes-Benz", "benz": "Mercedes-Benz",
    "mercury": "Mercury", "mini": "Mini", "mitsubishi": "Mitsubishi", "nissan": "Nissan",
    "oldsmobile": "Oldsmobile", "pontiac": "Pontiac", "porsche": "Porsche", "ram": "Ram",
    "saab": "Saab", "saturn": "Saturn", "scion": "Scion", "subaru": "Subaru", "suzuki": "Suzuki",
    "tesla": "Tesla", "toyota": "Toyota", "volkswagen": "Volkswagen", "vw": "Volkswagen",
    "volvo": "Volvo", "plymouth": "Plymouth", "geo": "Geo",
}

TRUCK_SUV_MODELS = {
    "f-150", "f150", "f-250", "f250", "silverado", "sierra", "ram", "1500", "2500", "tacoma", "tundra",
    "ranger", "colorado", "canyon", "frontier", "ridgeline", "titan", "4runner", "cr-v", "crv",
    "rav4", "highlander", "pilot", "tahoe", "suburban", "yukon", "explorer", "expedition",
    "grand cherokee", "cherokee", "wrangler", "escape", "equinox", "forester", "outback",
    "rogue", "pathfinder", "sequoia", "durango", "liberty", "trailblazer", "envoy", "edge",
    "tucson", "santa fe", "sorento", "sportage", "cx-5", "odyssey", "sienna", "dakota",
}

HIGH_RETENTION_MAKES = {"Toyota", "Honda", "Lexus", "Subaru", "Acura", "Mazda"}
HIGH_RETENTION_MODELS = {"tacoma", "4runner", "wrangler", "tundra", "land cruiser"}
LOW_RETENTION_MAKES = {
    "Chrysler", "Dodge", "Nissan", "Kia", "Hyundai", "Mitsubishi", "Fiat", "Mini", "Jaguar",
    "Land Rover", "BMW", "Mercedes-Benz", "Audi", "Volkswagen", "Cadillac", "Lincoln", "Buick",
    "Infiniti", "Volvo", "Saab", "Saturn", "Mercury", "Pontiac", "Oldsmobile", "Chrysler",
}

PRICE_RE = re.compile(r"\$\s?([\d]{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?")
YEAR_RE = re.compile(r"\b(19[5-9]\d|20[0-3]\d)\b")
VIN_RE = re.compile(r"\b([A-HJ-NPR-Z0-9]{17})\b", re.I)


@dataclass
class Listing:
    source: str
    listing_id: str
    url: str
    title: str = ""
    price: Optional[int] = None
    prev_price: Optional[int] = None
    year: Optional[int] = None
    make: Optional[str] = None
    model: Optional[str] = None
    trim: Optional[str] = None
    mileage: Optional[int] = None
    location_text: str = ""
    lat: Optional[float] = None
    lon: Optional[float] = None
    title_status: Optional[str] = None
    vin: Optional[str] = None
    transmission: Optional[str] = None
    description: str = ""
    seller_name: str = ""
    seller_info: dict = field(default_factory=dict)
    posted_at: Optional[str] = None
    listing_age_days: Optional[float] = None
    photos: list = field(default_factory=list)
    attrs: dict = field(default_factory=dict)
    detail_fetched: bool = False


def parse_price(text: str | None) -> Optional[int]:
    if not text:
        return None
    m = PRICE_RE.search(text)
    if not m:
        return None
    try:
        return int(m.group(1).replace(",", ""))
    except ValueError:
        return None


def all_prices(text: str) -> list[int]:
    return [int(m.group(1).replace(",", "")) for m in PRICE_RE.finditer(text or "")]


def parse_mileage(text: str | None) -> Optional[int]:
    """'120K miles', '120,000 miles', 'odometer: 120000', 'Driven 98,500 miles'."""
    if not text:
        return None
    t = text.lower().replace(" ", " ")
    m = re.search(r"(\d{1,3}(?:\.\d)?)\s?k\s*(?:mi\b|miles\b|mileage)", t)
    if m:
        return int(float(m.group(1)) * 1000)
    m = re.search(r"(\d{1,3}(?:,\d{3})+|\d{4,7})\s*(?:mi\b|miles\b)", t)
    if m:
        return int(m.group(1).replace(",", ""))
    m = re.search(r"(?:odometer|mileage|miles)\s*[:\-]?\s*(\d{1,3}(?:,\d{3})+|\d{3,7})", t)
    if m:
        return int(m.group(1).replace(",", ""))
    return None


def parse_ymm(title: str) -> tuple[Optional[int], Optional[str], Optional[str], Optional[str]]:
    """Year, make, model, trim from a listing title like '2011 Honda Accord EX-L Sedan'."""
    if not title:
        return None, None, None, None
    t = re.sub(r"\s+", " ", title.strip())
    ym = YEAR_RE.search(t)
    year = int(ym.group(1)) if ym else None
    rest = t[ym.end():] if ym else t
    words = rest.strip(" -–,").split(" ")
    low = [w.lower().strip(",.") for w in words]
    make = None
    idx = None
    for i in range(len(low)):
        two = " ".join(low[i:i + 2])
        if two in MAKES:
            make, idx = MAKES[two], i + 2
            break
        if low[i] in MAKES:
            make, idx = MAKES[low[i]], i + 1
            break
    if make is None:
        return year, None, None, None
    tail = [w for w in words[idx:] if w]
    model = None
    trim = None
    if tail:
        model = tail[0]
        # two-word models
        if len(tail) > 1 and f"{tail[0]} {tail[1]}".lower() in {
            "grand cherokee", "santa fe", "grand caravan", "town &", "land cruiser", "grand marquis",
            "crown victoria", "grand prix", "monte carlo", "park avenue", "model 3", "model s",
            "model y", "rav 4", "e 350", "e 150", "tc 2",
        }:
            model = f"{tail[0]} {tail[1]}"
            tail = tail[1:]
        trim = " ".join(tail[1:4]) or None
    return year, make, normalize_model(model), trim


def normalize_model(model: str | None) -> Optional[str]:
    if not model:
        return None
    m = model.strip(" ,.").lower()
    aliases = {"f150": "f-150", "f250": "f-250", "crv": "cr-v", "rav-4": "rav4", "rav 4": "rav4",
               "cx5": "cx-5", "4-runner": "4runner", "silverado1500": "silverado"}
    m = aliases.get(m, m)
    special = {"cr-v": "CR-V", "hr-v": "HR-V", "rav4": "RAV4", "cx-5": "CX-5", "cx-9": "CX-9",
               "f-150": "F-150", "f-250": "F-250", "4runner": "4Runner", "mx-5": "MX-5"}
    if m in special:
        return special[m]
    return m.upper() if len(m) <= 3 else m.title()


def model_key(make: str | None, model: str | None) -> str:
    return f"{(make or '').lower()}|{(model or '').lower()}"


_TRANSLIT = {c: v for v, cs in {
    1: "AJ", 2: "BKS", 3: "CLT", 4: "DMU", 5: "ENV", 6: "FW", 7: "GPX", 8: "HY", 9: "RZ"}.items() for c in cs}
_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2]


def vin_check_ok(vin: str) -> bool:
    """North-American VIN check digit (position 9)."""
    vin = vin.upper()
    if len(vin) != 17 or any(c in "IOQ" for c in vin):
        return False
    total = 0
    for i, c in enumerate(vin):
        v = int(c) if c.isdigit() else _TRANSLIT.get(c)
        if v is None:
            return False
        total += v * _WEIGHTS[i]
    check = total % 11
    return vin[8] == ("X" if check == 10 else str(check))


def find_vin(text: str | None) -> Optional[str]:
    if not text:
        return None
    for m in VIN_RE.finditer(text.upper()):
        cand = m.group(1)
        if any(c.isdigit() for c in cand) and any(c.isalpha() for c in cand) and vin_check_ok(cand):
            return cand
    return None


def age_from_relative(text: str) -> Optional[float]:
    """'Listed 3 days ago', 'about a week ago', '5 hours ago' -> days."""
    t = (text or "").lower()
    m = re.search(r"(\d+|an?|about an?|over an?)\s+(minute|hour|day|week|month)s?\s+ago", t)
    if not m:
        if "yesterday" in t:
            return 1.0
        if "just now" in t:
            return 0.0
        return None
    num = m.group(1)
    n = 1 if not num[0].isdigit() else int(num)
    unit = m.group(2)
    return {"minute": n / 1440, "hour": n / 24, "day": float(n), "week": n * 7.0, "month": n * 30.0}[unit]


def clean_ws(text: str) -> str:
    return re.sub(r"[ \t ]+", " ", re.sub(r"\n{3,}", "\n\n", text or "")).strip()
