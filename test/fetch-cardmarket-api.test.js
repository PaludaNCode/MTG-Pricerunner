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

// Each handler gets { n, method, url, body } and returns [status, jsonBody].
// Every request is recorded in `seen` (scrapes and credit-usage calls alike).
async function withStub(handler, run) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null; // GET /credit-usage has no body
      seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body });
      const [status, json] = handler({ n: seen.length, method: req.method, url: req.url, body });
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
        apiKey: "fc-test", perRunLimit: 10, now: NOW, ...FAST,
      });
      assert.equal(seen.length, 1, "402 must not be retried, and must not be re-tried per card");
      assert.equal(scraped, 1);
      assert.equal(results.length, 3);
      for (const r of results) assert.match(r.error, /402|credits/);
    },
  );
});

// Requests split by endpoint — the credit-usage GETs are bookkeeping, not scrapes.
const scrapesIn = (seen) => seen.filter((s) => s.url === "/v2/scrape");
const byUrl = (credits, page) => ({ url }) =>
  url === "/v2/team/credit-usage" ? [200, credits] : [200, { success: true, data: { rawHtml: page } }];

test("the per-run limit caps a single wake, whatever the queue looks like", async () => {
  await withStub(
    () => [200, { success: true, data: { rawHtml: PAGE } }],
    async (mod, seen) => {
      const { scraped } = await mod.fetchAll([product(1), product(2), product(3), product(4)], {
        apiKey: "fc-test", perRunLimit: 2, now: NOW, ...FAST,
      });
      assert.equal(scraped, 2, "an hourly job must not spend the whole day in one wake");
      assert.equal(scrapesIn(seen).length, 2);
    },
  );
});

test("when the budget is smaller than the queue, the stalest cards go first", async () => {
  await withStub(
    () => [200, { success: true, data: { rawHtml: PAGE } }],
    async (mod, seen) => {
      // Card 2 is the oldest, then card 3, then card 1 — none of them fresh.
      const at = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
      const prev = [
        { site: "cardmarket", productUrl: product(1).productUrl, fetchedAt: at(7), offers: [] },
        { site: "cardmarket", productUrl: product(2).productUrl, fetchedAt: at(40), offers: [] },
        { site: "cardmarket", productUrl: product(3).productUrl, fetchedAt: at(20), offers: [] },
      ];
      const { scraped, meta } = await mod.fetchAll([product(1), product(2), product(3)], {
        apiKey: "fc-test", prev, ttlMinutes: 360, perRunLimit: 1, now: NOW, ...FAST,
      });

      assert.equal(scraped, 1);
      assert.deepEqual(
        scrapesIn(seen).map((s) => s.body.url),
        [product(2).productUrl],
        "the 40h-old card should win the only slot",
      );
      assert.equal(meta.day, "2026-08-16");
      assert.equal(meta.scrapes, 1);
    },
  );
});

test("a card with no previous result sorts ahead of every dated one", async () => {
  await withStub(
    () => [200, { success: true, data: { rawHtml: PAGE } }],
    async (mod, seen) => {
      const prev = [
        {
          site: "cardmarket",
          productUrl: product(1).productUrl,
          fetchedAt: new Date(NOW - 40 * 3600 * 1000).toISOString(),
          offers: [],
        },
      ];
      await mod.fetchAll([product(1), product(2)], {
        apiKey: "fc-test", prev, ttlMinutes: 360, perRunLimit: 1, now: NOW, ...FAST,
      });
      assert.deepEqual(
        scrapesIn(seen).map((s) => s.body.url),
        [product(2).productUrl],
        "the never-fetched card should be scraped before the 40h-old one",
      );
    },
  );
});

test("the daily credit allowance, not the scrape count, decides how much a run may spend", async () => {
  await withStub(
    // 1000 remaining, no billing period -> 1000/30 = 33.3 credits/day. At the assumed
    // 5 credits a scrape that affords 6, but 30 are already spent today, leaving 3.3 -> 0.
    byUrl({ success: true, data: { remainingCredits: 1000 } }, PAGE),
    async (mod, seen) => {
      const { scraped } = await mod.fetchAll([product(1), product(2)], {
        apiKey: "fc-test",
        checkCredits: true,
        perRunLimit: 5,
        minCredits: 25,
        monthlyCredits: 1000,
        meta: { day: "2026-08-16", scrapes: 6, credits: 30 },
        now: NOW,
        ...FAST,
      });
      assert.equal(scraped, 0, "today's allowance is already spent");
      assert.equal(scrapesIn(seen).length, 0);
    },
  );
});

