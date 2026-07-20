// Zero-dependency local price watcher for cardtrader.com + cardmarket.com
// Run:  node server.js   then open  http://localhost:8787
// Needs Node 18+ (uses built-in global fetch).

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { normalizeCards } = require("../shared/cards");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cloudflare 403s Node's built-in fetch (undici) on Cardmarket, but lets curl.exe through
// (when not rate-limited). Returns { status, body }.
function curlGet(url) {
  return new Promise((resolve, reject) => {
    execFile(
      "curl.exe",
      ["-s", "--compressed", "-w", "\\n%{http_code}", "-A", UA,
        "-H", "Accept-Language: en-US,en;q=0.9",
        "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", url],
      { maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        const nl = stdout.lastIndexOf("\n");
        const status = parseInt(stdout.slice(nl + 1).trim(), 10) || 0;
        resolve({ status, body: stdout.slice(0, nl) });
      }
    );
  });
}

const CONFIG_PATH = path.join(__dirname, "..", "config.json");
const SHARED_DIR = path.join(__dirname, "..", "shared");
const loadConfig = () => JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

// ---------- FX rates (EUR base, from ECB via frankfurter.app) ----------
let _rates = null;
let _ratesAt = 0;
async function getRates() {
  if (_rates && Date.now() - _ratesAt < 6 * 3600 * 1000) return _rates;
  try {
    const res = await fetch(
      "https://api.frankfurter.app/latest?base=EUR&symbols=USD,GBP,CHF,CAD,AUD,JPY,SEK,DKK,NOK,PLN,CZK"
    );
    const j = await res.json();
    _rates = { EUR: 1, ...j.rates }; // 1 EUR = rate[CUR]
    _ratesAt = Date.now();
  } catch (e) {
    if (!_rates) _rates = { EUR: 1 };
  }
  return _rates;
}
// Convert an amount in `currency` to EUR. Returns null if rate unknown.
function toEur(amount, currency, rates) {
  if (amount == null) return null;
  const r = rates[(currency || "EUR").toUpperCase()];
  return r ? amount / r : null;
}

// Normalized offer shape used by the front-end:
// { price:Number|null, priceStr, currency, foil:Bool|null, condition, qty,
//   seller, location, language:String|null, shipsToMe:Bool|null, shipCost:String|null }

// ---------- CardTrader (JSON API) ----------
async function fetchCardtrader(product, rates) {
  const base = `https://www.cardtrader.com/en/cards/${product.blueprintId}.json`;
  const offers = [];
  let pageUrl = `https://www.cardtrader.com/en/cards/${product.blueprintId}-x`; // human link
  for (let page = 1; page <= 12; page++) {
    // Retry on 429 (rate limit) with backoff so a burst of cards doesn't get blocked.
    let res;
    for (let tries = 0; tries < 3; tries++) {
      res = await fetch(`${base}?page=${page}`, {
        headers: { ...BROWSER_HEADERS, Accept: "application/json" },
      });
      if (res.status !== 429) break;
      await sleep(1500 * (tries + 1));
    }
    if (!res.ok) {
      if (page === 1) throw new Error("HTTP " + res.status);
      break;
    }
    const data = await res.json();
    const products = data.products || [];
    for (const o of products) {
      const ph = o.properties_hash || {};
      const lang = (ph.mtg_language || "").toLowerCase() || null;
      if (product.language && lang !== product.language.toLowerCase()) continue;
      // Seller's actual listed price (top-level), NOT the session-converted `price` object.
      // layered_price_cents matches what the site shows; price_currency is the seller's currency.
      const cents = o.layered_price_cents ?? o.price_cents ?? null;
      const rawAmt = cents != null ? cents / 100 : null;
      const rawCur = (o.price_currency || "EUR").toUpperCase();
      const eur = rawCur === "EUR" ? rawAmt : toEur(rawAmt, rawCur, rates);
      offers.push({
        price: eur != null ? eur : rawAmt,
        priceStr:
          eur != null ? eur.toFixed(2) + " €"
          : rawAmt != null ? rawAmt.toFixed(2) + " " + rawCur : null,
        currency: "EUR",
        foil: !!ph.mtg_foil,
        condition: ph.condition || null,
        qty: o.quantity ?? null,
        seller: o.user ? o.user.username : null,
        location: o.user ? o.user.country_code : null,
        language: lang,
        // For CardTrader the Ship column means "CardTrader Zero" eligibility (hub-shippable).
        shipsToMe: !!(o.user && o.user.can_sell_via_hub),
        shipCost: o.formatted_min_shipping_cost || null,
      });
    }
    if (data.products_last_page_reached || products.length === 0) break;
  }
  return { ...product, productUrl: `https://www.cardtrader.com/en/cards/${product.blueprintId}`, offers };
}

