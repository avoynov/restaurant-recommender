"""Hosted tier: Apify actors, logged-out, pay per result.

Actors used (official Apify ones, checked Nov 2026):
  apify/instagram-scraper          profile feeds and single posts   ~$0.0027 per post (free plan)
  apify/instagram-comment-scraper  deeper comments, optional        ~$0.0026 per comment

All handles in one call share a single actor run, which keeps start-up overhead and cost down.
Every run carries maxTotalChargeUsd, so a run can never spend more than the budget we pass.
"""
from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from ..canonical import post_url, profile_url
from ..models import Author, Comment, FetchResult, Location, Media, Post, Stats, normalize_tag, top_comments
from .base import Blocked, ConfigError, Permanent, ProviderError, Transient, iso_utc

log = logging.getLogger(__name__)

API = "https://api.apify.com/v2"
POSTS_ACTOR = "apify~instagram-scraper"
COMMENTS_ACTOR = "apify~instagram-comment-scraper"
# Free-plan list prices, used to estimate and cap spend. Override via config if your plan differs.
PRICE_PER_POST_USD = 0.0027
PRICE_PER_COMMENT_USD = 0.0026

_TERMINAL = {"SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"}
_PERMANENT_ERRORS = ("not_found", "not found", "private", "doesn't exist", "does not exist", "no_items", "restricted")