test("a measured cost per scrape replaces the pessimistic assumption", async () => {
  await withStub(
    byUrl({ success: true, data: { remainingCredits: 1000 } }, PAGE),
    async (mod, seen) => {
      // 33.3/day allowance. costPerScrape 1 (measured) affords 33; perRunLimit caps at 4.
      const { scraped } = await mod.fetchAll([product(1), product(2), product(3), product(4)], {
        apiKey: "fc-test",
        checkCredits: true,
        perRunLimit: 4,
        monthlyCredits: 1000,
        meta: { day: "2026-08-16", scrapes: 0, credits: 0, costPerScrape: 1 },
        now: NOW,
        ...FAST,
      });
      assert.equal(scraped, 4, "a cheap measured cost should unlock more scrapes");
      assert.equal(scrapesIn(seen).length, 4);
    },
  );
});

test("the credit floor is respected even with budget to spare", async () => {
  await withStub(
    byUrl({ success: true, data: { remainingCredits: 30 } }, PAGE),
    async (mod, seen) => {
      // 30 remaining - 25 reserve = 5 spendable, at an assumed 5/scrape = exactly 1.
      const { scraped } = await mod.fetchAll([product(1), product(2), product(3)], {
        apiKey: "fc-test", checkCredits: true, perRunLimit: 5, minCredits: 25, now: NOW, ...FAST,
      });
      assert.equal(scraped, 1);
      assert.equal(scrapesIn(seen).length, 1);
    },
  );
});

test("an exhausted balance scrapes nothing and flags no error", async () => {
  await withStub(
    byUrl({ success: true, data: { remainingCredits: 10 } }, PAGE),
    async (mod, seen) => {
      const { scraped, results } = await mod.fetchAll([product(1)], {
        apiKey: "fc-test", checkCredits: true, perRunLimit: 5, minCredits: 25, now: NOW, ...FAST,
      });
      assert.equal(scraped, 0);
      assert.equal(scrapesIn(seen).length, 0);
      assert.equal(results[0].error, undefined, "a deferred card is not an error");
    },
  );
});

test("an unreadable balance falls back to the coarse scrape counter", async () => {
  await withStub(
    ({ url }) =>
      url === "/v2/team/credit-usage"
        ? [500, { error: "nope" }]
        : [200, { success: true, data: { rawHtml: PAGE } }],
    async (mod, seen) => {
      const { scraped } = await mod.fetchAll([product(1), product(2), product(3)], {
        apiKey: "fc-test",
        checkCredits: true,
        perRunLimit: 5,
        dailyBudget: 4,
        meta: { day: "2026-08-16", scrapes: 2 }, // 2 of 4 already used
        now: NOW,
        ...FAST,
      });
      assert.equal(scraped, 2, "a broken endpoint must not mean unlimited spending");
      assert.equal(scrapesIn(seen).length, 2);
    },
  );
});

test("the run books what it actually spent and learns the cost", async () => {
  let remaining = 1000;
  await withStub(
    ({ url }) => {
      if (url === "/v2/team/credit-usage") return [200, { success: true, data: { remainingCredits: remaining } }];
      remaining -= 3; // this account bills 3 credits a scrape
      return [200, { success: true, data: { rawHtml: PAGE } }];
    },
    async (mod) => {
      const { scraped, meta } = await mod.fetchAll([product(1), product(2)], {
        apiKey: "fc-test", checkCredits: true, perRunLimit: 2, monthlyCredits: 1000, now: NOW, ...FAST,
      });
      assert.equal(scraped, 2);
      assert.equal(meta.credits, 6, "measured spend, not an estimate");
      assert.equal(meta.costPerScrape, 3, "first measurement is taken at face value");
    },
  );
});
