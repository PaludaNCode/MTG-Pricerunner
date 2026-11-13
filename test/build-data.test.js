// When a CardTrader run may replace the last good data.json.
//
// Requiring build-data.js only pulls in its helpers — main() is guarded behind
// require.main, so no config is read and no network is touched.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { publishVerdict, MAX_ERROR_SHARE, breakerOpen, tripBreaker, carryForward, BREAKER_BASE_MS, BREAKER_MAX_MS } = require("../cloud/build-data");

const fine = (n) => Array.from({ length: n }, (_, i) => ({ group: "c" + i, offers: [] }));
const failed = (n, error = "HTTP 403") => Array.from({ length: n }, (_, i) => ({ group: "x" + i, offers: [], error }));

test("a clean run publishes", () => {
  assert.deepEqual(publishVerdict(fine(51), false), { ok: true });
});

test("one or two network failures in a run still publish", () => {
  assert.equal(publishVerdict([...fine(49), ...failed(2, "network: ECONNRESET")], false).ok, true);
});

test("an empty product list publishes (nothing to judge)", () => {
  assert.equal(publishVerdict([], false).ok, true);
});

// The bug this guards: on 2026-10-19 a run with 37 of 51 cards at "HTTP 403" was
// published, because the old guard only refused when every card had failed.
test("a run with more than a quarter of the cards errored is refused", () => {
  const v = publishVerdict([...fine(14), ...failed(37)], false);
  assert.equal(v.ok, false);
  assert.match(v.reason, /37 of 51 cards errored \(more than 25%\)/);
});

test("exactly a quarter still publishes; the guard is 'more than'", () => {
  assert.equal(publishVerdict([...fine(3), ...failed(1)], false).ok, true);
  assert.equal(publishVerdict([...fine(2), ...failed(1)], false).ok, false);
});

test("every card errored is refused, as before", () => {
  assert.equal(publishVerdict(failed(51), false).ok, false);
});

test("a run cut short by a Cloudflare challenge is refused however few cards it reached", () => {
  const v = publishVerdict([...fine(50), ...failed(1, "blocked: Cloudflare challenge")], true);
  assert.equal(v.ok, false);
  assert.match(v.reason, /Cloudflare challenged the run — 1 of 51 cards blocked or never requested/);
});

test("the threshold is the documented one", () => {
  assert.equal(MAX_ERROR_SHARE, 0.25);
});

// ---- Circuit breaker ----------------------------------------------------------------
// Cloudflare's challenge is a verdict on the runner, so a challenged run must stop the
// following runs from probing for a while, and the wait must grow while the block holds.
const H = 60 * 60 * 1000;
const T0 = Date.parse("2026-11-11T15:36:00Z");
const withState = (cardtrader) => ({ updatedAt: "2026-11-11T15:33:33Z", meta: { cardmarketCards: ["a"], cardtrader }, results: fine(3) });

test("no previous file, or no breaker state in it, means the run may fetch", () => {
  assert.equal(breakerOpen(null, T0), null);
  assert.equal(breakerOpen({ updatedAt: "x", results: [] }, T0), null);
  assert.equal(breakerOpen(withState(undefined), T0), null);
});

test("the first strike waits one hour, and the breaker is open until then", () => {
  const state = tripBreaker(null, T0);
  assert.equal(state.strikes, 1);
  assert.equal(Date.parse(state.blockedUntil) - T0, BREAKER_BASE_MS);
  assert.equal(state.challengedAt, new Date(T0).toISOString());
  const open = breakerOpen(withState(state), T0 + 59 * 60 * 1000);
  assert.deepEqual(open, { until: state.blockedUntil, strikes: 1 });
});

test("once the wait has passed the breaker is closed and the run probes again", () => {
  const state = tripBreaker(null, T0);
  assert.equal(breakerOpen(withState(state), T0 + H), null);
  assert.equal(breakerOpen(withState(state), T0 + 5 * H), null);
});

test("consecutive strikes double the wait: 1 h, 2 h, 4 h, then 8 h flat", () => {
  let prev = null; const waits = [];
  for (let i = 0; i < 6; i++) {
    const now = T0 + i * 24 * H; // each probe happens after the previous wait expired
    const state = tripBreaker(prev, now);
    waits.push((Date.parse(state.blockedUntil) - now) / H);
    prev = withState(state);
  }
  assert.deepEqual(waits, [1, 2, 4, 8, 8, 8]);
  assert.equal(BREAKER_MAX_MS, 8 * BREAKER_BASE_MS);
});

test("a garbled blockedUntil never jams the breaker shut", () => {
  assert.equal(breakerOpen(withState({ strikes: 3, blockedUntil: "not a date" }), T0), null);
});

// The file a challenged run publishes has to read as *old* on the page: same results,
// same updatedAt. Only the watch list (from today's config) and the state are new.
test("carrying forward keeps the previous results and timestamp and adds the state", () => {
  const prev = withState(undefined);
  const state = tripBreaker(prev, T0);
  const out = carryForward(prev, state, ["a", "b"]);
  assert.equal(out.updatedAt, prev.updatedAt);
  assert.deepEqual(out.results, prev.results);
  assert.deepEqual(out.meta.cardmarketCards, ["a", "b"]);
  assert.deepEqual(out.meta.cardtrader, state);
  assert.deepEqual(prev.meta.cardtrader, undefined, "the previous document is not mutated");
});

test("a previous file with no results or meta still carries forward safely", () => {
  const out = carryForward({ updatedAt: "2026-01-01T00:00:00Z" }, tripBreaker(null, T0), []);
  assert.deepEqual(out.results, []);
  assert.equal(out.meta.cardtrader.strikes, 1);
});
