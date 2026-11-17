"""Market value from comparable listings, instant-offer and patient-sale estimates,
and REAL instant offers once you have them.

Comparable data = private-party asking prices flipscout has stored itself. When a
model has too few comps, a simple market-wide regression (age, miles, brand
retention) gives a LOW-confidence fallback.
"""
from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta, timezone
from statistics import median
from typing import Optional

from .db import DB, dec
from .parsing import HIGH_RETENTION_MAKES, HIGH_RETENTION_MODELS, LOW_RETENTION_MAKES, TRUCK_SUV_MODELS

CONF_ORDER = {"NONE": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3, "REAL": 4}


def quantile(xs: list[float], q: float) -> float:
    s = sorted(xs)
    if not s:
        raise ValueError("empty")
    pos = (len(s) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


@dataclass
class Market:
    value: Optional[float] = None
    low: Optional[float] = None
    high: Optional[float] = None
    n: int = 0
    method: str = "none"          # comps | model | none
    confidence: str = "NONE"
    comps: list = field(default_factory=list)


def _cutoff(cfg) -> str:
    days = cfg.get("valuation.comps.lookback_days", 90)
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def comps_for(db: DB, listing: dict, cfg) -> list[dict]:
    make, model, year = listing.get("make"), listing.get("model"), listing.get("year")
    if not (make and model and year):
        return []
    yw = cfg.get("valuation.comps.year_window", 2)
    rows = db.q(
        """SELECT id, source, year, mileage, price, title, url FROM listings
           WHERE lower(make) = ? AND lower(model) = ? AND id != ? AND price IS NOT NULL AND comp_ok = 1
             AND year BETWEEN ? AND ? AND last_seen >= ?""",
        (make.lower(), model.lower(), listing.get("id") or -1, year - yw, year + yw, _cutoff(cfg)),
    )
    mw = cfg.get("valuation.comps.mileage_window", 30000)
    subj_miles = listing.get("mileage")
    out = []
    for r in rows:
        if subj_miles and r["mileage"] and abs(r["mileage"] - subj_miles) > mw:
            continue
        out.append(dict(r))
    return out


def adjust(comp: dict, subject: dict, cfg) -> float:
    price = float(comp["price"])
    per_mile = cfg.get("valuation.comps.mileage_adj_per_mile", 0.04)
    year_pct = cfg.get("valuation.comps.year_adj_pct", 0.06)
    adj = price
    if comp.get("mileage") and subject.get("mileage"):
        adj += (comp["mileage"] - subject["mileage"]) * per_mile
    if comp.get("year") and subject.get("year"):
        adj += (subject["year"] - comp["year"]) * year_pct * price
    return max(adj, price * 0.3)


# ---- market-wide fallback model -------------------------------------------------
def _features(year: int, miles: Optional[int], make: str, model: str, today_year: int) -> list[float]:
    age = max(0, today_year - year)
    m = (miles if miles else 120000) / 10000.0
    mk = (make or "")
    md = (model or "").lower()
    high = 1.0 if (mk in HIGH_RETENTION_MAKES or md in HIGH_RETENTION_MODELS) else 0.0
    low = 1.0 if mk in LOW_RETENTION_MAKES else 0.0
    truck = 1.0 if md in TRUCK_SUV_MODELS else 0.0
    return [1.0, age, age * age, m, high, low, truck]


def _solve(a: list[list[float]], b: list[float]) -> list[float]:
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(m[r][col]))
        m[col], m[piv] = m[piv], m[col]
        if abs(m[col][col]) < 1e-12:
            return [0.0] * n
        for r in range(n):
            if r != col:
                f = m[r][col] / m[col][col]
                for c in range(col, n + 1):
                    m[r][c] -= f * m[col][c]
    return [m[i][n] / m[i][i] for i in range(n)]


class MarketModel:
    def __init__(self, coef: list[float], sigma: float, n: int, today_year: int):
        self.coef, self.sigma, self.n, self.today_year = coef, sigma, n, today_year

    def predict(self, year: int, miles: Optional[int], make: str, model: str) -> tuple[float, float, float]:
        x = _features(year, miles, make, model, self.today_year)
        mu = sum(c * v for c, v in zip(self.coef, x))
        z = 0.674 * self.sigma
        return math.exp(mu), math.exp(mu - z), math.exp(mu + z)


