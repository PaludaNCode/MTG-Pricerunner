// End-to-end test of the page side of the Cardmarket path, in a real browser: the UMD
// load, the postMessage protocol against a stubbed bridge, parsing, the challenge
// diagnosis, and the cache that stops the 60s dashboard refresh from re-scraping.
//
// The bridge is stubbed rather than loading the real extension, so this tests our code
// (which is what can regress) without needing a Cardmarket session.
//
// Served over http because the postMessage protocol targets window.location.origin, which
// is opaque on about:blank/file:/data: URLs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SHARED = path.join(ROOT, "shared");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  chromium = null;
}

const row = (id, price, seller) =>
  `<div id="articleRow${id}" class="article-row">
     <a href="/en/Magic/Users/${seller}">${seller}</a>
     <span class="article-condition condition-NM"></span>
     <span class="fw-bold">${price} €</span>
     <span class="item-count">2</span>
     <button class="btn-primary">cart</button>
   </div>`;

const PAGES = {
  "https://www.cardmarket.com/a": `<html><body>${row(1, "3,50", "SellerA")}${row(2, "4,00", "SellerB")}</body></html>`,
  "https://www.cardmarket.com/b": "<html><head><title>Just a moment...</title></head><body></body></html>",
};

const HARNESS = `<!doctype html><meta charset="utf-8">
<script src="/cardmarket-parse.js"></script>
<script src="/cardmarket-client.js"></script>
<script>
  // Stub bridge: same protocol as extension/bridge.js, canned responses.
  window.__fetchCount = 0;
  const PAGES = ${JSON.stringify(PAGES)};
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const m = ev.data;
    if (!m || m.source !== "mtg-pricerunner") return;
    if (m.type === "CM_BRIDGE_PING") {
      window.postMessage({ source: "mtg-pricerunner-bridge", type: "CM_BRIDGE_READY" }, location.origin);
      return;
    }
    if (m.type === "CM_FETCH") {
      window.__fetchCount++;
      const html = PAGES[m.url];
      window.postMessage(
        { source: "mtg-pricerunner-bridge", type: "CM_RESULT", id: m.id,
          ok: html !== undefined, status: html !== undefined ? 200 : 404,
          html, error: html === undefined ? "not found" : undefined },
        location.origin
      );
    }
  });
</script>`;

function serve() {
  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(HARNESS);
    }
    const file = path.join(SHARED, path.basename(url));
    if (file.endsWith(".js") && fs.existsSync(file)) {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(404);
    res.end("nope");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test(
  "client detects the bridge, parses offers, flags a challenge, and caches",
  { skip: !chromium && "playwright unavailable", timeout: 120000 },
  async () => {
    const server = await serve();
    const port = server.address().port;
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);

      const detected = await page.evaluate(() => CardmarketClient.detect(3000));
      assert.equal(detected, true, "the client must detect a bridge that announces itself");

      const first = await page.evaluate(async () => {
        const rows = [
          { site: "cardmarket", productUrl: "https://www.cardmarket.com/a", offers: [], error: "paused" },
          { site: "cardmarket", productUrl: "https://www.cardmarket.com/b", offers: [], error: "paused" },
        ];
        await CardmarketClient.fillOffers(rows);
        return { rows, fetches: window.__fetchCount };
      });

      // Row A: real HTML -> parsed offers, and the "paused" placeholder error is cleared.
      const a = first.rows[0];
      assert.equal(a.offers.length, 2);
      assert.equal(a.offers[0].price, 3.5);
      assert.equal(a.offers[0].priceStr, "3.50 €");
      assert.equal(a.offers[0].seller, "SellerA");
      assert.equal(a.offers[0].condition, "NM");
      assert.equal(a.error, undefined, "a successful row must clear the paused placeholder");

      // Row B: Cloudflare interstitial must be reported as a challenge, NOT as "no offers".
      const b = first.rows[1];
      assert.equal(b.offers.length, 0);
      assert.match(b.error, /challenge/i);
      assert.doesNotMatch(b.error, /no offers/i);

      assert.equal(first.fetches, 2, "both rows should have been fetched once");

      // The dashboard re-renders every 60s; a second pass must be served from cache so
      // Cardmarket isn't hit again.
      const second = await page.evaluate(async () => {
        const rows = [
          { site: "cardmarket", productUrl: "https://www.cardmarket.com/a", offers: [] },
          { site: "cardmarket", productUrl: "https://www.cardmarket.com/b", offers: [] },
        ];
        await CardmarketClient.fillOffers(rows);
        return { offers: rows[0].offers.length, fetches: window.__fetchCount };
      });
      assert.equal(second.offers, 2, "cached offers must still be applied");
      assert.equal(second.fetches, 2, "a cached pass must issue no new fetches");

      // ...and force must override the cache, otherwise a manual refresh could never work.
      const forced = await page.evaluate(async () => {
        const rows = [{ site: "cardmarket", productUrl: "https://www.cardmarket.com/a", offers: [] }];
        await CardmarketClient.fillOffers(rows, { force: true });
        return window.__fetchCount;
      });
      assert.equal(forced, 3, "force:true must bypass the cache");
    } finally {
      await browser.close();
      server.close();
    }
  }
);

test("client degrades silently when no bridge answers", { skip: !chromium && "playwright unavailable", timeout: 60000 }, async () => {
  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // Load the scripts without the stub bridge, so nothing ever answers the ping.
    await page.goto(`http://127.0.0.1:${port}/blank.html`).catch(() => {});
    await page.setContent("<!doctype html><meta charset=utf-8>");
    await page.addScriptTag({ url: `http://127.0.0.1:${port}/cardmarket-parse.js` });
    await page.addScriptTag({ url: `http://127.0.0.1:${port}/cardmarket-client.js` });
    const detected = await page.evaluate(() => CardmarketClient.detect(600));
    assert.equal(detected, false, "detect must resolve false rather than hang when the extension is absent");
  } finally {
    await browser.close();
    server.close();
  }
});
