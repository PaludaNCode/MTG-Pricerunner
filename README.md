# MTG Pricerunner

Watches Magic: The Gathering card prices (Japanese printings) on CardTrader and Cardmarket.

**Live site:** https://paludancode.github.io/MTG-Pricerunner/

Two flavors, one identical UI — only the price import differs:

| | Local watcher | Cloud site |
|---|---|---|
| Sources | CardTrader API + Cardmarket (scraped via your own Chrome over CDP) | CardTrader API only |
| Refresh | rolling, one card every 5 s | GitHub Actions cron, ~every 5 min (best-effort) |
| Run | `local\start-watcher.cmd` → http://localhost:8787 | nothing — GitHub Pages |

## Layout

```
config.json          card watch list + watcher settings (shared by both)
shared/              one UI for both dashboards: ui.css, render.js, app.js
local/               Node watcher server + launcher scripts (Windows)
cloud/               GitHub Actions fetcher + static site (cloud/web)
  fetch-cardtrader.js  builds cloud/web/data.json from the CardTrader JSON API
  verify-mobile.js     UI smoke test (renders at 320/390/1440 px, fails on overflow)
  fixture-data.json    offline test data for CI
.github/workflows/
  update.yml           CD — fetch prices + deploy Pages (cron + push to main)
  ci.yml               CI — syntax check + UI smoke test (pull requests)
```

The deploy workflow copies `shared/` into the site at build time; `cloud/web/` build
artifacts (`data.json`, copied UI files) are gitignored.

## Branching strategy

Trunk-based, short-lived branches:

1. Branch off `main`: `feat/<thing>` or `fix/<thing>`
2. Push, open a PR — CI runs (JS syntax check + UI smoke test at three viewports)
3. Merge when green. Merging to `main` **is** the release: the deploy workflow
   fires on push to `main` and publishes to GitHub Pages.

`main` is protected: PRs need the `checks` job green before merge; force-pushes and
deletion are blocked. Repo admins can push directly in a pinch (escape hatch — prefer PRs).

## Maintenance

Dependabot (`.github/dependabot.yml`) opens a weekly grouped PR per ecosystem when
updates exist: one for GitHub Actions versions, one for npm. Treat them like any PR —
CI must be green, then merge. If the repo sees no commits for 60 days GitHub pauses
the cron schedule and emails the owner; re-enable under the Actions tab.

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

Add an entry to `cards` in `config.json` (CardTrader or Cardmarket URL + `group` + `variant`),
commit to `main`. The next scheduled run picks it up; the local watcher reloads config on the fly.
