// Cardmarket support — PROTOTYPE. Parsing works; the *transport* is the blocker.
//
// Measured 2026-07-26, all against a real product page:
//   plain curl, residential IP ........ 403 "Just a moment"   (Cloudflare)
//   headless Chrome, residential IP ... 403 "Attention Required"
//   headed Chrome, fresh profile ...... 403 "Just a moment"
// The only thing that ever worked was the user's own long-lived Chrome profile, which
// had already earned a cf_clearance cookie. That cookie is bound to the IP + TLS
// fingerprint + User-Agent that solved the challenge, so it cannot be exported to a
// server: from an Azure IP it is rejected on sight.
//
// Consequence: there is no way to read Cardmarket offers from Azure using only
// first-party infrastructure. This module therefore isolates the one thing that would
// have to change — the transport — behind a single seam, so a working one can be
// dropped in without touching the parser or the data pipeline.
//
// Transports (config.cardmarketFetch, or the CARDMARKET_FETCH env var):
//   "off"    (default) — emit a paused row, fetch nothing. Keeps the live site clean.
//   "direct" — plain fetch. Expected to fail; useful to re-test whether Cloudflare has
//              loosened, and to prove the failure is transport-level, not parser-level.
//   "proxy"  — route through a scraping/residential-proxy service that solves the
//              challenge for you. Set CARDMARKET_PROXY_URL to a template containing
//              {url} (and optionally {key}, filled from CARDMARKET_PROXY_KEY), e.g.
//                https://api.scrapingbee.com/v1/?api_key={key}&render_js=true&url={url}
//              NOTE: third-party proxying of Cardmarket is against their Terms of Use
//              and risks the account/IP. Opt in deliberately, not by default.
//
// If Cardmarket ever grants API access (currently closed to new applicants, and
// restricted to large sellers), prefer that over any of the above: add an "api"
// transport here and delete the scraping paths.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cardmarket is aggressively rate-limited even when a transport works, so pace
// requests far more conservatively than CardTrader's API.
const CARDMARKET_WAIT_MS = 3000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const CHALLENGE_RE =
  /Just a moment|cf-browser-verification|Attention Required|Verify you are human|Access denied|cf-challenge/i;

// Parses a Cardmarket product page (guest or logged-in HTML) into normalized offers.
// Kept transport-agnostic and pure so it stays unit-testable with no network.
//
// Normalized offer shape used by the front-end:
// { price:Number|null, priceStr, currency, foil:Bool|null, condition, qty,
//   seller, location, language:String|null, shipsToMe:Bool|null, shipCost:String|null }
function parseCardmarket(html) {
  const offers = [];
  const rowStarts = [];
  const re = /id="articleRow(\d+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) rowStarts.push(m.index);
  for (let i = 0; i < rowStarts.length; i++) {
    const block = html.slice(rowStarts[i], i + 1 < rowStarts.length ? rowStarts[i + 1] : html.length);
    const pm = block.match(/fw-bold[^>]*>\s*([\d.]+),(\d{2})\s*(?:&euro;|€)/);
    let price = null;
    if (pm) price = parseFloat(pm[1].replace(/\./g, "") + "." + pm[2]);
    const sellerMatch = block.match(/\/Magic\/Users\/([^"?#]+)"/);
    const locMatch = block.match(/Item location:\s*([^"]+)"/);
    const condMatch = block.match(/article-condition condition-(\w+)/);
    const qtyMatch = block.match(/item-count[^>]*>\s*(\d+)\s*</);
    const isFoil = /title="Foil"|showMsgBox\(this,`Foil`\)/.test(block);
    // Ship-to-me (only meaningful when logged in): a greyed cart button / "does not ship
    // to your country" tooltip = can't buy; a normal cart button = ships to you.
    let shipsToMe;
    if (/Login\?redirectTo/i.test(block)) shipsToMe = null; // logged out → unknown
    else if (/btn-grey|does not ship to your country/i.test(block)) shipsToMe = false;
    else shipsToMe = true;
    if (price !== null || sellerMatch) {
      offers.push({
        price,
        priceStr: price !== null ? price.toFixed(2) + " €" : null,
        currency: "EUR",
        foil: isFoil,
        condition: condMatch ? condMatch[1].toUpperCase() : null,
        qty: qtyMatch ? parseInt(qtyMatch[1], 10) : null,
        seller: sellerMatch ? decodeURIComponent(sellerMatch[1]) : null,
        location: locMatch ? locMatch[1].trim() : null,
        language: null, // not reliably exposed by Cardmarket guest HTML
        shipsToMe, // true/false when logged in, null when logged out
        shipCost: null,
      });
    }
  }
  return offers;
}

// Resolves the transport name. Env wins over config so a deployment can flip it
// without a code change.
function resolveTransport(config = {}) {
  const t = (process.env.CARDMARKET_FETCH || config.cardmarketFetch || "off").toLowerCase();
  return ["off", "direct", "proxy"].includes(t) ? t : "off";
}

function proxyUrlFor(target) {
  const tpl = process.env.CARDMARKET_PROXY_URL;
  if (!tpl) throw new Error("CARDMARKET_PROXY_URL is required for the 'proxy' transport");
  return tpl
    .replace("{url}", encodeURIComponent(target))
    .replace("{key}", encodeURIComponent(process.env.CARDMARKET_PROXY_KEY || ""));
}

// Fetches one product page and returns its HTML, or throws with a diagnosis that
// distinguishes "Cloudflare stopped us" from an ordinary HTTP/network failure.
async function fetchProductHtml(productUrl, transport) {
  const target = transport === "proxy" ? proxyUrlFor(productUrl) : productUrl;
  const res = await fetch(target, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });
  const body = await res.text();
  if (CHALLENGE_RE.test(body.slice(0, 4000))) {
    throw new Error(
      `Cloudflare challenge (HTTP ${res.status}) — transport "${transport}" cannot reach Cardmarket`
    );
  }
  if (!res.ok) throw new Error("HTTP " + res.status);
  if (!body) throw new Error("empty response");
  return body;
}

// Fetches one Cardmarket product. Never throws: a failure becomes an `error` on the
// result so one blocked card can't sink the whole refresh.
async function fetchCardmarketCard(product, transport) {
  const base = { ...product, productUrl: product.url, offers: [] };
  if (transport === "off") {
    return {
      ...base,
      paused: true,
      error: "Cardmarket paused — no server-side transport (see cloud/cardmarket-core.js)",
    };
  }
  try {
    const html = await fetchProductHtml(product.url, transport);
    const offers = parseCardmarket(html);
    return { ...base, offers };
  } catch (e) {
    return { ...base, error: e.message };
  }
}

// Fetches every Cardmarket product, paced. Products are expected to be already
// normalized and filtered to site === "cardmarket".
async function fetchCardmarketAll(products, { config = {}, log = () => {} } = {}) {
  const transport = resolveTransport(config);
  const results = [];
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const r = await fetchCardmarketCard(p, transport);
    log(`[cardmarket ${i + 1}/${products.length}] ${p.name} … ${r.offers.length} offers${r.error ? " (" + r.error + ")" : ""}`);
    results.push(r);
    // "off" does no I/O, so don't pay the pacing cost for it.
    if (transport !== "off" && i < products.length - 1) await sleep(CARDMARKET_WAIT_MS);
  }
  return results;
}

module.exports = { parseCardmarket, fetchCardmarketCard, fetchCardmarketAll, resolveTransport };
