// Timer-triggered scrape -> data.json in the $web container of the Function's own
// storage account, whose static website also serves the UI (same origin, no CORS).
// config.json and lib/cards.js are copied into this package by deploy-azure.yml —
// the checked-in sources in the repo root and shared/ stay the single source of truth.
const { app } = require("@azure/functions");
const { BlobServiceClient } = require("@azure/storage-blob");
const { scrapeAll } = require("../../lib/scrape");
const { normalizeCards } = require("../../lib/cards");
const config = require("../../config.json");

app.timer("updateData", {
  schedule: "0 */5 * * * *",
  runOnStartup: true, // publish immediately after each deploy/restart
  handler: async (_timer, context) => {
    const products = normalizeCards(config).filter((p) => p.site === "cardtrader");
    const { updatedAt, results } = await scrapeAll(products, (m) => context.log(m));
    if (results.length && results.every((r) => r.error)) {
      context.error("all cards errored — keeping the previous data.json");
      return;
    }
    const svc = BlobServiceClient.fromConnectionString(process.env.AzureWebJobsStorage);
    const blob = svc.getContainerClient("$web").getBlockBlobClient("data.json");
    const body = JSON.stringify({ updatedAt, results });
    await blob.upload(body, Buffer.byteLength(body), {
      blobHTTPHeaders: { blobContentType: "application/json", blobCacheControl: "public, max-age=60" },
    });
    context.log(`published data.json (${results.length} cards)`);
  },
});
