# Azure site (EU-hosted, website-JSON scraper)

Third deployment of the same UI, alongside the local watcher and the GitHub Pages site
(which stays as-is). Why it exists: the official CardTrader marketplace API used by the
Pages site serves stale data server-side — sold listings kept appearing 13+ hours after
purchase (verified 2026-07-11; cache-busting doesn't help, `cf-cache-status: DYNAMIC`).
The public website JSON is fresh but geo-filtered by requester IP, so it must be fetched
from an EU IP to see EU sellers — hence Azure, EU region.

## Architecture

- **One storage account** (EU region) does double duty: it is the Function app's storage
  *and* hosts the static website (`$web` container) serving the shared UI.
- **Timer Function** (`azure/functions/`, Node 20, runs every 5 min + once on startup)
  scrapes `www.cardtrader.com/en/cards/<blueprintId>.json` for every CardTrader product
  in `config.json` and writes `data.json` into `$web` (same origin as the page, no CORS).
  If every card errors, it keeps the previous `data.json`.
- **Deploy workflow** (`.github/workflows/deploy-azure.yml`) runs on push to `main`
  touching `azure/**`, `shared/**` or `config.json`. It copies `config.json` and
  `shared/cards.js` into the function package (single source of truth), deploys the
  Function, and uploads `azure/web/` + shared UI files to `$web`. The job is **skipped
  until the `AZURE_FUNCTIONAPP_NAME` repo variable exists**, so this can merge before
  Azure is provisioned.

## Picking a region empirically (optional, recommended)

The scrape's offer list reflects the *function's* IP country, not yours — and Azure IP
ranges don't always geolocate to the region's physical country, nor does Cloudflare
treat all datacenter ranges equally. Before provisioning, probe the candidates from
Cloud Shell (works from the Azure mobile app too):

```bash
curl -s https://raw.githubusercontent.com/PaludaNCode/MTG-Pricerunner/main/azure/region-probe.sh | bash
```

It launches a throwaway Container Instance per EU region, prints each region's egress
IP geolocation and CardTrader offer counts (Cloudflare blocks show up as NON-JSON/403),
then deletes everything. Pick the region whose JP offer counts best match the Pages
site and whose `geo=` is closest to DK. Until this branch is merged, add `REF=<branch>`
before `bash` so the probe script's JS half resolves.

## One-time provisioning (Azure Cloud Shell, bash)

Pick the region the probe liked best. `westeurope` (Netherlands) is a reasonable
default for Denmark; EU sellers that ship NL almost always ship DK.

```bash
RG=mtg-pricerunner
LOC=westeurope
ST=mtgpricerunner$RANDOM        # storage account names must be globally unique, a-z0-9
APP=mtg-pricerunner-func

az group create -n $RG -l $LOC
az storage account create -n $ST -g $RG -l $LOC --sku Standard_LRS --kind StorageV2
az storage blob service-properties update --account-name $ST --static-website --index-document index.html
az functionapp create -g $RG -n $APP --storage-account $ST \
  --consumption-plan-location $LOC --os-type Linux \
  --runtime node --runtime-version 20 --functions-version 4

# Site URL (bookmark this):
az storage account show -n $ST -g $RG --query primaryEndpoints.web -o tsv
```

If publish-profile deployment later fails with a 401/basic-auth error, enable SCM basic
auth (some subscriptions disable it by default):

```bash
az resource update -g $RG --namespace Microsoft.Web --resource-type basicPublishingCredentialsPolicies \
  --parent sites/$APP --name scm --set properties.allow=true
```

## GitHub repo configuration

| Where | Name | Value |
|---|---|---|
| Variable | `AZURE_FUNCTIONAPP_NAME` | `$APP` (e.g. `mtg-pricerunner-func`) |
| Secret | `AZURE_FUNCTIONAPP_PUBLISH_PROFILE` | output of `az functionapp deployment list-publishing-profiles -g $RG -n $APP --xml` |
| Secret | `AZURE_STORAGE_CONNECTION_STRING` | output of `az storage account show-connection-string -n $ST -g $RG -o tsv` |

Then run the **Deploy Azure site** workflow once manually (or push anything touching
`azure/**` to `main`). The Function publishes `data.json` immediately on startup, so the
site is live right after the first deploy.

## Cost

Consumption-plan Function (≈9 s of compute per 5-min run) and one LRS storage account:
comfortably inside the Functions free grant; storage is a few cents/month.

## Caveats

- The website JSON paginates (~25 offers/page); the scraper walks up to 12 pages per
  card with pacing and 429 backoff. A full 28-card run takes ~1–2 min.
- `shipsToMe` from this source means CardTrader-Zero (hub) eligibility, same as the
  Pages site.
- Offers are what CardTrader shows an IP in `$LOC`'s country — near-identical to what
  you see from Denmark, but not guaranteed identical.
