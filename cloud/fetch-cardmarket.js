// Cardmarket offers, scraped through Firecrawl (https://api.firecrawl.dev).
//
// Why Firecrawl: Cardmarket sits behind Cloudflare, which 403s plain fetches from a
// datacentre IP (a GitHub runner). The old local watcher worked around that by driving
// a real signed-in Chrome over CDP — impossible in Actions. Firecrawl renders the page
// on its own (optionally stealth-proxied) infrastructure and hands back the HTML.
//
// Credits are the binding constraint, not rate limits. The budget is denominated in
// **credits, not scrapes**, because the cost of a scrape isn't knowable up front:
// `proxy: "auto"` silently escalates to the stealth proxy when Cloudflare bites, which
// bills several credits instead of one. A scrape-counted budget would therefore either
// under-spend the plan by ~5x or overrun it by ~5x, depending on which way we guessed.
//
// So: measure the balance before and after each pass, learn the real cost per scrape,
// and spend against a daily credit allowance derived from the live balance and the days
// left in the billing period. Under-spending one day raises tomorrow's allowance;
// overspending lowers it. Brakes, weakest to strongest:
//
//   1. Credit/day    — remaining balance ÷ days left in the period, minus what today
//                      already cost. This is the real ceiling for every run.
//   2. Credit floor  — never spend below `cardmarketMinCredits`, so the plan can't be zeroed.
//
// A TTL and a per-run limit also exist as defaults here, but every real run is started
// with force=true (the site's button, and the workflow's own default), which bypasses
// both — so they only apply if someone deliberately unticks force in the Actions UI.
// They were dropped from config.json rather than left there looking like live settings.
const { parseCardmarket, looksBlocked } = require("./cardmarket-parse");

// FIRECRAWL_API_URL matches the official SDK's env var; the tests point it at a stub.
const BASE = (process.env.FIRECRAWL_API_URL || "https://api.firecrawl.dev").replace(/\/$/, "");
const API = BASE + "/v2/scrape";
const CREDITS_API = BASE + "/v2/team/credit-usage";
const DEFAULT_TTL_MINUTES = 120;
const DEFAULT_DAILY_BUDGET = 6; // fallback cap, used only when the balance can't be read
const DEFAULT_MIN_CREDITS = 25;
const DEFAULT_PER_RUN_LIMIT = 2;
const DEFAULT_MONTHLY_CREDITS = 1000; // used only when the API reports no billing period
// The overnight quiet window, in UTC hours [start, end). Cardmarket has no scheduler —
// nothing but a human starts a scrape — so this guards the on-demand path: a press at
// 03:00 spends credits nobody is awake to look at. UTC because every other date in this
// system is: the ledger day rolls at 00:00 UTC and the allowance unlocks with it, so the
// window opens exactly when the fresh allowance does and closes before the day's use.
const DEFAULT_QUIET_START_HOUR = 0;
const DEFAULT_QUIET_END_HOUR = 8;
// Assume the expensive case until a run measures otherwise: guessing low burns the plan,
// guessing high only means a slower first day.
const ASSUMED_COST_PER_SCRAPE = 5;
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

// True while the clock is inside the quiet window. Equal bounds mean no window at all,
// which is how the guard is switched off from config. A window that wraps past midnight
// (start > end, e.g. 22-06) is read as the union of its two halves rather than as an
// empty range — the 0-8 default doesn't wrap, but a future edit to config shouldn't
// silently disable the guard.
function inQuietHours(now, startHour = DEFAULT_QUIET_START_HOUR, endHour = DEFAULT_QUIET_END_HOUR) {
  // A value that isn't a usable hour falls back to the default window rather than
  // disabling the guard: a typo in config.json must not silently reopen the night.
  // Only bounds that are explicitly equal switch the window off.
  const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : fallback);
  const start = num(startHour, DEFAULT_QUIET_START_HOUR);
  const end = num(endHour, DEFAULT_QUIET_END_HOUR);
  if (start === end) return false;
  const hour = new Date(now).getUTCHours();
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

// How many scrapes are still allowed today by the fallback scrape counter. Only used
// when the balance can't be read; the credit allowance below is the real control.
function budgetLeft(meta, dailyBudget, now) {
  if (!(dailyBudget > 0)) return 0;
  const used = meta && meta.day === utcDay(now) ? meta.scrapes || 0 : 0;
  return Math.max(0, dailyBudget - used);
}

// Credits already spent today (measured, not estimated), from the carried-over meta.
const creditsUsedToday = (meta, now) =>
  meta && meta.day === utcDay(now) ? meta.credits || 0 : 0;

// Whole days left in the billing period, including today. Falls back to a 30-day month
// when the plan reports no period (one-time credits), so the allowance still paces out.
function daysLeftInPeriod(periodEnd, now) {
  if (!periodEnd) return null;
  const end = Date.parse(periodEnd);
  if (!Number.isFinite(end) || end <= now) return null;
  return Math.max(1, Math.ceil((end - now) / 86400000));
}

