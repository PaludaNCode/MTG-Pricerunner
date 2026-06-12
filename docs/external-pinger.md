# External pinger: real ~5-minute data updates

GitHub's `schedule:` cron is best-effort. Measured on this repo (June 2026): the
`*/5` cron fired every **2.5–4.6 hours**. `workflow_dispatch` runs immediately, so an
external scheduler POSTing the dispatch endpoint every 5 minutes is the only way to
get reliable cadence on the free tier. The in-repo cron stays as a fallback.

## 1. Create a fine-grained PAT

GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token:

- **Repository access**: Only select repositories → `PaludaNCode/MTG-Pricerunner`
- **Permissions**: Repository permissions → **Actions: Read and write** (nothing else)
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
- **Schedule**: every 5 minutes
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
  scheduler's config; never commit it.
- `update-data.yml` has `concurrency: group: data, cancel-in-progress: true`, so
  overlapping pings collapse to the newest run — over-pinging is harmless.
- If the pinger dies, the in-repo cron (and its keepalive step) still updates data
  at whatever cadence GitHub grants.
