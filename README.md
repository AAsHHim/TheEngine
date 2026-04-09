# TheEngine

A self-crawling web search engine: Playwright crawler, SQLite inverted index, TF-based ranking with PageRank-lite and freshness bonuses, and a vanilla HTML/CSS/JS frontend.

## GitHub Codespaces

1. Open the repo in a Codespace (or clone locally).
2. Run `npm install` and `npx playwright install chromium --with-deps` (the devcontainer runs this on create).
3. `npm start` — the app listens on **port 3000** (`PORT` in `.env`).

## Environment

Copy `.env.example` to `.env`. Variables:

- `PORT` — HTTP port (default `3000`).
- `CRAWL_INTERVAL_MS` — delay between scheduler crawl batches in ms (default `5000`).
- `AUTO_CRAWL` — `true` starts the background crawler on boot and seeds the default queue; `false` (default) leaves crawling off until you use the UI (**Auto crawl**), **Add to queue** + **Run batch**, or the API. Restarting the server re-applies `.env`: if `AUTO_CRAWL=true`, auto mode turns on again on boot; the UI toggle only affects the running process until you change `.env` or restart without that flag.
- `CRAWL_FETCH_MODE` — `playwright` (default) uses headless Chromium so client-rendered pages can be indexed; `http` uses plain HTTP + Cheerio only (no browser install, but many JavaScript-heavy pages will look empty in the index).

## Why Chromium?

The crawler is “its own” indexer and ranker, but **fetching** a modern URL is often not just downloading HTML: many sites ship an empty shell and fill content with JavaScript. Playwright runs a real browser so those pages get real text and links. If you prefer a self-contained setup without a browser binary, set `CRAWL_FETCH_MODE=http` and accept weaker results on JS-heavy sites.

## Robots.txt

If `robots.txt` cannot be fetched or parsed, crawling that host is **disallowed** (conservative default) to avoid accidental aggressive crawling.

## API

- `GET /` — Search UI
- `GET /search?q=...&limit=20` — JSON results
- `GET /suggest?q=...` — Title autocomplete
- `GET /stats` — Index and queue stats
- `GET /crawl/status` — Crawler status
- `POST /crawl/seed` — Re-seed default URLs into the queue
