# ig-ingest

Ingestion prototype for the restaurant recommendation app. Give it public Instagram
handles (or post URLs); it fetches their posts, normalizes each one into the handoff
record from the design doc (`schema_version` 1.0), downloads media, and stores
everything for the separate **Dataset Population** module.

Logged-out only. No Instagram accounts, no burner logins.

## Quick start

```bash
pip install -e '.[free,dev]'
cp .env.example .env          # put your APIFY_TOKEN in it (or set it as an environment variable)
ig-ingest doctor              # checks token, network, tools
ig-ingest fetch nasa some.bistro --limit 12 --dry-run   # cost estimate, nothing fetched
ig-ingest fetch nasa some.bistro --limit 12
ig-ingest status
ig-ingest export              # data/export/posts.jsonl
ig-ingest show <shortcode>
```

Inputs accepted: `nasa`, `@nasa`, `instagram.com/nasa`, and post links in `/p/`, `/reel/`,
`/reels/`, `/tv/` or `instagr.am` form. Use `--file handles.txt` for a list.

## How it works

```
handles / URLs ──► canonicalise ──► providers in fallback order ──► merge (field provenance)
                                     1. Apify (hosted, paid per result)        │
                                     2. Instaloader (free, logged-out)         ▼
                                                         optional comment deepening (Apify)
                                                                               │
                                                     media lane: photos, video covers, videos
                                                                               │
                                              SQLite (data/ig.db) ──► export JSONL handoff
```

* **Providers.** `--providers auto` uses Apify first when a token is set, then Instaloader.
  Blocked or transient failures fall through to the next provider. A permanent failure
  (private, deleted, not found) stops there, so no money is spent on dead targets.
* **Apify actors.** `apify/instagram-scraper` (one run for all handles, `resultsType=posts`) and,
  only with `--comments N`, `apify/instagram-comment-scraper`.
* **Merge rules.** Null never overwrites data; manual input is never overwritten; otherwise the
  fresher value wins. Each field records which provider filled it (`provenance`).
* **Media.** `--media covers` (default) stores every photo and each video's cover image;
  `--media all` adds the videos; `--media none` skips it. File types are checked from magic
  bytes. Keys look like `media/{shortcode}/{idx}.jpg`, ready to map onto an R2 bucket.
* **Status.** A post is `COMPLETE` once it has type, author, date and the media the policy asks
  for. Caption, comments and location can legitimately be missing and are listed in `missing`.
* **Raw payloads.** Every provider response is kept in `raw_payloads`, so we can re-normalize
  later without paying to fetch again.

## Cost and budget guards

| | Free-plan price (Nov 2026) |
|---|---|
| Post via `apify/instagram-scraper` | $0.0027 |
| Comment via `apify/instagram-comment-scraper` | $0.0026 |

Apify's free plan includes $5 of credit a month: about 1,850 posts. Twelve posts from each
of 10 friends costs about $0.32.

* Every Apify run is started with `maxTotalChargeUsd`, so Apify itself stops it at the cap.
* Per run: `--budget` (default `$1`, env `IG_RUN_BUDGET_USD`).
* Per month: `IG_MONTHLY_CAP_USD` (default `$5`). Spend is tracked in the `attempts` table and
  shown by `ig-ingest status`.
* `--dry-run` prints the worst-case estimate and stops.

Comments: the posts actor already returns a handful of recent comments per post at no extra
cost. `--comments 20` tops that up to 20 per post, about $0.05 a post, so use it sparingly.

## Output record

One JSON line per post and source, following the design doc's handoff contract:

```json
{
  "schema_version": "1.0",
  "event_id": "uuid (stable for the same post and source)",
  "user_id": null,
  "save": {"source": "profile_feed", "handle": "some.bistro", "collection": null, "saved_at": "..."},
  "post": {
    "shortcode": "...", "url": "https://www.instagram.com/p/.../", "type": "image | carousel | video",
    "author": {"username": "...", "full_name": "...", "is_business": null},
    "posted_at": "2026-09-30T12:00:00Z", "caption": "...", "hashtags": ["#..."], "mentions": ["@..."],
    "location": {"name": "...", "ig_location_id": "...", "lat": null, "lng": null},
    "comments": [{"text": "...", "like_count": 41, "created_at": "..."}],
    "media": [{"idx": 0, "kind": "image", "storage_key": "media/.../0.jpg", "mime": "image/jpeg", "...": "..."}],
    "stats": {"like_count": 1520, "comment_count": 3, "view_count": null},
    "is_pinned": false, "product_type": "clips"
  },
  "provenance": {"caption": "tier2_apify", "comments": "tier2_apify", "fetched_at": "..."},
  "status": "COMPLETE",
  "missing": []
}
```

Contract rules kept: missing fields are `null`, never omitted; at most 50 comments, sorted by
likes, with commenter usernames dropped; media passed by storage key, never by CDN URL.
`status`, `missing`, `stats`, `is_pinned` and `product_type` are additive fields.

## Known limits (found while building, 15 Nov 2026)

* **Instagram blocks the free tier from cloud servers fast.** From a cloud worker, Instaloader
  logged-out read one profile, then got HTTP 429 and a login wall within about three requests.
  Comments always need a login. From a home connection it lasts longer; expect Apify to carry
  cloud runs.
* **Media from the Claude cloud sandbox.** Instagram's CDN hosts (`scontent-*.cdninstagram.com`)
  change per request and are not on the sandbox allowlist, so downloads fail there and posts stay
  `PARTIAL (missing: media)`. Run anywhere with normal internet, or use `--media none`.
* `author.is_business` and location coordinates are not in Apify's post output; they stay `null`.

## Tests

```bash
pytest -q
```

Tests run offline against sample Apify payloads and a fake Apify API and CDN. They cover
URL parsing, normalization, run budgets, error classes and fallback, merge rules, media
handling and the export contract.
