const test = require("node:test");
const assert = require("node:assert");
const { scrapeAll, fetchCard, mapPageOffers, toEur, shouldPublish, TUNING } = require("../azure/functions/lib/scrape");

const product = { site: "cardtrader", blueprintId: 1, language: "jp", name: "Test Card" };
const rates = { EUR: 1, USD: 1.25 }; // 1 EUR = 1.25 USD

const offer = (over = {}) => ({
  price_cents: 500,
  price_currency: "EUR",
  quantity: 1,
  user: { username: "seller", can_sell_via_hub: true },
  properties_hash: { mtg_language: "jp", mtg_foil: false, condition: "Near Mint" },
  ...over,
});

// ---------- mapPageOffers (pure offer mapping) ----------

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

test("language comparison is case-insensitive", () => {
  const upper = offer({ properties_hash: { mtg_language: "JP" } });
  assert.strictEqual(mapPageOffers([upper], { ...product, language: "Jp" }, rates).length, 1);
});

test("an offer without a language is filtered when the product pins one", () => {
  const bare = offer({ properties_hash: {} });
  assert.strictEqual(mapPageOffers([bare], product, rates).length, 0);
  assert.strictEqual(mapPageOffers([bare], { ...product, language: null }, rates).length, 1);
});

test("tolerates missing properties_hash and user", () => {
  const [o] = mapPageOffers([{ price_cents: 100 }], { ...product, language: null }, rates);
  assert.deepStrictEqual(o, {
    price: 1,
    priceStr: "1.00 €",
    foil: false,
    condition: null,
    qty: null,
    seller: null,
    language: null,
    shipsToMe: false,
  });
});

test("prefers layered_price_cents over price_cents", () => {
  const [o] = mapPageOffers([offer({ layered_price_cents: 700 })], product, rates);
  assert.strictEqual(o.price, 7);
});

test("null price -> null price and priceStr", () => {
  const [o] = mapPageOffers([offer({ price_cents: null })], product, rates);
  assert.strictEqual(o.price, null);
  assert.strictEqual(o.priceStr, null);
});

test("converts non-EUR prices via rates", () => {
  const [o] = mapPageOffers([offer({ price_cents: 1000, price_currency: "USD" })], product, rates);
  assert.strictEqual(o.price, 8); // 10 USD / 1.25
  assert.strictEqual(o.priceStr, "8.00 €");
});

test("unknown currency falls back to the raw amount with its currency code", () => {
  const [o] = mapPageOffers([offer({ price_cents: 1000, price_currency: "XYZ" })], product, rates);
  assert.strictEqual(o.price, 10);
  assert.strictEqual(o.priceStr, "10.00 XYZ");
});

test("foil and hub-eligibility map to booleans", () => {
  const [o] = mapPageOffers(
    [offer({ properties_hash: { mtg_language: "jp", mtg_foil: true }, user: { username: "s", can_sell_via_hub: false } })],
    product, rates,
  );
  assert.strictEqual(o.foil, true);
  assert.strictEqual(o.shipsToMe, false);
});

test("toEur returns null for unknown currency or null amount", () => {
  assert.strictEqual(toEur(10, "XYZ", rates), null);
  assert.strictEqual(toEur(null, "EUR", rates), null);
});

// ---------- fetchCard / scrapeAll (network behaviour, fetch mocked) ----------

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });
test.before(() => { TUNING.cardWaitMs = 0; TUNING.pageWaitMs = 0; TUNING.rateLimitBackoffMs = 0; });

const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const pageOf = (url) => Number(new URL(url).searchParams.get("page"));

test("fetchCard aggregates pages until products_last_page_reached", async () => {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    return pageOf(url) === 1
      ? jsonRes({ products: [offer()], products_last_page_reached: false })
      : jsonRes({ products: [offer({ price_cents: 900 })], products_last_page_reached: true });
  };
  const r = await fetchCard(product, rates);
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[0].startsWith("https://www.cardtrader.com/en/cards/1.json"));
  assert.deepStrictEqual(r.offers.map((o) => o.price), [5, 9]);
  assert.strictEqual(r.productUrl, "https://www.cardtrader.com/en/cards/1");
  assert.strictEqual(r.error, undefined);
});

