// Builds web/data.json from the official CardTrader API (api.cardtrader.com) for all
// cardtrader products in config.json. Zero-dependency (Node 18+ global fetch).
// Requires a CARDTRADER_TOKEN env var (GitHub Actions secret).
//
// Why the official API: the public website JSON (/en/cards/<id>.json) only returns
// offers shippable to the requester's IP country, so US-based GitHub runners silently
// miss most JP sellers. The authenticated API is not geo-filtered and returns the
// whole list in one request (no pagination). Cardmarket is ignored here.
const fs = require("fs");
const path = require("path");
const { normalizeCards } = require("../shared/cards");

const ROOT = path.join(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const OUT = path.join(__dirname, "web", "data.json");

const TOKEN = process.env.CARDTRADER_TOKEN;
if (!TOKEN) {
  console.error("CARDTRADER_TOKEN env var is required (CardTrader API bearer token)");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAIT_MS = 250; // pace between cards

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

const cardUrl = (p) => `https://www.cardtrader.com/en/cards/${p.blueprintId}`;

async function fetchCard(product, rates) {
  const url = `https://api.cardtrader.com/api/v2/marketplace/products?blueprint_id=${product.blueprintId}`;
  let res;
  for (let tries = 0; tries < 4; tries++) {
    res = await fetch(url, { headers: { Authorization: "Bearer " + TOKEN, Accept: "application/json" } });
    if (res.status !== 429) break;
    await sleep(2000 * (tries + 1)); // back off hard on rate limit
  }
  if (!res.ok) return { ...product, productUrl: cardUrl(product), offers: [], error: "HTTP " + res.status };

  const data = await res.json();
  const list = data[product.blueprintId] || [];
  const offers = [];
  for (const o of list) {
    const ph = o.properties_hash || {};
    const lang = (ph.mtg_language || "").toLowerCase() || null;
    if (product.language && lang !== product.language.toLowerCase()) continue;
    const rawAmt = o.price_cents != null ? o.price_cents / 100 : null;
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
  return { ...product, productUrl: cardUrl(product), offers };
}

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
