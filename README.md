# MTG Pricerunner

Watches Magic: The Gathering card prices (Japanese printings) on CardTrader and
Cardmarket.

**Live site:** https://paludancode.github.io/MTG-Pricerunner/

A GitHub Actions fetcher builds `data.json` from the CardTrader API and from
Cardmarket (scraped via Firecrawl), and a static GitHub Pages site renders it —
nothing to run or host yourself. Offers from both sites are merged into one
price-sorted table per card; the `Src` column says which site a row came from.

## Layout

```
config.json          card watch list (paste-a-URL entries)
shared/              UI for the dashboard: ui.css, render.js, app.js
cloud/               GitHub Actions fetcher + static site (cloud/web)
  build-data.js        entry point — runs every source, writes data.json
  fetch-cardtrader.js  CardTrader offers from its official API
  fetch-cardmarket.js  Cardmarket offers, scraped through Firecrawl
  cardmarket-parse.js  Cardmarket HTML -> offers (pure, unit-tested)
  verify-mobile.js     UI smoke test (renders at 320/390/1440 px, fails on overflow)
  fixture-data.json    offline test data for CI
test/                unit tests (node:test, zero deps) — run with `npm test`
docs/                external-pinger.md — the cron-job.org pinger behind the ~2-min data refresh
.github/workflows/
  update.yml           CD — deploy the site to Pages (push to main only)
  update-data.yml      data refresh — cron + dispatch, publishes data.json to the `data` branch
  ci.yml               CI — syntax check + unit tests + UI smoke test (pull requests)
```

The deploy workflow copies `shared/` into the site at build time; `cloud/web/` build
artifacts (`data.json`, copied UI files) are gitignored.

## How data updates work

Site deploys and data refreshes are decoupled:

- **`update.yml`** publishes the site to GitHub Pages, only when UI/source files
  change on `main`. It never touches prices.
- **`update-data.yml`** fetches prices and force-pushes `data.json` as a single
  orphan commit to the **`data` branch**. The live page fetches it from
  `raw.githubusercontent.com`, so fresh data needs no deploy. The `data` branch is
  a build artifact — never branch from it or PR into it.

In practice the refresh cadence comes from an **external pinger**: a cron-job.org
job POSTs the workflow's `workflow_dispatch` endpoint every 2 minutes (setup and
credentials: `docs/external-pinger.md`). The workflow also has a `2-57/5` in-repo
cron, but GitHub's scheduler is best-effort — empirically it fires every few hours —
so it only serves as a fallback if the pinger dies. Pushes to `main` that touch
`config.json` or the fetcher trigger a run too.

## Cardmarket and Firecrawl credits

Cardmarket sits behind Cloudflare, which blocks plain fetches from a GitHub runner,
so those pages are scraped through [Firecrawl](https://firecrawl.dev). That costs a
credit per scrape, and the data workflow runs every couple of minutes — scraping
every card every run would drain a plan within hours.

`cardmarketTtlMinutes` in `config.json` is the throttle. Each Cardmarket result
carries a `fetchedAt`, the workflow hands the previous `data.json` to
`build-data.js --prev`, and a result is re-scraped only once it is older than the
TTL. Budget:

```
scrapes/day ≈ cardmarket cards × 1440 / cardmarketTtlMinutes
```

At the default 360 min, 5 Cardmarket cards cost ~20 credits/day. Lower the TTL for
fresher prices, raise it to stretch the quota. CardTrader is unaffected — it is a
free API call and keeps refreshing every run.

Setup: add the Firecrawl API key as the **`FIRECRAWL_API_KEY`** repo secret
(Settings → Secrets and variables → Actions). Without it the run still succeeds and
simply skips the Cardmarket cards. Failures never blank a card: the previous offers
are kept and the run records the error.

## Branching strategy

Trunk-based, short-lived branches:

1. Branch off `main`: `feat/<thing>` or `fix/<thing>`
2. Push, open a PR — CI runs (JS syntax check + unit tests + UI smoke test at three viewports)
3. Merge when green. Merging to `main` **is** the release: the deploy workflow
   fires on push to `main` and publishes to GitHub Pages. UI changes can take up
   to ~20 min to show up in the browser (Pages CDN caches files for 10 min and a
   deploy doesn't purge it; the browser caches its copy for 10 more) — and a tab
   that's already open never picks up new UI at all, since the page only refetches
   `data.json`. When in doubt, test in a private tab.

`main` is protected: PRs need the `checks` job green before merge; force-pushes and
deletion are blocked. Repo admins can push directly in a pinch (escape hatch — prefer PRs).

## Maintenance

Dependabot (`.github/dependabot.yml`) opens a weekly grouped PR per ecosystem when
updates exist: one for GitHub Actions versions, one for npm. Treat them like any PR —
CI must be green, then merge. GitHub normally pauses scheduled workflows after 60 days
without repo activity, but `update-data.yml` re-enables itself on every run (Keepalive
step), so no manual re-enabling is needed.

## UI rules

Desktop layout is the reference design — don't touch the base CSS look.
Phone/tablet adjustments live in `@media (max-width: …)` blocks in `shared/ui.css` only.
Verify any UI change with:

```bash
node cloud/verify-mobile.js
```

Writes `cloud/shot-{narrow,mobile,desktop}.png` and exits non-zero on horizontal
overflow or an empty grid. Uses live `cloud/web/data.json` when present, else the fixture.

## Adding a card

Add an entry to `cards` in `config.json` (CardTrader **or** Cardmarket URL +
`group` + `variant` + `code`, the official Scryfall set code shown on phones — CI
fails if it's missing), and merge to `main` via PR. That push triggers an immediate
data refresh.

Entries sharing a `group` are merged into one card on the page, so pasting both a
CardTrader and a Cardmarket URL for the same printing puts both sites' offers in one
price-sorted table. Cardmarket URLs must keep their `?language=7` (Japanese) query —
that is the only language filter Cardmarket offers, and CI checks it is there.