class ApifyProvider:
    name = "tier2_apify"

    def __init__(
        self,
        token: str | None,
        *,
        client: httpx.Client | None = None,
        run_timeout_s: int = 600,
        poll_s: int = 30,
        price_per_post: float = PRICE_PER_POST_USD,
        price_per_comment: float = PRICE_PER_COMMENT_USD,
        sleep=time.sleep,
    ):
        if not token:
            raise ConfigError("APIFY_TOKEN is not set")
        self._client = client or httpx.Client(timeout=httpx.Timeout(90.0, connect=15.0))
        self._headers = {"Authorization": f"Bearer {token}"}
        self.run_timeout_s = run_timeout_s
        self.poll_s = poll_s
        self.price_per_post = price_per_post
        self.price_per_comment = price_per_comment
        self._sleep = sleep

    # ---- public API -------------------------------------------------------------------------

    def check(self) -> dict[str, Any]:
        """Validate the token and return the account's plan facts."""
        data = self._request("GET", "/users/me")["data"]
        return {"username": data.get("username"), "plan": (data.get("plan") or {}).get("id")}

    def fetch_profiles(
        self, handles: list[str], limit: int, since: str | None, max_charge_usd: float
    ) -> dict[str, FetchResult | ProviderError]:
        """One actor run for all handles. Returns a result or an error for each handle."""
        urls = {profile_url(h): h for h in handles}
        run_input: dict[str, Any] = {
            "directUrls": list(urls),
            "resultsType": "posts",
            "resultsLimit": limit,
            "addParentData": False,
        }
        if since:
            run_input["onlyPostsNewerThan"] = since
        items, cost = self._run(POSTS_ACTOR, run_input, max_charge_usd)

        out: dict[str, FetchResult | ProviderError] = {h: FetchResult() for h in handles}
        for item in items:
            handle = self._owner_handle(item, urls)
            if handle is None:
                log.warning("apify item matched no requested handle: %s", item.get("inputUrl") or item.get("url"))
                continue
            if item.get("error"):
                out[handle] = _item_error(item)
                continue
            res = out[handle]
            if isinstance(res, ProviderError):
                continue
            try:
                res.posts.append(self.normalize(item))
                res.raw.append(item)
            except Exception as e:  # one bad item must not lose the rest
                log.warning("apify item for %s could not be normalized: %s", handle, e)
        # Spread run cost across handles by posts returned, for the audit trail.
        total_posts = sum(len(r.posts) for r in out.values() if isinstance(r, FetchResult)) or 1
        for r in out.values():
            if isinstance(r, FetchResult):
                r.cost_usd = round(cost * len(r.posts) / total_posts, 6)
        return out

    def fetch_posts(self, shortcodes: list[str], max_charge_usd: float) -> dict[str, FetchResult | ProviderError]:
        urls = {post_url(c): c for c in shortcodes}
        run_input = {"directUrls": list(urls), "resultsType": "posts", "resultsLimit": 1, "addParentData": False}
        items, cost = self._run(POSTS_ACTOR, run_input, max_charge_usd)
        out: dict[str, FetchResult | ProviderError] = {}
        for item in items:
            code = item.get("shortCode") or _shortcode_from_url(item.get("inputUrl") or item.get("url"), urls)
            if not code:
                continue
            if item.get("error"):
                out[code] = _item_error(item)
            elif code in urls.values():
                out[code] = FetchResult(posts=[self.normalize(item)], raw=[item],
                                        cost_usd=round(cost / max(len(items), 1), 6))
        for c in shortcodes:
            out.setdefault(c, Permanent("post not returned (removed, private or not found)"))
        return out

    def fetch_comments(self, shortcodes: list[str], per_post: int, max_charge_usd: float) -> dict[str, list[Comment]]:
        """Deeper comments for posts, via the comment actor. Commenter handles are dropped here."""
        urls = {post_url(c): c for c in shortcodes}
        run_input = {"directUrls": list(urls), "resultsLimit": per_post, "includeNestedComments": False}
        items, _ = self._run(COMMENTS_ACTOR, run_input, max_charge_usd)
        out: dict[str, list[Comment]] = {c: [] for c in shortcodes}
        for item in items:
            if item.get("error"):
                continue
            code = _shortcode_from_url(item.get("postUrl") or item.get("inputUrl"), urls)
            text = (item.get("text") or "").strip()
            if code in out and text:
                out[code].append(Comment(text=text, like_count=_int(item.get("likesCount")),
                                         created_at=iso_utc(item.get("timestamp"))))
        return {c: top_comments(cs) for c, cs in out.items()}

    def inspect_profiles(self, handles: list[str], max_charge_usd: float = 0.05) -> dict[str, dict | ProviderError]:
        """Profile facts, mainly how many posts exist, so the user can approve a full scrape."""
        urls = {profile_url(h): h for h in handles}
        run_input = {"directUrls": list(urls), "resultsType": "details", "resultsLimit": 1}
        items, _ = self._run(POSTS_ACTOR, run_input, max_charge_usd)
        out: dict[str, dict | ProviderError] = {}
        for item in items:
            h = self._owner_handle({"inputUrl": item.get("inputUrl"), "ownerUsername": item.get("username")}, urls)
            if h is None:
                continue
            if item.get("error"):
                out[h] = _item_error(item)
                continue
            out[h] = {
                "handle": h,
                "full_name": item.get("fullName") or None,
                "post_count": _int(item.get("postsCount")),
                "private": bool(item.get("private")),
                "is_business": item.get("isBusinessAccount"),
                "verified": item.get("verified"),
            }
        for h in handles:
            out.setdefault(h, Permanent("profile not found"))
        return out

    def estimate_cost(self, n_posts: int, n_comments: int = 0) -> float:
        return round(n_posts * self.price_per_post + n_comments * self.price_per_comment, 4)

    # ---- normalization ----------------------------------------------------------------------

    def normalize(self, item: dict[str, Any]) -> Post:
        code = item.get("shortCode")
        if not code:
            raise ValueError("item has no shortCode")
        kind = {"Image": "image", "Video": "video", "Sidecar": "carousel"}.get(item.get("type") or "")

        comments = [
            Comment(text=c["text"].strip(), like_count=_int(c.get("likesCount")), created_at=iso_utc(c.get("timestamp")))
            for c in (item.get("latestComments") or [])
            if isinstance(c, dict) and (c.get("text") or "").strip()
        ]
        n_comments = _int(item.get("commentsCount"))
        if comments:
            comments_val: list[Comment] | None = top_comments(comments)
        elif n_comments == 0 or item.get("isCommentsDisabled"):
            comments_val = []
        else:
            comments_val = None  # there are comments but we didn't get them

        loc = None
        if item.get("locationName") or item.get("locationId"):
            loc = Location(name=item.get("locationName"), ig_location_id=_str(item.get("locationId")))

        return Post(
            shortcode=code,
            type=kind,
            author=Author(username=(item.get("ownerUsername") or None), full_name=item.get("ownerFullName") or None),
            posted_at=iso_utc(item.get("timestamp")),
            caption=item.get("caption") if item.get("caption") is not None else None,
            hashtags=[normalize_tag(t, "#") for t in item.get("hashtags") or []],
            mentions=[normalize_tag(m, "@") for m in item.get("mentions") or []],
            location=loc,
            comments=comments_val,
            media=_media(item, kind),
            stats=Stats(
                like_count=_nonneg(item.get("likesCount")),
                comment_count=n_comments,
                view_count=_nonneg(item.get("videoPlayCount") or item.get("videoViewCount")),
            ),
            is_pinned=item.get("isPinned"),
            product_type=item.get("productType"),
        )

    # ---- HTTP plumbing ----------------------------------------------------------------------

    def _run(self, actor: str, run_input: dict[str, Any], max_charge_usd: float) -> tuple[list[dict], float]:
        params = {"timeout": self.run_timeout_s, "maxTotalChargeUsd": f"{max_charge_usd:.4f}"}
        run = self._request("POST", f"/acts/{actor}/runs", params=params, json=run_input)["data"]
        run_id = run["id"]
        log.info("apify run %s started for %s", run_id, actor)
        deadline = time.monotonic() + self.run_timeout_s + 120
        while run.get("status") not in _TERMINAL:
            if time.monotonic() > deadline:
                raise Transient(f"apify run {run_id} did not finish in time")
            run = self._request("GET", f"/actor-runs/{run_id}", params={"waitForFinish": self.poll_s})["data"]
            if run.get("status") not in _TERMINAL:
                self._sleep(1)

        status = run["status"]
        items = self._dataset_items(run["defaultDatasetId"])
        n_ok = sum(1 for i in items if not i.get("error"))
        cost = _run_cost(run, n_ok, self.price_per_post if actor == POSTS_ACTOR else self.price_per_comment)
        log.info("apify run %s %s: %d items, ~$%.4f", run_id, status, len(items), cost)
        if status == "SUCCEEDED" or items:
            # TIMED-OUT or ABORTED (e.g. charge cap reached) with partial data still counts.
            return items, cost
        msg = run.get("statusMessage") or status
        if status == "TIMED-OUT":
            raise Transient(f"apify run timed out: {msg}")
        raise Blocked(f"apify run {status.lower()}: {msg}")

    def _dataset_items(self, dataset_id: str) -> list[dict]:
        items: list[dict] = []
        offset, page = 0, 1000
        while True:
            batch = self._request(
                "GET", f"/datasets/{dataset_id}/items",
                params={"clean": "true", "format": "json", "offset": offset, "limit": page},
            )
            items.extend(batch)
            if len(batch) < page:
                return items
            offset += page

    def _request(self, method: str, path: str, *, attempts: int = 4, **kw) -> Any:
        delay = 2.0
        for attempt in range(1, attempts + 1):
            try:
                r = self._client.request(method, API + path, headers=self._headers, **kw)
            except httpx.TransportError as e:
                err: ProviderError = Transient(f"network error talking to Apify: {e}")
            else:
                if r.status_code < 400:
                    return r.json()
                err = _http_error(r)
            if not isinstance(err, Transient) or attempt == attempts:
                raise err
            log.info("apify %s %s failed (%s), retry in %.0fs", method, path, err, delay)
            self._sleep(delay)
            delay *= 3
        raise AssertionError("unreachable")

    @staticmethod
    def _owner_handle(item: dict, urls: dict[str, str]) -> str | None:
        input_url = (item.get("inputUrl") or "").rstrip("/") + "/"
        if input_url in urls:
            return urls[input_url]
        owner = (item.get("ownerUsername") or "").lower()
        return owner if owner in urls.values() else None


