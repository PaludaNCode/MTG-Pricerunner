// Azure Function that refreshes data.json on a timer — the Azure replacement for
// .github/workflows/update-data.yml.
//
// Publishes into the SAME storage account that serves the site ($web container), so
// the page fetches a relative "data.json" (same origin: no CORS, no second CDN, no
// cross-host cache surprises).
//
// Auth is the Function App's managed identity, granted "Storage Blob Data Contributor"
// on the account by azure/provision.ps1 — no storage keys or SAS tokens anywhere.
//
// Unlike GitHub's scheduler (documented best-effort; empirically fires every few hours,
// which is why the repo needed an external cron-job.org pinger), an Azure timer trigger
// fires on schedule. DATA_REFRESH_CRON is an app setting so the cadence is tunable
// without a redeploy.
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("@azure/functions");
const { BlobServiceClient } = require("@azure/storage-blob");
const { DefaultAzureCredential } = require("@azure/identity");
const { buildData } = require("../../cloud/build-data");

const CONFIG_PATH = path.join(__dirname, "..", "..", "config.json");
const CONTAINER = "$web"; // the static-website container
const BLOB = "data.json";

// data.json is small and refetched by the page every 60s; a short max-age keeps
// phones current while still absorbing bursts.
const DATA_CACHE_CONTROL = "public, max-age=60";

function blobClient() {
  const account = process.env.STORAGE_ACCOUNT_NAME;
  if (!account) throw new Error("STORAGE_ACCOUNT_NAME app setting is required");
  const svc = new BlobServiceClient(
    `https://${account}.blob.core.windows.net`,
    new DefaultAzureCredential()
  );
  return svc.getContainerClient(CONTAINER).getBlockBlobClient(BLOB);
}

async function refresh(context) {
  const token = process.env.CARDTRADER_TOKEN;
  if (!token) throw new Error("CARDTRADER_TOKEN app setting is required");

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  // buildData throws when every card errored, which aborts before the upload and
  // leaves the previous data.json in place.
  const data = await buildData({ config, token, log: (m) => context.log(m) });

  const body = JSON.stringify(data, null, 0);
  await blobClient().upload(body, Buffer.byteLength(body), {
    blobHTTPHeaders: {
      blobContentType: "application/json",
      blobCacheControl: DATA_CACHE_CONTROL,
    },
  });

  const offers = data.results.reduce((n, r) => n + r.offers.length, 0);
  context.log(`published ${BLOB}: ${data.results.length} cards, ${offers} offers`);
  return { cards: data.results.length, offers, updatedAt: data.updatedAt };
}

app.timer("refreshData", {
  schedule: "%DATA_REFRESH_CRON%",
  runOnStartup: false,
  handler: async (_timer, context) => {
    await refresh(context);
  },
});

// Manual "refresh now" (needs the function key), for right after a config.json change.
app.http("refreshDataNow", {
  methods: ["POST"],
  authLevel: "function",
  handler: async (_req, context) => {
    try {
      const summary = await refresh(context);
      return { jsonBody: { ok: true, ...summary } };
    } catch (e) {
      context.error(e);
      return { status: 500, jsonBody: { ok: false, error: e.message } };
    }
  },
});
