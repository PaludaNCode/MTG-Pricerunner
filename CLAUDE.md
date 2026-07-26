# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MTG card price watcher (Japanese printings) on GitHub Pages at
https://paludancode.github.io/MTG-Pricerunner/. CardTrader only. Two decoupled workflows:

- `.github/workflows/update.yml` ("Deploy site") publishes to Pages **only on push to `main`** (UI/source changes).
- `.github/workflows/update-data.yml` ("Update card data") runs on a `2-57/5` cron (GitHub best-effort; empirically fires every few hours, not every 5 min) and force-pushes `data.json` as a **single orphan commit to the `data` branch**. The Pages-hosted page fetches it from `raw.githubusercontent.com/.../data/data.json` — fresh data needs no deploy. The `data` branch is a build artifact: never branch from it or PR into it. In practice the cadence comes from a live cron-job.org pinger hitting the workflow's `workflow_dispatch` endpoint every 2 min — see `docs/external-pinger.md`; the in-repo cron is only a fallback.

(A local Node watcher that also scraped Cardmarket used to live in `local/`; it was
removed — see git history if it ever needs resurrecting.)

**Cardmarket is read client-side by the user's own browser**, via the unpacked Chrome
extension in `extension/` — no server can get past its Cloudflare protection. The server
emits paused Cardmarket rows and the page fills them in. See
`docs/cardmarket-extension.md`.

There is also a **fully-Azure deployment** (`azure/`, `docs/azure-hosting.md`): one Storage
Account static website serving both the site and `data.json`, refreshed by a Function App
timer trigger. It removes the `data` branch, the external cron pinger, and the ~20 min
phone-cache window. It is **not** wired to auto-deploy —
`.github/workflows/azure-deploy.yml` is `workflow_dispatch`-only on purpose, so merging to
`main` never deploys Azure.

## Commands

