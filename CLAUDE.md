# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MTG card price watcher (Japanese printings) with two deployments sharing one UI:

- **Local watcher** (`local/`): Node server on `http://localhost:8787` that scrapes CardTrader (public website JSON) and Cardmarket (via the user's own Chrome over CDP on port 9222, to ride an already-cleared Cloudflare session). Started with `local\start-watcher.cmd`, usually already running in the background.
- **Cloud site** (`cloud/`): GitHub Pages at https://paludancode.github.io/MTG-Pricerunner/. CardTrader only. Two decoupled workflows:
  - `.github/workflows/update.yml` ("Deploy site") publishes to Pages **only on push to `main`** (UI/source changes).
  - `.github/workflows/update-data.yml` ("Update card data") runs on a `2-57/5` cron (GitHub best-effort; empirically fires every few hours, not every 5 min) and force-pushes `data.json` as a **single orphan commit to the `data` branch**. The Pages-hosted page fetches it from `raw.githubusercontent.com/.../data/data.json` — fresh data needs no deploy. The `data` branch is a build artifact: never branch from it or PR into it. In practice the cadence comes from a live cron-job.org pinger hitting the workflow's `workflow_dispatch` endpoint every 2 min — see `docs/external-pinger.md`; the in-repo cron is only a fallback.

## Commands

```bash
# UI smoke test — REQUIRED after any UI change. Renders at 320/390/1440 px,
# writes cloud/shot-*.png, exits non-zero on horizontal overflow or empty grid.
# Uses cloud/web/data.json if present, else cloud/fixture-data.json.
node cloud/verify-mobile.js

# Build cloud data locally (needs the CardTrader API token in env)
CARDTRADER_TOKEN=... node cloud/fetch-cardtrader.js

# Unit tests (node:test, zero deps) — config normalization + Cardmarket HTML parser
npm test
# Single test file
node --test test/cards.test.js

# Syntax-check everything (same as CI)
for f in $(git ls-files '*.js'); do node --check "$f"; done
```

No build step. CI (`.github/workflows/ci.yml`, job `checks`) = syntax check + unit tests + the smoke test above.

## Workflow rules (non-negotiable)

- **Never push to `main` directly.** Branch (`feat/...` / `fix/...`) → PR → wait for the `checks` job → merge. Merging to `main` *is* the release: the deploy workflow publishes to Pages on push. Admin rights bypass the protection — don't use that.
- **Never run `local/stop-watcher.cmd` from a session** — it force-kills *every* `node.exe` on the machine (including Claude Code's own tooling). To restart the watcher, kill only the PID listening on port 8787, then `Start-Process node -ArgumentList 'server.js' -WorkingDirectory local -WindowStyle Hidden`.
- After changing `local/server.js`, the running watcher must be restarted the same way to pick it up.
- Dependabot opens weekly grouped PRs (actions + npm). They follow the normal PR flow: merge when `checks` is green.

## Architecture

One UI, two data plumbings — keep it that way:

- `shared/render.js` — `CardUI.renderGrid(data, opts)` renders the offer grid; also highlights new offers (and floats their groups to the top) via the `seen` set. Groups with more than 10 offers collapse the tail behind a per-card "Show more" toggle (state survives refetch re-renders).
- `shared/app.js` — page bootstrap (fetch loop, status line). Pages configure it with `window.DASH = { url, intervalMs, showSrc? }` — that one line is the *only* intended difference between `local/index.html` and `cloud/web/index.html`. The cloud page's `url` is hostname-conditional: the raw `data`-branch URL on `github.io`, relative `data.json` on localhost (keeps `verify-mobile.js` offline).
- `shared/ui.css` — **the base rules are the desktop design and must not change visually.** All phone/tablet adaptation lives in `@media (max-width: ...)` blocks (1100px → 2 grid cols, 700px → 1, 480px → compact, Src column collapsed, Set column shows the official set code instead of the full variant name).
- `shared/cards.js` — `normalizeCards(config)` turns the paste-a-URL `config.json` entries into product objects (site, blueprintId, language defaulting). Both fetchers and the local server consume it.
- The local server serves `shared/` files via routes; the deploy workflow `cp`s them into `cloud/web/`. Copies inside `cloud/web/` (`ui.css`, `render.js`, `app.js`, `data.json`) are build artifacts and gitignored.

Data shape contract (produced by both `local/server.js` and `cloud/fetch-cardtrader.js`, consumed by `render.js`): `{ updatedAt, results: [{ site, group, variant, code, productUrl, error?, offers: [{ price, priceStr, foil, condition, qty, seller, shipsToMe }] }] }`. Offers are merged per `group` and sorted by price client-side. `code` is the official Scryfall set code from `config.json`, shown instead of `variant` on phones; `render.js` falls back to `variant` when it's missing (data.json predating the field).

## Hard-won gotchas

- **CardTrader geo-filter:** the public website JSON (`/en/cards/<id>.json`) only returns offers shippable to the requester's IP country. That's why the cloud fetcher uses the authenticated official API (`api.cardtrader.com/api/v2/marketplace/products?blueprint_id=`, bearer token in the `CARDTRADER_TOKEN` repo secret) — full list, no pagination. Don't "simplify" it back to the website JSON.
- **Hiding table columns:** the tables use `table-layout: fixed` with class-based `<col>` widths (`col.c-price` etc., emitted by `render.js`). To hide a column responsively, set its `col` width to 0 and its cells' padding to 0 — `display: none` on cells shifts later cells into the wrong columns.
- `shipsToMe` means different things per site: CardTrader = CardTrader Zero (hub) eligibility; Cardmarket = actually ships to the logged-in user's country (null when logged out).
- Cardmarket fetching modes (`config.json` → `cardmarketFetch`): `cdp` (default, scrape via user's Chrome), `curl` (works until Cloudflare rate-limits), `off`. Details in the comments in `local/server.js`.
- `gh` lives at `C:\Program Files\GitHub CLI\gh.exe` — shells opened before its install don't have it on PATH.
- **UI changes take up to ~20 min to appear on phones after merging.** GitHub Pages serves everything with `Cache-Control: max-age=600` and a deploy doesn't purge the CDN: an edge that re-caches the old files right after the deploy serves them for another 10 min, and the browser then caches *that* copy for 10 more. On top of that, an already-open tab **never** picks up new UI — `app.js` only refetches `data.json`, so the header timestamp stays fresh while HTML/JS/CSS stay stale. Before debugging a "deploy didn't work" report: check the Deploy run's commit, wait out the cache window, and test in a private tab (separate cache). `data.json` is unaffected (different URL, `raw.githubusercontent.com`, max-age=300).
