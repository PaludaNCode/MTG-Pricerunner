// The parser against markup Cardmarket actually served, rather than markup we invented.
//
// Every other parse test builds its own HTML from what we believe the page looks like,
// which cannot catch the failure that mattered most: a regex that matches our idea of the
// row and nothing on the live site. That is exactly what happened to the product-link
// strategy — it looked right, passed its tests, and resolved no sets in production.
//
// test/fixtures/cardmarket-row.html is one real article row, captured by a debug=true run
// (which costs a credit and cannot be done from a dev box, since Cardmarket blocks
// datacentre IPs behind Cloudflare). Treat it as a specimen: don't tidy it up.
//
// It is a PARTIAL row. The capture used a fixed 3000-char window and stopped before the
// price, condition and quantity markup — which is itself worth knowing, and why the
// sampler now cuts at the next row instead. So this file asserts what the specimen
// genuinely contains (seller, location, printing) and leaves the numeric fields to the
// synthetic tests in cardmarket-parse.test.js. Re-capture with a debug run and these can
// grow; don't assert fields the bytes don't cover.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseCardmarket, looksBlocked } = require("../cloud/cardmarket-parse");

const html = fs.readFileSync(path.join(__dirname, "fixtures", "cardmarket-row.html"), "utf8");

test("the captured row yields one offer with the fields the specimen covers", () => {
  const offers = parseCardmarket(html);
  assert.equal(offers.length, 1);
  const [o] = offers;
  assert.equal(o.seller, "P9Events");
  assert.equal(o.location, "United Kingdom");
  assert.equal(o.variant, "Commander 2016");
  assert.equal(o.language, null, "the ?language= URL is the only filter");
});

// The finding that motivated the third strategy: this row, from the all-versions page,
// contains no /Magic/Products/Singles/ link at all. Whatever names the printing has to
// come from the expansion anchor.
test("the real all-versions row has no product link — the expansion link carries the set", () => {
  assert.doesNotMatch(html, /\/Magic\/Products\/Singles\//, "the assumption behind strategy 1");
  assert.match(html, /\/Magic\/Expansions\/Commander-2016/);
  assert.equal(parseCardmarket(html)[0].variant, "Commander 2016");
});

test("a real page is not mistaken for a Cloudflare interstitial", () => {
  assert.equal(looksBlocked(html), false);
});
