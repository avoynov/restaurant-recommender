# Restaurant recommender

An app that builds taste profiles from friends' Instagram activity, finds where friends'
tastes overlap, and recommends restaurants.

| Folder | What it is | Status |
|---|---|---|
| [`ingestion/`](ingestion/) | Fetches public Instagram posts for handles or post links and stores normalized records (caption, comments, location, media) for the dataset-population step | Working prototype |
| [`site/`](site/) | GitHub Pages app: share a post link, count and scrape a profile or a saved collection, browse saved posts with photos and videos served from our own copy | Prototype |
| [`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) | Runs the scraper in GitHub Actions when the app sends a request, saves results to the `data` branch, publishes Pages | Prototype |

## How the Pages app works

1. The app saves a request file to `requests/` using your GitHub token (kept in your browser only).
2. That push starts the **Ingest and publish** workflow. It scrapes through Apify, downloads photos and
   videos, and commits the database, statuses and media to the `data` branch.
3. The workflow publishes the site plus the saved data to GitHub Pages. The app shows the post with
   media served from the published copy, not from Instagram.

**Install it like an app.** The site is a Progressive Web App. On Android (Chrome), install it and
"Taste" appears in Instagram's Share menu; sharing a post fetches it straight away. On iPhone, add it
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

Design: Instagram ingestion design doc and plain-English playbook (linked in the project).
