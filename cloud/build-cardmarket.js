// Entry point for the Cardmarket workflow: builds cloud/web/cardmarket.json from the
// cardmarket entries in config.json, scraping through Firecrawl.
//
//   FIRECRAWL_API_KEY=…  node cloud/build-cardmarket.js [--prev <cardmarket.json>]
//
// Deliberately separate from build-data.js (CardTrader) and published to its own
// `data-cm` branch, because the two have nothing in common operationally:
// CardTrader is a free API call every couple of minutes; Cardmarket is metered
// scraping on an hourly cron. Sharing one file would also mean the 2-min job
// rewrites Cardmarket's budget ledger ~720 times a day — and a single dropped
// --prev there is a credit-burn event. One writer, one file.
//
// --prev is the previous cardmarket.json off the data-cm branch. It carries both the
// cached offers and `meta` (today's spend, the learned cost per scrape). Losing it
// costs credits, so the workflow treats it as required-if-present.
const fs = require("fs");
const path = require("path");
const { normalizeCards } = require("../shared/cards");
const cardmarket = require("./fetch-cardmarket");

const ROOT = path.join(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const OUT = path.join(__dirname, "web", "cardmarket.json");

const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY;

function readPrev() {
  const i = process.argv.indexOf("--prev");
  const file = i !== -1 ? process.argv[i + 1] : null;
  if (!file) return { results: [], meta: null };
  try {
    const prev = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      results: Array.isArray(prev.results) ? prev.results : [],
      meta: prev.meta && typeof prev.meta === "object" ? prev.meta : null,
    };
  } catch (e) {
    // Not fatal, but worth shouting about: without the ledger this run starts the
    // day's budget over and re-scrapes everything.
    console.log(`WARNING: no usable previous cardmarket.json (${e.message}) — ` +
      "budget ledger reset and every card looks stale");
    return { results: [], meta: null };
  }
}

(async () => {
  const products = normalizeCards(CONFIG).filter((p) => p.site === "cardmarket");
  if (!products.length) {
    console.log("no cardmarket entries in config.json — nothing to do");
    return;
  }
  if (!FIRECRAWL_KEY) {
    console.error("FIRECRAWL_API_KEY env var is required to scrape Cardmarket");
    process.exit(1);
  }

  const prev = readPrev();
  const pick = (key, fallback) => (CONFIG[key] != null ? CONFIG[key] : fallback);

  const out = await cardmarket.fetchAll(products, {
    apiKey: FIRECRAWL_KEY,
    prev: prev.results,
    meta: prev.meta,
    ttlMinutes: pick("cardmarketTtlMinutes", cardmarket.DEFAULT_TTL_MINUTES),
    dailyBudget: pick("cardmarketDailyBudget", cardmarket.DEFAULT_DAILY_BUDGET),
    minCredits: pick("cardmarketMinCredits", cardmarket.DEFAULT_MIN_CREDITS),
    perRunLimit: pick("cardmarketPerRunLimit", cardmarket.DEFAULT_PER_RUN_LIMIT),
    monthlyCredits: pick("cardmarketMonthlyCredits", cardmarket.DEFAULT_MONTHLY_CREDITS),
    country: CONFIG.cardmarketCountry || null,
    checkCredits: true,
  });

  // A run that scraped nothing is normal (everything fresh, or budget spent) — but it
  // must still write, so `meta` and the day's ledger move forward.
  console.log(
    `Cardmarket: ${out.scraped} scrape(s); ${out.meta.credits} credit(s) spent on ${out.meta.day}`,
  );

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    JSON.stringify({ updatedAt: new Date().toISOString(), meta: out.meta, results: out.results }, null, 0),
  );
  console.log(`wrote ${OUT} (${out.results.length} entries)`);
})();
