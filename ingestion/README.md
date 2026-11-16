# ingestion

Fetches public Instagram posts (by post link, profile or saved-collection export), normalizes
each one into the handoff record from the design doc (`schema_version` 1.0), and saves photos
and videos as our own files for the Dataset Population step.

Node 20+, no dependencies. Logged-out only: no Instagram accounts, no burner logins.

## Quick start

```bash
cd ingestion
cp .env.example .env              # add APIFY_TOKEN
node src/cli.js doctor            # checks token and network
node src/cli.js fetch some.bistro https://www.instagram.com/reel/XXXX/ --limit 12 --dry-run
node src/cli.js fetch some.bistro --limit 12 --media all
node src/cli.js status
node src/cli.js export            # data/export/posts.jsonl
npm test
```

In GitHub Actions the same code runs as `src/worker.js`, driven by request files from the Pages app
(see the repository README).

## Layout

| File | Role |
|---|---|
| `src/canonical.js` | Handles and links to canonical targets (`/reel/` and `/p/` share one shortcode) |
| `src/apify.js` | `apify/instagram-scraper` (posts, profile details) and `apify/instagram-comment-scraper`; error classes; spend cap per run |
| `src/pipeline.js` | Fallback across providers, comment deepening, budget, grading |
| `src/merge.js` | Field-level merge with provenance; COMPLETE / PARTIAL grading |
| `src/media.js` | Saves media, checks real file type from magic bytes, 100 MB limit |
| `src/store.js` | JSON-file store: `posts/`, `raw/`, `status/`, `ledger.jsonl`, `media/` |
| `src/export.js` | Handoff records as JSON lines |
| `src/worker.js` | Processes Pages app requests in Actions and builds the public data folder |

## Rules kept from the design doc

* A field we couldn't get is `null`, never omitted.
* At most 50 comments, most-liked first; commenter usernames are dropped, including from raw payloads.
* Media is passed by storage key (`media/{shortcode}/{idx}.jpg|mp4`), never by Instagram CDN link.
* Null never overwrites data; manual input is never overwritten; each field records its source.

## Cost (Apify free plan, Nov 2026)

About $0.0027 per post, with roughly 10 recent comments included. Extra comments cost about
$0.0026 each. Spend is capped per run (`--budget`, default $1) and per month (`IG_MONTHLY_CAP_USD`,
default $5, Apify's free credit), and every Apify run is started with `maxTotalChargeUsd`.

## Known limits

* Instagram blocks logged-out scraping from cloud servers quickly, so the free open-source route
  (Instaloader, Python) was dropped; Apify is the scraper.
* `author.is_business` and location coordinates are not in Apify's post output; they stay `null`.
* Node's built-in `fetch` ignores `HTTPS_PROXY`. Behind a proxy, run with `NODE_USE_ENV_PROXY=1` (Node 22.21+).
