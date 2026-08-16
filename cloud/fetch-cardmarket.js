// Cardmarket offers, scraped through Firecrawl (https://api.firecrawl.dev).
//
// Why Firecrawl: Cardmarket sits behind Cloudflare, which 403s plain fetches from a
// datacentre IP (a GitHub runner). The old local watcher worked around that by driving
// a real signed-in Chrome over CDP — impossible in Actions. Firecrawl renders the page
// on its own (optionally stealth-proxied) infrastructure and hands back the HTML.
//
// Credits are the binding constraint, not rate limits: the data workflow runs every
// couple of minutes, and one scrape per card per run would burn a free plan in an hour.
// So every result carries a `fetchedAt` and is reused from the previous data.json until
// it ages past `cardmarketTtlMinutes`. Scrapes per day ≈ cards × 1440 / ttlMinutes.
const { parseCardmarket, looksBlocked } = require("./cardmarket-parse");

// FIRECRAWL_API_URL matches the official SDK's env var; the tests point it at a stub.
const API = (process.env.FIRECRAWL_API_URL || "https://api.firecrawl.dev").replace(/\/$/, "") + "/v2/scrape";
const DEFAULT_TTL_MINUTES = 360;
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

// Raised when the account is out of credits or the key is bad: retrying the remaining
// cards would fail identically, so the caller stops the whole Cardmarket pass.
class FirecrawlFatal extends Error {}

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
  } = opts;

  const prevByUrl = new Map();
  for (const r of prev) if (r && r.site === "cardmarket" && r.productUrl) prevByUrl.set(r.productUrl, r);

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

  return { results, scraped };
}

// Keep the last known offers (and their original fetchedAt, so the next run retries
// instead of treating the failure as a fresh scrape) and record why they're stale.
function carryForward(product, prevResult, error) {
  return {
    ...product,
    productUrl: product.productUrl,
    offers: prevResult ? prevResult.offers || [] : [],
    fetchedAt: prevResult ? prevResult.fetchedAt || null : null,
    error,
  };
}

module.exports = { fetchAll, isFresh, DEFAULT_TTL_MINUTES };
