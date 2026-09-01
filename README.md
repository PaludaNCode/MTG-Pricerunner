# MTG Pricerunner

Watches Magic: The Gathering card prices (Japanese printings) on CardTrader and
Cardmarket.

**Live site:** https://paludancode.github.io/MTG-Pricerunner/

GitHub Actions fetchers build two feeds — `data.json` from the CardTrader API and
`cardmarket.json` from Cardmarket (scraped via Firecrawl) — and a static GitHub Pages
site merges and renders them; nothing to run or host yourself. Offers from both sites
end up in one price-sorted table per card; the `Src` column says which site a row came
from, and a filter in the control strip can narrow the page to just one of them.

## Layout

```
config.json          card watch list (paste-a-URL entries)
shared/              UI for the dashboard: ui.css, render.js, app.js
cloud/               GitHub Actions fetchers + static site (cloud/web)
  build-data.js        entry point A — CardTrader -> data.json (every ~2 min)
  build-cardmarket.js  entry point B — Cardmarket -> cardmarket.json (on demand only)
  fetch-cardtrader.js  CardTrader offers from its official API
  fetch-cardmarket.js  Cardmarket offers via Firecrawl + the credit budget
  cardmarket-parse.js  Cardmarket HTML -> offers (pure, unit-tested)
  verify-mobile.js     UI smoke test (renders at 320/390/1440 px, fails on overflow
                       or a header rail that has lost its shape)
  verify-refresh.js    behaviour test for the "↻ CM" button (browser, network stubbed)
  fixture-data.json    offline CardTrader test data for CI
  fixture-cardmarket.json  offline Cardmarket test data for CI
test/                unit tests (node:test, zero deps) — run with `npm test`
docs/                external-pinger.md — the cron-job.org pinger behind the ~2-min refresh
  prototypes/          reviewed HTML mock-ups kept for reference (header, controls)
.github/workflows/
  update.yml           CD — deploy the site to Pages (push to main only)
  update-data.yml      CardTrader refresh — every ~2 min, publishes data.json to `data`
  update-cardmarket.yml  Cardmarket refresh — on demand only, publishes to `data-cm`
  ci.yml               CI — syntax check + unit tests + both browser checks (pull requests)
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
  to the **`data-cm` branch**. It runs **only when you ask** — there is no schedule,
  because every scrape costs credits.

The live page fetches both from `raw.githubusercontent.com` and merges them, so fresh
data needs no deploy. Both branches are build artifacts — never branch from them or PR
into them.

The two are split because they have nothing in common operationally: CardTrader is a
free API call that can run every couple of minutes and carries no state, while
Cardmarket is metered scraping with a credit ledger that must survive between runs.
One writer per file means the 2-min job can never disturb Cardmarket's budget
accounting — and a lost ledger costs real money.

In practice the CardTrader refresh cadence comes from an **external pinger**: a
cron-job.org job POSTs the workflow's `workflow_dispatch` endpoint every 2 minutes
(setup and credentials: `docs/external-pinger.md`). The workflow also has a `2-57/5`
in-repo cron, but GitHub's scheduler is best-effort — empirically it fires every few
hours — so it only serves as a fallback if the pinger dies. Pushes to `main` that touch
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
Firecrawl: 964 credits/1000, period ends 2026-09-01 · 33.1/day allowance, 6 spent today
           · ~3.0 credits/scrape (measured) → 9 affordable
Firecrawl: spent 6 credit(s) on 2 scrape(s) (3.0/scrape), 958 remaining
```

The daily allowance is `(remaining − reserve) ÷ days left in the billing period`, so it
self-corrects: a quiet day raises tomorrow's ceiling, a heavy one lowers it. The
measured cost per scrape is smoothed and carried in `cardmarket.json` under `meta`,
alongside today's spend — which is why `--prev` matters and why only one workflow writes
that file.

The credit budget is the whole of what `config.json` configures:

| Setting in `config.json` | Value | What it does |
|---|---|---|
| `cardmarketMonthlyCredits` | 1000 | Plan size. Only used to pace things when the API reports no billing period. |
| `cardmarketMinCredits` | 50 | Untouchable reserve — never spend below this. |
| `cardmarketCountry` | `DK` | The country Firecrawl browses Cardmarket from. |
| `defaultLanguage` | `jp` | Language for entries that don't name one. |

