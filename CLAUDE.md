# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MTG card price watcher (Japanese printings) on GitHub Pages at
https://paludancode.github.io/MTG-Pricerunner/. Two sources: CardTrader (official API) and
Cardmarket (scraped via Firecrawl). Two decoupled workflows:

- `.github/workflows/update.yml` ("Deploy site") publishes to Pages **only on push to `main`** (UI/source changes).
- `.github/workflows/update-data.yml` ("Update card data") runs on a `2-57/5` cron (GitHub best-effort; empirically fires every few hours, not every 5 min) and force-pushes `data.json` as a **single orphan commit to the `data` branch**. The Pages-hosted page fetches it from `raw.githubusercontent.com/.../data/data.json` — fresh data needs no deploy. The `data` branch is a build artifact: never branch from it or PR into it. In practice the cadence comes from a live cron-job.org pinger hitting the workflow's `workflow_dispatch` endpoint every 2 min — see `docs/external-pinger.md`; the in-repo cron is only a fallback.

(A local Node watcher used to live in `local/`; it was removed in 03c49ae — see git
history if it ever needs resurrecting. Cardmarket support came back afterwards, in the
cloud pipeline, via Firecrawl.)

## Commands

```bash
# UI smoke test — REQUIRED after any UI change. Renders at 320/390/1440 px,
# writes cloud/shot-*.png, exits non-zero on horizontal overflow or empty grid.
# Uses cloud/web/data.json if present, else cloud/fixture-data.json.
node cloud/verify-mobile.js

# Build cloud data locally. CARDTRADER_TOKEN is required; without FIRECRAWL_API_KEY
# the Cardmarket cards are skipped (CardTrader still builds). --prev is optional and
# only matters for the Cardmarket TTL — see below.
CARDTRADER_TOKEN=... FIRECRAWL_API_KEY=... node cloud/build-data.js [--prev old-data.json]

# Unit tests (node:test, zero deps) — config normalization
npm test
# Single test file
node --test test/cards.test.js

# Syntax-check everything (same as CI)
for f in $(git ls-files '*.js'); do node --check "$f"; done
```

No build step. CI (`.github/workflows/ci.yml`, job `checks`) = syntax check + unit tests + the smoke test above.

## Workflow rules (non-negotiable)

- **Never push to `main` directly.** Branch (`feat/...` / `fix/...`) → PR → wait for the `checks` job → merge. Merging to `main` *is* the release: the deploy workflow publishes to Pages on push. Admin rights bypass the protection — don't use that.
- Dependabot opens weekly grouped PRs (actions + npm). They follow the normal PR flow: merge when `checks` is green.

## Architecture

- `shared/render.js` — `CardUI.renderGrid(data, opts)` renders the offer grid.
- `shared/app.js` — page bootstrap (fetch loop, status line). The page configures it with `window.DASH = { url, intervalMs }`. The `url` is hostname-conditional: the raw `data`-branch URL on `github.io`, relative `data.json` on localhost (keeps `verify-mobile.js` offline).
- `shared/ui.css` — **the base rules are the desktop design and must not change visually.** All phone/tablet adaptation lives in `@media (max-width: ...)` blocks (1100px → 2 grid cols, 700px → 1, 480px → compact, Set column shows the official set code instead of the full variant name).
- `shared/cards.js` — `normalizeCards(config)` turns the paste-a-URL `config.json` entries into product objects (site, blueprintId, language defaulting). The fetchers consume it.
- `cloud/build-data.js` — **the entry point.** Splits the normalized products by `site`, runs each fetcher, and writes the merged `cloud/web/data.json` in config order. `cloud/fetch-cardtrader.js` and `cloud/fetch-cardmarket.js` are modules (`fetchAll(products, opts)`), not scripts — don't run them directly.
- `cloud/cardmarket-parse.js` — pure HTML → offers (regex over `id="articleRow<N>"` blocks) plus `looksBlocked()`. Kept separate from the fetcher so it is unit-testable with no network.
- The deploy workflow `cp`s `shared/` files into `cloud/web/`. Copies inside `cloud/web/` (`ui.css`, `render.js`, `app.js`, `data.json`) are build artifacts and gitignored.

