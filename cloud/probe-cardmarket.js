// Diagnoses whether a Cardmarket transport can actually reach a product page, and
// whether the parser finds offers in what comes back. Prints the distinction that
// matters: "blocked by Cloudflare" vs "reached the page but parsed nothing".
//
// This is the one command to re-run when re-testing the Cardmarket question — from
// your PC, from an Azure Function console, or against a proxy service.
//
// Usage:
//   node cloud/probe-cardmarket.js direct
//   node cloud/probe-cardmarket.js direct "https://www.cardmarket.com/en/Magic/Products/Singles/..."
//   CARDMARKET_PROXY_URL='https://api.scrapingbee.com/v1/?api_key={key}&render_js=true&url={url}' \
//     CARDMARKET_PROXY_KEY=... node cloud/probe-cardmarket.js proxy
//
// Exit code 0 = offers parsed, 1 = transport blocked or nothing parsed.
const { parseCardmarket, fetchCardmarketCard } = require("./cardmarket-core");

const DEFAULT_URL =
  "https://www.cardmarket.com/en/Magic/Products/Singles/Aetherdrift/Stock-Up?language=7";

const transport = (process.argv[2] || "direct").toLowerCase();
const url = process.argv[3] || DEFAULT_URL;

if (!["direct", "proxy", "off"].includes(transport)) {
  console.error(`unknown transport "${transport}" (expected: direct | proxy | off)`);
  process.exitCode = 2;
  return;
}

(async () => {
  console.log(`transport : ${transport}`);
  console.log(`url       : ${url}`);
  if (transport === "proxy") {
    console.log(`proxy tpl : ${process.env.CARDMARKET_PROXY_URL || "(unset — will fail)"}`);
  }
  console.log("");

  const product = { site: "cardmarket", url, name: "probe", group: "probe", variant: "", code: null };
  const r = await fetchCardmarketCard(product, transport);

  if (r.error) {
    console.log(`RESULT: blocked — ${r.error}`);
    console.log("");
    console.log("Parser sanity check (offline, synthetic HTML):");
    const synthetic = parseCardmarket(
      '<div id="articleRow1"><a href="/en/Magic/Users/Probe"></a>' +
        '<span class="article-condition condition-NM"></span>' +
        '<span class="fw-bold">1,50 €</span><span class="item-count">2</span></div>'
    );
    console.log(`  parsed ${synthetic.length} offer(s) from synthetic HTML → parser is ${synthetic.length ? "fine" : "BROKEN"}`);
    console.log("  so the failure above is transport-level, not parser-level.");
    // Set exitCode rather than calling process.exit(): an abrupt exit while fetch's
    // sockets are still open trips a libuv assertion on Windows.
    process.exitCode = 1;
    return;
  }

  console.log(`RESULT: reached the page, parsed ${r.offers.length} offer(s)`);
  for (const o of r.offers.slice(0, 10)) {
    console.log(`  ${o.priceStr ?? "?"}  ${o.condition ?? "?"}  qty=${o.qty ?? "?"}  ${o.seller ?? "?"}  ${o.location ?? ""}`);
  }
  process.exitCode = r.offers.length ? 0 : 1;
})();
