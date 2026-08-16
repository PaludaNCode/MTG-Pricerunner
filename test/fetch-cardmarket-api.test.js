// Exercises the Firecrawl call path against a local stub: the real thing can only be
// checked in Actions, so the request shape and every failure branch are pinned here.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const PAGE = `<div id="articleRow1">
  <a href="/en/Magic/Users/JPSeller">JPSeller</a>
  <span class="article-condition condition-NM"></span>
  <span class="fw-bold">12,34 €</span>
  <span class="item-count">2</span>
  <a href="/en/Login?redirectTo=x">log in</a>
</div>`;

// Each handler gets (req, body) and returns [status, jsonBody]. Requests are recorded.
async function withStub(handler, run) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      const [status, json] = handler(seen.length, body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.FIRECRAWL_API_URL = `http://127.0.0.1:${server.address().port}`;
  // Required after setting the env var: the module reads it once, at load.
  delete require.cache[require.resolve("../cloud/fetch-cardmarket")];
  const mod = require("../cloud/fetch-cardmarket");
  try {
    return await run(mod, seen);
  } finally {
    server.close();
    delete process.env.FIRECRAWL_API_URL;
    delete require.cache[require.resolve("../cloud/fetch-cardmarket")];
  }
}

const product = (n) => ({
  site: "cardmarket",
  group: "Card " + n,
  variant: "V",
  code: "SET",
  name: "Card " + n,
  productUrl: `https://www.cardmarket.com/en/Magic/Products/Singles/S/Card-${n}?language=7`,
});
const quiet = () => {};
// Keep the suite fast: the real backoff/pacing is seconds per retry.
const FAST = { log: quiet, write: quiet, retryBackoffMs: 1, paceMs: 0 };
const NOW = Date.parse("2026-08-16T12:00:00.000Z");

test("scrapes a card and asks Firecrawl for uncached raw HTML", async () => {
  await withStub(
    () => [200, { success: true, data: { rawHtml: PAGE } }],
    async (mod, seen) => {
      const { results, scraped } = await mod.fetchAll([product(1)], { apiKey: "fc-test", country: "DK", now: NOW, ...FAST });

      assert.equal(scraped, 1);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, "/v2/scrape");
      assert.equal(seen[0].auth, "Bearer fc-test");
      assert.deepEqual(seen[0].body.formats, ["rawHtml"]); // ids/classes must survive
      assert.equal(seen[0].body.maxAge, 0); // never serve a cached price
      assert.equal(seen[0].body.onlyMainContent, false);
      assert.deepEqual(seen[0].body.location, { country: "DK", languages: ["en"] });
      assert.equal(seen[0].body.url, product(1).productUrl);

      const [r] = results;
      assert.equal(r.site, "cardmarket");
      assert.equal(r.fetchedAt, new Date(NOW).toISOString());
      assert.equal(r.error, undefined);
      assert.equal(r.offers.length, 1);
      assert.equal(r.offers[0].price, 12.34);
      assert.equal(r.offers[0].seller, "JPSeller");
      assert.equal(r.offers[0].shipsToMe, null); // guest scrape
    },
  );
});

test("a still-fresh previous result costs no scrape", async () => {
  await withStub(
    () => [200, { success: true, data: { rawHtml: PAGE } }],
    async (mod, seen) => {
      const prev = [
        {
          site: "cardmarket",
          productUrl: product(1).productUrl,
          fetchedAt: new Date(NOW - 10 * 60000).toISOString(),
          offers: [{ price: 1 }],
        },
      ];
      const { results, scraped } = await mod.fetchAll([product(1)], {
        apiKey: "fc-test", prev, ttlMinutes: 60, now: NOW, ...FAST,
      });
      assert.equal(scraped, 0);
      assert.equal(seen.length, 0, "no HTTP call should be made");
      assert.deepEqual(results[0].offers, [{ price: 1 }]);
    },
  );
});

test("a Cloudflare interstitial is retried, then falls back to the previous offers", async () => {
  await withStub(
    () => [200, { success: true, data: { rawHtml: "<html>Just a moment...</html>" } }],
    async (mod, seen) => {
      const stale = new Date(NOW - 10 * 3600 * 1000).toISOString();
      const prev = [
        { site: "cardmarket", productUrl: product(1).productUrl, fetchedAt: stale, offers: [{ price: 9 }] },
      ];
      const { results } = await mod.fetchAll([product(1)], {
        apiKey: "fc-test", prev, ttlMinutes: 60, now: NOW, ...FAST,
      });
      assert.equal(seen.length, 3, "should retry the challenge before giving up");
      assert.deepEqual(results[0].offers, [{ price: 9 }], "keeps the last known offers");
      assert.equal(results[0].fetchedAt, stale, "keeps the old timestamp so the next run retries");
      assert.match(results[0].error, /Cloudflare/);
    },
  );
});

test("a card with no previous result reports the error and no offers", async () => {
  await withStub(
    () => [500, { error: "upstream boom" }],
    async (mod) => {
      const { results } = await mod.fetchAll([product(1)], { apiKey: "fc-test", now: NOW, ...FAST });
      assert.deepEqual(results[0].offers, []);
      assert.equal(results[0].fetchedAt, null);
      assert.match(results[0].error, /upstream boom/);
    },
  );
});

test("running out of credits stops the pass instead of retrying every card", async () => {
  await withStub(
    () => [402, { error: "Insufficient credits" }],
    async (mod, seen) => {
      const { results, scraped } = await mod.fetchAll([product(1), product(2), product(3)], {
        apiKey: "fc-test", now: NOW, ...FAST,
      });
      assert.equal(seen.length, 1, "402 must not be retried, and must not be re-tried per card");
      assert.equal(scraped, 1);
      assert.equal(results.length, 3);
      for (const r of results) assert.match(r.error, /402|credits/);
    },
  );
});