Data shape contract (produced by `cloud/build-data.js`, consumed by `render.js`): `{ updatedAt, results: [{ site, group, variant, code, productUrl, error?, fetchedAt?, offers: [{ price, priceStr, foil, condition, qty, seller, shipsToMe }] }] }`. `site` is `"cardtrader"` or `"cardmarket"` and drives the `Src` column (CT/CM); `fetchedAt` is set on Cardmarket results only and drives the TTL. Offers are merged per `group` and sorted by price client-side. `code` is the official Scryfall set code from `config.json`, shown instead of `variant` on phones; `render.js` falls back to `variant` when it's missing (data.json predating the field).

## Cardmarket / Firecrawl

- **Cloudflare is why Firecrawl exists here.** Cardmarket 403s plain fetches from a datacentre IP. The old local watcher drove a signed-in Chrome over CDP; that's impossible in Actions, so `fetch-cardmarket.js` POSTs `api.firecrawl.dev/v2/scrape` (key in the `FIRECRAWL_API_KEY` repo secret) and parses the HTML it returns. Request must stay `formats: ["rawHtml"]` (the cleaned `html` format drops the ids/classes the parser matches), `onlyMainContent: false`, `maxAge: 0` (v2 otherwise serves a cached page — fatal for prices) and `proxy: "auto"` (falls back to the stealth proxy when Cloudflare bites).
- **Credits, not rate limits, are the constraint.** The workflow runs every ~2 min; one scrape per card per run would drain a plan in hours. Every Cardmarket result carries `fetchedAt` and is reused from the previous `data.json` until it ages past `config.cardmarketTtlMinutes` (default 360). The workflow reads that previous file off the `data` branch (`git show FETCH_HEAD:data.json`, not raw.githubusercontent — a CDN-stale copy would cause needless re-scrapes) and passes it as `--prev`. Budget: `cards × 1440 / ttlMinutes` scrapes/day.
- **A blocked scrape looks like a successful one.** Cloudflare's interstitial is a 200 with a plausible body, so "0 offers" can't distinguish it from an out-of-stock card — hence `looksBlocked()`. On any failure the previous offers are carried forward with the *old* `fetchedAt`, so the card keeps its prices and the next run retries instead of treating the failure as fresh.
- **Cardmarket language filtering is URL-only** (`?language=7` = Japanese); the offer HTML doesn't expose it, so `offer.language` is always null there. A config test enforces the query parameter.
- `shipsToMe` is always null (renders `?`) for Cardmarket: it's only knowable when logged in, and the scrape is a guest session.

## Hard-won gotchas

- **CardTrader geo-filter:** the public website JSON (`/en/cards/<id>.json`) only returns offers shippable to the requester's IP country. That's why the fetcher uses the authenticated official API (`api.cardtrader.com/api/v2/marketplace/products?blueprint_id=`, bearer token in the `CARDTRADER_TOKEN` repo secret) — full list, no pagination. Don't "simplify" it back to the website JSON.
- **Hiding table columns:** the tables use `table-layout: fixed` with class-based `<col>` widths (`col.c-price` etc., emitted by `render.js`). To hide a column responsively, set its `col` width to 0 and its cells' padding to 0 — `display: none` on cells shifts later cells into the wrong columns.
- `shipsToMe` = CardTrader Zero (hub) eligibility on CardTrader rows; always null on Cardmarket rows.
- **Only `c-seller` flexes.** The `<col>` percentages don't sum to 100 and Seller has no explicit width, so it absorbs the remainder — adding or widening any other column shrinks Seller and nothing else.
- `gh` lives at `C:\Program Files\GitHub CLI\gh.exe` — shells opened before its install don't have it on PATH.
- **UI changes take up to ~20 min to appear on phones after merging.** GitHub Pages serves everything with `Cache-Control: max-age=600` and a deploy doesn't purge the CDN: an edge that re-caches the old files right after the deploy serves them for another 10 min, and the browser then caches *that* copy for 10 more. The deploy workflow stamps `?v=<commit SHA>` onto the JS/CSS links in `index.html` (CDN caches by full URL), so HTML and assets can never mismatch — but `index.html` itself is still cached, so the window applies to the page as a whole. On top of that, an already-open tab **never** picks up new UI — `app.js` only refetches `data.json`, so the header timestamp stays fresh while HTML/JS/CSS stay stale. Before debugging a "deploy didn't work" report: check the Deploy run's commit, wait out the cache window, and test in a private tab (separate cache). `data.json` is unaffected (different URL, `raw.githubusercontent.com`, max-age=300).