def _http_error(r: httpx.Response) -> ProviderError:
    try:
        body = r.json().get("error", {})
        detail = f"{body.get('type', '')}: {body.get('message', '')}".strip(": ")
    except Exception:
        detail = r.text[:200]
    msg = f"Apify HTTP {r.status_code} {detail}"
    low = detail.lower()
    if r.status_code == 429 or r.status_code >= 500:
        return Transient(msg)
    if r.status_code == 402 or any(k in low for k in ("credit", "usage", "limit-exceeded", "not-enough")):
        return Blocked(msg + " (out of credit or over the monthly limit)")
    if r.status_code in (401, 403):
        return ConfigError(msg + " (check APIFY_TOKEN)")
    if r.status_code == 404:
        return ConfigError(msg + " (actor or run not found)")
    return Blocked(msg)


def _item_error(item: dict) -> ProviderError:
    text = f"{item.get('error')}: {item.get('errorDescription') or ''}".strip(": ")
    if any(k in text.lower() for k in _PERMANENT_ERRORS):
        return Permanent(text)
    return Blocked(text)


def _run_cost(run: dict, n_items: int, unit_price: float) -> float:
    """Prefer what Apify charged; fall back to items x list price."""
    counts = run.get("chargedEventCounts") or {}
    prices = ((run.get("pricingInfo") or {}).get("pricingPerEvent") or {}).get("actorChargeEvents") or {}
    total = 0.0
    for event, count in counts.items():
        p = prices.get(event, {})
        unit = p.get("eventPriceUsd")
        if unit is None:
            tiers = p.get("eventTieredPricingUsd") or {}
            unit = (tiers.get("FREE") or {}).get("tieredEventPriceUsd")
        if unit is not None:
            total += unit * count
    if total:
        return round(total, 6)
    return round(n_items * unit_price, 6)


