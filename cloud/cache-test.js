// One-off diagnostic: is the stale-sold-listing problem a URL-keyed cache we can bust?
// Hits /marketplace/products for the two Raph & Mikey blueprints (both bought ~12h ago,
// both still returned by the API) with several cache-defeating variants and prints offer
// summaries + cache-related response headers. Never prints the token.
const TOKEN = process.env.CARDTRADER_TOKEN;
if (!TOKEN) {
  console.error("CARDTRADER_TOKEN env var is required");
  process.exit(1);
}

const BLUEPRINTS = [367956, 367873]; // Raph & Mikey: Showcase Collectors, TMNT base
const HEADERS_OF_INTEREST = [
  "age", "cache-control", "x-cache", "cf-cache-status", "x-cached",
  "x-cache-hit", "via", "etag", "last-modified", "date",
];

async function probe(label, url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + TOKEN, Accept: "application/json", ...extraHeaders },
  });
  const shownUrl = url.replace(/&_=\d+/, "&_=<ts>");
  console.log(`\n--- ${label}`);
  console.log(`GET ${shownUrl} -> HTTP ${res.status}`);
  for (const h of HEADERS_OF_INTEREST) {
    const v = res.headers.get(h);
    if (v) console.log(`  ${h}: ${v}`);
  }
  if (!res.ok) return;
  const data = await res.json();
  for (const bp of BLUEPRINTS) {
    const list = data[bp];
    if (!list) continue;
    const jp = list.filter((o) => ((o.properties_hash || {}).mtg_language || "").toLowerCase() === "jp");
    console.log(`  blueprint ${bp}: ${list.length} offers total, ${jp.length} jp:`);
    for (const o of jp) {
      const ph = o.properties_hash || {};
      console.log(`    ${o.user && o.user.username} | ${(o.price_cents / 100).toFixed(2)} ${o.price_currency} | qty ${o.quantity} | ${ph.mtg_foil ? "foil" : "nonfoil"} | ${ph.condition}`);
    }
  }
}

(async () => {
  for (const bp of BLUEPRINTS) {
    const base = `https://api.cardtrader.com/api/v2/marketplace/products?blueprint_id=${bp}`;
    await probe(`bp ${bp}: plain (what the fetcher does today)`, base);
    await probe(`bp ${bp}: cache-buster query param`, `${base}&_=${Date.now()}`);
    await probe(`bp ${bp}: no-cache request headers`, base, { "Cache-Control": "no-cache", Pragma: "no-cache" });
  }
  console.log("\ndone");
})();