// ---------- Cardmarket (HTML scrape) ----------
const { parseCardmarket } = require("./cardmarket-parse");

async function fetchCardmarket(product) {
  const { status, body } = await curlGet(product.url);
  const blocked = /Just a moment|cf-browser-verification|Access denied|Attention Required/i.test(
    (body || "").slice(0, 3000)
  );
  if (status === 429 || blocked) {
    throw new Error(`Cardmarket blocked by Cloudflare (HTTP ${status || "?"}) — rate-limited`);
  }
  if (status >= 400 || !body) throw new Error("HTTP " + status);
  return { ...product, productUrl: product.url, offers: parseCardmarket(body) };
}

// ---------- Cardmarket via your own Chrome (CDP attach) ----------
// You start Chrome with --remote-debugging-port=9222 and open Cardmarket once so the
// Cloudflare challenge is cleared in YOUR trusted session. The server then reuses that
// browser to read the offer pages — no challenge, no extra fingerprint to flag.
const CDP_URL = "http://localhost:9222";
let _cdpBrowser = null;

async function getCdpContext() {
  if (_cdpBrowser && _cdpBrowser.isConnected()) {
    const ctxs = _cdpBrowser.contexts();
    if (ctxs.length) return ctxs[0];
  }
  const { chromium } = require("playwright");
  _cdpBrowser = await chromium.connectOverCDP(CDP_URL, { timeout: 5000 });
  _cdpBrowser.on("disconnected", () => {
    _cdpBrowser = null;
    _cmPage = null;
    _cmKeep = null;
  });
  const ctxs = _cdpBrowser.contexts();
  return ctxs[0] || (await _cdpBrowser.newContext());
}

// One reused scrape tab, kept in the BACKGROUND behind a blank "front" tab. Navigating
// a non-active tab doesn't raise the Chrome window, so it never steals OS focus — no
// minimizing, no window moving. (Foreground lock stays as a belt-and-suspenders backup.)
let _cmPage = null;
let _cmKeep = null;

async function fetchCardmarketCDP(product) {
  let ctx;
  try {
    ctx = await getCdpContext();
  } catch (e) {
    throw new Error(
      "Can't reach your Chrome. Start it with --remote-debugging-port=9222, open Cardmarket once, then leave it open."
    );
  }
  if (!_cmPage || _cmPage.isClosed()) {
    _cmPage = await ctx.newPage();
  }
  // Ensure a blank tab is the ACTIVE tab, created AFTER the scrape tab, so the scrape tab
  // is backgrounded. Then navigating it never pulls the window to the foreground.
  if (!_cmKeep || _cmKeep.isClosed()) {
    _cmKeep = await ctx.newPage();
    await _cmKeep.goto("about:blank").catch(() => {});
  }
  const page = _cmPage;
  // Navigations are ~70s apart (round-robin), so ERR_ABORTED is unlikely; retry once if it
  // happens (Cardmarket sometimes supersedes the nav with a consent/redirect).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(product.url, { waitUntil: "domcontentloaded", timeout: 45000 });
      break;
    } catch (e) {
      if (/ERR_ABORTED/.test(String(e.message)) && attempt === 0) {
        await sleep(1000);
        continue;
      }
      if (/ERR_ABORTED/.test(String(e.message))) break;
      throw e;
    }
  }
  try {
    await page.waitForSelector(".article-row", { timeout: 60000 });
  } catch (_) {
    const title = await page.title();
    if (/Just a moment|Attention Required|Verify you are human/i.test(title)) {
      throw new Error('Cloudflare challenge — click "Verify you are human" in your Chrome window once');
    }
    // No challenge and no rows = genuinely no offers for this card.
  }
  const html = await page.content();
  return { ...product, productUrl: product.url, offers: parseCardmarket(html) };
}

