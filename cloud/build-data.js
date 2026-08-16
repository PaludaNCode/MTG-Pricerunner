// Entry point for the fast data workflow: builds cloud/web/data.json from the
// CardTrader entries in config.json.
//
//   CARDTRADER_TOKEN=…  node cloud/build-data.js
//
// CardTrader only. Cardmarket is metered scraping on a separate hourly schedule and
// lives in its own file on its own branch — see cloud/build-cardmarket.js. Keeping
// this job free of it is deliberate: it runs every couple of minutes and must stay
// stateless, with nothing to carry forward and nothing expensive to lose.
const fs = require("fs");
const path = require("path");
const { normalizeCards } = require("../shared/cards");
const cardtrader = require("./fetch-cardtrader");

const ROOT = path.join(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const OUT = path.join(__dirname, "web", "data.json");

const TOKEN = process.env.CARDTRADER_TOKEN;
if (!TOKEN) {
  console.error("CARDTRADER_TOKEN env var is required (CardTrader API bearer token)");
  process.exit(1);
}

(async () => {
  const products = normalizeCards(CONFIG).filter((p) => p.site === "cardtrader");
  const { results } = await cardtrader.fetchAll(products, { token: TOKEN });

  // A total wipeout means the API is down or the token expired — bail out so the last
  // good data.json stays on the data branch instead of being replaced by empty cards.
  if (results.length && results.every((r) => r.error)) {
    console.error("all CardTrader cards errored — not writing data.json so the last good data survives");
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), results }, null, 0));
  console.log(`wrote ${OUT} (${results.length} entries)`);
})();
