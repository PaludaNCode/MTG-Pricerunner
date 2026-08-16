# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MTG card price watcher (Japanese printings) on GitHub Pages at
https://paludancode.github.io/MTG-Pricerunner/. Two sources: CardTrader (official API) and
Cardmarket (scraped via Firecrawl). **Three** decoupled workflows, and the page merges two
independent feeds:

- `.github/workflows/update.yml` ("Deploy site") publishes to Pages **only on push to `main`** (UI/source changes).
- `.github/workflows/update-cardmarket.yml` ("Update Cardmarket data") runs hourly (`17 * * * *`) and force-pushes `cardmarket.json` as a single orphan commit to the **`data-cm` branch**. Separate from the data workflow on purpose — see the Cardmarket section. Hourly is a *ceiling*: the fetcher decides per wake how many cards the credit allowance can afford, and most wakes scrape nothing. `concurrency.cancel-in-progress` is deliberately **false** here (unlike the data workflow): a cancelled run may have spent credits without recording them.
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

# Build the CardTrader feed locally (cloud/web/data.json)
CARDTRADER_TOKEN=... node cloud/build-data.js

# Build the Cardmarket feed locally (cloud/web/cardmarket.json). SPENDS REAL CREDITS.
# --prev is the previous cardmarket.json: without it the budget ledger restarts and
# every card looks stale, so always pass it if you have one.
FIRECRAWL_API_KEY=... node cloud/build-cardmarket.js [--prev old-cardmarket.json]

# Unit tests (node:test, zero deps) — config normalization
npm test
# Single test file
node --test test/cards.test.js

# Refresh-button behaviour (browser; every api.github.com call is stubbed)
node cloud/verify-refresh.js

# Syntax-check everything (same as CI)
for f in $(git ls-files '*.js'); do node --check "$f"; done
```

No build step. CI (`.github/workflows/ci.yml`, job `checks`) = syntax check + unit tests + both browser checks above.

## Workflow rules (non-negotiable)

- **Never push to `main` directly.** Branch (`feat/...` / `fix/...`) → PR → wait for the `checks` job → merge. Merging to `main` *is* the release: the deploy workflow publishes to Pages on push. Admin rights bypass the protection — don't use that.
- Dependabot opens weekly grouped PRs (actions + npm). They follow the normal PR flow: merge when `checks` is green.

## Architecture

- `shared/render.js` — `CardUI.renderGrid(data, opts)` renders the offer grid.
- `shared/app.js` — page bootstrap (fetch loop, status line). The page configures it with `window.DASH = { url, cmUrl, intervalMs }` and app.js **merges the two feeds** into one `results` array before rendering. Both URLs are hostname-conditional: raw `data`/`data-cm` branch URLs on `github.io`, relative paths on localhost (keeps `verify-mobile.js` offline). The Cardmarket fetch is wrapped in a `.catch(() => null)` — the `data-cm` branch may not exist yet, and a failed scrape must never take the page down. The status line shows CardTrader's timestamp plus a `CM <age>` suffix, because the Cardmarket snapshot legitimately lags by hours.
- **The "↻ CM" button lives in `app.js`, deliberately not its own file.** The deploy workflow stamps exactly four asset URLs with the commit SHA and `test/deploy-stamp.test.js` asserts that count, so a fifth script would mean touching the workflow, the sed guard and that test. It triggers `update-cardmarket.yml` via `workflow_dispatch` with `force: "true"`. The PAT is typed into the `#cm-token` field (shown automatically when no token is stored, reopened by the `⚿` toggle) and kept in `localStorage` under `mtg-pricerunner.gh-token` — **never put a token in the page**, the site is public and that PAT can spend real credits. A 401/403 clears the stored token so the next click re-prompts. `cloud/verify-refresh.js` pins all of this in a real browser with the GitHub calls stubbed.
- `shared/ui.css` — **the base rules are the desktop design and must not change visually.** All phone/tablet adaptation lives in `@media (max-width: ...)` blocks (1100px → 2 grid cols, 700px → 1, 480px → compact, Set column shows the official set code instead of the full variant name).
- `shared/cards.js` — `normalizeCards(config)` turns the paste-a-URL `config.json` entries into product objects (site, blueprintId, language defaulting). The fetchers consume it.
- **Two entry points, one per source.** `cloud/build-data.js` (CardTrader → `cloud/web/data.json`, stateless) and `cloud/build-cardmarket.js` (Cardmarket → `cloud/web/cardmarket.json`, carries the credit ledger). `cloud/fetch-cardtrader.js` and `cloud/fetch-cardmarket.js` are modules (`fetchAll(products, opts)`), not scripts — don't run them directly. Don't merge the two entry points back together: one writer per file is what keeps the 2-min job from clobbering the hourly job's ledger.
- `cloud/cardmarket-parse.js` — pure HTML → offers (regex over `id="articleRow<N>"` blocks) plus `looksBlocked()`. Kept separate from the fetcher so it is unit-testable with no network.
- The deploy workflow `cp`s `shared/` files into `cloud/web/`. Copies inside `cloud/web/` (`ui.css`, `render.js`, `app.js`, `data.json`) are build artifacts and gitignored.