test("fetchCard stops on an empty page", async () => {
  global.fetch = async (url) =>
    pageOf(url) === 1 ? jsonRes({ products: [offer()] }) : jsonRes({ products: [] });
  const r = await fetchCard(product, rates);
  assert.strictEqual(r.offers.length, 1);
});

test("fetchCard reports an error when page 1 fails", async () => {
  global.fetch = async () => jsonRes({}, 404);
  const r = await fetchCard(product, rates);
  assert.strictEqual(r.error, "HTTP 404");
  assert.deepStrictEqual(r.offers, []);
  assert.strictEqual(r.productUrl, "https://www.cardtrader.com/en/cards/1");
});

test("fetchCard keeps earlier pages when a later page fails", async () => {
  global.fetch = async (url) =>
    pageOf(url) === 1 ? jsonRes({ products: [offer()] }) : jsonRes({}, 500);
  const r = await fetchCard(product, rates);
  assert.strictEqual(r.offers.length, 1);
  assert.strictEqual(r.error, undefined);
});

test("fetchCard retries through 429s and succeeds", async () => {
  let attempts = 0;
  global.fetch = async () =>
    ++attempts < 3 ? jsonRes({}, 429) : jsonRes({ products: [offer()], products_last_page_reached: true });
  const r = await fetchCard(product, rates);
  assert.strictEqual(attempts, 3);
  assert.strictEqual(r.offers.length, 1);
});

test("fetchCard gives up after four consecutive 429s on page 1", async () => {
  let attempts = 0;
  global.fetch = async () => { attempts++; return jsonRes({}, 429); };
  const r = await fetchCard(product, rates);
  assert.strictEqual(attempts, 4);
  assert.strictEqual(r.error, "HTTP 429");
});

test("fetchCard stops at the 12-page safety cap", async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return jsonRes({ products: [offer()], products_last_page_reached: false }); };
  const r = await fetchCard(product, rates);
  assert.strictEqual(calls, 12);
  assert.strictEqual(r.offers.length, 12);
});

test("scrapeAll returns results in product order with an ISO timestamp and logs each card", async () => {
  global.fetch = async (url) => {
    if (url.includes("frankfurter")) return jsonRes({ rates: { USD: 1.25 } });
    return jsonRes({ products: [offer()], products_last_page_reached: true });
  };
  const products = [product, { ...product, blueprintId: 2, name: "Second Card" }];
  const logged = [];
  const { updatedAt, results } = await scrapeAll(products, (m) => logged.push(m));
  assert.ok(!Number.isNaN(Date.parse(updatedAt)));
  assert.deepStrictEqual(results.map((r) => r.blueprintId), [1, 2]);
  assert.strictEqual(logged.length, 2);
  assert.match(logged[0], /\[1\/2\] Test Card … 1 offers/);
});

test("scrapeAll survives a rates outage (EUR passes through, others fall back raw)", async () => {
  global.fetch = async (url) => {
    if (url.includes("frankfurter")) throw new Error("down");
    return jsonRes({ products: [offer(), offer({ price_cents: 1000, price_currency: "USD" })], products_last_page_reached: true });
  };
  const { results } = await scrapeAll([product]);
  assert.deepStrictEqual(results[0].offers.map((o) => o.priceStr), ["5.00 €", "10.00 USD"]);
});

// ---------- shouldPublish (keep-last-good-data guard) ----------

test("shouldPublish: publishes normal and partial results, blocks a total failure", () => {
  assert.strictEqual(shouldPublish([{ offers: [] }]), true);
  assert.strictEqual(shouldPublish([{ error: "HTTP 500" }, { offers: [] }]), true);
  assert.strictEqual(shouldPublish([{ error: "HTTP 500" }, { error: "HTTP 429" }]), false);
  assert.strictEqual(shouldPublish([]), true); // nothing configured is not a failure
});
