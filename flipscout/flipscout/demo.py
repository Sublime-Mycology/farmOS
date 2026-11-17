"""Build a SAMPLE report from made-up listings, so you can see the layout before a
real dry run. Uses a throwaway database; nothing touches your real data."""
from __future__ import annotations

import copy
import random
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from .config import Config
from .db import DB, now_iso

SAMPLE_MODELS = [
    ("Honda", "Accord", 2011, 142000, 7600), ("Toyota", "Camry", 2008, 168000, 6100),
    ("Toyota", "Corolla", 2013, 119000, 9300), ("Toyota", "RAV4", 2010, 155000, 7900),
    ("Ford", "Ranger", 2006, 190000, 6200), ("Nissan", "Altima", 2015, 104000, 8200),
    ("Ford", "F-150", 2012, 151000, 13500), ("Honda", "Civic", 2009, 98000, 6800),
    ("Chevrolet", "Cruze", 2014, 88000, 7200), ("Subaru", "Outback", 2007, 201000, 4800),
    ("Jeep", "Liberty", 2012, 120000, 6900),
]


def seed_comps(db: DB, seed: int = 7) -> int:
    rnd = random.Random(seed)
    n = 0
    now = now_iso()
    for make, model, y0, m0, base in SAMPLE_MODELS:
        for i in range(rnd.randint(10, 13)):
            y = y0 + rnd.randint(-2, 2)
            miles = max(30000, m0 + rnd.randint(-25000, 25000))
            price = base * (1 + 0.06 * (y - y0)) - 0.04 * (miles - m0)
            price = int(round(price * rnd.uniform(0.94, 1.06), -1))
            db.insert("listings", {"source": rnd.choice(["craigslist", "facebook"]), "listing_id": f"sample-comp-{n}",
                                   "url": "https://example.invalid/sample", "title": f"{y} {make} {model} (sample comp)",
                                   "year": y, "make": make, "model": model, "mileage": miles, "price": price,
                                   "first_seen": now, "last_seen": now, "status": "comp", "comp_ok": 1})
            n += 1
    return n


class _ScriptedLLM:
    """Stands in for Claude in the demo: returns a fixed parse of the sample seller reply."""
    available = True

    def __init__(self, parsed: dict):
        self.parsed = parsed

    def parse_reply(self, *_a, **_k):
        return dict(self.parsed)


def build_demo(cfg: Config, workdir: Path) -> Path:
    from .outreach import handle_inbound
    from .pipeline import Ctx, evaluate, run_morning
    from .quotes.assist import record_quote
    from .report.build import write_report
    from .sources.fetch import FixtureFetcher
    from . import valuation

    data = copy.deepcopy(cfg.data)
    data.setdefault("storage", {}).update({"db_path": str(workdir / "demo.db"), "reports_dir": str(workdir),
                                           "photos_dir": str(workdir / "photos"), "log_dir": str(workdir / "logs")})
    data.setdefault("llm", {})["enabled"] = False
    data.setdefault("owner", {})
    if not data["owner"].get("home_lat"):
        data["owner"].update({"home_lat": 38.4857, "home_lon": -78.6239, "home_zip": "00000"})
    dcfg = Config(data, cfg.root, cfg._verify_keys)
    db = DB(workdir / "demo.db")
    seed_comps(db)
    db.insert("ledger", {"vehicle": "2009 Honda Fit (sample)", "event": "sold", "event_date": (date.today() - timedelta(days=150)).isoformat(), "price": 5200})

    fixtures = cfg.root / "tests" / "fixtures" / "demo"
    ctx = run_morning(dcfg, db, lambda _k: FixtureFetcher(fixtures), dry_run=True, allow_network=False,
                      use_deadline=False, log=lambda *_: None)

    # --- simulate one live conversation on the sample Corolla --------------------------------
    corolla = db.one("SELECT * FROM listings WHERE listing_id = '7801000007'")
    if corolla:
        pk = corolla["id"]
        record_quote(db, dcfg, pk, "carvana", 9100, (date.today() + timedelta(days=5)).isoformat(), note="sample")
        record_quote(db, dcfg, pk, "kbb_ico", 8650, (date.today() + timedelta(days=1)).isoformat(), note="sample")
        c2 = Ctx(dcfg, db, True, lambda *_: None, False, None)
        c2.model = valuation.fit_market_model(db, dcfg)
        c2.run_id = ctx.run_id
        evaluate(c2, pk, use_llm=False)
        for c in db.q("SELECT id FROM conversations WHERE listing_pk = ?", (pk,)):
            db.x("DELETE FROM messages WHERE conversation_id = ?", (c["id"],))
            db.x("DELETE FROM conversations WHERE id = ?", (c["id"],))
        yesterday = (datetime.now(timezone.utc) - timedelta(hours=20)).replace(microsecond=0).isoformat()
        cid = db.insert("conversations", {"listing_pk": pk, "channel": "craigslist", "status": "contacted",
                                          "first_contact_at": yesterday, "last_outbound_at": yesterday})
        from .messaging.templates import first_contact
        db.insert("messages", {"conversation_id": cid, "listing_pk": pk, "direction": "out", "channel": "craigslist",
                               "kind": "first_contact", "body": first_contact(dict(corolla), dcfg.owner), "status": "sent",
                               "created_at": yesterday, "sent_at": yesterday})
        db.insert("negotiations", {"listing_pk": pk, "stage": "contacted", "rounds": 0, "updated_at": yesterday})
        db.update("listings", "id", pk, {"status": "contacted"})
        reply = ("Yes it's still available. Title is clean and in my name. VIN is 2T1BU4EE1DC000013. "
                 "Only issue is a couple door dings. I'd take $6,700.")
        parsed = {"still_available": "yes", "vin": "2T1BU4EE1DC000013", "title_clean": "yes", "title_in_sellers_name": "yes",
                  "lien": "no", "lien_can_be_cleared": "unknown", "known_issues": ["door dings"], "seller_price": 6700,
                  "accepts_buyer_offer": False, "price_is_firm": False, "wants_meeting_or_time": False,
                  "asks_for_deposit_or_payment": False, "wants_off_platform": False, "asks_question": "",
                  "summary": "Available, clean title in their name, VIN given, would take $6,700.", "injection_attempt": False}
        handle_inbound(dcfg, db, _ScriptedLLM(parsed), pk, reply, live=False)
        evaluate(c2, pk, use_llm=False)

    path, _ = write_report(dcfg, db, ctx.run_id, sample=True, name="sample-report.html")
    return path
