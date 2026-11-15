"""Command line: ig-ingest fetch | export | status | show | doctor."""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from .canonical import InputError, parse_target
from .config import Settings
from .providers.base import ConfigError

EXAMPLES = """examples:
  ig-ingest doctor
  ig-ingest fetch nasa natgeo --limit 12 --dry-run
  ig-ingest fetch --file handles.txt --since "6 months" --comments 20
  ig-ingest fetch https://www.instagram.com/p/DfahZrMjAqq/
  ig-ingest export --out data/export/posts.jsonl
"""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="ig-ingest", description=__doc__, epilog=EXAMPLES,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch", help="fetch posts for handles or post URLs")
    f.add_argument("targets", nargs="*", help="handles (nasa, @nasa), profile URLs or post URLs")
    f.add_argument("--file", type=Path, help="text file with one handle or URL per line (# comments ok)")
    f.add_argument("--limit", type=int, default=12, help="max posts per profile (default 12)")
    f.add_argument("--since", help="only posts newer than a date (2026-01-31) or '6 months'")
    f.add_argument("--providers", default="auto",
                   help="comma list in fallback order: apify,instaloader (default auto: Apify first if a token is set)")
    f.add_argument("--comments", type=int, default=0,
                   help="deepen comments to N per post with Apify's comment actor (costs ~$0.0026/comment)")
    f.add_argument("--media", choices=["none", "covers", "all"], default="covers",
                   help="none, photos + video covers (default), or everything including video")
    f.add_argument("--budget", type=float, help="max USD this run may spend on paid tiers (default $1)")
    f.add_argument("--dry-run", action="store_true", help="show the cost estimate and stop")

    e = sub.add_parser("export", help="write handoff records as JSON lines")
    e.add_argument("--out", type=Path, default=None, help="default: <data>/export/posts.jsonl")
    e.add_argument("--include-partial", action="store_true")
    e.add_argument("--user-id", help="app user id to stamp on records (default null)")

    sub.add_parser("status", help="counts, profile results, tier outcomes and spend")
    s = sub.add_parser("show", help="print one stored post record")
    s.add_argument("shortcode")
    sub.add_parser("doctor", help="check token, network and installed tools")

    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = Settings.from_env()
    try:
        return {"fetch": cmd_fetch, "export": cmd_export, "status": cmd_status,
                "show": cmd_show, "doctor": cmd_doctor}[args.cmd](args, settings)
    except ConfigError as err:
        print(f"error: {err}", file=sys.stderr)
        return 2


def _targets(args) -> list:
    raw = list(args.targets)
    if args.file:
        for line in args.file.read_text().splitlines():
            line = line.split("#", 1)[0].strip()
            if line:
                raw.append(line)
    out, bad = [], []
    for r in raw:
        try:
            out.append(parse_target(r))
        except InputError as err:
            bad.append(str(err))
    for b in bad:
        print(f"skipped: {b}", file=sys.stderr)
    return out


def cmd_fetch(args, settings: Settings) -> int:
    from .pipeline import Options, Pipeline, build_providers
    from .store import Store

    targets = _targets(args)
    if not targets:
        print("nothing to fetch: give handles or post URLs", file=sys.stderr)
        return 2
    providers, warnings = build_providers([p.strip() for p in args.providers.split(",") if p.strip()], settings)
    for w in warnings:
        print(f"note: {w}", file=sys.stderr)
    if not providers:
        print("error: no provider is usable. Set APIFY_TOKEN or install instaloader.", file=sys.stderr)
        return 2
    opts = Options(limit=args.limit, since=args.since, comments=args.comments, media=args.media,
                   budget_usd=args.budget, dry_run=args.dry_run)
    store = Store(settings.db_path)
    rep = Pipeline(store, settings, providers).run(targets, opts)

    print(f"providers: {' -> '.join(p.name for p in providers)}")
    print(f"estimated paid-tier cost if all served by Apify: ${rep.estimate_usd:.4f}")
    if args.dry_run:
        return 0
    for h, msg in rep.profiles.items():
        print(f"  @{h}: {msg}")
    counts: dict[str, int] = {}
    for st in rep.posts.values():
        k = st.split(" ")[0]
        counts[k] = counts.get(k, 0) + 1
    print(f"posts: {counts or 'none'}   spent: ${rep.spent_usd:.4f}")
    if rep.media_errors:
        print(f"media download errors: {len(rep.media_errors)} (first: {rep.media_errors[0]})")
    failed = [h for h, m in rep.profiles.items() if not m.startswith("ok")]
    return 1 if failed and len(failed) == len(rep.profiles) and not rep.posts else 0


def cmd_export(args, settings: Settings) -> int:
    from .export import write_jsonl
    from .store import Store
    out = args.out or settings.data_dir / "export" / "posts.jsonl"
    n = write_jsonl(Store(settings.db_path), out, args.include_partial, args.user_id)
    print(f"wrote {n} records to {out}")
    return 0


def cmd_status(args, settings: Settings) -> int:
    from .store import Store
    print(json.dumps(Store(settings.db_path).summary(), indent=2))
    return 0


def cmd_show(args, settings: Settings) -> int:
    from .export import public_post
    from .store import Store
    rec = Store(settings.db_path).get_post(args.shortcode)
    if not rec:
        print("not found", file=sys.stderr)
        return 1
    print(json.dumps({"post": public_post(rec[0]), "provenance": rec[1]}, indent=2, ensure_ascii=False))
    return 0


def cmd_doctor(args, settings: Settings) -> int:
    import httpx
    ok = True
    if settings.apify_token:
        try:
            from .providers.apify import ApifyProvider
            info = ApifyProvider(settings.apify_token).check()
            print(f"[ok]   Apify token valid (user {info['username']}, plan {info['plan']})")
        except Exception as err:
            ok = False
            print(f"[fail] Apify: {err}")
    else:
        print("[warn] APIFY_TOKEN not set: only the free tier will run")
    try:
        import instaloader
        print(f"[ok]   instaloader {instaloader.__version__} installed")
    except ImportError:
        print("[warn] instaloader not installed: no free tier (pip install 'ig-ingest[free]')")
    for url in ("https://www.instagram.com/", "https://api.apify.com/v2/"):
        try:
            code = httpx.get(url, timeout=15).status_code
            print(f"[ok]   reach {url} (HTTP {code})")
        except Exception as err:
            ok = False
            print(f"[fail] reach {url}: {type(err).__name__}")
    print(f"data dir: {settings.data_dir.resolve()}  monthly cap: ${settings.monthly_cap_usd}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
