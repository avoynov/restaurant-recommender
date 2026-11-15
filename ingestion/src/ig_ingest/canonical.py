"""Turn user input into canonical targets: profile handles or post shortcodes.

Accepted:
  handles      nasa, @nasa, instagram.com/nasa, https://www.instagram.com/nasa/?hl=en
  post URLs    /p/{code}, /reel/{code}, /reels/{code}, /tv/{code}, instagr.am/p/{code},
               with or without www., query strings or fragments
Rejected with a clear message: Stories, highlights, explore pages, non-Instagram links.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlsplit

_HANDLE_RE = re.compile(r"^[A-Za-z0-9._]{1,30}$")
_SHORTCODE_RE = re.compile(r"^[A-Za-z0-9_-]{5,}$")
_POST_KINDS = {"p", "reel", "reels", "tv"}
_INSTAGRAM_HOSTS = {"instagram.com", "www.instagram.com", "m.instagram.com", "instagr.am", "www.instagr.am"}
# First path segments that are Instagram pages, not usernames.
_RESERVED = {
    "explore", "stories", "accounts", "direct", "about", "developer", "legal",
    "web", "emails", "challenge", "graphql", "api", "s", "highlights", "locations",
}


class InputError(ValueError):
    """Input that is not a public profile or post we can fetch."""


@dataclass(frozen=True)
class Target:
    kind: str  # "profile" | "post"
    value: str  # handle (lowercase) or shortcode

    @property
    def url(self) -> str:
        if self.kind == "profile":
            return profile_url(self.value)
        return post_url(self.value)


def profile_url(handle: str) -> str:
    return f"https://www.instagram.com/{handle}/"


def post_url(shortcode: str) -> str:
    # /reel/ and /p/ share one shortcode, so /p/ is the canonical form.
    return f"https://www.instagram.com/p/{shortcode}/"


def parse_target(raw: str) -> Target:
    s = raw.strip()
    if not s:
        raise InputError("empty input")

    if s.startswith("@"):
        return _handle(s[1:])
    if "/" not in s and not _looks_like_domain(s):
        return _handle(s)

    url = s if "://" in s else "https://" + s
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if host not in _INSTAGRAM_HOSTS:
        raise InputError(f"not an Instagram link or handle: {raw!r}")

    segs = [p for p in parts.path.split("/") if p]
    if not segs:
        raise InputError(f"link has no profile or post: {raw!r}")

    head = segs[0].lower()
    if head in _POST_KINDS:
        if len(segs) < 2 or not _SHORTCODE_RE.match(segs[1]):
            raise InputError(f"post link has no valid shortcode: {raw!r}")
        return Target("post", segs[1])
    # /{user}/p/{code}/ and /{user}/reel/{code}/ forms
    if len(segs) >= 3 and segs[1].lower() in _POST_KINDS and _SHORTCODE_RE.match(segs[2]):
        return Target("post", segs[2])
    if head in _RESERVED:
        raise InputError(f"Stories, highlights and other non-post pages are not supported: {raw!r}")
    if len(segs) == 1 or (len(segs) == 2 and segs[1].lower() in {"reels", "tagged", "feed"}):
        return _handle(segs[0])
    raise InputError(f"unrecognised Instagram link: {raw!r}")


def _looks_like_domain(s: str) -> bool:
    return bool(re.search(r"\.(com|am|net|org|io|co)$", s.lower()))


def _handle(s: str) -> Target:
    if not _HANDLE_RE.match(s) or s.startswith(".") or s.endswith(".") or ".." in s:
        raise InputError(f"invalid Instagram handle: {s!r}")
    if s.lower() in _RESERVED:
        raise InputError(f"{s!r} is an Instagram page, not a profile")
    return Target("profile", s.lower())
