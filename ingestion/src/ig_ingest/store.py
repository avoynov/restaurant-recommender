"""SQLite store for the prototype.

Mirrors the design's data model in miniature: one row per post shared by every source
(global cache by shortcode), a link table from profiles to posts, an attempts audit trail
that also tracks spend, and the raw provider payloads so we can re-normalize later
without paying to fetch again. Swapping to Postgres later is a schema copy.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS posts (
  shortcode   TEXT PRIMARY KEY,
  record      TEXT NOT NULL,          -- normalized Post as JSON (internal: includes CDN URLs)
  provenance  TEXT NOT NULL,          -- {field: provider} plus fetched_at
  status      TEXT NOT NULL,          -- COMPLETE | PARTIAL | UNAVAILABLE
  missing     TEXT NOT NULL DEFAULT '[]',
  first_seen  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  shortcode   TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- profile_feed | post_url
  handle      TEXT,                   -- profile handle for profile_feed
  first_seen  TEXT NOT NULL,
  PRIMARY KEY (shortcode, kind, handle)
);
CREATE TABLE IF NOT EXISTS profiles (
  handle          TEXT PRIMARY KEY,
  info            TEXT,
  last_status     TEXT,
  last_error      TEXT,
  last_fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  target      TEXT NOT NULL,
  provider    TEXT NOT NULL,
  outcome     TEXT NOT NULL,          -- ok | transient | blocked | permanent | config | skipped
  detail      TEXT,
  ms          INTEGER,
  n_posts     INTEGER,
  cost_usd    REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS raw_payloads (
  shortcode   TEXT NOT NULL,
  provider    TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  payload     TEXT NOT NULL,
  PRIMARY KEY (shortcode, provider)
);
CREATE INDEX IF NOT EXISTS attempts_at ON attempts(at);
"""


_COMMENT_LISTS = ("latestComments", "comments", "preview_comments")
_COMMENTER_KEYS = ("ownerUsername", "owner", "ownerProfilePicUrl", "ownerId", "user", "replies")


def scrub_commenters(payload: dict[str, Any]) -> dict[str, Any]:
    """Drop who wrote each comment from raw payloads too (design: commenter handles never stored)."""
    out = dict(payload)
    for key in _COMMENT_LISTS:
        if isinstance(out.get(key), list):
            out[key] = [{k: v for k, v in c.items() if k not in _COMMENTER_KEYS} if isinstance(c, dict) else c
                        for c in out[key]]
    return out


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self.db:
            yield self.db

    # posts ---------------------------------------------------------------------------------

    def get_post(self, shortcode: str) -> tuple[dict, dict] | None:
        row = self.db.execute("SELECT record, provenance FROM posts WHERE shortcode=?", (shortcode,)).fetchone()
        return (json.loads(row["record"]), json.loads(row["provenance"])) if row else None

    def put_post(self, record: dict, provenance: dict, status: str, missing: list[str]) -> None:
        ts = now()
        with self.tx() as db:
            db.execute(
                """INSERT INTO posts(shortcode, record, provenance, status, missing, first_seen, updated_at)
                   VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT(shortcode) DO UPDATE SET record=excluded.record, provenance=excluded.provenance,
                     status=excluded.status, missing=excluded.missing, updated_at=excluded.updated_at""",
                (record["shortcode"], json.dumps(record, ensure_ascii=False), json.dumps(provenance),
                 status, json.dumps(missing), ts, ts),
            )

    def mark_unavailable(self, shortcode: str, reason: str) -> None:
        existing = self.get_post(shortcode)
        record = existing[0] if existing else {"shortcode": shortcode}
        prov = existing[1] if existing else {}
        prov["unavailable_reason"] = reason
        self.put_post(record, prov, "UNAVAILABLE", ["all"])

    def iter_posts(self, statuses: tuple[str, ...] | None = None) -> Iterator[sqlite3.Row]:
        q = "SELECT * FROM posts"
        args: tuple = ()
        if statuses:
            q += f" WHERE status IN ({','.join('?' * len(statuses))})"
            args = statuses
        yield from self.db.execute(q + " ORDER BY updated_at", args)

    # sources and profiles ------------------------------------------------------------------

    def add_source(self, shortcode: str, kind: str, handle: str | None) -> None:
        with self.tx() as db:
            db.execute("INSERT OR IGNORE INTO sources VALUES (?,?,?,?)", (shortcode, kind, handle or "", now()))

    def sources_for(self, shortcode: str) -> list[sqlite3.Row]:
        return list(self.db.execute("SELECT * FROM sources WHERE shortcode=? ORDER BY first_seen", (shortcode,)))

    def put_profile(self, handle: str, status: str, info: dict | None = None, error: str | None = None) -> None:
        with self.tx() as db:
            db.execute(
                """INSERT INTO profiles(handle, info, last_status, last_error, last_fetched_at) VALUES (?,?,?,?,?)
                   ON CONFLICT(handle) DO UPDATE SET info=COALESCE(excluded.info, profiles.info),
                     last_status=excluded.last_status, last_error=excluded.last_error,
                     last_fetched_at=excluded.last_fetched_at""",
                (handle, json.dumps(info) if info else None, status, error, now()),
            )

    # audit and spend -----------------------------------------------------------------------

    def log_attempt(self, target: str, provider: str, outcome: str, *, detail: str | None = None,
                    ms: int | None = None, n_posts: int | None = None, cost_usd: float = 0.0) -> None:
        with self.tx() as db:
            db.execute(
                "INSERT INTO attempts(at, target, provider, outcome, detail, ms, n_posts, cost_usd) VALUES (?,?,?,?,?,?,?,?)",
                (now(), target, provider, outcome, (detail or "")[:500] or None, ms, n_posts, cost_usd),
            )

    def spend_since(self, since_iso: str, provider_prefix: str = "tier2_") -> float:
        row = self.db.execute(
            "SELECT COALESCE(SUM(cost_usd),0) s FROM attempts WHERE at >= ? AND provider LIKE ?",
            (since_iso, provider_prefix + "%"),
        ).fetchone()
        return float(row["s"])

    def put_raw(self, shortcode: str, provider: str, payload: dict[str, Any]) -> None:
        payload = scrub_commenters(payload)
        with self.tx() as db:
            db.execute("INSERT OR REPLACE INTO raw_payloads VALUES (?,?,?,?)",
                       (shortcode, provider, now(), json.dumps(payload, ensure_ascii=False, default=str)))

    def summary(self) -> dict[str, Any]:
        by_status = {r["status"]: r["n"] for r in self.db.execute("SELECT status, COUNT(*) n FROM posts GROUP BY status")}
        profiles = [dict(r) for r in self.db.execute(
            "SELECT handle, last_status, last_error, last_fetched_at FROM profiles ORDER BY handle")]
        month = datetime.now(timezone.utc).strftime("%Y-%m-01T00:00:00Z")
        tiers = [dict(r) for r in self.db.execute(
            """SELECT provider, outcome, COUNT(*) n, ROUND(SUM(cost_usd),4) cost FROM attempts
               GROUP BY provider, outcome ORDER BY provider, outcome""")]
        return {"posts": by_status, "profiles": profiles, "attempts": tiers,
                "spend_this_month_usd": round(self.spend_since(month), 4)}
