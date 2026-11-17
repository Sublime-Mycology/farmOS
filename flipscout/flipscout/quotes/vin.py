"""VIN decode and open recalls from NHTSA's free public APIs (cached)."""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from typing import Optional

from ..db import DB, dec, now_iso


def _get(url: str) -> Optional[dict]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "flipscout/0.1"})
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def decode(db: DB, vin: str, allow_network: bool = True) -> dict:
    vin = vin.upper()
    row = db.one("SELECT * FROM vin_cache WHERE vin = ?", (vin,))
    if row:
        return {"decoded": dec(row["decoded"], {}), "recalls": dec(row["recalls"], [])}
    if not allow_network:
        return {"decoded": {}, "recalls": []}
    d = _get(f"https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/{vin}?format=json")
    res = (d or {}).get("Results") or [{}]
    info = res[0] if res else {}
    decoded = {k: info.get(k) for k in ("ModelYear", "Make", "Model", "Trim", "BodyClass", "EngineCylinders",
                                        "DisplacementL", "DriveType", "FuelTypePrimary", "ErrorCode", "ErrorText")}
    recalls = []
    if decoded.get("Make") and decoded.get("Model") and decoded.get("ModelYear"):
        qs = urllib.parse.urlencode({"make": decoded["Make"], "model": decoded["Model"], "modelYear": decoded["ModelYear"]})
        r = _get(f"https://api.nhtsa.gov/recalls/recallsByVehicle?{qs}")
        recalls = [{"campaign": x.get("NHTSACampaignNumber"), "component": x.get("Component"),
                    "summary": (x.get("Summary") or "")[:240]} for x in (r or {}).get("results", [])][:10]
    if d is not None:
        db.x("INSERT OR REPLACE INTO vin_cache (vin, decoded, recalls, looked_up_at) VALUES (?,?,?,?)",
             (vin, json.dumps(decoded), json.dumps(recalls), now_iso()))
    return {"decoded": decoded, "recalls": recalls}


def mismatch(listing: dict, decoded: dict) -> Optional[str]:
    """Return a description if the VIN disagrees with the listing's year/make/model."""
    if not decoded or not decoded.get("Make"):
        return None
    issues = []
    try:
        if listing.get("year") and decoded.get("ModelYear") and int(decoded["ModelYear"]) != int(listing["year"]):
            issues.append(f"year {decoded['ModelYear']} vs listed {listing['year']}")
    except ValueError:
        pass
    if listing.get("make") and decoded["Make"].lower() not in listing["make"].lower() and listing["make"].lower() not in decoded["Make"].lower():
        issues.append(f"make {decoded['Make']} vs listed {listing['make']}")
    lm, dm = (listing.get("model") or "").lower(), (decoded.get("Model") or "").lower()
    if lm and dm and lm not in dm and dm not in lm:
        issues.append(f"model {decoded['Model']} vs listed {listing['model']}")
    return "; ".join(issues) or None
