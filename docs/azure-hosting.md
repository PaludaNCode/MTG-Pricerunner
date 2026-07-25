# Azure hosting

Fully-Azure deployment of the watcher: no GitHub Pages, no cron-job.org pinger, and
nothing running on a PC.

```
                    ┌──────────────────────────── Storage Account ─────────┐
Azure Function App  │  $web container (static website endpoint)            │
  timer, every 5m ──┼─▶ data.json      (Cache-Control: max-age=60)         │
  managed identity  │   index.html     (Cache-Control: no-cache)           │
                    │   ui.css/render.js/app.js/favicon.svg  (immutable,   │
                    │                     versioned by ?v=<commit sha>)    │
                    └──────────────────────────────────────────────────────┘
                                       ▲
                                phone / browser
```

One storage account serves both the site and the data, so the page fetches a **relative**
`data.json` — same origin, no CORS, no second CDN. `shared/app.js` needs no change: its
URL is only special-cased for `github.io`, and any other host (Azure, localhost) already
falls through to the relative path.

## Why this is better than the Pages setup

- **The timer actually fires.** GitHub's scheduler is documented best-effort and
  empirically ran every few hours, which is why the repo needed an external cron-job.org
  pinger (`docs/external-pinger.md`). An Azure timer trigger fires on schedule; the
  pinger becomes unnecessary.
- **The ~20 minute phone-cache window goes away.** On Pages every file is served
  `max-age=600` and a deploy purges nothing. Here we set `Cache-Control` per blob:
  `index.html` is `no-cache`, and the SHA-stamped assets are immutable. A deploy is
  visible on the next page load.
- **No `data` branch.** The function writes the blob directly, so there's no orphan-commit
  force-push dance.

## Cost

Effectively free at this scale. Storage is a few MB and a few thousand transactions a day
(pennies/month); the Function App's consumption plan includes 1M executions and 400,000
GB-s per month, and ~8,600 runs/month of a few seconds each sits far inside it.

## Setup

Prereqs: Azure CLI (`winget install Microsoft.AzureCLI`), then `az login`.

```powershell
# 1. Provision (idempotent — safe to re-run)
./azure/provision.ps1 -CardTraderToken '<your CardTrader API token>'

# 2. Deploy site + function
./azure/deploy.ps1
```

`provision.ps1` prints the site URL. Defaults: resource group `rg-mtg-pricerunner`,
region `westeurope`, name prefix `mtgpricerunner` (override with `-NamePrefix`, which must
resolve to a globally-unique storage account name of lowercase letters/digits).

The function authenticates to storage with its **managed identity** plus a
`Storage Blob Data Contributor` role assignment — no storage keys or SAS tokens exist
anywhere. Role assignments take a minute to propagate, so the first timer run may 403.

### Later changes

```powershell
./azure/deploy.ps1 -SiteOnly       # UI/CSS change
./azure/deploy.ps1 -FunctionOnly   # config.json or fetcher change
```

To force a data refresh immediately instead of waiting for the timer:

```powershell
$key = az functionapp function keys list -g rg-mtg-pricerunner -n mtgpricerunner-fn `
  --function-name refreshDataNow --query default -o tsv
curl -X POST "https://mtgpricerunner-fn.azurewebsites.net/api/refreshDataNow?code=$key"
```

Tune the cadence without redeploying (NCRONTAB is 6 fields, leading `{seconds}`):

```powershell
az functionapp config appsettings set -g rg-mtg-pricerunner -n mtgpricerunner-fn `
  --settings "DATA_REFRESH_CRON=0 */2 * * * *"
```

### Deploying from CI instead

`.github/workflows/azure-deploy.yml` does the same thing, but is **manual-trigger only**
on purpose: a merge to `main` must never silently deploy the Azure site. It needs an app
registration federated to this repo and three secrets — `AZURE_CLIENT_ID`,
`AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.

## Cardmarket: what moving to Azure does and does not fix

**Hosting was never the blocker, so moving to Azure does not by itself get Cardmarket
back.** Measured 2026-07-26 against a real product page:

| Transport | From | Result |
|---|---|---|
| plain `curl` | residential IP | `403` "Just a moment" |
| headless Chrome | residential IP | `403` "Attention Required" |
| headed Chrome, fresh profile | residential IP | `403` "Just a moment" |
| the user's everyday Chrome profile | residential IP | worked (this was the old `cdp` mode) |

Cloudflare is gating **automation**, not just datacenter IPs — a fresh browser fails from
a home IP too. The only thing that ever worked was a long-lived Chrome profile that had
already solved a challenge and held a `cf_clearance` cookie.

That cookie cannot be shipped to Azure: Cloudflare binds it to the IP, TLS fingerprint and
User-Agent that solved the challenge, so presenting it from an Azure IP is rejected on
sight. This closes the obvious "warm the session locally, export the cookie" workaround.

Three routes, all currently closed:

1. **Official API** — the clean answer, but Cardmarket is not accepting new API
   applications; access is limited to large existing sellers. If that ever changes, add an
   `"api"` transport in `cloud/cardmarket-core.js` and delete the scraping paths.
2. **Scraping from Azure** — blocked as measured above.
3. **Price aggregators** (Scryfall `prices.eur`, MTGJSON) — these work fine from Azure but
   are *not* live listings. Scryfall syncs every 24h and uses "Trend Price, one-day
   average, seven-day average, average price, or suggested price, whichever is available",
   and its per-language card objects mostly carry `null` prices — so it cannot express
   "Japanese copies currently for sale". Rejected as not matching the requirement.

### What is in the repo instead

A prototype with the transport isolated behind one seam, so only that piece has to change
if a route opens:

- `cloud/cardmarket-core.js` — the HTML parser (works; unit-tested in
  `test/cardmarket-parse.test.js`) plus a pluggable transport: `off` (default) | `direct` |
  `proxy`.
- `cloud/probe-cardmarket.js` — one command to re-test any transport and get the
  distinction that matters, "blocked by Cloudflare" vs "reached the page but parsed
  nothing":

  ```bash
  node cloud/probe-cardmarket.js direct
  ```

- `config.json` takes Cardmarket URLs again (`shared/cards.js` normalizes them), but with
  the transport `off` each one renders as a paused row rather than offers. The live grid is
  unchanged until a transport works.

The `proxy` transport routes through a third-party scraping/residential-proxy service:

```bash
CARDMARKET_PROXY_URL='https://api.scrapingbee.com/v1/?api_key={key}&render_js=true&url={url}' \
CARDMARKET_PROXY_KEY=... node cloud/probe-cardmarket.js proxy
```

It is **off by default and should stay that way unless you decide otherwise**: paying a
service to defeat Cloudflare is against Cardmarket's Terms of Use and puts the account and
IP at risk. It is implemented so the choice is yours to make explicitly, not so it happens
by default.
