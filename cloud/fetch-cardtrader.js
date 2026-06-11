// Builds web/data.json from the CardTrader JSON API for all cardtrader products in config.json.
// Zero-dependency (Node 18+ global fetch). Paced to avoid 429. Cardmarket is ignored here.
const fs = require("fs");
const path = require("path");
const { normalizeCards } = require("../shared/cards");

const ROOT = path.join(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const OUT = path.join(__dirname, "web", "data.json");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAIT_MS = 5000; // pace between cards
const PAGE_WAIT_MS = 400; // pace between pages of one card

async function getRates() {
  try {
    const r = await fetch("https://api.frankfurter.app/latest?base=EUR&symbols=USD,GBP,CHF,CAD,AUD,JPY,SEK,DKK,NOK,PLN,CZK");
    const j = await r.json();
    return { EUR: 1, ...j.rates };
  } catch {
    return { EUR: 1 };
  }
}
const toEur = (amt, cur, rates) => {
  if (amt == null) return null;
  const r = rates[(cur || "EUR").toUpperCase()];
  return r ? amt / r : null;
};

async function fetchCard(product, rates) {
  const base = `https://www.cardtrader.com/en/cards/${product.blueprintId}.json`;
  const offers = [];
  for (let page = 1; page <= 12; page++) {
    let res;
    for (let tries = 0; tries < 4; tries++) {
      res = await fetch(`${base}?page=${page}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (res.status !== 429) break;
      await sleep(2000 * (tries + 1)); // back off hard on rate limit
    }
    if (!res.ok) {
      if (page === 1) return { ...product, productUrl: cardUrl(product), offers: [], error: "HTTP " + res.status };
      break;
    }
    const data = await res.json();
    const products = data.products || [];
    for (const o of products) {
      const ph = o.properties_hash || {};
      const lang = (ph.mtg_language || "").toLowerCase() || null;
      if (product.language && lang !== product.language.toLowerCase()) continue;
      const cents = o.layered_price_cents ?? o.price_cents ?? null;
      const rawAmt = cents != null ? cents / 100 : null;
      const rawCur = (o.price_currency || "EUR").toUpperCase();
      const eur = rawCur === "EUR" ? rawAmt : toEur(rawAmt, rawCur, rates);
      offers.push({
        price: eur != null ? eur : rawAmt,
        priceStr: eur != null ? eur.toFixed(2) + " €" : rawAmt != null ? rawAmt.toFixed(2) + " " + rawCur : null,
        foil: !!ph.mtg_foil,
        condition: ph.condition || null,
        qty: o.quantity ?? null,
        seller: o.user ? o.user.username : null,
        language: lang,
        // Ship column = CardTrader Zero eligibility (hub-shippable).
        shipsToMe: !!(o.user && o.user.can_sell_via_hub),
      });
    }
    if (data.products_last_page_reached || products.length === 0) break;
    await sleep(PAGE_WAIT_MS);
  }
  return { ...product, productUrl: cardUrl(product), offers };
}
const cardUrl = (p) => `https://www.cardtrader.com/en/cards/${p.blueprintId}`;

(async () => {
  const products = normalizeCards(CONFIG).filter((p) => p.site === "cardtrader");
  const rates = await getRates();
  const results = [];
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    process.stdout.write(`[${i + 1}/${products.length}] ${p.name} … `);
    const r = await fetchCard(p, rates);
    console.log(`${r.offers.length} offers${r.error ? " (" + r.error + ")" : ""}`);
    results.push(r);
    if (i < products.length - 1) await sleep(WAIT_MS);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), results }, null, 0));
  console.log("wrote " + OUT);
})();
