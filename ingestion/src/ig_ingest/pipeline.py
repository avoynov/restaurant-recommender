"""Orchestration: targets in, merged and stored post records out.

For each batch of targets the pipeline tries providers in order. A handle that one provider
cannot serve (blocked, transient) falls through to the next; a permanent error (private,
missing) stops there. Then it optionally deepens comments, downloads media and grades
each post COMPLETE or PARTIAL.
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from .canonical import Target
from .config import Settings
from .media import MediaStore
from .merge import assess, merge
from .models import Comment, FetchResult, top_comments
from .providers.base import Blocked, ConfigError, Permanent, ProviderError
from .store import Store

log = logging.getLogger(__name__)


@dataclass
class Options:
    limit: int = 12
    since: str | None = None
    providers: list[str] = field(default_factory=lambda: ["auto"])
    comments: int = 0  # >0: fetch up to N comments per post via the Apify comment actor
    media: str = "covers"  # none | covers | all
    budget_usd: float | None = None
    dry_run: bool = False


@dataclass
class Report:
    profiles: dict[str, str] = field(default_factory=dict)  # handle -> "ok via X (n posts)" or error
    posts: dict[str, str] = field(default_factory=dict)  # shortcode -> status
    spent_usd: float = 0.0
    media_errors: list[str] = field(default_factory=list)
    estimate_usd: float | None = None


class Budget:
    def __init__(self, store: Store, settings: Settings, run_budget: float | None):
        month_start = datetime.now(timezone.utc).strftime("%Y-%m-01T00:00:00Z")
        self.month_left = max(0.0, settings.monthly_cap_usd - store.spend_since(month_start))
        self.run_left = run_budget if run_budget is not None else settings.run_budget_usd

    def allowance(self, estimate: float) -> float:
        cap = min(self.month_left, self.run_left)
        return round(min(cap, estimate * 1.25 + 0.01), 4)

    def spend(self, usd: float) -> None:
        self.month_left -= usd
        self.run_left -= usd


def parse_since(since: str | None) -> str | None:
    """Accept YYYY-MM-DD, ISO, or relative ('30 days', '6 months', '1 year'); return YYYY-MM-DD."""
    if not since:
        return None
    m = re.fullmatch(r"\s*(\d+)\s*(day|week|month|year)s?\s*", since.lower())
    if m:
        n, unit = int(m.group(1)), m.group(2)
        days = {"day": 1, "week": 7, "month": 30, "year": 365}[unit] * n
        return (date.today() - timedelta(days=days)).isoformat()
    try:
        return datetime.fromisoformat(since.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        raise ConfigError(f"--since must be a date (2026-01-31) or relative ('6 months'), got {since!r}")


def build_providers(names: list[str], settings: Settings) -> tuple[list, list[str]]:
    """Instantiate providers in order. Returns (providers, warnings)."""
    if names == ["auto"]:
        names = ["apify", "instaloader"] if settings.apify_token else ["instaloader"]
    out, warnings = [], []
    for n in names:
        try:
            if n == "apify":
                from .providers.apify import ApifyProvider
                out.append(ApifyProvider(settings.apify_token))
            elif n == "instaloader":
                from .providers.instaloader_tier import InstaloaderProvider
                out.append(InstaloaderProvider())
            else:
                warnings.append(f"unknown provider {n!r}")
        except ConfigError as e:
            warnings.append(f"{n}: {e}")
    return out, warnings


class Pipeline:
    def __init__(self, store: Store, settings: Settings, providers: list, media: MediaStore | None = None):
        self.store, self.settings, self.providers = store, settings, providers
        self.media = media or MediaStore(settings.data_dir)

    def run(self, targets: list[Target], opts: Options) -> Report:
        rep = Report()
        budget = Budget(self.store, self.settings, opts.budget_usd)
        since = parse_since(opts.since)
        handles = list(dict.fromkeys(t.value for t in targets if t.kind == "profile"))
        codes = list(dict.fromkeys(t.value for t in targets if t.kind == "post"))

        rep.estimate_usd = self._estimate(len(handles) * opts.limit + len(codes), opts.comments)
        if opts.dry_run:
            return rep

        touched: set[str] = set()
        if handles:
            touched |= self._profiles(handles, opts.limit, since, budget, rep)
        if codes:
            touched |= self._posts(codes, budget, rep)
        if opts.comments > 0 and touched:
            self._deepen_comments(sorted(touched), opts.comments, budget, rep)
        for code in sorted(touched):
            self._finish_post(code, opts.media, rep)
        return rep

    # ---- stages -----------------------------------------------------------------------------

    def _profiles(self, handles: list[str], limit: int, since: str | None, budget: Budget, rep: Report) -> set[str]:
        remaining = list(handles)
        touched: set[str] = set()
        for prov in self.providers:
            if not remaining:
                break
            charge = self._allowance(prov, budget, len(remaining) * limit)
            if charge is None:
                for h in remaining:
                    self.store.log_attempt(f"@{h}", prov.name, "skipped", detail="budget exhausted")
                continue
            t0 = time.monotonic()
            try:
                results = prov.fetch_profiles(remaining, limit, since, charge)
            except ProviderError as e:  # whole-provider failure (bad token, outage)
                results = {h: e for h in remaining}
            ms = int((time.monotonic() - t0) * 1000)
            nxt = []
            for h in remaining:
                res = results.get(h) or Blocked("no result")
                if isinstance(res, FetchResult):
                    budget.spend(res.cost_usd)
                    rep.spent_usd += res.cost_usd
                    self.store.log_attempt(f"@{h}", prov.name, "ok", ms=ms, n_posts=len(res.posts), cost_usd=res.cost_usd)
                    self.store.put_profile(h, "ok", res.profile)
                    for post, raw in zip(res.posts, res.raw):
                        self._save(post, raw, prov.name)
                        self.store.add_source(post.shortcode, "profile_feed", h)
                        touched.add(post.shortcode)
                    rep.profiles[h] = f"ok via {prov.name} ({len(res.posts)} posts)"
                else:
                    self.store.log_attempt(f"@{h}", prov.name, res.error_class, detail=str(res), ms=ms)
                    rep.profiles[h] = f"{res.error_class} via {prov.name}: {res}"
                    if isinstance(res, Permanent):
                        self.store.put_profile(h, "unavailable", error=str(res))
                    else:
                        self.store.put_profile(h, "failed", error=str(res))
                        nxt.append(h)
            remaining = nxt
        return touched

    def _posts(self, codes: list[str], budget: Budget, rep: Report) -> set[str]:
        remaining = list(codes)
        touched: set[str] = set()
        for prov in self.providers:
            if not remaining:
                break
            charge = self._allowance(prov, budget, len(remaining))
            if charge is None:
                continue
            t0 = time.monotonic()
            try:
                results = prov.fetch_posts(remaining, charge)
            except ProviderError as e:
                results = {c: e for c in remaining}
            ms = int((time.monotonic() - t0) * 1000)
            nxt = []
            for c in remaining:
                res = results.get(c) or Blocked("no result")
                if isinstance(res, FetchResult) and res.posts:
                    budget.spend(res.cost_usd)
                    rep.spent_usd += res.cost_usd
                    self.store.log_attempt(c, prov.name, "ok", ms=ms, n_posts=1, cost_usd=res.cost_usd)
                    self._save(res.posts[0], res.raw[0] if res.raw else {}, prov.name)
                    self.store.add_source(c, "post_url", None)
                    touched.add(c)
                elif isinstance(res, Permanent):
                    self.store.log_attempt(c, prov.name, "permanent", detail=str(res), ms=ms)
                    self.store.mark_unavailable(c, str(res))
                    self.store.add_source(c, "post_url", None)
                    rep.posts[c] = f"UNAVAILABLE ({res})"
                else:
                    err = res if isinstance(res, ProviderError) else Blocked("empty result")
                    self.store.log_attempt(c, prov.name, err.error_class, detail=str(err), ms=ms)
                    rep.posts[c] = f"failed via {prov.name}: {err}"
                    nxt.append(c)
            remaining = nxt
        return touched

    def _deepen_comments(self, codes: list[str], per_post: int, budget: Budget, rep: Report) -> None:
        apify = next((p for p in self.providers if p.name == "tier2_apify"), None)
        if apify is None:
            log.warning("--comments needs the Apify provider (set APIFY_TOKEN); skipping")
            return
        want = []
        for c in codes:
            rec = self.store.get_post(c)
            if not rec:
                continue
            record, prov = rec
            n = ((record.get("stats") or {}).get("comment_count")) or 0
            have = len(record.get("comments") or [])
            if prov.get("comments") != "manual" and n > have and have < per_post:
                want.append(c)
        if not want:
            return
        est = apify.estimate_cost(0, len(want) * per_post)
        charge = min(budget.month_left, budget.run_left, est * 1.25 + 0.01)
        if charge < 0.01:
            log.warning("budget exhausted; skipping comments for %d posts", len(want))
            return
        t0 = time.monotonic()
        try:
            got = apify.fetch_comments(want, per_post, charge)
        except ProviderError as e:
            self.store.log_attempt(f"comments x{len(want)}", apify.name + "_comments", e.error_class, detail=str(e))
            return
        n_comments = sum(len(v) for v in got.values())
        cost = round(n_comments * apify.price_per_comment, 6)
        budget.spend(cost)
        rep.spent_usd += cost
        self.store.log_attempt(f"comments x{len(want)}", apify.name + "_comments", "ok",
                               ms=int((time.monotonic() - t0) * 1000), n_posts=len(want), cost_usd=cost)
        for c, comments in got.items():
            if not comments:
                continue
            record, prov = self.store.get_post(c)
            existing = record.get("comments") or []
            merged = top_comments([Comment(**x) for x in existing] + comments)
            record["comments"] = [x.__dict__ for x in merged]
            prov["comments"] = apify.name
            status, missing = assess(record, "none")
            self.store.put_post(record, prov, status, missing)

    def _finish_post(self, code: str, media_policy: str, rep: Report) -> None:
        rec = self.store.get_post(code)
        if not rec:
            return
        record, prov = rec
        errors = self.media.download_post(record, media_policy)
        if errors:
            rep.media_errors.extend(errors)
            self.store.log_attempt(code, "media", "blocked", detail="; ".join(errors))
        if any(m.get("storage_key") or m.get("cover_storage_key") for m in record.get("media") or []):
            prov.setdefault("media_stored_by", "media_lane")
        status, missing = assess(record, media_policy)
        self.store.put_post(record, prov, status, missing)
        rep.posts[code] = status + (f" (missing: {', '.join(missing)})" if missing else "")

    # ---- helpers ----------------------------------------------------------------------------

    def _save(self, post, raw: dict, provider: str) -> None:
        record, prov = merge(self.store.get_post(post.shortcode), post, provider)
        status, missing = assess(record, "none")
        self.store.put_post(record, prov, status, missing)
        if raw:
            self.store.put_raw(post.shortcode, provider, raw)

    def _allowance(self, prov, budget: Budget, n_posts: int) -> float | None:
        if not hasattr(prov, "estimate_cost"):
            return 0.0  # free provider
        charge = budget.allowance(prov.estimate_cost(n_posts))
        return charge if charge >= 0.01 else None

    def _estimate(self, n_posts: int, comments: int) -> float | None:
        from .providers.apify import PRICE_PER_COMMENT_USD, PRICE_PER_POST_USD
        return round(n_posts * PRICE_PER_POST_USD + n_posts * comments * PRICE_PER_COMMENT_USD, 4)
