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

// Upper bound on the debug sample row. Generous — it lands in a public JSON file, but one
// row of marketplace HTML is small next to being able to test the parser offline at all.
const MAX_SAMPLE_CHARS = 12000;

// The parts of a previous result that are data rather than config: everything the
// scrape produced, nothing the config owns.
function pickData(r) {
  const out = { offers: r.offers || [], fetchedAt: r.fetchedAt || null };
  if (r.triedAt) out.triedAt = r.triedAt;
  if (r.failures) out.failures = r.failures;
  if (r.error) out.error = r.error;
  return out;
}

// Roll the ledger onto `today`. The day's counters reset at the UTC boundary, but
// costPerScrape must not: it is a property of the plan and the proxy, not of the date.
// Dropping it sent the next run back to the pessimistic 5-credit assumption, so it rated
// itself at a fifth of what it could actually afford — the first refresh of each day
// would silently defer most of the list. `fetchAll` already carries the learned cost
// across days; this is the balance-only path, which has to agree with it.
function carryMeta(prevMeta, today) {
  if (prevMeta && prevMeta.day === today) return { ...prevMeta, day: today };
  const fresh = { day: today, scrapes: 0, credits: 0 };
  if (prevMeta && prevMeta.costPerScrape) fresh.costPerScrape = prevMeta.costPerScrape;
  return fresh;
}

// The file must always describe EVERY watched card, not just this run's selection.
// A targeted run only fetches the cards you ticked, so writing its results verbatim
// would delete every other card's offers from the snapshot — one press of the button
// and the other cards go blank until they are individually re-scraped.
function mergeResults(products, freshResults, prevResults) {
  const fresh = new Map(freshResults.map((r) => [r.productUrl, r]));
  const carried = new Map(prevResults.map((r) => [r.productUrl, r]));
  return products.map(
    (p) =>
      fresh.get(p.productUrl) ||
      // Keep the old offers, but re-apply the current config fields so a renamed group
      // or corrected URL shows up without waiting for that card's next scrape.
      (carried.has(p.productUrl)
        ? { ...p, ...pickData(carried.get(p.productUrl)) }
        : { ...p, offers: [], fetchedAt: null }),
  );
}

function write(meta, results) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), meta, results }, null, 0));
  console.log(`wrote ${OUT} (${results.length} entries)`);
}

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