Data shape contract (both feeds, consumed by `render.js` after app.js concatenates their `results`): `{ updatedAt, meta?, results: [{ site, group, variant, code, productUrl, error?, fetchedAt?, offers: [{ price, priceStr, foil, condition, qty, seller, shipsToMe }] }] }`. `site` is `"cardtrader"` or `"cardmarket"` and drives the `Src` column (CT/CM); `fetchedAt` is set on Cardmarket results only and drives the TTL. `meta` appears only in `cardmarket.json` and is bookkeeping (`{ day, scrapes, credits, costPerScrape }`) — `render.js` ignores it. Offers are merged per `group` and sorted by price client-side. `code` is the official Scryfall set code from `config.json`, shown instead of `variant` on phones; `render.js` falls back to `variant` when it's missing (data.json predating the field).

## Cardmarket / Firecrawl

- **Cloudflare is why Firecrawl exists here.** Cardmarket 403s plain fetches from a datacentre IP. The old local watcher drove a signed-in Chrome over CDP; that's impossible in Actions, so `fetch-cardmarket.js` POSTs `api.firecrawl.dev/v2/scrape` (key in the `FIRECRAWL_API_KEY` repo secret) and parses the HTML it returns. Request must stay `formats: ["rawHtml"]` (the cleaned `html` format drops the ids/classes the parser matches), `onlyMainContent: false`, `maxAge: 0` (v2 otherwise serves a cached page — fatal for prices) and `proxy: "auto"` (falls back to the stealth proxy when Cloudflare bites).
- **The budget is in credits, not scrapes, and that is not incidental.** `proxy: "auto"` escalates to the stealth proxy silently, and stealth bills several credits instead of one. A scrape-counted budget would therefore under-spend the plan by ~5x or overrun it by ~5x depending on which way we guessed. Instead: read the balance, spend against `(remaining − cardmarketMinCredits) ÷ days left in period`, re-read the balance, book the measured delta, and smooth it into `meta.costPerScrape`. Don't "simplify" this back to counting scrapes.
- **The ledger lives in `cardmarket.json` under `meta`** (`{ day, scrapes, credits, costPerScrape }`) and round-trips via `--prev` off the `data-cm` branch; the day fields reset on the UTC boundary. Losing `--prev` restarts the day's allowance *and* makes every card look stale — that is a credit-burn event, which is precisely why Cardmarket got its own file and its own workflow instead of riding along in the 2-min job's `data.json`.
- **Deferral is stalest-first, and that matters.** When more cards are due than the allowance covers, `fetchAll` sorts the due list by `fetchedAt` ascending (never-fetched first) and takes the top N. Without that the first cards in `config.json` would eat the allowance every day and the tail would never refresh. A deferred card carries its old offers forward with **no** `error` field — it isn't a fault.
- **Don't count `fetchedAt`s to reconstruct spend.** A failed scrape costs a credit without updating any timestamp, so the explicit counter is the only honest tally.
- **A forced run (`CM_FORCE=true`, set by the site's button) ignores the TTL and the per-run limit, never the credit allowance.** `ttlMinutes: 0` already means "never reuse" in `isFresh`, so force is just that plus `perRunLimit = products.length`. Keep it that way: on-demand must not be able to outspend the plan, only to spend today's allowance sooner.
- **`meta` also publishes `remaining` and `allowance`** so the page can grey the button out when the day is spent. That puts the Firecrawl balance in a public file — benign (no credential), but deliberate rather than accidental.
- **`cardmarketTtlMinutes` is deliberately low (120).** It exists to stop pointless re-scrapes, not to pace spending — the credit allowance does that. Raising the TTL just leaves credits unspent.
- **A blocked scrape looks like a successful one.** Cloudflare's interstitial is a 200 with a plausible body, so "0 offers" can't distinguish it from an out-of-stock card — hence `looksBlocked()`. On any failure the previous offers are carried forward with the *old* `fetchedAt`, so the card keeps its prices and the next run retries.
- **Cardmarket has two page shapes and the all-versions one is much cheaper.** `/Magic/Cards/<Card-Name>` lists every printing's offers in one table; `/Magic/Products/Singles/<Set>/<Card>` lists one printing. CardTrader has no all-versions equivalent, which is why `config.json` carries one CardTrader URL per printing but should carry only one Cardmarket URL per card — 24 URLs cover all 41 printings. Such entries are flagged `allVersions: true` and carry no `code`; config tests enforce the flag in both directions, because an unflagged `/Magic/Cards/` URL would stamp one set onto offers from every printing.
- **On the all-versions page the set is a property of the offer, not the entry.** `cardmarket-parse.js` reads each row's `/Magic/Products/Singles/<Set>/…` link to get that row's set and a per-offer `productUrl`; single-product pages have no such link, so both come back null and `render.js` falls back to the entry's own `variant`/`code`. That fallback is what keeps both page shapes working through one code path — don't collapse it.
- **Cardmarket language filtering is URL-only** (`?language=7` = Japanese); the offer HTML doesn't expose it, so `offer.language` is always null there. A config test enforces the query parameter.
- `shipsToMe` is always null (renders `?`) for Cardmarket: it's only knowable when logged in, and the scrape is a guest session.

## Hard-won gotchas

- **CardTrader geo-filter:** the public website JSON (`/en/cards/<id>.json`) only returns offers shippable to the requester's IP country. That's why the fetcher uses the authenticated official API (`api.cardtrader.com/api/v2/marketplace/products?blueprint_id=`, bearer token in the `CARDTRADER_TOKEN` repo secret) — full list, no pagination. Don't "simplify" it back to the website JSON.
- **Hiding table columns:** the tables use `table-layout: fixed` with class-based `<col>` widths (`col.c-price` etc., emitted by `render.js`). To hide a column responsively, set its `col` width to 0 and its cells' padding to 0 — `display: none` on cells shifts later cells into the wrong columns.
- `shipsToMe` = CardTrader Zero (hub) eligibility on CardTrader rows; always null on Cardmarket rows.
- **Only `c-seller` flexes.** The `<col>` percentages don't sum to 100 and Seller has no explicit width, so it absorbs the remainder — adding or widening any other column shrinks Seller and nothing else.
- `gh` lives at `C:\Program Files\GitHub CLI\gh.exe` — shells opened before its install don't have it on PATH.
- **UI changes take up to ~20 min to appear on phones after merging.** GitHub Pages serves everything with `Cache-Control: max-age=600` and a deploy doesn't purge the CDN: an edge that re-caches the old files right after the deploy serves them for another 10 min, and the browser then caches *that* copy for 10 more. The deploy workflow stamps `?v=<commit SHA>` onto the JS/CSS links in `index.html` (CDN caches by full URL), so HTML and assets can never mismatch — but `index.html` itself is still cached, so the window applies to the page as a whole. On top of that, an already-open tab **never** picks up new UI — `app.js` only refetches `data.json`, so the header timestamp stays fresh while HTML/JS/CSS stay stale. Before debugging a "deploy didn't work" report: check the Deploy run's commit, wait out the cache window, and test in a private tab (separate cache). `data.json` is unaffected (different URL, `raw.githubusercontent.com`, max-age=300).