// The self-correcting daily allowance: spendable balance ÷ days left. Recomputed every
// run, so a quiet day lifts tomorrow's ceiling and a heavy one lowers it — no drift, and
// no need to know the plan size.
function dailyCreditAllowance(credits, { minCredits, monthlyCredits, now }) {
  if (!credits) return null;
  const spendable = Math.max(0, credits.remaining - minCredits);
  const days = daysLeftInPeriod(credits.periodEnd, now);
  if (days) return spendable / days;
  // No billing period reported: pace the configured monthly figure over 30 days, but
  // never promise more than the balance actually holds.
  return Math.min(spendable, monthlyCredits / 30);
}

// Cost per scrape, learned from measured deltas and carried in meta. Smoothed so one
// odd run (a cheap cached hit, a retry storm) doesn't swing the budget.
function learnCost(previous, spent, scrapes) {
  if (!(scrapes > 0) || !(spent > 0)) return previous || null;
  const observed = spent / scrapes;
  if (!previous) return observed;
  return previous * 0.7 + observed * 0.3;
}

// Queue order: least-recently-*attempted* first, never-attempted before everything.
//
// Ordering on fetchedAt alone would be a trap. A card whose URL is wrong never gets a
// fetchedAt, so it would sort to the front on every single run, spend a credit failing,
// and starve every working card behind it — forever. Counting the failed attempt is what
// sends it to the back of the rotation instead.
const lastAttempt = (prev) => {
  if (!prev) return 0;
  const ok = prev.fetchedAt ? Date.parse(prev.fetchedAt) : 0;
  const tried = prev.triedAt ? Date.parse(prev.triedAt) : 0;
  return Math.max(ok || 0, tried || 0);
};

// …and after a few consecutive failures, stop paying to rediscover the same 404 every
// rotation. One retry a day is enough to pick a fixed URL back up.
const FAILURES_BEFORE_BACKOFF = 3;
const FAILURE_BACKOFF_MS = 24 * 3600 * 1000;
function inFailureBackoff(prev, now) {
  if (!prev || (prev.failures || 0) < FAILURES_BEFORE_BACKOFF || !prev.triedAt) return false;
  const since = now - Date.parse(prev.triedAt);
  return Number.isFinite(since) && since >= 0 && since < FAILURE_BACKOFF_MS;
}

// Narrows a run to named cards. The site's tick boxes send a comma-separated list of
// group names, so a scarce allowance can be aimed at the cards that matter today
// instead of being spread over the whole rotation. Empty/absent = every card.
// Unknown names are ignored rather than fatal: the list comes from a browser whose
// localStorage may predate a config edit.
function selectProducts(products, csv) {
  const wanted = String(csv || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!wanted.length) return products;
  const picked = products.filter((p) => wanted.includes(String(p.group || "").toLowerCase()));
  return picked.length ? picked : products;
}

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
      // A mistyped card slug is a 404 that Firecrawl reports as a *successful* scrape:
      // the parser then finds no article rows and the card silently shows no offers
      // forever, costing a credit every run. Fail loudly on the upstream status instead.
      const upstream = json.data.metadata && json.data.metadata.statusCode;
      // Thrown, not retried (a 404 stays a 404) — and a plain Error, not FirecrawlFatal,
      // so one bad URL fails its own card without stopping the rest of the pass.
      if (typeof upstream === "number" && upstream >= 400) {
        throw new Error(`Cardmarket returned HTTP ${upstream} — check the URL`);
      }
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

