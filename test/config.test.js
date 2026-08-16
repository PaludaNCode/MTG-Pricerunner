// Guards the real config.json: a bad card paste (malformed URL, unparseable id,
// duplicate entry) should fail CI here rather than silently produce empty offers.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { normalizeCards } = require("../shared/cards");

const raw = fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8");

test("config.json is valid JSON with a cards array", () => {
  const cfg = JSON.parse(raw);
  assert.ok(Array.isArray(cfg.cards), "cards must be an array");
  assert.ok(cfg.cards.length > 0, "cards must not be empty");
});

test("every card entry normalizes (site + id/url derivable)", () => {
  const cfg = JSON.parse(raw);
  const out = normalizeCards(cfg);
  assert.equal(
    out.length,
    cfg.cards.length,
    "some entry dropped — a URL is malformed or its site/id can't be derived",
  );
});

test("every cardtrader entry yields a blueprintId", () => {
  const cfg = JSON.parse(raw);
  for (const p of normalizeCards(cfg).filter((p) => p.site === "cardtrader")) {
    assert.ok(p.blueprintId, `no blueprintId parsed from ${p.url}`);
  }
});

test("no duplicate cardtrader entries (same blueprintId)", () => {
  const cfg = JSON.parse(raw);
  const ids = normalizeCards(cfg)
    .filter((p) => p.site === "cardtrader")
    .map((p) => p.blueprintId);
  assert.equal(new Set(ids).size, ids.length, "duplicate blueprintId in config.json");
});

// Cardmarket has no language property in its offer HTML — the ?language= query
// parameter on the URL is the only filter, so a paste that drops it silently
// starts watching every language at once.
test("every cardmarket entry filters by language in its URL", () => {
  const cfg = JSON.parse(raw);
  for (const p of normalizeCards(cfg).filter((p) => p.site === "cardmarket")) {
    assert.match(p.productUrl, /[?&]language=\d+/, `no ?language= filter on ${p.productUrl}`);
  }
});

// build-data.js keys results by site+productUrl, so a duplicate URL would collapse
// into one fetch rendered twice.
test("no duplicate cardmarket entries (same URL)", () => {
  const cfg = JSON.parse(raw);
  const urls = normalizeCards(cfg)
    .filter((p) => p.site === "cardmarket")
    .map((p) => p.productUrl);
  assert.equal(new Set(urls).size, urls.length, "duplicate Cardmarket URL in config.json");
});

// An all-versions Cardmarket entry (/Magic/Cards/<Name>) spans every printing, so it
// has no single set — the per-offer set comes off each row instead.
test("every card entry has an official set code (shown on phones)", () => {
  const cfg = JSON.parse(raw);
  for (const p of normalizeCards(cfg)) {
    if (p.allVersions) continue;
    assert.ok(p.code, `missing "code" for ${p.name}`);
  }
});

test("only Cardmarket /Magic/Cards/ entries may declare allVersions", () => {
  const cfg = JSON.parse(raw);
  for (const p of normalizeCards(cfg).filter((p) => p.allVersions)) {
    assert.equal(p.site, "cardmarket", `allVersions is Cardmarket-only (${p.name})`);
    assert.match(p.productUrl, /\/Magic\/Cards\//, `allVersions needs the /Magic/Cards/ URL (${p.name})`);
  }
});

// The reverse guard: a /Magic/Cards/ URL without the flag would label every offer with
// one entry's set, silently mislabelling most rows.
test("every Cardmarket /Magic/Cards/ entry is marked allVersions", () => {
  const cfg = JSON.parse(raw);
  for (const p of normalizeCards(cfg).filter((p) => p.site === "cardmarket")) {
    if (/\/Magic\/Cards\//.test(p.productUrl)) {
      assert.ok(p.allVersions, `${p.productUrl} is an all-versions page but isn't flagged`);
    }
  }
});
