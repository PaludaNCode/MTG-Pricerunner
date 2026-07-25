// Covers the cross-site orchestration in cloud/build-data.js. Every case here is
// Cardmarket-only with the transport "off", which does zero network I/O — so these
// tests stay offline and fast.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildData } = require("../cloud/build-data");

const cm = (name) => ({
  url: `https://www.cardmarket.com/en/Magic/Products/Singles/Aetherdrift/${name}?language=7`,
  group: name,
  variant: "Aetherdrift",
  code: "DFT",
});

test("a paused Cardmarket row is not treated as a failed refresh", async () => {
  const data = await buildData({
    config: { cardmarketFetch: "off", cards: [cm("Stock-Up")] },
    token: "dummy", // never used: no cardtrader entries
  });

  assert.equal(data.results.length, 1);
  const [r] = data.results;
  assert.equal(r.site, "cardmarket");
  assert.equal(r.paused, true);
  assert.deepEqual(r.offers, []);
  assert.match(r.error, /paused/i);
  assert.ok(!Number.isNaN(Date.parse(data.updatedAt)), "updatedAt must be an ISO timestamp");
});

test("results keep config order", async () => {
  const names = ["Stock-Up", "Memory-Guardian", "Flow-State"];
  const data = await buildData({
    config: { cardmarketFetch: "off", cards: names.map(cm) },
    token: "dummy",
  });
  assert.deepEqual(data.results.map((r) => r.group), names);
});

test("a missing CardTrader token is rejected up front", async () => {
  await assert.rejects(
    () => buildData({ config: { cards: [cm("Stock-Up")] }, token: "" }),
    /token is required/i
  );
});

test("every result carries the fields render.js reads", async () => {
  const data = await buildData({
    config: { cardmarketFetch: "off", cards: [cm("Stock-Up")] },
    token: "dummy",
  });
  for (const key of ["site", "group", "variant", "code", "productUrl", "offers"]) {
    assert.ok(key in data.results[0], `result is missing ${key}`);
  }
});
