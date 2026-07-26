// SERVER-SIDE Cardmarket fetching. It does not work, and this module exists mainly to say
// so precisely and to keep the door open.
//
// **The working path is the browser, not the server** — see docs/cardmarket-extension.md.
// The dashboard reads Cardmarket through the extension in extension/, using your own
// logged-in session, and `off` below is the correct production setting.
//
// Measured 2026-07-26, all against a real product page:
//   plain curl, residential IP ........ 403 "Just a moment"   (Cloudflare)
//   headless Chrome, residential IP ... 403 "Attention Required"
//   headed Chrome, fresh profile ...... 403 "Just a moment"
// The only thing that worked was a long-lived Chrome profile that had already earned a
// cf_clearance cookie. That cookie is bound to the IP + TLS fingerprint + User-Agent that
// solved the challenge, so it cannot be exported to a server: from an Azure IP it is
// rejected on sight.
//
// Transports (config.cardmarketFetch, or the CARDMARKET_FETCH env var):
//   "off"    (default, and correct) — emit a paused row that the browser fills in.
//   "direct" — plain fetch. Expected to fail; kept so `node cloud/probe-cardmarket.js
//              direct` can re-test whether Cloudflare has loosened, and prove that a
//              failure is transport-level rather than a parser regression.
//   "proxy"  — route through a scraping/residential-proxy service. Implemented but NOT
//              recommended: it costs money, breaks often, is against Cardmarket's Terms of
//              Use, and risks the account — and the extension makes it unnecessary. Set
//              CARDMARKET_PROXY_URL to a template containing {url} (and optionally {key},
//              from CARDMARKET_PROXY_KEY).
//
// If Cardmarket ever grants API access (currently closed to new applicants, and
// restricted to large sellers), prefer that over any of the above: add an "api"
// transport here and delete the scraping paths.

// One copy of the selectors, shared with the browser (the extension bridge parses in the
// page). See shared/cardmarket-parse.js.
const { parseCardmarket, looksChallenged } = require("../shared/cardmarket-parse");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cardmarket is aggressively rate-limited even when a transport works, so pace
// requests far more conservatively than CardTrader's API.
const CARDMARKET_WAIT_MS = 3000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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
  if (looksChallenged(body)) {
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
