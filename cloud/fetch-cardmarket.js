// Cardmarket offers, scraped through Firecrawl (https://api.firecrawl.dev).
//
// Why Firecrawl: Cardmarket sits behind Cloudflare, which 403s plain fetches from a
// datacentre IP (a GitHub runner). The old local watcher worked around that by driving
// a real signed-in Chrome over CDP — impossible in Actions. Firecrawl renders the page
// on its own (optionally stealth-proxied) infrastructure and hands back the HTML.
//
// Credits are the binding constraint, not rate limits: the data workflow runs every
// couple of minutes, and one scrape per card per run would burn a plan in an hour.
// Three independent brakes, weakest to strongest:
//
//   1. TTL          — a result younger than `cardmarketTtlMinutes` is reused, not re-fetched.
//   2. Daily budget — at most `cardmarketDailyBudget` scrapes per UTC day, whatever the TTL
//                     says. When more cards are due than budget remains, the *stalest* ones
//                     go first, so the allowance rotates instead of always feeding the top
//                     of config.json.
//   3. Credit floor — the live balance is read before scraping and the pass stops while
//                     `cardmarketMinCredits` are still in the account, so an unattended
//                     workflow can never zero the plan out.
const { parseCardmarket, looksBlocked } = require("./cardmarket-parse");

// FIRECRAWL_API_URL matches the official SDK's env var; the tests point it at a stub.
const BASE = (process.env.FIRECRAWL_API_URL || "https://api.firecrawl.dev").replace(/\/$/, "");
const API = BASE + "/v2/scrape";
const CREDITS_API = BASE + "/v2/team/credit-usage";
const DEFAULT_TTL_MINUTES = 360;
const DEFAULT_DAILY_BUDGET = 12;
const DEFAULT_MIN_CREDITS = 25;
const WAIT_MS = 1000; // pace between cards

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A previous result may be reused when it came from a real scrape (`fetchedAt` set)
// that is younger than the TTL. A clock that jumped backwards must not pin a result
// as fresh forever, hence the lower bound.
function isFresh(prev, ttlMinutes, now) {
  if (!prev || !prev.fetchedAt || !(ttlMinutes > 0)) return false;
  const age = now - Date.parse(prev.fetchedAt);
  return Number.isFinite(age) && age >= 0 && age < ttlMinutes * 60000;
}

// The budget resets on the UTC day boundary. Derived from the timestamp rather than
// kept as a counter that could drift: `${day}` in the carried-over meta is compared
// against today, and a mismatch means the tally starts at zero.
const utcDay = (now) => new Date(now).toISOString().slice(0, 10);

// How many scrapes are still allowed today, given the meta carried over in data.json.
function budgetLeft(meta, dailyBudget, now) {
  if (!(dailyBudget > 0)) return 0;
  const used = meta && meta.day === utcDay(now) ? meta.scrapes || 0 : 0;
  return Math.max(0, dailyBudget - used);
}

// Stalest first, never-fetched before everything: this is what makes a budget smaller
// than the number of due cards rotate fairly instead of starving the tail of the list.
const staleness = (prevResult) =>
  prevResult && prevResult.fetchedAt ? Date.parse(prevResult.fetchedAt) || 0 : 0;

// Raised when the account is out of credits or the key is bad: retrying the remaining
// cards would fail identically, so the caller stops the whole Cardmarket pass.
class FirecrawlFatal extends Error {}

// Account balance. Free to call (it is not a scrape), and the only way to know the real
// per-scrape cost: Cloudflare pushes `proxy: "auto"` onto the stealth proxy, which bills
// several credits instead of one, so the run reports the measured delta rather than
// assuming. Returns null if the endpoint is unavailable — never blocks a run.
async function getCredits(apiKey) {
  try {
    const res = await fetch(CREDITS_API, { headers: { Authorization: "Bearer " + apiKey } });
    if (!res.ok) return null;
    const json = await res.json();
    const d = json && (json.data || json);
    const remaining = d && (d.remainingCredits ?? d.remaining_credits);
    if (typeof remaining !== "number") return null;
    return {
      remaining,
      plan: d.planCredits ?? d.plan_credits ?? null,
      periodEnd: d.billingPeriodEnd ?? d.billing_period_end ?? null,
    };
  } catch {
    return null;
  }
}

