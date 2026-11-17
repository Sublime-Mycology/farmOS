"""Net profit and walk-away price. All rates/fees come from config.yaml."""
from __future__ import annotations

import math
from typing import Optional


def sales_tax(price: float, cfg) -> float:
    rate = cfg.get("virginia.sales_and_use_tax_rate", 0.0415)
    minimum = cfg.get("virginia.sales_and_use_tax_minimum", 75)
    return max(rate * price, minimum)


def _hold_days(exit_kind: str, cfg) -> int:
    if exit_kind == "patient":
        return int(cfg.get("valuation.patient.hold_days", 21))
    return int(cfg.get("profit.hold_days_instant", 10))


def fixed_costs(exit_kind: str, sale_value: float, cfg) -> dict:
    """Costs that don't depend on purchase price."""
    va = lambda k, d=0: cfg.get(f"virginia.{k}", d)  # noqa: E731
    register = bool(va("register_vehicle", False)) or exit_kind == "patient"  # test drives need plates
    hold = _hold_days(exit_kind, cfg)
    c = {
        "title_fee": float(va("title_fee", 15)),
        "registration": float(va("registration_fee", 40.75)) if register else 0.0,
        "trip_permit": float(va("trip_permit_fee", 5)),
        "insurance": float(va("insurance_cost_per_day", 3.0)) * hold,
    }
    ppt = cfg.get("virginia.personal_property_tax", {}) or {}
    if ppt.get("enabled"):
        months = math.ceil(hold / 30) if ppt.get("prorated_monthly", True) else 12
        c["personal_property_tax"] = sale_value * float(ppt.get("rate_per_100_assessed", 0)) / 100 * months / 12
    if exit_kind == "patient":
        c["listing_and_detail"] = float(cfg.get("valuation.patient.extra_costs", 150))
    return c


def travel_cost(distance_mi: Optional[float], cfg) -> tuple[float, bool]:
    """Round-trip road miles x trips x $/mile. Unknown distance -> assume the default."""
    approx = distance_mi is None
    d = distance_mi if distance_mi is not None else float(cfg.get("profit.unknown_distance_miles", 60))
    trips = cfg.get("profit.round_trips_per_purchase", 1)
    return 2 * d * trips * float(cfg.get("profit.travel_cost_per_mile", 0.70)), approx


def delivery_cost(buyer: str, cfg) -> float:
    miles = (cfg.get("profit.delivery_round_trip_miles", {}) or {}).get(buyer, 0)
    return float(miles) * float(cfg.get("profit.travel_cost_per_mile", 0.70))


def buffer(offer: float, cfg) -> float:
    return float(cfg.get("profit.condition_risk_buffer_pct", 0.10)) * offer


def net_profit(purchase: float, offer: float, distance_mi: Optional[float], buyer: str, exit_kind: str, cfg) -> tuple[float, dict]:
    fixed = fixed_costs(exit_kind, offer, cfg)
    travel, approx = travel_cost(distance_mi, cfg)
    parts = {
        "sale": round(offer),
        "purchase": -round(purchase),
        "sales_tax": -round(sales_tax(purchase, cfg), 2),
        **{k: -round(v, 2) for k, v in fixed.items()},
        "travel": -round(travel, 2),
        "delivery": -round(delivery_cost(buyer, cfg) if exit_kind == "instant" else 0.0, 2),
        "condition_buffer": -round(buffer(offer, cfg), 2),
    }
    net = round(sum(parts.values()), 2)
    parts["distance_assumed"] = approx
    return net, parts


def walk_away(offer: float, distance_mi: Optional[float], buyer: str, exit_kind: str, cfg) -> Optional[int]:
    """Highest purchase price that still nets min profit, capped at budget, rounded down to $25."""
    min_profit = float(cfg.get("profit.min_net_profit", 1000))
    rate = float(cfg.get("virginia.sales_and_use_tax_rate", 0.0415))
    tmin = float(cfg.get("virginia.sales_and_use_tax_minimum", 75))
    fixed = sum(fixed_costs(exit_kind, offer, cfg).values())
    travel, _ = travel_cost(distance_mi, cfg)
    delivery = delivery_cost(buyer, cfg) if exit_kind == "instant" else 0.0
    k = offer - buffer(offer, cfg) - fixed - travel - delivery - min_profit   # P + tax(P) <= k
    if k <= 0:
        return None
    candidates = []
    p1 = k / (1 + rate)
    if rate * p1 >= tmin:
        candidates.append(p1)
    p2 = k - tmin
    if p2 > 0 and rate * p2 <= tmin:
        candidates.append(p2)
    if not candidates:
        return None
    p = min(max(candidates), float(cfg.get("search.budget_max_purchase", 8000)))
    p = int(p // 25 * 25)
    return p if p > 0 else None


def round_offer(x: float, step: int = 50) -> int:
    return int(x // step * step)
