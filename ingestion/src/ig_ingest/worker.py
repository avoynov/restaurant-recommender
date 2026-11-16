"""Request worker for the GitHub Actions runner.

The Pages app writes a request file to requests/{id}.json on main. The workflow then runs
`python -m ig_ingest.worker`, which processes every request that has no final status yet,
keeps the database, media and statuses in the store folder (the `data` branch), and builds
the public files the Pages app reads.

Request kinds:
  posts    {"urls": [...], "comments": 10, "label": "Date night"}   scrape these posts
  inspect  {"handle": "some.bistro"}                                 count posts, estimate cost
  profile  {"handle": "some.bistro", "limit": 50, "comments": 10}    scrape a profile's posts
"""
from __future__ import annotations

import argparse
import json
import logging
import shutil
import sys
import traceback
from pathlib import Path
from typing import Any

from .canonical import InputError, parse_target
from .config import Settings
from .export import public_post
from .pipeline import Options, Pipeline, build_providers
from .providers.apify import PRICE_PER_COMMENT_USD, PRICE_PER_POST_USD
from .providers.base import ProviderError
from .store import Store, now

log = logging.getLogger("ig_ingest.worker")

MAX_POSTS_PER_REQUEST = 500
MAX_COMMENTS = 50
FINAL = {"done", "failed"}


def estimate(n_posts: int, comments: int) -> float:
    extra = max(0, comments - 10)  # the posts actor already returns about 10 comments per post
    return round(n_posts * (PRICE_PER_POST_USD + extra * PRICE_PER_COMMENT_USD), 4)


