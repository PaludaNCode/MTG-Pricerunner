// The TTL is what keeps Firecrawl credit use bounded, so it gets its own tests:
// a wrong answer here either burns the quota or freezes prices on the page.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  isFresh,
  budgetLeft,
  utcDay,
  daysLeftInPeriod,
  dailyCreditAllowance,
  learnCost,
  creditsUsedToday,
  lastAttempt,
  inFailureBackoff,
} = require("../cloud/fetch-cardmarket");

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

test("the daily allowance divides the spendable balance over the days left", () => {
  const in10Days = new Date(NOW + 10 * 86400000).toISOString();
  const opts = { minCredits: 25, monthlyCredits: 1000, now: NOW };

  // (525 - 25 reserve) / 10 days = 50 a day.
  assert.equal(dailyCreditAllowance({ remaining: 525, periodEnd: in10Days }, opts), 50);
  // Spending less today lifts the figure tomorrow; spending more lowers it. Self-correcting.
  assert.equal(dailyCreditAllowance({ remaining: 1025, periodEnd: in10Days }, opts), 100);
  // Never promise credits that are inside the reserve.
  assert.equal(dailyCreditAllowance({ remaining: 20, periodEnd: in10Days }, opts), 0);
});

test("with no billing period the allowance paces the configured monthly figure", () => {
  const opts = { minCredits: 25, monthlyCredits: 1000, now: NOW };
  assert.equal(dailyCreditAllowance({ remaining: 900, periodEnd: null }, opts), 1000 / 30);
  // …but still never more than the balance actually holds.
  assert.equal(dailyCreditAllowance({ remaining: 30, periodEnd: null }, opts), 5);
  assert.equal(dailyCreditAllowance(null, opts), null);
});

test("a period end in the past or unparseable falls back to monthly pacing", () => {
  assert.equal(daysLeftInPeriod(null, NOW), null);
  assert.equal(daysLeftInPeriod("nonsense", NOW), null);
  assert.equal(daysLeftInPeriod(new Date(NOW - 86400000).toISOString(), NOW), null);
  assert.equal(daysLeftInPeriod(new Date(NOW + 3 * 86400000).toISOString(), NOW), 3);
});

test("cost per scrape is smoothed, so one odd run can't swing the budget", () => {
  assert.equal(learnCost(null, 10, 2), 5); // first measurement taken as-is
  assert.equal(learnCost(5, 5, 5), 5 * 0.7 + 1 * 0.3); // drifts toward the new observation
  assert.equal(learnCost(5, 0, 2), 5, "a zero-cost run (cached hits) is ignored");
  assert.equal(learnCost(5, 10, 0), 5, "no scrapes means nothing to learn");
});

test("credits spent today reset with the UTC day", () => {
  assert.equal(creditsUsedToday({ day: "2026-08-16", credits: 12 }, NOW), 12);
  assert.equal(creditsUsedToday({ day: "2026-08-15", credits: 12 }, NOW), 0);
  assert.equal(creditsUsedToday(null, NOW), 0);
});

test("queue order counts failed attempts, so a broken URL can't starve the rotation", () => {
  const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

  // A card that has never succeeded but was just tried must NOT sort ahead of a card
  // last fetched 30 hours ago — otherwise a 404 eats the budget on every run forever.
  const brokenUrl = { fetchedAt: null, triedAt: hoursAgo(1), failures: 2 };
  const staleButWorking = { fetchedAt: hoursAgo(30) };
  assert.ok(
    lastAttempt(brokenUrl) > lastAttempt(staleButWorking),
    "the just-failed card must sort behind the genuinely stale one",
  );

  // A never-touched card still goes first.
  assert.equal(lastAttempt(undefined), 0);
  assert.equal(lastAttempt({}), 0);
  // A success after an earlier failure is what counts.
  assert.equal(lastAttempt({ fetchedAt: hoursAgo(1), triedAt: hoursAgo(9) }), Date.parse(hoursAgo(1)));
});

test("a card that keeps failing backs off to one retry a day", () => {
  const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();

  assert.equal(inFailureBackoff({ failures: 2, triedAt: minsAgo(5) }, NOW), false, "under the threshold, keep trying");
  assert.equal(inFailureBackoff({ failures: 3, triedAt: minsAgo(5) }, NOW), true, "three strikes -> hold off");
  assert.equal(
    inFailureBackoff({ failures: 9, triedAt: minsAgo(60 * 25) }, NOW),
    false,
    "after a day, try once more in case the URL was fixed",
  );
  assert.equal(inFailureBackoff(null, NOW), false);
  assert.equal(inFailureBackoff({ failures: 5 }, NOW), false, "no attempt timestamp -> no backoff");
});