Three further limits exist only as defaults in `cloud/fetch-cardmarket.js` — a TTL
(120 min), a per-run scrape limit (2) and a fallback scrape cap (6). They were taken
out of `config.json` rather than left there looking like live settings: every real run
sends `force=true` (the site's button, and the workflow input's own default), which
bypasses the first two, and the scrape cap only applies when the balance can't be read
at all. What actually bounds spending is the daily credit allowance and the reserve.

**What 1000 credits/month actually buys**, across all Cardmarket cards:

| Measured cost | Loads/day | With 5 cards, each refreshes |
|---|---|---|
| 1 credit (basic proxy) | ~32 | every ~4 hours |
| 3 credits | ~11 | every ~11 hours |
| 5 credits (stealth) | ~6 | every ~20 hours |

Watch the `credits/scrape` line after the first real run to see which row you are on.

**Checking the balance costs nothing.** The site's legend has a "Check credit balance"
link, and the workflow has a `balance_only` input: both read the Firecrawl balance and
scrape nothing. Reading the balance is not billed.

Setup: add the Firecrawl API key as the **`FIRECRAWL_API_KEY`** repo secret
(Settings → Secrets and variables → Actions). The Cardmarket workflow fails loudly
without it; CardTrader is unaffected either way. Failures never blank a card — the
previous offers are kept and the run records the error — and a card deferred by the
budget keeps its prices too, without being marked as an error.

## Reading the page

Under the header sits a **control strip** holding everything that decides what the next
refresh shows and costs. On the left, free of charge: a **Both / CT / CM** filter that
narrows the tables to one source. It is pure client-side state over the two feeds
already fetched, so switching costs nothing and is remembered across visits; filtering
to one source also drops the now-pointless `Src` column. A card with no offers from the
chosen source keeps its tick box and freshness chip — both describe *scraping
Cardmarket*, not the prices on screen — and says "no Cardmarket offers" rather than
looking broken.

On the right, the part that spends credits: the per-card tick boxes' **Select all** /
**Clear** buttons and the count of what is ticked, then **⚿** (the GitHub token) and
**↻ CM** (scrape now).

The **Set** column shows the official short set code at every width — a code is what you
compare printings by, and full set names truncate even on a desktop. The full name is
the link's tooltip. For CardTrader that code comes from `config.json`; for Cardmarket it
is read off the row's product thumbnail, and rows scraped before that existed have their
code derived from the CardTrader printings of the same card rather than re-scraped at a
credit apiece. Where no code can be established honestly, the full name stays.

## Refreshing Cardmarket on demand

The control strip has a **↻ CM** button that triggers a Cardmarket scrape immediately —
it is the only thing that ever starts one. It sends `workflow_dispatch` with
`force: true`, which makes that run ignore the TTL and the per-run limit — but **not**
the credit allowance or the reserve. The worst a button press can do is spend today's
allowance sooner; it can never overspend the plan. When the allowance is gone the button
greys itself out and says so, rather than firing a run that would defer every card. Tick
the cards you want first; ticking nothing scrapes every card, stalest first.

**Nothing scrapes between 00:00 and 08:00 UTC.** There is no scheduler to switch off —
only a human ever starts a run — so the window guards the on-demand path instead: a press
at 03:00 would spend credits nobody is awake to read. A run started inside it scrapes
nothing and writes nothing, and the button greys out with the reason. `force` does not
bypass it, for the same reason force does not bypass the credit allowance — "I want this
now" may reorder the day's spending, not rewrite the rules. The free balance check still
works. UTC because the ledger day rolls at 00:00 UTC and the allowance unlocks with it,
so the window opens exactly when the fresh allowance does. Set `cardmarketQuietStartHour`
equal to `cardmarketQuietEndHour` in `config.json` to switch it off.

Triggering a workflow needs a GitHub PAT with `Actions: read and write`, and this site
is public — so the token is **not** in the page. The strip has a token field: paste the
PAT, press Enter, and it is kept in that browser's `localStorage`. The field then hides
itself; the **⚿** button reopens it to change the token, and emptying it forgets the
token entirely. Anyone without a token sees a disabled button. A token that comes back
401/403 (they expire yearly) is discarded automatically and the field reopens.

