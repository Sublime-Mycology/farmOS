"""0-100 score. Weights and thresholds come from config.yaml (scoring.*)."""
from __future__ import annotations

from typing import Optional


def _lerp(x: float, x0: float, x1: float, y0: float, y1: float) -> float:
    if x1 == x0:
        return y1
    t = max(0.0, min(1.0, (x - x0) / (x1 - x0)))
    return y0 + t * (y1 - y0)


def responsiveness_points(state: str, w: float) -> float:
    return {"none": 0.5, "fast": 1.0, "slow": 0.6, "silent": 0.0}.get(state, 0.5) * w


def score(net: Optional[float], confidence: str, responsiveness: str, age_days: Optional[float],
          price_dropped: bool, distance_mi: Optional[float], flags: list, cfg) -> tuple[int, dict]:
    w = cfg.get("scoring.weights", {})
    W = lambda k, d: float(w.get(k, d))  # noqa: E731
    min_profit = float(cfg.get("profit.min_net_profit", 1000))
    full = float(cfg.get("scoring.profit_full_marks_at", 3000))
    at_min = float(cfg.get("scoring.profit_points_at_min", 10))
    wp = W("net_profit", 35)

    if net is None or net < min_profit:
        p_profit = 0.0
    else:
        p_profit = _lerp(net, min_profit, full, at_min, wp)

    conf_pts = cfg.get("scoring.confidence_points", {"REAL": 20, "HIGH": 16, "MEDIUM": 10, "LOW": 4})
    p_conf = float(conf_pts.get(confidence, 0)) * W("confidence", 20) / 20.0

    p_resp = responsiveness_points(responsiveness, W("responsiveness", 10))

    wd = W("days_listed", 10)
    if age_days is None:
        p_age = 0.5 * wd
    elif age_days < 2:
        p_age = wd
    elif age_days <= 7:
        p_age = 0.7 * wd
    elif age_days <= 30:
        p_age = 0.5 * wd
    else:
        p_age = 0.3 * wd
    if price_dropped:
        p_age = min(wd, p_age + 0.3 * wd)

    wdist = W("distance", 10)
    radius = float(cfg.get("search.radius_miles", 100))
    if distance_mi is None:
        p_dist = 0.5 * wdist
    elif distance_mi <= 25:
        p_dist = wdist
    else:
        p_dist = _lerp(distance_mi, 25, radius, wdist, 0.2 * wdist)

    wf = W("red_flags", 15)
    weights = cfg.get("filters.soft_flags", {}) or {}
    deduct = sum(float(weights.get(name, 2)) for name, _ in flags)
    p_flags = max(0.0, wf - deduct)

    parts = {"net_profit": round(p_profit, 1), "confidence": round(p_conf, 1), "responsiveness": round(p_resp, 1),
             "days_listed": round(p_age, 1), "distance": round(p_dist, 1), "red_flags": round(p_flags, 1)}
    total = int(round(sum(parts.values())))
    return max(0, min(100, total)), parts
