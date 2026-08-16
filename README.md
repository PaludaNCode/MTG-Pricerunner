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
cloud/               GitHub Actions fetchers + static site (cloud/web)
  build-data.js        entry point A — CardTrader -> data.json (every ~2 min)
  build-cardmarket.js  entry point B — Cardmarket -> cardmarket.json (hourly)
  fetch-cardtrader.js  CardTrader offers from its official API
  fetch-cardmarket.js  Cardmarket offers via Firecrawl + the credit budget
  cardmarket-parse.js  Cardmarket HTML -> offers (pure, unit-tested)
  verify-mobile.js     UI smoke test (renders at 320/390/1440 px, fails on overflow)
  verify-refresh.js    behaviour test for the "↻ CM" button (browser, network stubbed)
  fixture-data.json    offline CardTrader test data for CI
  fixture-cardmarket.json  offline Cardmarket test data for CI
test/                unit tests (node:test, zero deps) — run with `npm test`
docs/                external-pinger.md — the cron-job.org pinger behind the ~2-min data refresh
.github/workflows/
  update.yml           CD — deploy the site to Pages (push to main only)
  update-data.yml      CardTrader refresh — every ~2 min, publishes data.json to `data`
  update-cardmarket.yml  Cardmarket refresh — hourly, publishes cardmarket.json to `data-cm`
  ci.yml               CI — syntax check + unit tests + UI smoke test (pull requests)
```

The deploy workflow copies `shared/` into the site at build time; `cloud/web/` build
artifacts (`data.json`, copied UI files) are gitignored.

## How data updates work

Site deploys and data refreshes are decoupled:

- **`update.yml`** publishes the site to GitHub Pages, only when UI/source files
  change on `main`. It never touches prices.
- **`update-data.yml`** fetches CardTrader prices and force-pushes `data.json` as a
  single orphan commit to the **`data` branch**.
- **`update-cardmarket.yml`** scrapes Cardmarket and force-pushes `cardmarket.json`
  to the **`data-cm` branch**, hourly at most.

The live page fetches both from `raw.githubusercontent.com` and merges them, so fresh
data needs no deploy. Both branches are build artifacts — never branch from them or PR
into them.

The two are split because they have nothing in common operationally: CardTrader is a
free API call that can run every couple of minutes and carries no state, while
Cardmarket is metered scraping with a credit ledger that must survive between runs.
One writer per file means the 2-min job can never disturb Cardmarket's budget
accounting — and a lost ledger costs real money.

In practice the refresh cadence comes from an **external pinger**: a cron-job.org
job POSTs the workflow's `workflow_dispatch` endpoint every 2 minutes (setup and
credentials: `docs/external-pinger.md`). The workflow also has a `2-57/5` in-repo
cron, but GitHub's scheduler is best-effort — empirically it fires every few hours —
so it only serves as a fallback if the pinger dies. Pushes to `main` that touch
`config.json` or the fetcher trigger a run too.

## Cardmarket and Firecrawl credits

Cardmarket sits behind Cloudflare, which blocks plain fetches from a GitHub runner, so
those pages are scraped through [Firecrawl](https://firecrawl.dev). Firecrawl bills
credits per scrape, and — this is the awkward part — **the cost per page is not knowable
up front**: `proxy: "auto"` silently escalates to the stealth proxy when Cloudflare
bites, which bills several credits instead of one.

So the budget is denominated in **credits, not scrapes**. Each run reads the live
balance, spends against a daily allowance, then re-reads the balance and books what the
pass actually cost:

```
Firecrawl: 964/1000 credits, period ends 2026-09-01 · 33.1/day allowance, 6 spent today
           · ~3.0 credits/scrape (measured) → 9 affordable
Firecrawl: spent 6 credit(s) on 2 scrape(s) (3.0/scrape), 958 remaining
```

The daily allowance is `(remaining − reserve) ÷ days left in the billing period`, so it
self-corrects: a quiet day raises tomorrow's ceiling, a heavy one lowers it. The
measured cost per scrape is smoothed and carried in `cardmarket.json` under `meta`,
alongside today's spend — which is why `--prev` matters and why only one workflow writes
that file.

| Knob | Default | What it does |
|---|---|---|
| `cardmarketMonthlyCredits` | 1000 | Plan size. Only used to pace things when the API reports no billing period. |
| `cardmarketMinCredits` | 50 | Untouchable reserve — never spend below this. |
| `cardmarketPerRunLimit` | 2 | Max scrapes per hourly wake, so one run can't eat the day. |
| `cardmarketTtlMinutes` | 120 | Don't re-scrape a card younger than this. |
| `cardmarketDailyBudget` | 6 | Fallback scrape cap, used only when the balance can't be read. |

The TTL is deliberately low: at 2 hours the **credit allowance**, not the TTL, is what
limits refreshes, so the plan gets spent on whatever is stalest rather than idling.
Hourly is the cron's ceiling; most wakes will scrape nothing.

**What 1000 credits/month actually buys**, across all Cardmarket cards:

| Measured cost | Loads/day | With 5 cards, each refreshes |
|---|---|---|
| 1 credit (basic proxy) | ~32 | every ~4 hours |
| 3 credits | ~11 | every ~11 hours |
| 5 credits (stealth) | ~6 | every ~20 hours |

Watch the `credits/scrape` line after the first real run to see which row you are on.

Setup: add the Firecrawl API key as the **`FIRECRAWL_API_KEY`** repo secret
(Settings → Secrets and variables → Actions). The Cardmarket workflow fails loudly
without it; CardTrader is unaffected either way. Failures never blank a card — the
previous offers are kept and the run records the error — and a card deferred by the
budget keeps its prices too, without being marked as an error.

## Refreshing Cardmarket on demand

The header has a **↻ CM** button that triggers a Cardmarket scrape immediately instead
of waiting for the hourly cron. It sends `workflow_dispatch` with `force: true`, which
makes that run ignore the TTL and the per-run limit — but **not** the credit allowance
or the reserve. The worst a button press can do is spend today's allowance sooner; it
can never overspend the plan. When the allowance is gone the button greys itself out
and says so, rather than firing a run that would defer every card.

Triggering a workflow needs a GitHub PAT with `Actions: read and write`, and this site
is public — so the token is **not** in the page. Next to the button is a token field:
paste the PAT, press Enter, and it is kept in that browser's `localStorage`. The field
then hides itself; the **⚿** button reopens it to change the token, and emptying it
forgets the token entirely. Anyone without a token sees a disabled button. A token that
comes back 401/403 (they expire yearly) is discarded automatically and the field
reopens.

Use the same fine-grained PAT the pinger uses, or mint another the same way —
`docs/external-pinger.md` step 1 has the exact settings. After pressing, the page polls
`cardmarket.json` until the snapshot's timestamp moves, up to three minutes.

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
