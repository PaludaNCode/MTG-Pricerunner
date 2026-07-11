// Scrapes the public CardTrader website JSON (www.cardtrader.com/en/cards/<id>.json).
// This endpoint is geo-filtered by the requester's IP country — which is exactly why
// this runs in an EU Azure region: the offer list then matches what an EU buyer sees.
// Unlike api.cardtrader.com/api/v2/marketplace/products it reflects sales immediately
// (the official API kept returning sold listings 13+ hours after purchase, verified
// 2026-07-11 — server-side staleness, not bypassable by cache-busting).
// Zero-dependency (Node 18+ global fetch); the caller supplies normalized products.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAIT_MS = 2000; // pace between cards (429 backoff below handles bursts)
const PAGE_WAIT_MS = 400; // pace between pages of one card
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

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

// Pure mapping of one page of website-JSON products to the shared offer shape.
function mapPageOffers(pageProducts, product, rates) {
  const offers = [];
  for (const o of pageProducts) {
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
  return offers;
}

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
    const pageProducts = data.products || [];
    offers.push(...mapPageOffers(pageProducts, product, rates));
    if (data.products_last_page_reached || pageProducts.length === 0) break;
    await sleep(PAGE_WAIT_MS);
  }
  return { ...product, productUrl: cardUrl(product), offers };
}

// products: normalizeCards(config) output, already filtered to site === "cardtrader".
// log: optional line logger (context.log in the Function, console.log in a CLI).
async function scrapeAll(products, log = () => {}) {
  const rates = await getRates();
  const results = [];
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const r = await fetchCard(p, rates);
    log(`[${i + 1}/${products.length}] ${p.name} … ${r.offers.length} offers${r.error ? " (" + r.error + ")" : ""}`);
    results.push(r);
    if (i < products.length - 1) await sleep(WAIT_MS);
  }
  return { updatedAt: new Date().toISOString(), results };
}

module.exports = { scrapeAll, mapPageOffers, toEur };
