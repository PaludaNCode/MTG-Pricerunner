const test = require("node:test");
const assert = require("node:assert");
const { mapPageOffers, toEur } = require("../azure/functions/lib/scrape");

const product = { site: "cardtrader", blueprintId: 1, language: "jp" };
const rates = { EUR: 1, USD: 1.25 }; // 1 EUR = 1.25 USD

const offer = (over = {}) => ({
  price_cents: 500,
  price_currency: "EUR",
  quantity: 1,
  user: { username: "seller", can_sell_via_hub: true },
  properties_hash: { mtg_language: "jp", mtg_foil: false, condition: "Near Mint" },
  ...over,
});

test("maps a website-JSON offer to the shared shape", () => {
  const [o] = mapPageOffers([offer()], product, rates);
  assert.deepStrictEqual(o, {
    price: 5,
    priceStr: "5.00 €",
    foil: false,
    condition: "Near Mint",
    qty: 1,
    seller: "seller",
    language: "jp",
    shipsToMe: true,
  });
});

test("filters out other languages when the product pins one", () => {
  const en = offer({ properties_hash: { mtg_language: "en" } });
  assert.strictEqual(mapPageOffers([en], product, rates).length, 0);
  // no language pin -> everything passes
  assert.strictEqual(mapPageOffers([en], { ...product, language: null }, rates).length, 1);
});

test("prefers layered_price_cents over price_cents", () => {
  const [o] = mapPageOffers([offer({ layered_price_cents: 700 })], product, rates);
  assert.strictEqual(o.price, 7);
});

test("converts non-EUR prices via rates", () => {
  const [o] = mapPageOffers([offer({ price_cents: 1000, price_currency: "USD" })], product, rates);
  assert.strictEqual(o.price, 8); // 10 USD / 1.25
  assert.strictEqual(o.priceStr, "8.00 €");
});

test("toEur returns null for unknown currency or null amount", () => {
  assert.strictEqual(toEur(10, "XYZ", rates), null);
  assert.strictEqual(toEur(null, "EUR", rates), null);
});
