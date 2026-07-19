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

test("every card entry has an official set code (shown on phones)", () => {
  const cfg = JSON.parse(raw);
  for (const p of normalizeCards(cfg)) {
    assert.ok(p.code, `missing "code" for ${p.name}`);
  }
});

test("fetch lands close the grid: ZEN fetches directly before the ONS fetches", () => {
  const cfg = JSON.parse(raw);
  // Grid order = first appearance of each group in cards[] (render.js);
  // add new cards ABOVE the fetch lands so these keep ending the grid.
  const groups = [];
  for (const c of cfg.cards) if (!groups.includes(c.group)) groups.push(c.group);
  assert.deepEqual(
    groups.slice(-5),
    ["Arid Mesa", "Verdant Catacombs", "Windswept Heath", "Wooded Foothills", "Bloodstained Mire"],
    "fetch lands must stay the last five groups (ZEN pair, then ONS trio)",
  );
});

test("no duplicate cardmarket entries (same url)", () => {
  const cfg = JSON.parse(raw);
  const urls = normalizeCards(cfg)
    .filter((p) => p.site === "cardmarket")
    .map((p) => p.url);
  assert.equal(new Set(urls).size, urls.length, "duplicate cardmarket url in config.json");
});
