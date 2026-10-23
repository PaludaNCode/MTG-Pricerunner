// When a CardTrader run may replace the last good data.json.
//
// Requiring build-data.js only pulls in its helpers — main() is guarded behind
// require.main, so no config is read and no network is touched.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { publishVerdict, MAX_ERROR_SHARE } = require("../cloud/build-data");

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
