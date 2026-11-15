"""Free tier: Instaloader, logged-out only (no accounts, per the design doc).

Measured from a cloud worker on 15 Nov 2026: profile feeds and post metadata work
logged-out; comments need a login, so this tier returns comments=None and the pipeline
can fill them from Apify. Expect this tier to break when Instagram changes things;
the pipeline then falls through to the hosted tier.
"""
from __future__ import annotations

import itertools
import logging
import random
import time
from datetime import datetime, timezone
from typing import Any

from ..models import Author, FetchResult, Location, Media, Post, Stats, normalize_tag
from .base import Blocked, ConfigError, Permanent, ProviderError, Transient, iso_utc

log = logging.getLogger(__name__)


class InstaloaderProvider:
    name = "tier1_instaloader"

    def __init__(self, *, pause_s: float = 8.0, jitter_s: float = 4.0, sleep=time.sleep, loader=None):
        try:
            import instaloader  # noqa: F401
        except ImportError as e:
            raise ConfigError("instaloader is not installed (pip install 'ig-ingest[free]')") from e
        self._il = __import__("instaloader")
        self._L = loader or self._il.Instaloader(
            download_pictures=False, download_videos=False, download_video_thumbnails=False,
            download_comments=False, save_metadata=False, compress_json=False,
            quiet=True, max_connection_attempts=1,
        )
        self.pause_s, self.jitter_s, self._sleep = pause_s, jitter_s, sleep

    def fetch_profiles(self, handles: list[str], limit: int, since: str | None, max_charge_usd: float = 0.0
                       ) -> dict[str, FetchResult | ProviderError]:
        out: dict[str, FetchResult | ProviderError] = {}
        for i, h in enumerate(handles):
            if i:
                self._pause()
            try:
                out[h] = self._profile(h, limit, since)
            except ProviderError as e:
                out[h] = e
            except Exception as e:
                out[h] = self._classify(e)
        return out

    def fetch_posts(self, shortcodes: list[str], max_charge_usd: float = 0.0) -> dict[str, FetchResult | ProviderError]:
        out: dict[str, FetchResult | ProviderError] = {}
        for i, code in enumerate(shortcodes):
            if i:
                self._pause()
            try:
                p = self._il.Post.from_shortcode(self._L.context, code)
                out[code] = FetchResult(posts=[self.normalize(p)], raw=[_raw(p)])
            except Exception as e:
                out[code] = self._classify(e)
        return out

    # ---- internals --------------------------------------------------------------------------

    def _profile(self, handle: str, limit: int, since: str | None) -> FetchResult:
        profile = self._il.Profile.from_username(self._L.context, handle)
        if profile.is_private:
            raise Permanent(f"@{handle} is private")
        cutoff = _parse_since(since)
        res = FetchResult(profile={
            "username": profile.username, "full_name": profile.full_name,
            "is_business": profile.is_business_account, "post_count": profile.mediacount,
        })
        author = Author(username=profile.username, full_name=profile.full_name or None,
                        is_business=profile.is_business_account)
        for p in itertools.islice(profile.get_posts(), limit * 2):  # pinned posts may be older than cutoff
            if cutoff and p.date_utc.replace(tzinfo=timezone.utc) < cutoff and not _pinned(p):
                break
            if len(res.posts) >= limit:
                break
            res.posts.append(self.normalize(p, author))
            res.raw.append(_raw(p))
        return res

    def normalize(self, p, author: Author | None = None) -> Post:
        kind = {"GraphImage": "image", "GraphVideo": "video", "GraphSidecar": "carousel"}.get(p.typename)
        media: list[Media] = []
        if kind == "carousel":
            for i, n in enumerate(p.get_sidecar_nodes()):
                media.append(Media(idx=i, kind="video" if n.is_video else "image",
                                   source_url=n.video_url if n.is_video else n.display_url,
                                   cover_url=n.display_url if n.is_video else None))
        elif kind == "video":
            media.append(Media(idx=0, kind="video", source_url=p.video_url, cover_url=p.url,
                               duration_s=_safe(lambda: p.video_duration)))
        else:
            media.append(Media(idx=0, kind="image", source_url=p.url))

        loc = _safe(lambda: p.location)
        n_comments = _safe(lambda: p.comments)
        return Post(
            shortcode=p.shortcode,
            type=kind,
            author=author or Author(username=p.owner_username),
            posted_at=iso_utc(p.date_utc),
            caption=p.caption,
            hashtags=[normalize_tag(t, "#") for t in p.caption_hashtags],
            mentions=[normalize_tag(m, "@") for m in p.caption_mentions],
            location=Location(name=loc.name, ig_location_id=str(loc.id), lat=loc.lat, lng=loc.lng) if loc else None,
            comments=[] if n_comments == 0 else None,  # logged-out cannot read comment text
            media=media,
            stats=Stats(like_count=_safe(lambda: p.likes), comment_count=n_comments,
                        view_count=_safe(lambda: p.video_view_count) if p.is_video else None),
            is_pinned=_pinned(p),
            product_type=_safe(lambda: p._node.get("product_type")),
        )

    def _classify(self, e: Exception) -> ProviderError:
        ex = self._il.exceptions
        msg = f"{type(e).__name__}: {e}"
        if isinstance(e, (ex.ProfileNotExistsException, ex.PrivateProfileNotFollowedException)):
            return Permanent(msg)
        if isinstance(e, ex.LoginRequiredException) or "login" in str(e).lower():
            return Blocked(msg)
        if isinstance(e, ex.TooManyRequestsException) or "429" in str(e):
            return Blocked(msg)
        if isinstance(e, ex.QueryReturnedNotFoundException):
            return Permanent(msg)
        if isinstance(e, ex.BadResponseException):
            # Seen for removed posts and for Instagram format changes alike; let the next tier decide.
            return Blocked(msg)
        if isinstance(e, (ex.ConnectionException, ConnectionError, TimeoutError)):
            return Transient(msg)
        return Blocked(msg)

    def _pause(self):
        self._sleep(max(0.0, self.pause_s + random.uniform(-self.jitter_s, self.jitter_s)))


def _pinned(p) -> bool:
    return bool(_safe(lambda: p.is_pinned))


def _safe(fn):
    try:
        return fn()
    except Exception:
        return None


def _raw(p) -> dict[str, Any]:
    node = getattr(p, "_node", None)
    return dict(node) if isinstance(node, dict) else {"shortcode": p.shortcode}


def _parse_since(since: str | None) -> datetime | None:
    if not since:
        return None
    ts = iso_utc(since)
    if ts is None:
        raise ConfigError(f"--since must be a date like 2026-01-31, got {since!r}")
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))