def fit_market_model(db: DB, cfg, min_rows: int = 30) -> Optional[MarketModel]:
    rows = db.q(
        "SELECT year, mileage, price, make, model FROM listings WHERE comp_ok = 1 AND price >= 500 "
        "AND year IS NOT NULL AND make IS NOT NULL AND last_seen >= ?", (_cutoff(cfg),))
    if len(rows) < min_rows:
        return None
    ty = date.today().year
    X = [_features(r["year"], r["mileage"], r["make"], r["model"], ty) for r in rows]
    y = [math.log(r["price"]) for r in rows]
    k = len(X[0])
    lam = 1e-2
    xtx = [[sum(X[i][p] * X[i][q] for i in range(len(X))) + (lam if p == q and p > 0 else 0) for q in range(k)] for p in range(k)]
    xty = [sum(X[i][p] * y[i] for i in range(len(X))) for p in range(k)]
    coef = _solve(xtx, xty)
    resid = [y[i] - sum(c * v for c, v in zip(coef, X[i])) for i in range(len(X))]
    sigma = math.sqrt(sum(r * r for r in resid) / max(1, len(resid) - k))
    return MarketModel(coef, sigma, len(rows), ty)


def market_estimate(db: DB, listing: dict, cfg, model: Optional[MarketModel] = None) -> Market:
    comps = comps_for(db, listing, cfg)
    n = len(comps)
    if n >= 2:
        adj = [adjust(c, listing, cfg) for c in comps]
        med = median(adj)
        p25, p75 = (quantile(adj, 0.25), quantile(adj, 0.75)) if n >= 3 else (min(adj), max(adj))
        iqr_ratio = (p75 - p25) / med if med else 9
        if n >= cfg.get("valuation.comps.min_comps_high", 8) and iqr_ratio <= cfg.get("valuation.comps.max_iqr_ratio_high", 0.25):
            conf = "HIGH"
        elif n >= cfg.get("valuation.comps.min_comps_medium", 4):
            conf = "MEDIUM"
        else:
            conf = "LOW"
        top = sorted(comps, key=lambda c: abs((c.get("mileage") or 0) - (listing.get("mileage") or 0)))[:5]
        return Market(round(med), round(p25), round(p75), n, "comps", conf,
                      [{"title": c["title"], "price": c["price"], "mileage": c["mileage"], "source": c["source"]} for c in top])
    if model is not None and listing.get("year") and listing.get("make"):
        v, lo, hi = model.predict(listing["year"], listing.get("mileage"), listing["make"], listing.get("model") or "")
        return Market(round(v), round(lo), round(hi), n, "model", "LOW")
    return Market(n=n)


# ---- instant-offer ratio calibration ------------------------------------------------
def instant_ratio(db: DB, make: Optional[str], cfg) -> tuple[float, bool, int]:
    need = cfg.get("valuation.instant.calibrate_after_real_quotes", 5)
    default = cfg.get("valuation.instant.offer_ratio_default", 0.78)
    rows = db.q("SELECT q.amount, q.answers, l.make FROM quotes q LEFT JOIN listings l ON l.id = q.listing_pk "
                "WHERE q.kind = 'REAL'")
    pairs = []
    for r in rows:
        meta = dec(r["answers"], {}) or {}
        mv = meta.get("market_at_quote")
        if mv:
            pairs.append(((r["make"] or "").lower(), r["amount"] / mv))
    mine = [p for mk, p in pairs if make and mk == make.lower()]
    if len(mine) >= need:
        return round(median(mine), 3), True, len(mine)
    allp = [p for _, p in pairs]
    if len(allp) >= need:
        return round(median(allp), 3), True, len(allp)
    return default, False, len(allp)


def real_offers(db: DB, listing_pk: int, today: Optional[date] = None) -> tuple[list[dict], list[dict]]:
    """(unexpired, expired) REAL offers for a listing."""
    today = today or date.today()
    live, expired = [], []
    for r in db.q("SELECT * FROM quotes WHERE listing_pk = ? AND kind = 'REAL' ORDER BY amount DESC", (listing_pk,)):
        d = dict(r)
        exp = d.get("expires_at")
        if exp and date.fromisoformat(exp[:10]) < today:
            expired.append(d)
        else:
            live.append(d)
    return live, expired


def value_listing(db: DB, listing: dict, cfg, model: Optional[MarketModel] = None) -> dict:
    mkt = market_estimate(db, listing, cfg, model)
    ratio, calibrated, nq = instant_ratio(db, listing.get("make"), cfg)
    out: dict = {"market": asdict(mkt), "instant_ratio": ratio, "ratio_calibrated": calibrated, "ratio_quotes": nq}
    if mkt.value:
        conf = mkt.confidence
        if conf == "HIGH" and not calibrated:
            conf = "MEDIUM"
        out["instant_estimate"] = {"value": round(mkt.value * ratio), "low": round(mkt.low * ratio),
                                   "high": round(mkt.high * ratio), "confidence": conf}
        sr = cfg.get("valuation.patient.sale_ratio", 0.95)
        out["patient_estimate"] = {"value": round(mkt.value * sr), "low": round(mkt.low * sr),
                                   "high": round(mkt.high * sr), "confidence": mkt.confidence}
    if listing.get("id"):
        live, expired = real_offers(db, listing["id"])
        out["real_offers"] = live
        out["expired_offers"] = expired
    return out
