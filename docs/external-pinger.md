# External pinger: real ~2-minute data updates

GitHub's `schedule:` cron is best-effort. Measured on this repo (June 2026): the
`*/5` cron fired every **2.5–4.6 hours**. `workflow_dispatch` runs immediately, so an
external scheduler POSTing the dispatch endpoint is the only way to get reliable
cadence on the free tier. The in-repo cron stays as a fallback.

**Current setup (live):** a cron-job.org job pings the dispatch endpoint every
**10 minutes**, so `data.json` refreshes at that cadence. The steps below document
how it was set up / how to recreate it.

## Cadence: why 10 minutes and not 2

The job ran every 2 minutes from July to November 2026 and was fine while the watch
list was ~30 CardTrader printings (~600 requests/hour). Once the list passed 50, the
same cadence meant ~1,100 identical requests an hour from datacentre IPs, and
Cloudflare in front of `api.cardtrader.com` challenged the runner twice: four days
from 2026-10-19, ~42 hours from 2026-11-11. CardTrader's own limit (200 requests per
10 s) was never near; this is bot scoring on the pattern. 10 minutes with 55 printings
is ~330 requests/hour — half the level that ran clean for months. If the list grows
past ~100 printings, slow the pinger again before Cloudflare does it for you.

The in-repo fallback cron is set to the same 10 minutes. `build-data.js` also carries a
breaker: a challenged run records a wait in `meta.cardtrader` (1 h, doubling to 8 h) and
the runs inside it make no request at all — so a block costs a few quiet probes a day,
not a mail per run, and clears itself. The `probe_now` input on the workflow ignores an
open breaker for one run.

## 1. Create a fine-grained PAT

Direct link: https://github.com/settings/personal-access-tokens/new (logged in as PaludaNCode;
the entry point is otherwise Settings → Developer settings, at the very bottom of the sidebar).

- **Resource owner**: `PaludaNCode`
- **Repository access**: **"Only select repositories"** → `PaludaNCode/MTG-Pricerunner`.
  Gotcha: the "Public repositories (read-only)" option hides the whole permissions
  section — pick it and "Actions: Read and write" never appears.
- **Permissions** (section appears only after the step above): expand "Repository
  permissions" → **Actions: Read and write** (nothing else; auto-added "Metadata:
  Read-only" is expected).
- Expiration: 1 year (set a reminder to rotate)

## 2. Test the dispatch call

```bash
curl -X POST \
  -H "Authorization: Bearer <PAT>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/PaludaNCode/MTG-Pricerunner/actions/workflows/update-data.yml/dispatches \
  -d '{"ref":"main"}'
```

Expect HTTP 204 and a new "Update card data" run in the Actions tab within seconds.

## 3. Configure cron-job.org (free tier)

Create a job:

- **URL**: `https://api.github.com/repos/PaludaNCode/MTG-Pricerunner/actions/workflows/update-data.yml/dispatches`
- **Schedule**: every 10 minutes (see *Cadence* above before going faster — each ping is
  one Actions run, free on public repos, but every run is 55 CardTrader requests)
- **Request method**: POST
- **Headers**:
  - `Authorization: Bearer <PAT>`
  - `Accept: application/vnd.github+json`
  - `User-Agent: mtg-pricerunner-pinger` (GitHub rejects requests without a User-Agent)
- **Body**: `{"ref":"main"}`
- Treat 204 as success.

Any equivalent scheduler works (UptimeRobot webhooks, a Cloudflare Worker cron, etc.) —
the API call is the only contract.

## Notes

- The PAT is a write credential for Actions on this repo. Keep it only in the
  scheduler's config; never commit it. The site's "↻ CM" button uses a PAT with the
  same permissions, entered in the browser and stored in `localStorage` — the same
  token works for both, and it must never be placed in the page itself.
- `update-data.yml` has `concurrency: group: data, cancel-in-progress: true`, so
  overlapping pings collapse to the newest run — over-pinging is harmless.
- If the pinger dies, the in-repo cron (and its keepalive step) still updates data
  at whatever cadence GitHub grants.