async function main() {
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

  // --dump <dir> saves each scraped page's raw HTML. Cardmarket can't be fetched from a
  // dev box either (Cloudflare), so this is the way to get a real page in front of the
  // parser when its regexes need checking against current markup.
  const dumpIdx = process.argv.indexOf("--dump");
  const dumpDir = dumpIdx !== -1 ? process.argv[dumpIdx + 1] : null;
  if (dumpDir) fs.mkdirSync(dumpDir, { recursive: true });

  // CM_DEBUG publishes one article row's raw HTML into meta.debug. Cardmarket cannot be
  // fetched from a dev box (Cloudflare), so this is the only way to check the parser's
  // regexes against markup that actually exists. It is how we learned that the live
  // all-versions row carries no product link at all; the captured specimen now lives in
  // test/fixtures/cardmarket-row.html.
  const debugSample = /^(true|1|yes)$/i.test(process.env.CM_DEBUG || "");
  let sample = null;

  // CM_CARDS is the site's tick-box selection, passed through workflow_dispatch.
  const chosen = cardmarket.selectProducts(products, process.env.CM_CARDS);
  if (chosen.length !== products.length) {
    console.log(`selection: ${chosen.length} of ${products.length} card(s) — ${chosen.map((p) => p.group).join(", ")}`);
  }

  // CM_BALANCE_ONLY answers "how many credits do I have left?" without scraping
  // anything. Reading the balance is not billed, so this costs nothing — it exists
  // because otherwise the only way to refresh that number is to spend credits.
  if (/^(true|1|yes)$/i.test(process.env.CM_BALANCE_ONLY || "")) {
    const now = Date.now();
    const today = cardmarket.utcDay(now);
    const meta = carryMeta(prev.meta, today);
    const credits = await cardmarket.getCredits(FIRECRAWL_KEY);
    if (credits) {
      const allowance = cardmarket.dailyCreditAllowance(credits, {
        minCredits: pick("cardmarketMinCredits", cardmarket.DEFAULT_MIN_CREDITS),
        monthlyCredits: pick("cardmarketMonthlyCredits", cardmarket.DEFAULT_MONTHLY_CREDITS),
        now,
      });
      meta.remaining = credits.remaining;
      if (allowance != null) meta.allowance = Math.round(allowance * 10) / 10;
      console.log(
        `Firecrawl balance: ${credits.remaining}${credits.plan ? "/" + credits.plan : ""} credits` +
          (credits.periodEnd ? `, period ends ${String(credits.periodEnd).slice(0, 10)}` : "") +
          ` · allowance ${meta.allowance}/day · ${meta.credits} spent today`,
      );
    } else {
      console.error("could not read the Firecrawl balance");
      process.exit(1);
    }
    write(meta, mergeResults(products, [], prev.results));
    return;
  }

  // CM_FORCE is set by the site's "↻ CM" button (a workflow_dispatch input). A manual
  // press means "I want this now", so it ignores the TTL and the per-run limit — but
  // NOT the credit allowance or the reserve. On-demand must never be able to outspend
  // the plan; the worst it can do is use today's allowance sooner.
  const force = /^(true|1|yes)$/i.test(process.env.CM_FORCE || "");
  if (force) console.log("forced refresh: ignoring the TTL and per-run limit (credit allowance still applies)");

  const out = await cardmarket.fetchAll(chosen, {
    apiKey: FIRECRAWL_KEY,
    prev: prev.results,
    meta: prev.meta,
    ttlMinutes: force ? 0 : pick("cardmarketTtlMinutes", cardmarket.DEFAULT_TTL_MINUTES),
    dailyBudget: pick("cardmarketDailyBudget", cardmarket.DEFAULT_DAILY_BUDGET),
    minCredits: pick("cardmarketMinCredits", cardmarket.DEFAULT_MIN_CREDITS),
    perRunLimit: force ? chosen.length : pick("cardmarketPerRunLimit", cardmarket.DEFAULT_PER_RUN_LIMIT),
    monthlyCredits: pick("cardmarketMonthlyCredits", cardmarket.DEFAULT_MONTHLY_CREDITS),
    country: CONFIG.cardmarketCountry || null,
    checkCredits: true,
    onHtml: (p, html) => {
      if (dumpDir) {
        const f = path.join(dumpDir, p.productUrl.replace(/[^a-z0-9]+/gi, "-").slice(-80) + ".html");
        fs.writeFileSync(f, html);
        console.log("  dumped " + f);
      }
      // Stash the first all-versions row seen. Whether it gets published is decided
      // after parsing: if no offer came back with a printing, the extraction is wrong
      // and this row is the only way to find out how the page actually names it.
      // Cut at the next row rather than after a fixed span: the first capture used a
      // 3000-char window and stopped mid-tag, before the price and condition markup, so
      // the specimen could only ever prove half the parser. A whole row costs nothing
      // extra — the page is already paid for.
      if (!sample && p.allVersions) {
        const i = html.indexOf('id="articleRow');
        if (i !== -1) {
          const start = Math.max(0, i - 400);
          const next = html.indexOf('id="articleRow', i + 1);
          const end = Math.min(next === -1 ? html.length : next, start + MAX_SAMPLE_CHARS);
          sample = { url: p.productUrl, group: p.group, row: html.slice(start, end) };
        }
      }
    },
  });

  // A run that scraped nothing is normal (everything fresh, or budget spent) — but it
  // must still write, so `meta` and the day's ledger move forward.
  console.log(
    `Cardmarket: ${out.scraped} scrape(s); ${out.meta.credits} credit(s) spent on ${out.meta.day}`,
  );

  const results = mergeResults(products, out.results, prev.results);
  const kept = results.length - out.results.length;

  // Self-diagnosing: an all-versions page whose offers carry no printing means the row
  // extraction missed. Publishing one raw row makes that fixable from the data itself,
  // rather than needing someone to remember to re-run with a debug flag.
  const allVersionsScraped = out.results.filter((r) => r.allVersions && (r.offers || []).length);
  const anySet = allVersionsScraped.some((r) => r.offers.some((o) => o.variant));
  const extractionBroken = allVersionsScraped.length > 0 && !anySet;
  if (extractionBroken) {
    console.log(
      `WARNING: ${allVersionsScraped.length} all-versions card(s) returned offers but no printings — ` +
        "the row extraction matched nothing. Publishing a sample row in meta.debug.",
    );
  } else if (allVersionsScraped.length) {
    const n = allVersionsScraped.reduce((a, r) => a + r.offers.filter((o) => o.variant).length, 0);
    const t = allVersionsScraped.reduce((a, r) => a + r.offers.length, 0);
    console.log(`per-offer printings resolved on ${n} of ${t} all-versions offer(s)`);
  }
  const publishSample = sample && (debugSample || extractionBroken);
  if (publishSample) console.log(`  sample row from ${sample.group} (${sample.row.length} chars)`);
  if (kept > 0) console.log(`carried ${kept} untouched card(s) forward from the previous snapshot`);

  write(publishSample ? { ...out.meta, debug: sample } : out.meta, results);
}

// Guarded so the unit tests can require this file for its helpers without launching a
// run that would read config.json and reach for the network.
if (require.main === module) main();

module.exports = { carryMeta, mergeResults, pickData };
