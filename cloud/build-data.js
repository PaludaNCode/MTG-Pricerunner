// Entry point for the data workflow: builds cloud/web/data.json from every source
// configured in config.json (CardTrader via its official API, Cardmarket via Firecrawl).
//
//   CARDTRADER_TOKEN=…  FIRECRAWL_API_KEY=…  node cloud/build-data.js [--prev <data.json>]
//
// --prev is the data.json from the previous run (the workflow pulls it off the `data`
// branch). It is what makes the Cardmarket TTL work: results younger than
// config.cardmarketTtlMinutes are copied over instead of re-scraped, which is the
// difference between a handful of Firecrawl credits a day and thousands.
// Without --prev every Cardmarket card is scraped fresh.
const fs = require("fs");
const path = require("path");
const { normalizeCards } = require("../shared/cards");
const cardtrader = require("./fetch-cardtrader");
const cardmarket = require("./fetch-cardmarket");

const ROOT = path.join(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const OUT = path.join(__dirname, "web", "data.json");

const TOKEN = process.env.CARDTRADER_TOKEN;
const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY;

if (!TOKEN) {
  console.error("CARDTRADER_TOKEN env var is required (CardTrader API bearer token)");
  process.exit(1);
}

// The previous file carries both the last results and `meta.cardmarket`, the running
// tally of today's Firecrawl scrapes. Losing it just means the day's budget restarts.
function readPrev() {
  const i = process.argv.indexOf("--prev");
  const file = i !== -1 ? process.argv[i + 1] : null;
  if (!file) return { results: [], meta: {} };
  try {
    const prev = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      results: Array.isArray(prev.results) ? prev.results : [],
      meta: prev.meta && typeof prev.meta === "object" ? prev.meta : {},
    };
  } catch (e) {
    console.log(`no usable previous data (${e.message}) — every card will be fetched fresh`);
    return { results: [], meta: {} };
  }
}

(async () => {
  const products = normalizeCards(CONFIG);
  const ct = products.filter((p) => p.site === "cardtrader");
  const cm = products.filter((p) => p.site === "cardmarket");
  const prev = readPrev();
  const prevMeta = prev.meta;

  const ctOut = await cardtrader.fetchAll(ct, { token: TOKEN });

  // A total CardTrader wipeout means the API is down or the token expired — bail out
  // so the last good data.json stays on the data branch instead of being replaced by
  // a page full of empty cards.
  if (ctOut.results.length && ctOut.results.every((r) => r.error)) {
    console.error("all CardTrader cards errored — not writing data.json so the last good data survives");
    process.exit(1);
  }

  let cmOut = { results: [], scraped: 0, meta: prevMeta.cardmarket };
  if (cm.length && !FIRECRAWL_KEY) {
    console.log(`skipping ${cm.length} Cardmarket card(s): FIRECRAWL_API_KEY is not set`);
  } else if (cm.length) {
    const pick = (key, fallback) => (CONFIG[key] != null ? CONFIG[key] : fallback);
    const ttlMinutes = pick("cardmarketTtlMinutes", cardmarket.DEFAULT_TTL_MINUTES);
    const dailyBudget = pick("cardmarketDailyBudget", cardmarket.DEFAULT_DAILY_BUDGET);
    cmOut = await cardmarket.fetchAll(cm, {
      apiKey: FIRECRAWL_KEY,
      prev: prev.results,
      ttlMinutes,
      dailyBudget,
      minCredits: pick("cardmarketMinCredits", cardmarket.DEFAULT_MIN_CREDITS),
      country: CONFIG.cardmarketCountry || null,
      meta: prevMeta.cardmarket,
      checkCredits: true,
    });
    console.log(
      `Cardmarket: ${cmOut.scraped} scrape(s) this run (ttl ${ttlMinutes} min); ` +
        `${cmOut.meta.scrapes}/${dailyBudget} used on ${cmOut.meta.day}`,
    );
  }

  // Emit in config order so the page's card order stays the one curated in config.json.
  const byKey = new Map();
  for (const r of [...ctOut.results, ...cmOut.results]) byKey.set(r.site + " " + r.productUrl, r);
  const results = products.map((p) => byKey.get(p.site + " " + p.productUrl)).filter(Boolean);

  // `meta` is bookkeeping that must survive to the next run (the page ignores it).
  const meta = { ...prevMeta, ...(cmOut.meta ? { cardmarket: cmOut.meta } : {}) };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), meta, results }, null, 0));
  console.log(`wrote ${OUT} (${results.length} entries)`);
})();
