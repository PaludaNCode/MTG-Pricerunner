const { test } = require("node:test");
const assert = require("node:assert/strict");
const { inQuietHours, DEFAULT_QUIET_START_HOUR, DEFAULT_QUIET_END_HOUR } = require("../cloud/fetch-cardmarket");

// Cardmarket has no scheduler, so this guards the on-demand path: the window is the one
// rule that can refuse a human's button press. It must be exact at the boundaries —
// an off-by-one here either burns credits at 08:00-minus-a-minute or blocks a legitimate
// run at 08:00 sharp.
const at = (hour, minute = 0) => Date.UTC(2026, 7, 27, hour, minute);

test("the default window is 00:00-08:00 UTC", () => {
  assert.equal(DEFAULT_QUIET_START_HOUR, 0);
  assert.equal(DEFAULT_QUIET_END_HOUR, 8);
});

test("midnight exactly is inside the window", () => {
  assert.equal(inQuietHours(at(0, 0)), true);
});

test("the last minute before the window closes is still inside", () => {
  assert.equal(inQuietHours(at(7, 59)), true);
});

test("08:00 exactly is outside — the window is half-open", () => {
  assert.equal(inQuietHours(at(8, 0)), false);
});

test("the working day is outside", () => {
  for (const h of [8, 12, 17, 23]) {
    assert.equal(inQuietHours(at(h)), false, `${h}:00 should be allowed`);
  }
});

test("every hour of the night is inside", () => {
  for (const h of [0, 1, 3, 5, 7]) {
    assert.equal(inQuietHours(at(h)), true, `${h}:00 should be quiet`);
  }
});

// The switch-off, so the guard can be lifted from config without touching code.
test("equal bounds mean no window at all", () => {
  assert.equal(inQuietHours(at(3), 0, 0), false);
  assert.equal(inQuietHours(at(3), 8, 8), false);
});

// A wrapping window must not read as an empty range — that would silently disable the
// guard for whoever edited config.json expecting 22:00-06:00 to work.
test("a window that wraps past midnight covers both halves", () => {
  assert.equal(inQuietHours(at(23), 22, 6), true);
  assert.equal(inQuietHours(at(2), 22, 6), true);
  assert.equal(inQuietHours(at(6), 22, 6), false);
  assert.equal(inQuietHours(at(12), 22, 6), false);
});

// Fail safe: a spend guard must not be switchable off by accident. Only explicitly
// equal bounds disable it; anything unusable falls back to the default night.
test("unusable bounds fall back to the default window instead of reopening the night", () => {
  assert.equal(inQuietHours(at(3), null, undefined), true);
  assert.equal(inQuietHours(at(3), "x", 8), true);
  assert.equal(inQuietHours(at(3), "", ""), true);
  assert.equal(inQuietHours(at(12), "nonsense", null), false, "and still allows the day");
});

// UTC, not the runner's local time: the ledger day and the allowance reset are both UTC,
// and a guard on a different clock would drift away from them twice a year.
test("the hour is read in UTC regardless of the local zone", () => {
  const tz = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Auckland"; // UTC+12/13 — 03:00 UTC is mid-afternoon there
    assert.equal(inQuietHours(at(3)), true);
    assert.equal(inQuietHours(at(12)), false);
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});