// Cardmarket is rate-limited by Cloudflare, so fetch each URL at most once per TTL
// (config.cardmarketTtlSec) and serve the cached result (or cached error) in between.
let CM_TTL = 60 * 1000;
const cmCache = new Map(); // url -> { at, result }

async function checkProduct(product, rates, cmMode) {
  try {
    if (product.site === "cardtrader") return await fetchCardtrader(product, rates);
    if (product.site === "cardmarket") {
      if (cmMode === "off") {
        return { ...product, productUrl: product.url, offers: [], paused: true,
          error: "Paused — Cardmarket fetching disabled (avoiding Cloudflare flag)" };
      }
      const cached = cmCache.get(product.url);
      const now = Date.now();
      if (cached && now - cached.at < CM_TTL) {
        const ageSec = Math.round((now - cached.at) / 1000);
        return { ...cached.result, cached: true, ageSec, nextInSec: Math.round((CM_TTL - (now - cached.at)) / 1000) };
      }
      let result;
      try {
        result = cmMode === "cdp" ? await fetchCardmarketCDP(product) : await fetchCardmarket(product);
      } catch (e) {
        result = { ...product, productUrl: product.url, error: String(e.message || e), offers: [] };
      }
      cmCache.set(product.url, { at: now, result });
      return { ...result, cached: false, ageSec: 0 };
    }
    return { ...product, error: "unknown site: " + product.site, offers: [] };
  } catch (e) {
    return { ...product, productUrl: product.url, error: String(e.message || e), offers: [] };
  }
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(__dirname, "index.html")));
    return;
  }
  if (url === "/favicon.svg") {
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    res.end(fs.readFileSync(path.join(SHARED_DIR, "favicon.svg")));
    return;
  }
  if (url === "/ui.css") {
    res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
    res.end(fs.readFileSync(path.join(SHARED_DIR, "ui.css")));
    return;
  }
  if (url === "/render.js" || url === "/app.js") {
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    res.end(fs.readFileSync(path.join(SHARED_DIR, url.slice(1))));
    return;
  }
  if (url === "/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(fs.readFileSync(CONFIG_PATH));
    return;
  }
  // /state and /check both return the latest rolling snapshot (instant — no fetching here).
  if (url === "/state" || url === "/check") {
    const cfg = loadConfig();
    const results = normalizeCards(cfg).map((p) => store.get(productKey(p)) || { ...p, offers: [], pending: true });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ updatedAt: state.updatedAt, current: state.current, results }));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

// ---------- Rolling background scraper ----------
// Continuously walks the product list, one card every WAIT ms, storing each result.
// The dashboard just reads /state; scraping cadence is decoupled from the page.
const WAIT_MS = 5000;
const store = new Map(); // productKey -> result (with updatedAt)
const state = { updatedAt: null, current: null };
const productKey = (p) => `${p.site}|${p.blueprintId || p.url}`;

async function scraperLoop() {
  let i = 0;
  for (;;) {
    let cfg;
    try {
      cfg = loadConfig();
    } catch (e) {
      await sleep(WAIT_MS);
      continue;
    }
    const products = normalizeCards(cfg);
    if (!products.length) {
      await sleep(WAIT_MS);
      continue;
    }
    if (i >= products.length) i = 0;
    const p = products[i];
    CM_TTL = (cfg.cardmarketTtlSec || 300) * 1000;
    const cmMode = cfg.cardmarketFetch || "curl";
    state.current = p.name;
    try {
      const rates = await getRates();
      const res = await checkProduct(p, rates, cmMode);
      res.updatedAt = new Date().toISOString();
      store.set(productKey(p), res);
      state.updatedAt = res.updatedAt;
    } catch (e) {
      store.set(productKey(p), { ...p, productUrl: p.url, offers: [], error: String(e.message || e), updatedAt: new Date().toISOString() });
    }
    state.current = null;
    i++;
    await sleep(WAIT_MS);
  }
}

const cfg = loadConfig();
const port = cfg.port || 8787;
server.listen(port, () => {
  console.log(`Price watcher running:  http://localhost:${port}`);
  console.log(`Rolling scraper: 1 card every ${WAIT_MS / 1000}s across ${normalizeCards(cfg).length} product(s).`);
  scraperLoop();
});
