// Entry point for the fast data workflow: builds cloud/web/data.json from the
// CardTrader entries in config.json.
//
//   CARDTRADER_TOKEN=…  node cloud/build-data.js
//
// CardTrader only. Cardmarket is metered scraping, run only on demand, and it
// lives in its own file on its own branch — see cloud/build-cardmarket.js. Keeping
// this job free of it is deliberate: it runs every couple of minutes and must stay
// stateless, with nothing to carry forward and nothing expensive to lose.
const fs = require("fs");
const path = require("path");
const { normalizeCards } = require("../shared/cards");
const cardtrader = require("./fetch-cardtrader");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "web", "data.json");

// Whether a run is fit to replace the last good data.json. Two ways to fail it:
//
// - The run was cut short by a Cloudflare challenge (fetchAll's `blocked`). The cards
//   after the challenge were never requested, so publishing would show them as empty.
// - Too many cards errored. The guard used to fire only when *every* card failed, and on
//   2026-10-19 that let a run with 37 of 51 cards at "HTTP 403" overwrite a good file —
//   the page showed 37 empty cards for four days. One or two network failures in a run
//   are normal and still publish; a quarter of the list is an outage, not a snapshot.
//
// Refusing to publish keeps the previous file on the data branch, and the page's own
// timestamp says how old it is. That is more honest than fresh-looking empty cards.
const MAX_ERROR_SHARE = 0.25;
function publishVerdict(results, blocked, maxErrorShare = MAX_ERROR_SHARE) {
  const errored = results.filter((r) => r.error).length;
  if (blocked) {
    const skipped = results.filter((r) => r.error === "blocked: Cloudflare challenge").length;
    return { ok: false, reason: `Cloudflare challenged the run — ${skipped} of ${results.length} cards blocked or never requested` };
  }
  if (results.length && errored / results.length > maxErrorShare) {
    return { ok: false, reason: `${errored} of ${results.length} cards errored (more than ${Math.round(maxErrorShare * 100)}%)` };
  }
  return { ok: true };
}

async function main() {
  const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  const TOKEN = process.env.CARDTRADER_TOKEN;
  if (!TOKEN) {
    console.error("CARDTRADER_TOKEN env var is required (CardTrader API bearer token)");
    process.exit(1);
  }

  const all = normalizeCards(CONFIG);
  const products = all.filter((p) => p.site === "cardtrader");
  // Which cards Cardmarket can refresh. Published here — in the feed that always
  // exists — because the page needs it to draw the tick boxes, and the Cardmarket
  // feed does not exist until the first successful scrape. Without this the UI is
  // unusable exactly when you need it: nothing to tick, so no way to run the first
  // scrape from the site.
  const cardmarketCards = [...new Set(all.filter((p) => p.site === "cardmarket").map((p) => p.group))];

  const { results, blocked } = await cardtrader.fetchAll(products, { token: TOKEN });

  const verdict = publishVerdict(results, blocked);
  if (!verdict.ok) {
    console.error(`${verdict.reason} — not writing data.json so the last good data survives`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    JSON.stringify({ updatedAt: new Date().toISOString(), meta: { cardmarketCards }, results }, null, 0),
  );
  console.log(`wrote ${OUT} (${results.length} entries, ${cardmarketCards.length} refreshable on Cardmarket)`);
}

if (require.main === module) main();

module.exports = { publishVerdict, MAX_ERROR_SHARE };
