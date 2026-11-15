"""Export stored posts as handoff records (schema_version 1.0) for Dataset Population.

One JSON line per (post, source). The record follows the design doc's handoff contract,
with two additive fields that consumers may ignore: `status` and `missing`.
Internal fields (Instagram CDN URLs) are stripped: media is passed by storage key only.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Iterator

from . import SCHEMA_VERSION
from .store import Store

_NS = uuid.UUID("6f1c2a4e-1b7d-4a53-9a59-2f8e3e0b9c11")
_MEDIA_KEYS = ("idx", "kind", "storage_key", "cover_storage_key", "mime", "bytes", "width", "height", "duration_s")
_POST_KEYS = ("shortcode", "url", "type", "author", "posted_at", "caption", "hashtags", "mentions",
              "location", "comments", "media", "stats", "is_pinned", "product_type")


def public_post(record: dict) -> dict:
    out = {k: record.get(k) for k in _POST_KEYS}
    if out["media"] is not None:
        out["media"] = [{k: m.get(k) for k in _MEDIA_KEYS} for m in out["media"]]
    return out


def records(store: Store, include_partial: bool = False, user_id: str | None = None) -> Iterator[dict]:
    statuses = ("COMPLETE", "PARTIAL") if include_partial else ("COMPLETE",)
    for row in store.iter_posts(statuses):
        record, prov = json.loads(row["record"]), json.loads(row["provenance"])
        post = public_post(record)
        for src in store.sources_for(row["shortcode"]) or [None]:
            kind = src["kind"] if src else "unknown"
            handle = (src["handle"] or None) if src else None
            yield {
                "schema_version": SCHEMA_VERSION,
                "event_id": str(uuid.uuid5(_NS, f"{row['shortcode']}|{kind}|{handle}|{user_id}")),
                "user_id": user_id,
                "save": {
                    "source": kind,
                    "handle": handle,
                    "collection": None,
                    "saved_at": src["first_seen"] if src else row["first_seen"],
                },
                "post": post,
                "provenance": prov,
                "status": row["status"],
                "missing": json.loads(row["missing"]),
            }


def write_jsonl(store: Store, out: Path, include_partial: bool = False, user_id: str | None = None) -> int:
    out.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    tmp = out.with_suffix(out.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        for rec in records(store, include_partial, user_id):
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n += 1
    tmp.replace(out)
    return n
