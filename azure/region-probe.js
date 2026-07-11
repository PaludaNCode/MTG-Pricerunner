// Runs inside a throwaway Azure Container Instance (see region-probe.sh) to answer,
// per region: (1) does Cloudflare let this datacenter's IP scrape the CardTrader
// website JSON at all, and (2) what country does the IP geolocate to — i.e. what does
// the geo-filter actually return here? Prints one summary block to stdout.
//
// Blueprints probed (override with a BLUEPRINTS env var, comma-separated):
//   27088  Bloodstained Mire (Onslaught) — busy card, ~34 JP offers via the official
//          API at the time of writing: a good geo-filter yardstick
//   367956 / 367873 Raph & Mikey — the sold-listing test case
const BLUEPRINTS = (process.env.BLUEPRINTS || "27088,367956,367873").split(",");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const region = process.env.PROBE_REGION || "?";
  let ipinfo = {};
  try {
    ipinfo = await (await fetch("https://ipinfo.io/json")).json();
  } catch (e) {
    ipinfo = { error: String(e) };
  }
  console.log(`region=${region} ip=${ipinfo.ip} geo=${ipinfo.country || "?"}/${ipinfo.city || "?"} org=${ipinfo.org || ipinfo.error || "?"}`);

  for (const bp of BLUEPRINTS) {
    try {
      const res = await fetch(`https://www.cardtrader.com/en/cards/${bp}.json`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      const ct = res.headers.get("content-type") || "";
      if (!res.ok || !ct.includes("json")) {
        const body = (await res.text()).slice(0, 120).replace(/\s+/g, " ");
        console.log(`  bp ${bp}: HTTP ${res.status}${ct.includes("json") ? "" : " NON-JSON (Cloudflare challenge/block?)"} :: ${body}`);
        continue;
      }
      const data = await res.json();
      const products = data.products || [];
      const jp = products.filter((p) => ((p.properties_hash || {}).mtg_language || "").toLowerCase() === "jp");
      const more = data.products_last_page_reached === false ? " (+more pages)" : "";
      console.log(`  bp ${bp}: ${products.length} offers on page 1, ${jp.length} jp${more}`);
    } catch (e) {
      console.log(`  bp ${bp}: FAILED ${e}`);
    }
    await sleep(1500);
  }
  console.log("probe done");
})();
