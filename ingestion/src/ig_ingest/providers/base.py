"""Provider interface and the error classes that drive fallback.

Error classes follow the design doc's operations section:
  Transient  timeout, 429, 5xx          -> retry the same provider with backoff
  Blocked    401, login wall, empty     -> count toward breaker, move to next provider
  Permanent  404, private, removed      -> stop; no other provider will do better
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Protocol

from ..canonical import Target
from ..models import FetchResult


class ProviderError(Exception):
    error_class = "error"


class Transient(ProviderError):
    error_class = "transient"


class Blocked(ProviderError):
    error_class = "blocked"


class Permanent(ProviderError):
    error_class = "permanent"


class ConfigError(ProviderError):
    """The provider is not usable as configured (missing token, missing package)."""
    error_class = "config"


class Provider(Protocol):
    name: str  # used in provenance, e.g. "tier2_apify"

    def fetch_profile(self, handle: str, limit: int, since: str | None) -> FetchResult: ...

    def fetch_posts(self, shortcodes: list[str]) -> FetchResult: ...


def fetch(provider: Provider, target: Target, limit: int, since: str | None) -> FetchResult:
    if target.kind == "profile":
        return provider.fetch_profile(target.value, limit, since)
    return provider.fetch_posts([target.value])


def iso_utc(value) -> str | None:
    """Accept epoch seconds, datetime or ISO string; return ISO 8601 UTC with 'Z'."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        dt = datetime.fromtimestamp(value, tz=timezone.utc)
    elif isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    else:
        s = str(value).strip()
        if s.isdigit():
            return iso_utc(int(s))
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