def _media(item: dict, kind: str | None) -> list[Media]:
    def one(node: dict, idx: int) -> Media | None:
        if node.get("type") == "Video" or node.get("videoUrl"):
            if not node.get("videoUrl") and not node.get("displayUrl"):
                return None
            return Media(idx=idx, kind="video", source_url=node.get("videoUrl"), cover_url=node.get("displayUrl"),
                         width=_int(node.get("dimensionsWidth")), height=_int(node.get("dimensionsHeight")),
                         duration_s=_float(node.get("videoDuration")))
        if node.get("displayUrl"):
            return Media(idx=idx, kind="image", source_url=node["displayUrl"],
                         width=_int(node.get("dimensionsWidth")), height=_int(node.get("dimensionsHeight")))
        return None

    if kind == "carousel":
        children = item.get("childPosts") or []
        if children:
            media = [one(c, i) for i, c in enumerate(children)]
            return [m for m in media if m]
        imgs = item.get("images") or []
        return [Media(idx=i, kind="image", source_url=u) for i, u in enumerate(imgs) if u]
    m = one(item, 0)
    return [m] if m else []


def _shortcode_from_url(url: str | None, urls: dict[str, str]) -> str | None:
    if not url:
        return None
    from ..canonical import InputError, parse_target
    try:
        t = parse_target(url)
    except InputError:
        return None
    return t.value if t.kind == "post" else None


def _int(v) -> int | None:
    try:
        return int(v) if v is not None and v != "" else None
    except (TypeError, ValueError):
        return None


def _nonneg(v) -> int | None:
    n = _int(v)
    return n if n is not None and n >= 0 else None  # Apify reports hidden like counts as -1


def _float(v) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _str(v) -> str | None:
    return str(v) if v not in (None, "") else None
