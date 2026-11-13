// Entry point for the data workflow: builds cloud/web/data.json from the
// CardTrader entries in config.json.
//
//   CARDTRADER_TOKEN=…  node cloud/build-data.js [--prev previous-data.json]
//
// CardTrader only. Cardmarket is metered scraping, run only on demand, and it
// lives in its own file on its own branch — see cloud/build-cardmarket.js. Keeping
// this job free of it is deliberate: it runs every ten minutes, and the only thing
// it carries between runs is the breaker state below (`meta.cardtrader` in the
// previous data.json, passed as --prev); losing that costs one extra probe, nothing more.
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

// ---- Circuit breaker -------------------------------------------------------------
//
// Cloudflare has twice decided the runner is a bot (2026-10-19 for four days, 2026-11-11
// for ~42 hours) and answered every request with a challenge. The challenge is a verdict
// on the runner, so probing again two minutes later cannot succeed — it only feeds the
// bot score and, before this, produced a red run and a failure mail each time, about
// twenty an hour. So a challenged run trips the breaker: it republishes the previous
// data.json unchanged except for `meta.cardtrader`, which records when the next probe
// is allowed, and exits green with a warning. Runs inside that window exit without a
// single request. The wait doubles per consecutive strike (1 h, 2 h, 4 h, then 8 h
// flat) and clears on the first successful fetch, so the job notices the lift itself.
// A genuine failure (token revoked, API down) is not a challenge and still exits red.
const BREAKER_BASE_MS = 60 * 60 * 1000; // first wait: one hour
const BREAKER_MAX_MS = 8 * BREAKER_BASE_MS; // never wait longer than eight

function readPrev(file) {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.warn(`[ct] previous data.json unreadable (${e.message}) — treating as none`);
    return null;
  }
}

// { until, strikes } while the previous run's breaker still holds, else null.
function breakerOpen(prev, now = Date.now()) {
  const state = prev && prev.meta && prev.meta.cardtrader;
  const t = state && state.blockedUntil ? Date.parse(state.blockedUntil) : NaN;
  if (!Number.isFinite(t) || t <= now) return null;
  return { until: new Date(t).toISOString(), strikes: state.strikes || 0 };
}

// The state a challenged run records: one more strike, a longer wait.
function tripBreaker(prev, now = Date.now()) {
  const strikes = ((prev && prev.meta && prev.meta.cardtrader && prev.meta.cardtrader.strikes) || 0) + 1;
  const wait = Math.min(BREAKER_BASE_MS * 2 ** (strikes - 1), BREAKER_MAX_MS);
  return { strikes, challengedAt: new Date(now).toISOString(), blockedUntil: new Date(now + wait).toISOString() };
}

// What a challenged run publishes: the previous results under the previous updatedAt
// (moving it would read on the page as a fresh fetch), today's watch list, and the
// breaker state. The page ignores meta keys it does not know.
function carryForward(prev, cardtrader, cardmarketCards) {
  return { ...prev, updatedAt: prev.updatedAt, meta: { ...(prev.meta || {}), cardmarketCards, cardtrader }, results: prev.results || [] };
}

function writeOut(doc) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 0));
}

async function main() {
  const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  const argv = process.argv.slice(2);
  const prev = readPrev(argv.includes("--prev") ? argv[argv.indexOf("--prev") + 1] : null);
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

  const now = Date.now();
  const open = breakerOpen(prev, now);
  if (open && process.env.CT_PROBE_NOW !== "true") {
    console.log(
      `::notice::CardTrader breaker is open until ${open.until} after ${open.strikes} consecutive Cloudflare challenge(s) — no request made, nothing published`,
    );
    return;
  }
  if (open) console.log(`[ct] probe_now: ignoring the open breaker (until ${open.until})`);

  const { results, blocked } = await cardtrader.fetchAll(products, { token: TOKEN });

  if (blocked) {
    const state = tripBreaker(prev, now);
    const minutes = Math.round((Date.parse(state.blockedUntil) - now) / 60000);
    console.log(
      `::warning::Cloudflare challenged the run (strike ${state.strikes}) — keeping the last good data; next probe after ${state.blockedUntil} (${minutes} min)`,
    );
    if (!prev) {
      console.log("[ct] no previous data.json to carry the breaker state in — the next run will probe again");
      return;
    }
    writeOut(carryForward(prev, state, cardmarketCards));
    console.log(`wrote ${OUT} (previous ${prev.results ? prev.results.length : 0} entries carried forward, breaker state recorded)`);
    return;
  }

  const verdict = publishVerdict(results, false);
  if (!verdict.ok) {
    console.error(`${verdict.reason} — not writing data.json so the last good data survives`);
    process.exit(1);
  }

  if (prev && prev.meta && prev.meta.cardtrader) {
    console.log(`::notice::CardTrader answered again after ${prev.meta.cardtrader.strikes} challenge(s) — breaker cleared`);
  }
  writeOut({ updatedAt: new Date(now).toISOString(), meta: { cardmarketCards }, results });
  console.log(`wrote ${OUT} (${results.length} entries, ${cardmarketCards.length} refreshable on Cardmarket)`);
}

if (require.main === module) main();

module.exports = { publishVerdict, MAX_ERROR_SHARE, breakerOpen, tripBreaker, carryForward, BREAKER_BASE_MS, BREAKER_MAX_MS };