```bash
# UI smoke test — REQUIRED after any UI change. Renders at 320/390/1440 px,
# writes cloud/shot-*.png, exits non-zero on horizontal overflow or empty grid.
# Uses cloud/web/data.json if present, else cloud/fixture-data.json.
node cloud/verify-mobile.js

# Build cloud data locally (needs the CardTrader API token in env)
CARDTRADER_TOKEN=... node cloud/fetch-cardtrader.js

# Can we reach Cardmarket at all? Reports "blocked by Cloudflare" vs "reached the
# page but parsed nothing", so a transport failure is never mistaken for a parser bug.
node cloud/probe-cardmarket.js direct

# Unit tests (node:test, zero deps) — config normalization, Cardmarket parser,
# cross-site orchestration, Azure staging layout
npm test

# The Cardmarket browser path, end-to-end in a real browser against a STUBBED extension
# bridge (parsing, challenge detection, cache, graceful degradation). Needs no Cardmarket
# session — this is the test to run after touching shared/cardmarket-{parse,client}.js.
node --test test/cardmarket-client.browser.test.js
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
- `shared/app.js` — page bootstrap (fetch loop, status line). The page configures it with `window.DASH = { url, intervalMs }`. The `url` is hostname-conditional: the raw `data`-branch URL on `github.io`, relative `data.json` on localhost (keeps `verify-mobile.js` offline). It renders CardTrader immediately, then fills Cardmarket rows via the extension if present — Cardmarket must never delay the data already in hand.
- `shared/cardmarket-parse.js` — the offer-row parser, **UMD: loaded both in the browser and by Node** (`cloud/cardmarket-core.js`), so there is one copy of the selectors. Also exports `looksChallenged` / `looksLoggedOut` so a Cloudflare interstitial is never reported as "no offers".
- `shared/cardmarket-client.js` — browser side of the extension bridge: `detect()` + `fillOffers()`. Owns the rate limiting (15 min `sessionStorage` cache, 2s gap, sequential) — **don't lower those**, the dashboard polls every 60s and Cardmarket must not be hit on that cadence.
- `extension/` — unpacked Chrome extension (MV3): `background.js` fetches (host-allowlisted to cardmarket.com so it can't become a credentialed proxy), `bridge.js` relays via `postMessage` and is injected only into the dashboard's own origins. No parsing, no storage, no remote code.
- `shared/ui.css` — **the base rules are the desktop design and must not change visually.** All phone/tablet adaptation lives in `@media (max-width: ...)` blocks (1100px → 2 grid cols, 700px → 1, 480px → compact, Set column shows the official set code instead of the full variant name).
- `shared/cards.js` — `normalizeCards(config)` turns the paste-a-URL `config.json` entries into product objects (site, blueprintId, language defaulting). Both fetchers consume it. Cardmarket URLs normalize fine; whether they can be *fetched* is a separate question owned by `cloud/cardmarket-core.js`.
- The deploy workflow `cp`s `shared/` files into `cloud/web/`. Copies inside `cloud/web/` (`ui.css`, `render.js`, `app.js`, `data.json`) are build artifacts and gitignored.

Data-side modules — **node-only, deliberately not in `shared/`** (everything in `shared/` is copied into the browser bundle):

- `cloud/build-data.js` — `buildData({ config, token, log })`: the one entry point both publishers use, so GitHub Actions and the Azure timer emit byte-identical data. Dispatches per site, returns results in **config order**, and throws when every non-paused card errored (so a total outage leaves the last good `data.json` in place; a partial failure still publishes).
- `cloud/cardtrader-core.js` — CardTrader API fetching + FX conversion to EUR.
- `cloud/cardmarket-core.js` — the HTML parser (works) plus a **pluggable transport**: `off` (default) | `direct` | `proxy`. See the Cardmarket gotcha below.
- `azure/functions/` mirrors the repo's directory layout at deploy time (`config.json`, `shared/cards.js`, `cloud/*.js` copied in) so those relative requires resolve unchanged. `test/azure-staging.test.js` runs the workflow's real `cp` lines and requires `build-data` out of the result, so the copy list can't drift from the require graph.

Data shape contract (produced by `cloud/build-data.js`, consumed by `render.js`): `{ updatedAt, results: [{ site, group, variant, code, productUrl, error?, offers: [{ price, priceStr, foil, condition, qty, seller, shipsToMe }] }] }`. Offers are merged per `group` and sorted by price client-side. `code` is the official Scryfall set code from `config.json`, shown instead of `variant` on phones; `render.js` falls back to `variant` when it's missing (data.json predating the field).

## Hard-won gotchas

- **CardTrader geo-filter:** the public website JSON (`/en/cards/<id>.json`) only returns offers shippable to the requester's IP country. That's why the fetcher uses the authenticated official API (`api.cardtrader.com/api/v2/marketplace/products?blueprint_id=`, bearer token in the `CARDTRADER_TOKEN` repo secret) — full list, no pagination. Don't "simplify" it back to the website JSON.
- **Hiding table columns:** the tables use `table-layout: fixed` with class-based `<col>` widths (`col.c-price` etc., emitted by `render.js`). To hide a column responsively, set its `col` width to 0 and its cells' padding to 0 — `display: none` on cells shifts later cells into the wrong columns.
- `shipsToMe` = CardTrader Zero (hub) eligibility. (On Cardmarket it meant something different: actually ships to the logged-in user's country, `null` when logged out.)
- **Cardmarket is blocked by automation detection, not by hosting — so it's read in the browser.** Measured 2026-07-26 against a real product page: plain `curl` → `403 Just a moment`; headless Chrome → `403 Attention Required`; **headed** Chrome with a fresh profile → `403 Just a moment` — all three from a residential IP. The retired `cdp` mode worked only because it borrowed a long-lived Chrome profile that already held a `cf_clearance` cookie, and that cookie is bound to the IP + TLS fingerprint + User-Agent that solved the challenge, so it can't be exported to a server. Moving to Azure does **not** get Cardmarket back, and neither does a headless browser or a VM. Don't re-litigate without re-running `node cloud/probe-cardmarket.js direct` first. Price aggregators (Scryfall `prices.eur`, MTGJSON) reach Azure fine but are 24h-synced trend/average figures, not live listings — rejected. A scraper VM was designed and rejected on cost/benefit (~$36–52/mo, plus an unvalidated re-challenge cadence that could mean manual re-warming several times a day). The answer is `extension/`: `docs/cardmarket-extension.md`.
- **The dashboard can't read Cardmarket without the extension, and Cloudflare isn't even the first reason.** Cardmarket sends no `Access-Control-Allow-Origin` (so a page `fetch()` may issue the request but can't read the response) and `X-Frame-Options: SAMEORIGIN` (so an `<iframe>`'s DOM is unreadable). Both are browser-enforced and unfixable from page JS. An extension with host permissions is exempt from CORS and its fetches carry the user's real cookies/IP — which is why that's the only client-side design that works. Don't "simplify" the extension away into a page `fetch()`.
- `gh` lives at `C:\Program Files\GitHub CLI\gh.exe` — shells opened before its install don't have it on PATH.
- **UI changes take up to ~20 min to appear on phones after merging.** GitHub Pages serves everything with `Cache-Control: max-age=600` and a deploy doesn't purge the CDN: an edge that re-caches the old files right after the deploy serves them for another 10 min, and the browser then caches *that* copy for 10 more. The deploy workflow stamps `?v=<commit SHA>` onto the JS/CSS links in `index.html` (CDN caches by full URL), so HTML and assets can never mismatch — but `index.html` itself is still cached, so the window applies to the page as a whole. On top of that, an already-open tab **never** picks up new UI — `app.js` only refetches `data.json`, so the header timestamp stays fresh while HTML/JS/CSS stay stale. Before debugging a "deploy didn't work" report: check the Deploy run's commit, wait out the cache window, and test in a private tab (separate cache). `data.json` is unaffected (different URL, `raw.githubusercontent.com`, max-age=300).
