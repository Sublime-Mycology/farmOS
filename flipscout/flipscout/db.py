"""SQLite storage. Everything flipscout knows lives in one local file."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    listing_id TEXT NOT NULL,
    url TEXT,
    title TEXT,
    year INTEGER,
    make TEXT,
    model TEXT,
    trim TEXT,
    mileage INTEGER,
    price INTEGER,
    prev_price INTEGER,
    location_text TEXT,
    lat REAL,
    lon REAL,
    distance_mi REAL,
    distance_approx INTEGER DEFAULT 1,
    title_status TEXT,
    vin TEXT,
    transmission TEXT,
    description TEXT,
    seller_name TEXT,
    seller_info TEXT,
    posted_at TEXT,
    listing_age_days REAL,
    first_seen TEXT,
    last_seen TEXT,
    detail_fetched INTEGER DEFAULT 0,
    last_processed_price INTEGER,
    comp_ok INTEGER DEFAULT 1,
    status TEXT DEFAULT 'new',
    reject_reason TEXT,
    flags TEXT,
    llm_extract TEXT,
    raw TEXT,
    UNIQUE(source, listing_id)
);
CREATE INDEX IF NOT EXISTS ix_listings_mm ON listings(make, model, year);
CREATE INDEX IF NOT EXISTS ix_listings_status ON listings(status);

CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY,
    listing_pk INTEGER NOT NULL,
    price INTEGER,
    seen_at TEXT
);

CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY,
    listing_pk INTEGER NOT NULL,
    url TEXT,
    local_path TEXT,
    phash TEXT,
    UNIQUE(listing_pk, url)
);

CREATE TABLE IF NOT EXISTS evaluations (
    id INTEGER PRIMARY KEY,
    listing_pk INTEGER NOT NULL,
    run_id INTEGER,
    created_at TEXT,
    result TEXT,
    data TEXT
);
CREATE INDEX IF NOT EXISTS ix_eval_listing ON evaluations(listing_pk, id);

CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY,
    listing_pk INTEGER,
    vin TEXT,
    buyer TEXT,
    amount INTEGER,
    kind TEXT,
    confidence TEXT,
    answers TEXT,
    obtained_at TEXT,
    expires_at TEXT,
    note TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY,
    listing_pk INTEGER NOT NULL UNIQUE,
    channel TEXT,
    thread_ref TEXT,
    relay_email TEXT,
    status TEXT,
    first_contact_at TEXT,
    last_inbound_at TEXT,
    last_outbound_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER,
    listing_pk INTEGER,
    direction TEXT,
    channel TEXT,
    kind TEXT,
    body TEXT,
    status TEXT,
    guard TEXT,
    parsed TEXT,
    external_id TEXT,
    created_at TEXT,
    sent_at TEXT
);

CREATE TABLE IF NOT EXISTS negotiations (
    listing_pk INTEGER PRIMARY KEY,
    stage TEXT,
    walk_away INTEGER,
    opening INTEGER,
    our_last_offer INTEGER,
    seller_last_ask INTEGER,
    rounds INTEGER DEFAULT 0,
    agreed_price INTEGER,
    basis TEXT,
    history TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS needs_owner (
    id INTEGER PRIMARY KEY,
    listing_pk INTEGER,
    kind TEXT,
    summary TEXT,
    detail TEXT,
    created_at TEXT,
    resolved_at TEXT,
    UNIQUE(listing_pk, kind, summary)
);

CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY,
    listing_pk INTEGER,
    vehicle TEXT,
    vin TEXT,
    event TEXT,
    event_date TEXT,
    price INTEGER,
    note TEXT
);

CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    kind TEXT,
    started_at TEXT,
    finished_at TEXT,
    dry_run INTEGER,
    stats TEXT,
    errors TEXT,
    blocks TEXT
);

CREATE TABLE IF NOT EXISTS llm_usage (
    id INTEGER PRIMARY KEY,
    day TEXT,
    purpose TEXT,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost REAL
);

CREATE TABLE IF NOT EXISTS geocache (
    place TEXT PRIMARY KEY,
    lat REAL,
    lon REAL,
    looked_up_at TEXT
);

CREATE TABLE IF NOT EXISTS vin_cache (
    vin TEXT PRIMARY KEY,
    decoded TEXT,
    recalls TEXT,
    looked_up_at TEXT
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class DB:
    def __init__(self, path: Path | str):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    # -- generic helpers -------------------------------------------------
    def q(self, sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
        return self.conn.execute(sql, tuple(params)).fetchall()

    def one(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Row | None:
        return self.conn.execute(sql, tuple(params)).fetchone()

    def x(self, sql: str, params: Iterable[Any] = ()) -> int:
        cur = self.conn.execute(sql, tuple(params))
        self.conn.commit()
        return cur.lastrowid

    def insert(self, table: str, row: dict) -> int:
        cols = ", ".join(row)
        qs = ", ".join("?" for _ in row)
        return self.x(f"INSERT INTO {table} ({cols}) VALUES ({qs})", [_enc(v) for v in row.values()])

    def update(self, table: str, pk_col: str, pk: Any, row: dict) -> None:
        if not row:
            return
        sets = ", ".join(f"{c} = ?" for c in row)
        self.x(f"UPDATE {table} SET {sets} WHERE {pk_col} = ?", [_enc(v) for v in row.values()] + [pk])

    # -- listings ---------------------------------------------------------
    def get_listing(self, source: str, listing_id: str) -> sqlite3.Row | None:
        return self.one("SELECT * FROM listings WHERE source = ? AND listing_id = ?", (source, listing_id))

    def listing(self, pk: int) -> sqlite3.Row | None:
        return self.one("SELECT * FROM listings WHERE id = ?", (pk,))

    def record_price(self, pk: int, price: int | None) -> None:
        if price is None:
            return
        last = self.one("SELECT price FROM price_history WHERE listing_pk = ? ORDER BY id DESC LIMIT 1", (pk,))
        if last is None or last["price"] != price:
            self.insert("price_history", {"listing_pk": pk, "price": price, "seen_at": now_iso()})

    def latest_eval(self, pk: int) -> dict | None:
        r = self.one("SELECT data FROM evaluations WHERE listing_pk = ? ORDER BY id DESC LIMIT 1", (pk,))
        return json.loads(r["data"]) if r else None

    # -- needs owner ------------------------------------------------------
    def add_need(self, listing_pk: int | None, kind: str, summary: str, detail: str = "") -> None:
        self.x(
            "INSERT OR IGNORE INTO needs_owner (listing_pk, kind, summary, detail, created_at) VALUES (?,?,?,?,?)",
            (listing_pk, kind, summary, detail, now_iso()),
        )

    def open_needs(self) -> list[sqlite3.Row]:
        return self.q("SELECT * FROM needs_owner WHERE resolved_at IS NULL ORDER BY id")

    def close(self) -> None:
        self.conn.close()


def _enc(v: Any) -> Any:
    if isinstance(v, (dict, list)):
        return json.dumps(v, default=str)
    return v


def dec(v: str | None, default: Any = None) -> Any:
    if not v:
        return default
    try:
        return json.loads(v)
    except (TypeError, ValueError):
        return default