class Worker:
    def __init__(self, store_dir: Path, settings: Settings, providers: list | None = None, media=None):
        self.dir = store_dir
        self.settings = settings
        settings.data_dir = store_dir
        self.store = Store(store_dir / "ig.db")
        if providers is None:
            providers, warnings = build_providers(["apify"], settings)
            for w in warnings:
                log.warning(w)
        self.providers = providers
        self.media = media
        (store_dir / "status").mkdir(parents=True, exist_ok=True)

    # ---- request handling --------------------------------------------------------------------

    def pending(self, requests_dir: Path) -> list[Path]:
        out = []
        for p in sorted(requests_dir.glob("*.json")):
            st = self.read_status(p.stem)
            if not st or st.get("state") not in FINAL:
                out.append(p)
        return out

    def read_status(self, rid: str) -> dict | None:
        p = self.dir / "status" / f"{rid}.json"
        return json.loads(p.read_text()) if p.exists() else None

    def write_status(self, rid: str, **fields) -> dict:
        st = self.read_status(rid) or {"id": rid}
        st.update(fields, updated_at=now())
        (self.dir / "status" / f"{rid}.json").write_text(json.dumps(st, indent=1, ensure_ascii=False))
        return st

    def process(self, path: Path) -> dict:
        rid = path.stem
        try:
            req = json.loads(path.read_text())
        except json.JSONDecodeError as e:
            return self.write_status(rid, state="failed", error=f"request is not valid JSON: {e}")
        kind = req.get("kind")
        self.write_status(rid, state="running", kind=kind, request=req, started_at=now())
        if not self.providers:
            return self.write_status(rid, state="failed", error="no provider configured (is APIFY_TOKEN set?)")
        try:
            if kind == "inspect":
                result = self._inspect(req)
            elif kind in ("posts", "profile"):
                result = self._scrape(req)
            else:
                raise ValueError(f"unknown request kind {kind!r}")
            return self.write_status(rid, state="done", finished_at=now(), **result)
        except (ProviderError, InputError, ValueError) as e:
            return self.write_status(rid, state="failed", finished_at=now(), error=str(e))
        except Exception as e:  # keep the worker alive for the next request
            log.error("request %s crashed:\n%s", rid, traceback.format_exc())
            return self.write_status(rid, state="failed", finished_at=now(), error=f"internal error: {e}")

    def _inspect(self, req: dict) -> dict:
        target = parse_target(req.get("handle") or "")
        if target.kind != "profile":
            raise ValueError("inspect needs a profile handle or profile link")
        apify = next((p for p in self.providers if hasattr(p, "inspect_profiles")), None)
        if apify is None:
            raise ValueError("inspect needs the Apify provider")
        info = apify.inspect_profiles([target.value])[target.value]
        if isinstance(info, ProviderError):
            raise info
        n = info.get("post_count") or 0
        info["estimate_usd_all"] = estimate(n, int(req.get("comments") or 10))
        info["estimate_usd_first_500"] = estimate(min(n, MAX_POSTS_PER_REQUEST), int(req.get("comments") or 10))
        self.store.log_attempt(f"@{target.value}", "tier2_apify_inspect", "ok", cost_usd=PRICE_PER_POST_USD)
        return {"profile": info, "spent_usd": PRICE_PER_POST_USD}

    def _scrape(self, req: dict) -> dict:
        comments = max(0, min(int(req.get("comments") or 10), MAX_COMMENTS))
        media = req.get("media") or "all"
        if req["kind"] == "posts":
            targets, rejected = [], []
            for u in req.get("urls") or []:
                try:
                    t = parse_target(u)
                except InputError as e:
                    rejected.append(str(e))
                    continue
                if t.kind == "post":
                    targets.append(t)
                else:
                    rejected.append(f"{u}: a profile, not a post link")
            targets = targets[:MAX_POSTS_PER_REQUEST]
            limit = 1
        else:
            t = parse_target(req.get("handle") or "")
            if t.kind != "profile":
                raise ValueError("profile request needs a handle")
            targets, rejected = [t], []
            limit = max(1, min(int(req.get("limit") or 12), MAX_POSTS_PER_REQUEST))
        if not targets:
            raise ValueError("no valid links in the request: " + "; ".join(rejected[:5]))

        n_posts = len(targets) if req["kind"] == "posts" else limit
        budget = float(req.get("budget_usd") or max(1.0, estimate(n_posts, comments) * 1.3))
        # Only spend on comments beyond what comes free with each post.
        opts = Options(limit=limit, comments=comments if comments > 10 else 0, media=media, budget_usd=budget)
        pipe = Pipeline(self.store, self.settings, self.providers, self.media)
        rep = pipe.run(targets, opts)

        label = (req.get("label") or "").strip()[:80]
        if label:
            for code in rep.posts:
                self.store.add_source(code, "collection", label)
        # Trim comments to the N the user asked for (ranked by likes already).
        for code in rep.posts:
            rec = self.store.get_post(code)
            if rec and rec[0].get("comments") and len(rec[0]["comments"]) > comments:
                rec[0]["comments"] = rec[0]["comments"][:comments]
                row = self.store.db.execute("SELECT status, missing FROM posts WHERE shortcode=?", (code,)).fetchone()
                self.store.put_post(rec[0], rec[1], row["status"], json.loads(row["missing"]))
        return {
            "posts": rep.posts,
            "profiles": rep.profiles,
            "rejected": rejected,
            "spent_usd": round(rep.spent_usd, 4),
            "media_errors": rep.media_errors[:20],
        }

    # ---- public site data --------------------------------------------------------------------

    def build_public(self, out: Path) -> int:
        """Write the files the Pages app reads: index.json, posts/{code}.json, status/, media/."""
        if out.exists():
            shutil.rmtree(out)
        (out / "posts").mkdir(parents=True)
        index = []
        for row in self.store.iter_posts(("COMPLETE", "PARTIAL")):
            record, prov = json.loads(row["record"]), json.loads(row["provenance"])
            post = public_post(record)
            sources = [{"kind": s["kind"], "handle": s["handle"] or None, "first_seen": s["first_seen"]}
                       for s in self.store.sources_for(row["shortcode"])]
            full = {"post": post, "provenance": prov, "status": row["status"],
                    "missing": json.loads(row["missing"]), "sources": sources, "updated_at": row["updated_at"]}
            (out / "posts" / f"{row['shortcode']}.json").write_text(json.dumps(full, ensure_ascii=False))
            media = post.get("media") or []
            thumb = next((m.get("storage_key") if m["kind"] == "image" else m.get("cover_storage_key")
                          for m in media if (m.get("storage_key") if m["kind"] == "image" else m.get("cover_storage_key"))), None)
            index.append({
                "shortcode": row["shortcode"], "type": post.get("type"),
                "author": (post.get("author") or {}).get("username"),
                "caption": (post.get("caption") or "")[:200], "posted_at": post.get("posted_at"),
                "thumb": thumb, "n_media": len(media),
                "has_video": any(m["kind"] == "video" and m.get("storage_key") for m in media),
                "n_comments": len(post.get("comments") or []),
                "location": (post.get("location") or {}).get("name"),
                "status": row["status"], "sources": sources, "updated_at": row["updated_at"],
            })
        index.sort(key=lambda x: x["updated_at"], reverse=True)
        requests = []
        for sp in sorted((self.dir / "status").glob("*.json"), reverse=True)[:50]:
            st = json.loads(sp.read_text())
            requests.append({k: st.get(k) for k in ("id", "kind", "state", "error", "started_at", "finished_at",
                                                    "spent_usd", "profile", "posts")})
        (out / "index.json").write_text(json.dumps({"generated_at": now(), "posts": index, "requests": requests,
                                                     "spend": self.store.summary()["spend_this_month_usd"]},
                                                    ensure_ascii=False))
        if (self.dir / "status").exists():
            shutil.copytree(self.dir / "status", out / "status")
        if (self.dir / "media").exists():
            shutil.copytree(self.dir / "media", out / "media")
        return len(index)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m ig_ingest.worker")
    ap.add_argument("--requests", type=Path, required=True, help="folder of request JSON files")
    ap.add_argument("--store", type=Path, required=True, help="persistent store folder (data branch)")
    ap.add_argument("--public", type=Path, help="write the Pages data folder here")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    w = Worker(args.store, Settings.from_env())
    todo = w.pending(args.requests) if args.requests.exists() else []
    log.info("%d pending request(s)", len(todo))
    for p in todo:
        st = w.process(p)
        log.info("request %s: %s %s", p.stem, st["state"], st.get("error", ""))
    if args.public:
        n = w.build_public(args.public)
        log.info("public data: %d posts", n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
