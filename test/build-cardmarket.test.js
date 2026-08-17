// The credit ledger's day rollover.
//
// Requiring build-cardmarket.js only pulls in its helpers — main() is guarded behind
// require.main, so no config is scraped and no network is touched.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { carryMeta } = require("../cloud/build-cardmarket");

test("same day: the ledger is carried through untouched", () => {
  const prev = { day: "2026-08-17", scrapes: 4, credits: 4, costPerScrape: 1, remaining: 1200 };
  assert.deepEqual(carryMeta(prev, "2026-08-17"), prev);
});

// The bug this guards: costPerScrape used to be dropped with the counters, so the first
// run of each UTC day fell back to the 5-credit assumption and rated itself at a fifth of
// what it could afford — a full refresh would silently defer most of the list.
test("new day: counters reset but the measured cost per scrape survives", () => {
  const meta = carryMeta({ day: "2026-08-16", scrapes: 17, credits: 17, costPerScrape: 1 }, "2026-08-17");
  assert.equal(meta.day, "2026-08-17");
  assert.equal(meta.scrapes, 0, "today has spent nothing yet");
  assert.equal(meta.credits, 0);
  assert.equal(meta.costPerScrape, 1, "cost is a property of the plan, not of the date");
});

test("new day with nothing learned yet: no cost is invented", () => {
  const meta = carryMeta({ day: "2026-08-16", scrapes: 3, credits: 15 }, "2026-08-17");
  assert.equal(meta.costPerScrape, undefined, "absent means 'assume the pessimistic default'");
});

test("no previous ledger at all: a clean day", () => {
  assert.deepEqual(carryMeta(null, "2026-08-17"), { day: "2026-08-17", scrapes: 0, credits: 0 });
});

// Yesterday's balance readings describe yesterday's plan state. They are refreshed from
// the API on every run, so carrying them would only ever publish a stale number.
test("new day: the balance snapshot is not carried forward", () => {
  const meta = carryMeta(
    { day: "2026-08-16", scrapes: 17, credits: 17, costPerScrape: 1, remaining: 1196, allowance: 37.5 },
    "2026-08-17",
  );
  assert.equal(meta.remaining, undefined);
  assert.equal(meta.allowance, undefined);
});
