"""Distance helpers. Listings with a map pin use it; otherwise a town lookup."""
from __future__ import annotations

import json
import math
import re
import urllib.parse
import urllib.request
from typing import Optional

from .db import DB, now_iso

# Approximate town centroids (lat, lon) for the area within ~130 mi of the
# central Shenandoah Valley. Good to a few miles, which is all scoring needs.
TOWNS: dict[str, tuple[float, float]] = {
    "shenandoah, va": (38.4857, -78.6239), "elkton, va": (38.4079, -78.6236),
    "stanley, va": (38.5784, -78.5103), "luray, va": (38.6654, -78.4594),
    "harrisonburg, va": (38.4496, -78.8689), "rockingham, va": (38.4496, -78.8689),
    "broadway, va": (38.6132, -78.7989), "timberville, va": (38.6390, -78.7739),
    "bridgewater, va": (38.3821, -78.9767), "dayton, va": (38.4146, -78.9389),
    "grottoes, va": (38.2671, -78.8259), "mcgaheysville, va": (38.3743, -78.7392),
    "new market, va": (38.6479, -78.6714), "mount jackson, va": (38.7457, -78.6422),
    "edinburg, va": (38.8210, -78.5653), "woodstock, va": (38.8818, -78.5056),
    "strasburg, va": (38.9887, -78.3586), "front royal, va": (38.9182, -78.1944),
    "stephens city, va": (39.0834, -78.2181), "winchester, va": (39.1857, -78.1633),
    "berryville, va": (39.1518, -77.9822), "staunton, va": (38.1496, -79.0717),
    "waynesboro, va": (38.0685, -78.8895), "verona, va": (38.2015, -79.0081),
    "fishersville, va": (38.0985, -78.9686), "stuarts draft, va": (38.0301, -79.0336),
    "crozet, va": (38.0696, -78.7006), "charlottesville, va": (38.0293, -78.4767),
    "ruckersville, va": (38.2332, -78.3692), "stanardsville, va": (38.2971, -78.4400),
    "madison, va": (38.3804, -78.2578), "orange, va": (38.2454, -78.1108),
    "gordonsville, va": (38.1374, -78.1878), "louisa, va": (38.0251, -77.9967),
    "culpeper, va": (38.4732, -77.9967), "sperryville, va": (38.6571, -78.2264),
    "washington, va": (38.7132, -78.1592), "warrenton, va": (38.7135, -77.7953),
    "marshall, va": (38.8651, -77.8572), "bealeton, va": (38.5718, -77.7631),
    "remington, va": (38.5357, -77.8111), "middleburg, va": (38.9687, -77.7355),
    "purcellville, va": (39.1368, -77.7147), "leesburg, va": (39.1157, -77.5636),
    "ashburn, va": (39.0437, -77.4875), "sterling, va": (39.0062, -77.4286),
    "herndon, va": (38.9696, -77.3861), "chantilly, va": (38.8943, -77.4311),
    "centreville, va": (38.8404, -77.4289), "gainesville, va": (38.7957, -77.6139),
    "haymarket, va": (38.8121, -77.6364), "manassas, va": (38.7509, -77.4753),
    "fairfax, va": (38.8462, -77.3064), "woodbridge, va": (38.6582, -77.2497),
    "dale city, va": (38.6371, -77.3111), "stafford, va": (38.4221, -77.4083),
    "fredericksburg, va": (38.3032, -77.4605), "spotsylvania, va": (38.2010, -77.5889),
    "arlington, va": (38.8816, -77.0910), "alexandria, va": (38.8048, -77.0469),
    "lexington, va": (37.7840, -79.4428), "buena vista, va": (37.7343, -79.3539),
    "lynchburg, va": (37.4138, -79.1422), "amherst, va": (37.5851, -79.0514),
    "lovingston, va": (37.7599, -78.8706), "nellysford, va": (37.8932, -78.8722),
    "scottsville, va": (37.7985, -78.4914), "palmyra, va": (37.8579, -78.2628),
    "monterey, va": (38.4123, -79.5806), "covington, va": (37.7935, -79.9939),
    "richmond, va": (37.5407, -77.4360), "roanoke, va": (37.2710, -79.9414),
    "washington, dc": (38.9072, -77.0369), "martinsburg, wv": (39.4562, -77.9639),
    "charles town, wv": (39.2890, -77.8597), "ranson, wv": (39.2954, -77.8603),
    "shepherdstown, wv": (39.4301, -77.8044), "inwood, wv": (39.3576, -78.0400),
    "berkeley springs, wv": (39.6251, -78.2272), "romney, wv": (39.3418, -78.7567),
    "moorefield, wv": (39.0623, -78.9692), "petersburg, wv": (38.9926, -79.1237),
    "franklin, wv": (38.6429, -79.3311), "wardensville, wv": (39.0751, -78.5939),
    "capon bridge, wv": (39.2976, -78.4339), "mathias, wv": (38.8721, -78.8655),
    "hagerstown, md": (39.6418, -77.7200), "williamsport, md": (39.6004, -77.8205),
    "frederick, md": (39.4143, -77.4105), "thurmont, md": (39.6237, -77.4111),
    "cumberland, md": (39.6529, -78.7625), "germantown, md": (39.1732, -77.2717),
    "gaithersburg, md": (39.1434, -77.2014), "rockville, md": (39.0840, -77.1528),
    "bethesda, md": (38.9847, -77.0947), "silver spring, md": (38.9907, -77.0261),
}

STATE_ABBR = {"virginia": "va", "west virginia": "wv", "maryland": "md", "district of columbia": "dc"}


def haversine_mi(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(h))


def normalize_place(text: str) -> str:
    t = (text or "").lower().strip()
    t = re.sub(r"\s+", " ", t)
    for full, ab in STATE_ABBR.items():
        t = re.sub(rf",\s*{full}$", f", {ab}", t)
    return t


def lookup_place(place: str, db: DB | None = None, allow_network: bool = False) -> Optional[tuple[float, float]]:
    key = normalize_place(place)
    if not key:
        return None
    if key in TOWNS:
        return TOWNS[key]
    if db is not None:
        r = db.one("SELECT lat, lon FROM geocache WHERE place = ?", (key,))
        if r:
            return (r["lat"], r["lon"]) if r["lat"] is not None else None
    if not allow_network:
        return None
    # OpenStreetMap Nominatim, cached forever; generic app name, no personal data.
    try:
        qs = urllib.parse.urlencode({"q": key + ", USA", "format": "json", "limit": 1})
        req = urllib.request.Request(
            f"https://nominatim.openstreetmap.org/search?{qs}",
            headers={"User-Agent": "flipscout/0.1 (personal car search tool)"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        latlon = (float(data[0]["lat"]), float(data[0]["lon"])) if data else None
    except Exception:
        latlon = None
    if db is not None:
        db.x("INSERT OR REPLACE INTO geocache (place, lat, lon, looked_up_at) VALUES (?,?,?,?)",
             (key, latlon[0] if latlon else None, latlon[1] if latlon else None, now_iso()))
    return latlon


def road_distance(home: tuple[float, float] | None, lat: float | None, lon: float | None,
                  place: str, factor: float, db: DB | None = None,
                  allow_network: bool = False) -> tuple[Optional[float], bool]:
    """Return (approx road miles, is_approx)."""
    if home is None:
        return None, True
    if lat is not None and lon is not None:
        return round(haversine_mi(home, (lat, lon)) * factor, 1), False
    latlon = lookup_place(place, db, allow_network)
    if latlon is None:
        return None, True
    return round(haversine_mi(home, latlon) * factor, 1), True
