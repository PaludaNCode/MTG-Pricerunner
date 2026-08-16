// The TTL is what keeps Firecrawl credit use bounded, so it gets its own tests:
// a wrong answer here either burns the quota or freezes prices on the page.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isFresh } = require("../cloud/fetch-cardmarket");

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