// products: normalized cardmarket products; prev: the last run's results array.
// Returns { results, scraped, meta } — meta is the bookkeeping the next run needs.
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
    perRunLimit = DEFAULT_PER_RUN_LIMIT,
    monthlyCredits = DEFAULT_MONTHLY_CREDITS,
    meta = null,
    checkCredits = false,
    onHtml = null, // (product, html) — used by --dump to save real pages for parser work
  } = opts;

  const prevByUrl = new Map();
  for (const r of prev) if (r && r.site === "cardmarket" && r.productUrl) prevByUrl.set(r.productUrl, r);

  // Everything past its TTL, stalest first.
  const due = products
    .filter((p) => {
      const prevResult = prevByUrl.get(p.productUrl);
      return !isFresh(prevResult, ttlMinutes, now) && !inFailureBackoff(prevResult, now);
    })
    .sort((a, b) => lastAttempt(prevByUrl.get(a.productUrl)) - lastAttempt(prevByUrl.get(b.productUrl)));

  // How many of them this run may actually pay for.
  let allowance = Math.max(0, perRunLimit);
  let credits = null;
  let allowanceCredits = 0;
  const costPerScrape = (meta && meta.costPerScrape) || ASSUMED_COST_PER_SCRAPE;

  if (checkCredits && due.length && allowance > 0) credits = await getCredits(apiKey);

  if (credits) {
    const perDay = dailyCreditAllowance(credits, { minCredits, monthlyCredits, now });
    allowanceCredits = perDay;
    const spentToday = creditsUsedToday(meta, now);
    const creditsLeftToday = Math.max(0, perDay - spentToday);
    const affordable = Math.floor(creditsLeftToday / costPerScrape);
    log(
      `Firecrawl: ${credits.remaining} credits${credits.plan ? "/" + credits.plan : ""}` +
        (credits.periodEnd ? `, period ends ${String(credits.periodEnd).slice(0, 10)}` : "") +
        ` · ${perDay.toFixed(1)}/day allowance, ${spentToday} spent today` +
        ` · ~${costPerScrape.toFixed(1)} credits/scrape${meta && meta.costPerScrape ? " (measured)" : " (assumed)"}` +
        ` → ${affordable} affordable`,
    );
    allowance = Math.min(allowance, affordable);
  } else if (checkCredits) {
    // Balance unreadable: fall back to the coarse scrape counter so a broken endpoint
    // can't turn into unlimited spending.
    allowance = Math.min(allowance, budgetLeft(meta, dailyBudget, now));
  }

  const scrapeSet = new Set(due.slice(0, allowance).map((p) => p.productUrl));
  const deferred = due.length - scrapeSet.size;
  if (deferred > 0) {
    log(`budget: scraping ${scrapeSet.size} of ${due.length} due card(s), ${deferred} deferred to a later run`);
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
      results.push(carryForward(p, prevResult, null, now));
      continue;
    }
    if (fatal) {
      // Out of credits: keep whatever we had rather than blanking the card.
      results.push(carryForward(p, prevResult, fatal, now));
      continue;
    }

    write(`${tag} … `);
    try {
      const html = await scrapeHtml(p.productUrl, { apiKey, country, retryBackoffMs });
      scraped++;
      if (onHtml) onHtml(p, html);
      const offers = parseCardmarket(html);
      log(`${offers.length} offers`);
      results.push({ ...p, productUrl: p.productUrl, offers, fetchedAt: new Date(now).toISOString() });
    } catch (e) {
      scraped++; // a failed scrape can still cost a credit; count it so the log stays honest
      log("failed: " + e.message);
      if (e instanceof FirecrawlFatal) fatal = e.message;
      results.push(carryForward(p, prevResult, e.message, now));
    }
    if (i < products.length - 1) await sleep(paceMs);
  }

  // Close the loop: re-read the balance, book what the pass actually cost against today,
  // and update the learned cost per scrape. This is the only trustworthy cost signal —
  // a stealth escalation bills more than a plain fetch and nothing reports it per request.
  let spent = 0;
  let learnedCost = (meta && meta.costPerScrape) || null;
  if (credits && scraped) {
    const after = await getCredits(apiKey);
    if (after) {
      spent = Math.max(0, credits.remaining - after.remaining);
      learnedCost = learnCost(learnedCost, spent, scraped);
      log(
        `Firecrawl: spent ${spent} credit(s) on ${scraped} scrape(s) ` +
          `(${(spent / scraped).toFixed(1)}/scrape), ${after.remaining} remaining`,
      );
    }
  }

  const sameDay = meta && meta.day === utcDay(now);
  const after = credits
    ? { remaining: credits.remaining - spent, allowance: Math.round(allowanceCredits * 10) / 10 }
    : null;
  return {
    results,
    scraped,
    meta: {
      day: utcDay(now),
      scrapes: (sameDay ? meta.scrapes || 0 : 0) + scraped,
      credits: (sameDay ? meta.credits || 0 : 0) + spent,
      ...(learnedCost ? { costPerScrape: Number(learnedCost.toFixed(2)) } : {}),
      // Published so the page can show the budget and grey out its refresh button
      // rather than firing a run that would defer every card. Not a secret, but it
      // does put the account balance in a public file.
      ...(after || {}),
    },
  };
}

// Keep the last known offers (and their original fetchedAt, so the next run retries
// instead of treating the failure as a fresh scrape). `error` is null for a card that
// was merely deferred — that is a budget decision, not a fault, so it records no attempt.
// A real failure does record one, which is what moves the card down the queue.
function carryForward(product, prevResult, error, now) {
  const out = {
    ...product,
    productUrl: product.productUrl,
    offers: prevResult ? prevResult.offers || [] : [],
    fetchedAt: prevResult ? prevResult.fetchedAt || null : null,
  };
  if (prevResult && prevResult.triedAt) out.triedAt = prevResult.triedAt;
  if (error) {
    out.error = error;
    out.triedAt = new Date(now).toISOString();
    out.failures = (prevResult && prevResult.failures ? prevResult.failures : 0) + 1;
  }
  return out;
}

module.exports = {
  fetchAll,
  selectProducts,
  isFresh,
  lastAttempt,
  inFailureBackoff,
  budgetLeft,
  utcDay,
  getCredits,
  daysLeftInPeriod,
  dailyCreditAllowance,
  learnCost,
  creditsUsedToday,
  inQuietHours,
  DEFAULT_TTL_MINUTES,
  DEFAULT_DAILY_BUDGET,
  DEFAULT_MIN_CREDITS,
  DEFAULT_PER_RUN_LIMIT,
  DEFAULT_MONTHLY_CREDITS,
  DEFAULT_QUIET_START_HOUR,
  DEFAULT_QUIET_END_HOUR,
};