Use the same fine-grained PAT the pinger uses, or mint another the same way —
`docs/external-pinger.md` step 1 has the exact settings. After pressing, the page
follows the actual workflow run through the GitHub Actions API — the token already has
`Actions: read` — and narrates it in four steps: request accepted, run picked up, which
step is executing, then fetching the result. A crashed run therefore reports the step it
died on instead of looking like a slow one, and only a run still going after five
minutes times out.

## Branching strategy

Trunk-based, short-lived branches:

1. Branch off `main`: `feat/<thing>` or `fix/<thing>`
2. Push, open a PR — CI runs (JS syntax check + unit tests + the UI smoke test at three
   viewports + the refresh-button behaviour test)
3. Merge when green. Merging to `main` **is** the release: the deploy workflow
   fires on push to `main` and publishes to GitHub Pages. UI changes can take up
   to ~20 min to show up in the browser (Pages CDN caches files for 10 min and a
   deploy doesn't purge it; the browser caches its copy for 10 more) — and a tab
   that's already open never picks up new UI at all, since the page only refetches
   `data.json`. When in doubt, test in a private tab.

`main` is protected: PRs need the `checks` job green before merge; force-pushes and
deletion are blocked. Repo admins can push directly in a pinch (escape hatch — prefer PRs).
Merged PRs clean up after themselves — "Automatically delete head branches" is on, so
GitHub removes the head branch at merge and nothing needs pruning by hand.

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
overflow, an empty grid, or a header status rail that has lost its shape (2×2 on phones,
a single row above 480px). Each feed uses the live file in `cloud/web/` when present and
its fixture otherwise, so the check never touches the network.

## Adding a card

Add an entry to `cards` in `config.json` (CardTrader **or** Cardmarket URL +
`group` + `variant` + `code`, the official Scryfall set code the Set column shows —
CI fails if it's missing, **and now also if it's wrong**: `cloud/verify-set-codes.js`
runs on the Actions runner, where the network is open, and rejects a code that names no
Scryfall set or names a real set that doesn't contain the card. When it fails it prints
the sets the card actually is in, so the fix is in the log. It degrades to a warning if
Scryfall doesn't answer, so it can't become a flaky gate), and merge to `main` via PR. That push triggers an immediate
CardTrader refresh; Cardmarket only moves when someone presses ↻ CM.

Entries sharing a `group` are merged into one card on the page, so pasting both a
CardTrader and a Cardmarket URL for the same card puts both sites' offers in one
price-sorted table. Cardmarket URLs must keep their `?language=7` (Japanese) query —
that is the only language filter Cardmarket offers, and CI checks it is there.

**Removing a card takes effect on the page by itself, but the file lags.** Deleting it
from `config.json` cleans the CardTrader feed within a couple of minutes, and the page
stops showing its Cardmarket rows just as fast — it filters them against the live watch
list that travels in `data.json`. `cardmarket.json` itself is only rewritten when a
Cardmarket run happens, so the dead entry lingers there until one does. To tidy the file
(worth doing if you read the published JSON directly), trigger a **balance check** — the
free link, or the workflow's `balance_only` input: it scrapes nothing, costs no credits,
and republishes from the current config.

Not every watched card needs a Cardmarket entry, and leaving one out is the cheapest
knob there is: each entry costs a credit every time it is refreshed, so a card only
worth watching on CardTrader simply has no Cardmarket URL, and renders CardTrader rows
with no tick box and no freshness chip.

**For Cardmarket, consider the all-versions URL.** Cardmarket has a per-card page
listing every printing's offers at once:

```
https://www.cardmarket.com/en/Magic/Cards/Runehorn-Hellkite?language=7      <- one scrape, all printings
https://www.cardmarket.com/en/Magic/Products/Singles/Commander-2016/Runehorn-Hellkite?language=7   <- one printing
```

CardTrader has no equivalent, which is why it needs a URL per printing — currently 40
CardTrader printing URLs against 17 Cardmarket ones across 23 watched cards. Flag
all-versions entries `"allVersions": true` and give them `"variant": "All printings"`
with no `code`; each offer reports its own set, read from the row. CI fails if a
`/Magic/Cards/` URL is missing the flag, since that would label every offer with a
single set. A per-printing URL costs the same per scrape and is the better choice when
only some printings matter — a fetchland's all-versions page is mostly reprints nobody
here watches — and it carries its own set code.
