// The TTL is what keeps Firecrawl credit use bounded, so it gets its own tests:
// a wrong answer here either burns the quota or freezes prices on the page.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isFresh, budgetLeft, utcDay } = require("../cloud/fetch-cardmarket");

const NOW = Date.parse("2026-08-16T12:00:00.000Z");
const ago = (minutes) => ({ fetchedAt: new Date(NOW - minutes * 60000).toISOString() });

test("a result younger than the TTL is reused, an older one is re-scraped", () => {
  assert.equal(isFresh(ago(59), 60, NOW), true);
  assert.equal(isFresh(ago(61), 60, NOW), false);
});

test("a result with no fetchedAt is never fresh (carried-forward failure retries next run)", () => {
  assert.equal(isFresh({ fetchedAt: null, offers: [] }, 60, NOW), false);
  assert.equal(isFresh({ offers: [] }, 60, NOW), false);
  assert.equal(isFresh(undefined, 60, NOW), false);
  assert.equal(isFresh({ fetchedAt: "not a date" }, 60, NOW), false);
});

test("a zero or negative TTL disables reuse entirely", () => {
  assert.equal(isFresh(ago(1), 0, NOW), false);
  assert.equal(isFresh(ago(1), -5, NOW), false);
});

test("a fetchedAt in the future is not treated as fresh forever", () => {
  assert.equal(isFresh(ago(-120), 60, NOW), false);
});

test("the daily budget counts down and resets on the UTC day boundary", () => {
  const today = utcDay(NOW);
  assert.equal(today, "2026-08-16");

  assert.equal(budgetLeft(null, 12, NOW), 12); // no meta yet
  assert.equal(budgetLeft({ day: today, scrapes: 5 }, 12, NOW), 7);
  assert.equal(budgetLeft({ day: today, scrapes: 12 }, 12, NOW), 0);
  assert.equal(budgetLeft({ day: today, scrapes: 99 }, 12, NOW), 0, "never negative");
  // Yesterday's tally must not eat into today's allowance.
  assert.equal(budgetLeft({ day: "2026-08-15", scrapes: 12 }, 12, NOW), 12);
});

test("a zero or missing daily budget stops all scraping", () => {
  assert.equal(budgetLeft({ day: utcDay(NOW), scrapes: 0 }, 0, NOW), 0);
  assert.equal(budgetLeft(null, undefined, NOW), 0);
});
