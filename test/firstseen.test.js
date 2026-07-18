// applyFirstSeen: stamps new-listing timestamps on cloud data.json offers by
// diffing CardTrader listing ids against the previous snapshot.
const test = require("node:test");
const assert = require("node:assert");
const { applyFirstSeen } = require("../cloud/fetch-cardtrader");

const NOW = "2026-07-18T12:00:00.000Z";
const EARLIER = "2026-07-17T08:00:00.000Z";

const snapshot = (offers) => ({ results: [{ site: "cardtrader", group: "Card", offers }] });

test("stamps offers absent from the previous snapshot with nowIso", () => {
  const results = snapshot([{ id: 1 }, { id: 2 }]).results;
  applyFirstSeen(results, snapshot([{ id: 1, firstSeenAt: EARLIER }]), NOW);
  assert.strictEqual(results[0].offers[0].firstSeenAt, EARLIER); // carried forward
  assert.strictEqual(results[0].offers[1].firstSeenAt, NOW); // newly seen
});

test("listing already in previous snapshot without a stamp stays unstamped (predates the feature)", () => {
  const results = snapshot([{ id: 1 }]).results;
  applyFirstSeen(results, snapshot([{ id: 1 }]), NOW);
  assert.strictEqual(results[0].offers[0].firstSeenAt, undefined);
});

test("no-op when previous snapshot has no listing ids (first run / old data.json)", () => {
  const results = snapshot([{ id: 1 }, { id: 2 }]).results;
  applyFirstSeen(results, snapshot([{ seller: "a", price: 1 }]), NOW);
  for (const o of results[0].offers) assert.strictEqual(o.firstSeenAt, undefined);
});

test("no-op when previous snapshot is unavailable", () => {
  const results = snapshot([{ id: 1 }]).results;
  applyFirstSeen(results, null, NOW);
  assert.strictEqual(results[0].offers[0].firstSeenAt, undefined);
});

test("offers without an id are left untouched", () => {
  const results = snapshot([{ seller: "a", price: 1 }]).results;
  applyFirstSeen(results, snapshot([{ id: 9, firstSeenAt: EARLIER }]), NOW);
  assert.strictEqual(results[0].offers[0].firstSeenAt, undefined);
});

test("matches ids across cards and errored results without offers", () => {
  const results = [
    { site: "cardtrader", group: "A", offers: [{ id: 10 }] },
    { site: "cardtrader", group: "B", error: "HTTP 500", offers: [] },
  ];
  const prev = {
    results: [
      { site: "cardtrader", group: "A", offers: [{ id: 10, firstSeenAt: EARLIER }] },
      { site: "cardtrader", group: "B", offers: [{ id: 11, firstSeenAt: EARLIER }] },
    ],
  };
  applyFirstSeen(results, prev, NOW);
  assert.strictEqual(results[0].offers[0].firstSeenAt, EARLIER);
});