async function scrapeHtml(url, { apiKey, country, retryBackoffMs = 3000 }) {
  const body = {
    url,
    formats: ["rawHtml"], // rawHtml keeps the id/class attributes the parser matches on
    onlyMainContent: false, // the offer table is not the "main content" heuristic's pick
    maxAge: 0, // never serve Firecrawl's cached copy — prices are the whole point
    proxy: "auto", // retries through the stealth proxy when Cloudflare blocks the basic one
    waitFor: 1500,
    timeout: 60000,
    ...(country ? { location: { country, languages: ["en"] } } : {}),
  };

  let last = null;
  for (let tries = 0; tries < 3; tries++) {
    if (tries) await sleep(retryBackoffMs * tries);
    const res = await fetch(API, {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON error body */
    }
    if (res.ok && json && json.success && json.data) {
      const html = json.data.rawHtml || json.data.html || "";
      if (looksBlocked(html)) {
        last = "Cloudflare challenge returned instead of the page";
        continue;
      }
      return html;
    }
    const msg = (json && (json.error || json.message)) || "HTTP " + res.status;
    // 402 = out of credits, 401/403 = bad key. Nothing to retry.
    if (res.status === 402 || res.status === 401 || res.status === 403) {
      throw new FirecrawlFatal(`Firecrawl ${res.status}: ${msg}`);
    }
    last = msg;
  }
  throw new Error(last || "scrape failed");
}

// products: normalized cardmarket products; prev: results array from the last data.json.
// Returns { results, scraped } — `scraped` is the Firecrawl call count (≈ credits spent).
async function fetchAll(products, opts = {}) {
  const {
    apiKey,
    prev = [],
    ttlMinutes = DEFAULT_TTL_MINUTES,
    country = null,
    now = Date.now(),
    log = console.log,
    write = (s) => process.stdout.write(s),
    retryBackoffMs,
    paceMs = WAIT_MS,
    dailyBudget = DEFAULT_DAILY_BUDGET,
    minCredits = DEFAULT_MIN_CREDITS,
    meta = null,
    checkCredits = false,
  } = opts;

  const prevByUrl = new Map();
  for (const r of prev) if (r && r.site === "cardmarket" && r.productUrl) prevByUrl.set(r.productUrl, r);

  // Pick this run's scrape set up front: everything past its TTL, stalest first, capped
  // by what's left of today's budget.
  let allowance = budgetLeft(meta, dailyBudget, now);
  const due = products
    .filter((p) => !isFresh(prevByUrl.get(p.productUrl), ttlMinutes, now))
    .sort((a, b) => staleness(prevByUrl.get(a.productUrl)) - staleness(prevByUrl.get(b.productUrl)));

  let credits = null;
  if (checkCredits && due.length && allowance > 0) {
    credits = await getCredits(apiKey);
    if (credits) {
      const spendable = Math.max(0, credits.remaining - minCredits);
      log(`Firecrawl: ${credits.remaining} credits remaining${credits.plan ? " of " + credits.plan : ""}` +
        (credits.periodEnd ? `, period ends ${String(credits.periodEnd).slice(0, 10)}` : "") +
        `; reserve ${minCredits}`);
      if (spendable < allowance) allowance = spendable;
    }
  }

  const scrapeSet = new Set(due.slice(0, allowance).map((p) => p.productUrl));
  const deferred = due.length - scrapeSet.size;
  if (deferred > 0) {
    log(`budget: ${scrapeSet.size} of ${due.length} due card(s) this run, ${deferred} deferred ` +
      `(${dailyBudget}/day, ${budgetLeft(meta, dailyBudget, now)} left before this run)`);
  }

  const results = [];
  let scraped = 0;
  let fatal = null;

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const prevResult = prevByUrl.get(p.productUrl);
    const tag = `[cm ${i + 1}/${products.length}] ${p.name}`;

    if (isFresh(prevResult, ttlMinutes, now)) {
      log(`${tag} … cached (${(prevResult.offers || []).length} offers)`);
      // Reuse the offers, but re-apply the current config fields — a renamed group or
      // a corrected set code should show up now, not once the TTL happens to expire.
      results.push({ ...p, offers: prevResult.offers || [], fetchedAt: prevResult.fetchedAt });
      continue;
    }
    if (!scrapeSet.has(p.productUrl)) {
      // Due, but out of allowance. Not an error — keep the old prices and let a later
      // run pick it up; it sorts to the front of the queue as the stalest card.
      log(`${tag} … deferred (budget)`);
      results.push(carryForward(p, prevResult, null));
      continue;
    }
    if (fatal) {
      // Out of credits: keep whatever we had rather than blanking the card.
      results.push(carryForward(p, prevResult, fatal));
      continue;
    }

    write(`${tag} … `);
    try {
      const html = await scrapeHtml(p.productUrl, { apiKey, country, retryBackoffMs });
      scraped++;
      const offers = parseCardmarket(html);
      log(`${offers.length} offers`);
      results.push({ ...p, productUrl: p.productUrl, offers, fetchedAt: new Date(now).toISOString() });
    } catch (e) {
      scraped++; // a failed scrape can still cost a credit; count it so the log stays honest
      log("failed: " + e.message);
      if (e instanceof FirecrawlFatal) fatal = e.message;
      results.push(carryForward(p, prevResult, e.message));
    }
    if (i < products.length - 1) await sleep(paceMs);
  }

  // Measured cost per scrape — the only trustworthy number, since a Cloudflare-triggered
  // stealth retry bills more than a plain fetch and neither side reports it per request.
  if (credits && scraped) {
    const after = await getCredits(apiKey);
    if (after) {
      const spent = credits.remaining - after.remaining;
      log(`Firecrawl: spent ${spent} credit(s) on ${scraped} scrape(s) ` +
        `(${(spent / scraped).toFixed(1)}/scrape), ${after.remaining} remaining`);
    }
  }

  const usedBefore = meta && meta.day === utcDay(now) ? meta.scrapes || 0 : 0;
  return {
    results,
    scraped,
    meta: { day: utcDay(now), scrapes: usedBefore + scraped },
  };
}

// Keep the last known offers (and their original fetchedAt, so the next run retries
// instead of treating the failure as a fresh scrape). `error` is null for a card that
// was merely deferred — that is a budget decision, not a fault.
function carryForward(product, prevResult, error) {
  const out = {
    ...product,
    productUrl: product.productUrl,
    offers: prevResult ? prevResult.offers || [] : [],
    fetchedAt: prevResult ? prevResult.fetchedAt || null : null,
  };
  if (error) out.error = error;
  return out;
}

module.exports = {
  fetchAll,
  isFresh,
  budgetLeft,
  utcDay,
  getCredits,
  DEFAULT_TTL_MINUTES,
  DEFAULT_DAILY_BUDGET,
  DEFAULT_MIN_CREDITS,
};
