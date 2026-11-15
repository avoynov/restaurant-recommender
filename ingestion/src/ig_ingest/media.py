"""Media lane: download photos, video covers and (optionally) videos to local storage.

Instagram CDN URLs expire within hours and may be tied to the requesting IP, so media is
fetched right after metadata and handed downstream by storage key only. Storage is a local
folder here; the key layout (media/{shortcode}/{idx}.{ext}) maps 1:1 onto an R2 bucket later.

Policies:
  none    metadata only
  covers  every photo, plus the cover image of each video (default: cheap, good for vision models)
  all     photos, covers and full videos
"""
from __future__ import annotations

import logging
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

MAX_BYTES = 100 * 1024 * 1024  # 100 MB per file, as in the design's manual-upload limit
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


def sniff(head: bytes) -> tuple[str, str] | None:
    """True file type from magic bytes, never from the URL. Returns (mime, extension)."""
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", "jpg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp", "webp"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in (b"heic", b"heix", b"mif1", b"msf1"):
            return "image/heic", "heic"
        if brand in (b"avif", b"avis"):
            return "image/avif", "avif"
        return "video/mp4", "mp4"
    return None


class MediaStore:
    def __init__(self, root: Path, client: httpx.Client | None = None):
        self.root = root
        self.client = client or httpx.Client(
            timeout=httpx.Timeout(60.0, connect=15.0), follow_redirects=True, headers={"User-Agent": _UA})

    def download_post(self, record: dict, policy: str) -> list[str]:
        """Download whatever the policy wants and is not stored yet. Mutates record['media'].

        Returns a list of error strings (empty when everything needed was stored).
        """
        if policy == "none" or not record.get("media"):
            return []
        code = record["shortcode"]
        errors: list[str] = []
        for m in record["media"]:
            jobs: list[tuple[str, str, str]] = []  # (url, key field, file stem)
            if m["kind"] == "image" and not m.get("storage_key") and m.get("source_url"):
                jobs.append((m["source_url"], "storage_key", f"{m['idx']}"))
            if m["kind"] == "video":
                if m.get("cover_url") and not m.get("cover_storage_key"):
                    jobs.append((m["cover_url"], "cover_storage_key", f"{m['idx']}_cover"))
                if policy == "all" and not m.get("storage_key") and m.get("source_url"):
                    jobs.append((m["source_url"], "storage_key", f"{m['idx']}"))
            for url, field, stem in jobs:
                try:
                    key, mime, size = self._fetch(code, stem, url)
                except Exception as e:
                    errors.append(f"{code}#{m['idx']} {field}: {e}")
                    continue
                m[field] = key
                if field == "storage_key":
                    m["mime"], m["bytes"] = mime, size
        return errors

    def _fetch(self, code: str, stem: str, url: str) -> tuple[str, str, int]:
        folder = self.root / "media" / code
        folder.mkdir(parents=True, exist_ok=True)
        tmp = folder / f".{stem}.part"
        try:
            return self._fetch_to(folder, tmp, code, stem, url)
        finally:
            tmp.unlink(missing_ok=True)

    def _fetch_to(self, folder: Path, tmp: Path, code: str, stem: str, url: str) -> tuple[str, str, int]:
        size = 0
        head = b""
        with self.client.stream("GET", url) as r:
            if r.status_code != 200:
                raise RuntimeError(f"HTTP {r.status_code}")
            declared = int(r.headers.get("content-length") or 0)
            if declared > MAX_BYTES:
                raise RuntimeError(f"too large ({declared} bytes)")
            with tmp.open("wb") as f:
                for chunk in r.iter_bytes():
                    if len(head) < 16:
                        head += chunk[: 16 - len(head)]
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise RuntimeError("too large")
                    f.write(chunk)
        kind = sniff(head)
        if kind is None:
            raise RuntimeError("not an image or video (unrecognised file type)")
        mime, ext = kind
        final = folder / f"{stem}.{ext}"
        tmp.replace(final)
        return f"media/{code}/{stem}.{ext}", mime, size
