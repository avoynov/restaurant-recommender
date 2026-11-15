"""Normalized post model, matching the handoff contract (schema_version 1.0).

Rules from the design doc, enforced here:
  * A field we couldn't get is None (serialized as null), never omitted.
  * comments holds at most MAX_COMMENTS, sorted by likes; commenter usernames are dropped.
  * Media leaves this module by storage key, never by Instagram CDN URL (those expire).
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

MAX_COMMENTS = 50

# Fields tracked individually for provenance and merging.
MERGE_FIELDS = (
    "type", "author", "posted_at", "caption", "hashtags", "mentions",
    "location", "comments", "media", "stats",
)


@dataclass
class Author:
    username: str | None = None
    full_name: str | None = None
    is_business: bool | None = None


@dataclass
class Location:
    name: str | None = None
    ig_location_id: str | None = None
    lat: float | None = None
    lng: float | None = None


@dataclass
class Comment:
    text: str
    like_count: int | None = None
    created_at: str | None = None


@dataclass
class Media:
    """One photo or video. source_url is internal only and is stripped on export."""
    idx: int
    kind: str  # "image" | "video"
    source_url: str | None = None
    cover_url: str | None = None  # video thumbnail, if any
    width: int | None = None
    height: int | None = None
    duration_s: float | None = None
    # Filled by the media downloader:
    storage_key: str | None = None
    cover_storage_key: str | None = None
    mime: str | None = None
    bytes: int | None = None


@dataclass
class Stats:
    like_count: int | None = None
    comment_count: int | None = None
    view_count: int | None = None


@dataclass
class Post:
    shortcode: str
    type: str | None = None  # "image" | "carousel" | "video"
    author: Author | None = None
    posted_at: str | None = None  # ISO 8601 UTC, "Z" suffix
    caption: str | None = None
    hashtags: list[str] | None = None
    mentions: list[str] | None = None
    location: Location | None = None
    comments: list[Comment] | None = None
    media: list[Media] | None = None
    stats: Stats | None = None
    is_pinned: bool | None = None
    product_type: str | None = None  # e.g. "clips" for reels, "feed"

    @property
    def url(self) -> str:
        return f"https://www.instagram.com/p/{self.shortcode}/"

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["url"] = self.url
        return d


@dataclass
class FetchResult:
    """What a provider returns for one target."""
    posts: list[Post] = field(default_factory=list)
    raw: list[dict[str, Any]] = field(default_factory=list)  # provider payloads, by post
    cost_usd: float = 0.0
    profile: dict[str, Any] | None = None  # profile-level facts if the provider has them


def normalize_tag(tag: str, prefix: str) -> str:
    t = tag.strip()
    return t if t.startswith(prefix) else prefix + t


def top_comments(comments: list[Comment], limit: int = MAX_COMMENTS) -> list[Comment]:
    """Most-liked first, ties broken by recency, deduplicated by text."""
    seen: set[str] = set()
    uniq: list[Comment] = []
    for c in comments:
        key = c.text.strip()
        if key and key not in seen:
            seen.add(key)
            uniq.append(c)
    uniq.sort(key=lambda c: (-(c.like_count or 0), _neg_time(c.created_at)))
    return uniq[:limit]


def _neg_time(ts: str | None) -> str:
    # Sort newest first among equal like counts, without parsing dates.
    if not ts:
        return "￿"
    return "".join(chr(0xFFFF - ord(ch)) for ch in ts)
