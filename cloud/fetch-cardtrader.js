// Builds cloud/web/data.json from the official CardTrader API for every cardtrader
// product in config.json. Zero-dependency (Node 18+ global fetch).
// Requires a CARDTRADER_TOKEN env var (GitHub Actions secret).
//
// The fetching itself lives in cloud/build-data.js, shared with the Azure timer
// function so both deployments publish byte-identical data.
const fs = require("fs");
const path = require("path");
const { buildData } = require("./build-data");

const ROOT = path.join(__dirname, "..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const OUT = path.join(__dirname, "web", "data.json");

const TOKEN = process.env.CARDTRADER_TOKEN;
if (!TOKEN) {
  console.error("CARDTRADER_TOKEN env var is required (CardTrader API bearer token)");
  process.exit(1);
}

(async () => {
  let data;
  try {
    data = await buildData({ config: CONFIG, token: TOKEN, log: (m) => console.log(m) });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data, null, 0));
  console.log("wrote " + OUT);
})();
