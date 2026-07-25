// Builds the data.json payload for every configured card, across every site.
// Used by both publishing paths so they emit byte-identical data:
//   - cloud/fetch-cardtrader.js  (GitHub Actions -> `data` branch)
//   - azure/functions           (timer trigger  -> Azure Blob $web/data.json)
//
// Data shape contract (consumed by shared/render.js):
//   { updatedAt, results: [{ site, group, variant, code, productUrl, error?, offers: [...] }] }
const { normalizeCards } = require("../shared/cards");
const { getRates, fetchCardtraderAll } = require("./cardtrader-core");
const { fetchCardmarketAll } = require("./cardmarket-core");

// Results are returned in config order so the grid stays stable between refreshes
// regardless of which site each card came from.
function inConfigOrder(products, bySite) {
  const queues = new Map();
  for (const [site, list] of Object.entries(bySite)) queues.set(site, list.slice());
  return products.map((p) => queues.get(p.site).shift());
}

// Throws when every card errored, so callers abort before publishing and the last
// good data.json survives. A partially-failed refresh still publishes.
async function buildData({ config, token, log = () => {} }) {
  if (!token) throw new Error("CardTrader API token is required");

  const products = normalizeCards(config);
  const cardtrader = products.filter((p) => p.site === "cardtrader");
  const cardmarket = products.filter((p) => p.site === "cardmarket");

  // Skip the FX lookup entirely when there's no CardTrader work — nothing else needs it.
  const rates = cardtrader.length ? await getRates() : { EUR: 1 };
  const ctResults = await fetchCardtraderAll(cardtrader, { token, rates, log });
  const cmResults = await fetchCardmarketAll(cardmarket, { config, log });

  const results = inConfigOrder(products, { cardtrader: ctResults, cardmarket: cmResults });

  // A paused Cardmarket row is an expected state, not a failure — don't let it make
  // an otherwise-healthy refresh look like a total outage, and don't let it mask one.
  const live = results.filter((r) => !r.paused);
  if (live.length && live.every((r) => r.error)) {
    throw new Error("all cards errored — refusing to publish so the last good data survives");
  }
  return { updatedAt: new Date().toISOString(), results };
}

module.exports = { buildData };
