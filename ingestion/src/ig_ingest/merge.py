"""Field-level merge of a fresh fetch into the stored record, with provenance.

Rules:
  * null never overwrites a value we already have;
  * a field filled by hand ("manual") is never overwritten by an automated tier;
  * otherwise the fresher automated value wins (CDN URLs and counts go stale);
  * media already downloaded keeps its storage keys if the post's media layout is unchanged.
"""
from __future__ import annotations

from typing import Any

from .models import MERGE_FIELDS, Post
from .store import now

MANUAL = "manual"


def merge(existing: tuple[dict, dict] | None, fresh: Post, provider: str) -> tuple[dict, dict]:
    new = fresh.to_dict()
    if existing is None:
        record = new
        prov: dict[str, Any] = {f: (provider if new.get(f) is not None else None) for f in MERGE_FIELDS}
    else:
        record, prov = dict(existing[0]), dict(existing[1])
        for f in MERGE_FIELDS:
            val = new.get(f)
            if val is None or prov.get(f) == MANUAL:
                continue
            if f == "media":
                val = _carry_storage(record.get("media"), val)
            record[f] = val
            prov[f] = provider
        for f in ("is_pinned", "product_type", "url"):
            if new.get(f) is not None:
                record[f] = new[f]
    prov["fetched_at"] = now()
    prov.pop("unavailable_reason", None)
    return record, prov


def _carry_storage(old: list[dict] | None, new: list[dict]) -> list[dict]:
    if not old or len(old) != len(new) or any(o["kind"] != n["kind"] for o, n in zip(old, new)):
        return new
    out = []
    for o, n in zip(old, new):
        m = dict(n)
        for k in ("storage_key", "cover_storage_key", "mime", "bytes"):
            if o.get(k) is not None:
                m[k] = o[k]
        out.append(m)
    return out


def assess(record: dict, media_policy: str) -> tuple[str, list[str]]:
    """Return (status, missing fields). COMPLETE needs core metadata and media per policy.

    Comments and location are reported in `missing` when absent but never block COMPLETE:
    many posts have no location tag, and logged-out tiers cannot always read comments.
    """
    missing = [f for f in ("type", "author", "posted_at") if record.get(f) is None]
    if record.get("caption") is None:
        missing.append("caption")
    if record.get("comments") is None:
        missing.append("comments")
    media = record.get("media")
    media_ok = True
    if media is None or (not media and record.get("type")):
        media_ok = False
    elif media_policy != "none":
        for m in media:
            if m["kind"] == "image" and not m.get("storage_key"):
                media_ok = False
            if m["kind"] == "video":
                if media_policy == "all" and not m.get("storage_key"):
                    media_ok = False
                if media_policy == "covers" and m.get("cover_url") and not m.get("cover_storage_key"):
                    media_ok = False
    if not media_ok:
        missing.append("media")
    blocking = {"type", "author", "posted_at", "media"}
    status = "PARTIAL" if blocking & set(missing) else "COMPLETE"
    return status, missing

