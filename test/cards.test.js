const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCards } = require("../shared/cards");

test("derives site and blueprintId from a CardTrader URL", () => {
  const [p] = normalizeCards({ cards: [{ url: "https://www.cardtrader.com/en/cards/146950", group: "Agadeem's Awakening", variant: "Zendikar Rising" }] });
  assert.equal(p.site, "cardtrader");
  assert.equal(p.blueprintId, 146950);
  assert.equal(p.productUrl, "https://www.cardtrader.com/en/cards/146950");
  assert.equal(p.name, "Agadeem's Awakening — Zendikar Rising");
});

test("parses blueprintId from a slugged CardTrader URL without /en/", () => {
  const [p] = normalizeCards({ cards: [{ url: "https://www.cardtrader.com/cards/384530-into-the-flood-maw-retro-frame", group: "Into the Flood Maw" }] });
  assert.equal(p.blueprintId, 384530);
});

test("derives site from a Cardmarket URL and keeps the original url", () => {
  const url = "https://www.cardmarket.com/en/Magic/Products/Singles/Aetherdrift/Stock-Up?language=7";
  const [p] = normalizeCards({ cards: [{ url, group: "Stock Up" }] });
  assert.equal(p.site, "cardmarket");
  assert.equal(p.blueprintId, null);
  assert.equal(p.productUrl, url);
});

test("language defaults to config.defaultLanguage and can be overridden per card", () => {
  const cfg = {
    defaultLanguage: "jp",
    cards: [
      { url: "https://www.cardtrader.com/en/cards/1", group: "A" },
      { url: "https://www.cardtrader.com/en/cards/2", group: "B", language: "en" },
      { url: "https://www.cardtrader.com/en/cards/3", group: "C", language: null },
    ],
  };
  const [a, b, c] = normalizeCards(cfg);
  assert.equal(a.language, "jp");
  assert.equal(b.language, "en");
  assert.equal(c.language, null); // explicit null disables the filter
});

test("drops entries whose site or id cannot be derived", () => {
  const out = normalizeCards({ cards: [{ url: "https://example.com/nope", group: "X" }, { group: "no url at all" }] });
  assert.equal(out.length, 0);
});

test("legacy explicit entries ({ site, blueprintId }) still work", () => {
  const [p] = normalizeCards({ cards: [{ site: "cardtrader", blueprintId: 99, group: "Legacy" }] });
  assert.equal(p.site, "cardtrader");
  assert.equal(p.blueprintId, 99);
  assert.equal(p.productUrl, "https://www.cardtrader.com/en/cards/99");
});

test("set code passes through and defaults to null", () => {
  const cfg = {
    cards: [
      { url: "https://www.cardtrader.com/en/cards/1", group: "A", variant: "Zendikar Rising", code: "ZNR" },
      { url: "https://www.cardtrader.com/en/cards/2", group: "B", variant: "Prerelease" },
    ],
  };
  const [a, b] = normalizeCards(cfg);
  assert.equal(a.code, "ZNR");
  assert.equal(b.code, null);
});

test("group falls back to name when omitted", () => {
  const [p] = normalizeCards({ cards: [{ url: "https://www.cardtrader.com/en/cards/5", name: "Some Card" }] });
  assert.equal(p.group, "Some Card");
});
