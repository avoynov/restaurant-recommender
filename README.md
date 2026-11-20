# Restaurant recommender

An app that builds taste profiles from friends' Instagram, TikTok, Facebook and Google Maps saves, finds where friends'
tastes overlap, and recommends restaurants.

| Folder | What it is | Status |
|---|---|---|
| [`ingestion/`](ingestion/) | Fetches public Instagram, TikTok and Facebook posts and Google Maps places or shared lists, and stores normalized records (caption, comments or reviews, location or place details, media) for the dataset-population step | Working prototype |
| [`site/`](site/) | GitHub Pages app: share a link from any of the four platforms, count and scrape an Instagram profile, upload a platform's data export of saved items, browse saved posts with photos and videos served from our own copy | Prototype |
| [`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) | Runs the scraper in GitHub Actions when the app sends a request, saves results to the `data` branch, publishes Pages | Prototype |

## How the Pages app works

1. The app saves a request file to `requests/` using your GitHub token (kept in your browser only).
2. That push starts the **Ingest and publish** workflow. It scrapes through Apify, downloads photos and
   videos, and commits the database, statuses and media to the `data` branch.
3. The workflow publishes the site plus the saved data to GitHub Pages. The app shows the post with
   media served from the published copy, not from the platform.

**Install it like an app.** The site is a Progressive Web App. On Android (Chrome), install it and
"Taste" appears in the Share menu of Instagram, TikTok, Facebook and Google Maps; sharing a link fetches it straight away. On iPhone, add it
to the Home Screen and use the "Send to Taste" Shortcut described on the page (iPhone web apps can't
join the share menu).

**Everything on Pages is public** (the repository is public). Use it for testing with posts you are
comfortable re-showing.

## One-time setup

1. **Apify token as a repository secret:** Settings → Secrets and variables → Actions → New repository
   secret, name `APIFY_TOKEN`.
2. **Pages from Actions:** Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. **A token for the app:** create a [fine-grained token](https://github.com/settings/personal-access-tokens/new)
   with access to this repository only and **Contents: Read and write**. Paste it into the app's
   "Access key" box.

Spend guard: Apify spend is capped at $5 a month by default (repository variable `IG_MONTHLY_CAP_USD`).

## Platforms

| Platform | What can be shared | Apify actor | About |
|---|---|---|---|
| Instagram | posts, reels, public profiles | apify/instagram-scraper | $0.0027 per post |
| TikTok | videos, photo slideshows, short links | clockworks/tiktok-scraper | $0.004 per video, $0.0013 per comment |
| Facebook | public page posts and reels | apify/facebook-posts-scraper (+ comments scraper) | $0.005 per post, $0.0025 per comment |
| Google Maps | places, public shared lists, short links | maximedupre/google-maps-shared-list-scraper (Compass as fallback) | $0.001 per place with photos |

Private lists, friends-only posts and in-app favourites can't be read logged out: upload the
platform's data export in the Collection tab instead (read in the browser; only links are sent).
Records use schema 1.1: `platform`, `platform_id`, and for places a `place` block; keys are
prefixed `tt_`, `fb_`, `gm_` outside Instagram.

Design: Instagram ingestion design doc, plain-English playbook, and the multi-platform plan (linked in the project).
