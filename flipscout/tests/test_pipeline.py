from datetime import date, timedelta
from pathlib import Path

from conftest import FIXTURES

from flipscout.config import find_verify_keys
from flipscout.guardrails import dealer_status
from flipscout.pipeline import run_morning
from flipscout.report.build import build_report_data, render_html, render_text
from flipscout.sources import craigslist, facebook
from flipscout.sources.fetch import FixtureFetcher, SourceBlocked, Snapshot, detect_block


def test_craigslist_parsers():
    stubs = craigslist.parse_search((FIXTURES / "cl_search.html").read_text())
    assert len(stubs) == 7 and stubs[0]["price"] == 5200
    L = craigslist.parse_detail((FIXTURES / "cl_7801000007.html").read_text(), stubs[6]["url"])
    assert (L.year, L.make, L.model, L.mileage, L.title_status) == (2013, "Toyota", "Corolla", 119500, "clean")
    assert L.vin == "2T1BU4EE1DC000013" and L.lat and len(L.photos) == 5 and L.listing_age_days is not None


def test_facebook_parsers():
    f = FixtureFetcher(FIXTURES)
    snap = f.get("https://www.facebook.com/marketplace/category/vehicles?x=1", source="facebook")
    stubs = facebook.parse_search(snap.links)
    assert len(stubs) == 4
    ranger = next(s for s in stubs if "Ranger" in s["title"])
    assert ranger["price"] == 4800 and ranger["prev_price"] == 5300 and ranger["mileage"] == 190000
    d = f.get("https://www.facebook.com/marketplace/item/1100000000000001/", source="facebook")
    L = facebook.parse_detail(d.text, d.url, d.images)
    assert (L.year, L.make, L.model, L.price, L.mileage, L.title_status) == (2010, "Toyota", "RAV4", 4500, 155000, "clean")
    assert L.location_text == "Stanley, VA" and L.listing_age_days < 1 and len(L.photos) == 5
    assert "surface rust" in L.description and L.seller_name == "Pat Example"
    assert not L.seller_info["dealer_hint"]
    d2 = f.get("https://www.facebook.com/marketplace/item/1100000000000002/", source="facebook")
    L2 = facebook.parse_detail(d2.text, d2.url, d2.images)
    assert (L2.price, L2.prev_price, L2.listing_age_days) == (4800, 5300, 14.0)


def test_block_detection():
    assert detect_block(Snapshot("https://x", "", "You're Temporarily Blocked"), "facebook")
    assert detect_block(Snapshot("https://www.facebook.com/login/", "", "Log in"), "facebook")
    assert detect_block(Snapshot("https://h.craigslist.org", "", "ok", status=403), "craigslist")
    assert detect_block(Snapshot("https://h.craigslist.org", "", "cars and trucks"), "craigslist") is None


def _run(cfg, db, fetcher=None):
    f = fetcher or FixtureFetcher(FIXTURES)
    return run_morning(cfg, db, lambda _k: f, dry_run=True, allow_network=False, use_deadline=False, log=lambda *_: None), f


def _seed(db):
    from flipscout.demo import seed_comps
    seed_comps(db)


def test_full_run_statuses(cfg, db):
    _seed(db)
    ctx, _ = _run(cfg, db)
    st = {r["listing_id"]: (r["status"], r["reject_reason"] or "") for r in db.q("SELECT * FROM listings WHERE status != 'comp'")}
    assert st["7801000003"][0] == "rejected" and "rebuilt" in st["7801000003"][1]
    assert st["7801000004"][0] == "rejected" and "scam" in st["7801000004"][1]
    assert st["7801000005"][0] == "rejected" and "dealer" in st["7801000005"][1]
    assert st["7801000006"][0] == "rejected" and "not running" in st["7801000006"][1]
    assert st["1100000000000004"][0] == "rejected"
    assert st["1100000000000001"][0] == "candidate"
    assert not ctx.errors and not ctx.blocks
    # dry run: drafts are "planned", nothing queued or sent
    statuses = {m["status"] for m in db.q("SELECT status FROM messages")}
    assert statuses <= {"planned"} and statuses
    html = render_html(build_report_data(cfg, db))
    assert "DRY RUN" in html and "Close these first" in html
    txt = render_text(build_report_data(cfg, db))
    assert "RAV4" in txt


def test_no_reprocessing_unless_price_changes(cfg, db):
    _seed(db)
    _run(cfg, db)
    ctx2, f2 = _run(cfg, db)
    detail_requests = [u for u in f2.requests if "/cto/d/" in u or "/marketplace/item/" in u]
    assert detail_requests == []          # nothing changed -> no detail pages re-opened
    assert ctx2.stats["craigslist"]["new"] == 0
    # simulate a price drop on one listing
    pk = db.one("SELECT id FROM listings WHERE listing_id = '7801000001'")["id"]
    db.x("UPDATE listings SET price = 5600, last_processed_price = 5600 WHERE id = ?", (pk,))
    db.insert("price_history", {"listing_pk": pk, "price": 5600, "seen_at": "2026-01-01T00:00:00+00:00"})
    ctx3, f3 = _run(cfg, db)
    assert ctx3.stats["craigslist"]["price_changed"] == 1
    assert any("7801000001" in u for u in f3.requests)
    assert db.one("SELECT COUNT(*) n FROM price_history WHERE listing_pk = ?", (pk,))["n"] == 3
    row = db.one("SELECT price, prev_price FROM listings WHERE id = ?", (pk,))
    assert (row["price"], row["prev_price"]) == (5200, 5600)


class BlockingFetcher(FixtureFetcher):
    def get(self, url, scrolls=0, source=""):
        if source == "facebook":
            raise SourceBlocked("Facebook: temporarily blocked")
        return super().get(url, scrolls, source)


def test_block_stops_source_and_reports(cfg, db):
    ctx, _ = _run(cfg, db, BlockingFetcher(FIXTURES))
    assert ctx.stats["facebook"]["blocked"] and ctx.blocks
    assert ctx.stats["craigslist"]["details"] == 7      # other source unaffected
    data = build_report_data(cfg, db)
    assert data["blocks"] and "BLOCKED" in render_html(data)


def test_dealer_threshold(cfg, db):
    today = date.today()
    for i, ev in enumerate(["sold", "sold", "listed"]):
        db.insert("ledger", {"vehicle": f"car {i}", "event": ev, "event_date": (today - timedelta(days=30 * (i + 1))).isoformat()})
    s = dealer_status(db, cfg)
    assert s.count == 3 and s.warn and not s.stop
    db.insert("ledger", {"vehicle": "car 9", "event": "bought", "event_date": today.isoformat()})
    s = dealer_status(db, cfg)
    assert s.count == 4 and s.stop
    db.insert("ledger", {"vehicle": "old", "event": "sold", "event_date": (today - timedelta(days=400)).isoformat()})
    assert dealer_status(db, cfg).count == 4            # outside the 12-month window


def test_dealer_stop_blocks_contact(cfg, db):
    _seed(db)
    for i in range(4):
        db.insert("ledger", {"vehicle": f"car {i}", "event": "sold", "event_date": date.today().isoformat()})
    _run(cfg, db)
    assert db.one("SELECT COUNT(*) n FROM listings WHERE status = 'candidate'")["n"] == 0
    assert db.one("SELECT COUNT(*) n FROM messages")["n"] == 0


def test_verify_keys():
    text = "a:\n  b: 1  # VERIFY\n  c: 2\nd:\n  e:\n    f: 3 # VERIFY\n"
    assert find_verify_keys(text) == ["a.b", "d.e.f"]
