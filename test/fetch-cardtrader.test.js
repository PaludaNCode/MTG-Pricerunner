// A dropped connection on one card must not take the whole run down: the fetcher
// retries it, and if it keeps failing reports it on that card alone.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fetchAll, offerPrice, REQUIRED_FIELDS } = require("../cloud/fetch-cardtrader");

const product = (id) => ({ site: "cardtrader", group: "Card " + id, name: "Card " + id, blueprintId: id });
const reset = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
const ok = (id) => ({
  ok: true,
  status: 200,
  json: async () => ({ [id]: [{ price: { cents: 1234, currency: "EUR" }, quantity: 1, properties_hash: {} }] }),
});
const quiet = () => {};
const FAST = { token: "t", rates: { EUR: 1 }, log: quiet, backoffMs: 0, paceMs: 0 };
const run = (products, fetch) => {
  const write = process.stdout.write;
  process.stdout.write = () => true; // fetchAll prints progress
  return fetchAll(products, { ...FAST, fetch }).finally(() => (process.stdout.write = write));
};

test("retries a reset connection and keeps the card's offers", async () => {
  let n = 0;
  const { results } = await run([product(1)], async () => {
    if (++n === 1) throw reset();
    return ok(1);
  });
  assert.equal(n, 2);
  assert.equal(results[0].error, undefined);
  assert.equal(results[0].offers.length, 1);
});

test("a card that never connects errors alone; the rest still publish", async () => {
  const { results } = await run([product(1), product(2)], async (url) => {
    if (url.endsWith("=1")) throw reset();
    return ok(2);
  });
  assert.equal(results[0].error, "network: ECONNRESET");
  assert.deepEqual(results[0].offers, []);
  assert.equal(results[1].error, undefined);
  assert.equal(results[1].offers.length, 1);
});

test("a body that fails to parse is retried like a dropped connection", async () => {
  let n = 0;
  const { results } = await run([product(3)], async () =>
    ++n === 1 ? { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected end of JSON input"); } } : ok(3),
  );
  assert.equal(n, 2);
  assert.equal(results[0].offers.length, 1);
});

test("an HTTP error is reported without retrying", async () => {
  let n = 0;
  const { results } = await run([product(4)], async () => (n++, { ok: false, status: 500 }));
  assert.equal(n, 1);
  assert.equal(results[0].error, "HTTP 500");
});

// A rejection's body is the one thing that tells a revoked token from a blocked runner,
// so the first one of a run is printed. Only the first: they all say the same thing.
test("the first rejected response is described once, body and server included", async () => {
  const lines = [];
  const refused = {
    ok: false,
    status: 403,
    headers: new Headers({ server: "cloudflare", "cf-ray": "abc123-CPH" }),
    text: async () => "<html>\n  <title>Attention Required! | Cloudflare</title>\n</html>",
  };
  const write = process.stdout.write;
  process.stdout.write = () => true;
  const { results, blocked } = await fetchAll([product(5), product(6)], { ...FAST, log: (l) => lines.push(l), fetch: async () => refused }).finally(
    () => (process.stdout.write = write),
  );
  assert.equal(results[0].error, "HTTP 403");
  assert.equal(results[1].error, "HTTP 403", "a plain block page is not a challenge: the run goes on");
  assert.equal(blocked, false);
  const described = lines.filter((l) => l.startsWith("[ct] first rejected response"));
  assert.equal(described.length, 1);
  assert.match(described[0], /HTTP 403 via cloudflare, cf-ray abc123-CPH: <html> <title>Attention Required! \| Cloudflare<\/title> <\/html>/);
});

// The 2026-10-19 outage: a Cloudflare managed challenge on every request. It judges the
// runner, not the card, so the rest of the run can only fail the same way — and each
// further request feeds the bot score. Stop, report the rest as not requested, and tell
// the caller not to publish.
test("a Cloudflare challenge stops the run; later cards are not requested", async () => {
  const lines = [];
  let calls = 0;
  const challenge = {
    ok: false,
    status: 403,
    headers: new Headers({ server: "cloudflare", "cf-mitigated": "challenge", "content-type": "text/html" }),
    text: async () => "<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>",
  };
  const write = process.stdout.write;
  process.stdout.write = () => true;
  const { results, blocked } = await fetchAll([product(7), product(8), product(9)], {
    ...FAST,
    log: (l) => lines.push(l),
    fetch: async (url) => (calls++, url.endsWith("=7") ? ok(7) : challenge),
  }).finally(() => (process.stdout.write = write));
  assert.equal(calls, 2, "the card after the challenge was never fetched");
  assert.equal(blocked, true);
  assert.equal(results.length, 3, "the result set stays whole");
  assert.equal(results[0].offers.length, 1);
  assert.equal(results[1].error, "blocked: Cloudflare challenge");
  assert.equal(results[2].error, "blocked: Cloudflare challenge");
  assert.ok(lines.some((l) => /Cloudflare challenge — stopping; 1 card\(s\) not requested/.test(l)), lines.join("\n"));
});

test("a challenge is recognised from the page when the header is missing", async () => {
  let calls = 0;
  const page = {
    ok: false,
    status: 403,
    headers: new Headers({ server: "cloudflare" }),
    text: async () => '<html><head><title>Just a moment...</title><script src="https://challenges.cloudflare.com/x.js"></script></head></html>',
  };
  const { results, blocked } = await run([product(10), product(11)], async () => (calls++, page));
  assert.equal(calls, 1);
  assert.equal(blocked, true);
  assert.equal(results[1].error, "blocked: Cloudflare challenge");
});

test("an ordinary HTTP 500 neither stops the run nor marks it blocked", async () => {
  let calls = 0;
  const { results, blocked } = await run([product(12), product(13)], async (url) => (calls++, url.endsWith("=12") ? { ok: false, status: 500, text: async () => "oops" } : ok(13)));
  assert.equal(calls, 2);
  assert.equal(blocked, false);
  assert.equal(results[0].error, "HTTP 500");
  assert.equal(results[1].offers.length, 1);
});

// The pause between cards is about a second with jitter — never the old 250 ms burst,
// never long enough for a 55-card run to crowd the 10-minute cadence.
test("the pace between cards is 800–1400 ms, jittered", () => {
  const { paceMs, PACE_MIN_MS, PACE_MAX_MS } = require("../cloud/fetch-cardtrader");
  assert.equal(paceMs(() => 0), PACE_MIN_MS);
  assert.equal(paceMs(() => 0.999999), PACE_MAX_MS);
  assert.ok(PACE_MIN_MS >= 800 && PACE_MAX_MS <= 1400, "a 55-card run stays around a minute");
  const seen = new Set(Array.from({ length: 200 }, () => paceMs()));
  assert.ok(seen.size > 20, "the jitter actually varies");
  for (const v of seen) assert.ok(v >= PACE_MIN_MS && v <= PACE_MAX_MS);
});

// 2026-11-25: the API dropped the flat price_cents/price_currency and sends only a nested
// price object. Reading the flat fields alone published every CT offer at price: null.
test("reads the nested price object the API sends (cents → euros)", async () => {
  const { results } = await run([product(5)], async () => ok(5));
  assert.equal(results[0].offers[0].price, 12.34);
  assert.equal(results[0].offers[0].priceStr, "12.34 €");
});

test("offerPrice: nested first, flat fields as a fallback, null when neither is there", () => {
  assert.deepEqual(offerPrice({ price: { cents: 62, currency: "EUR" } }), { amount: 0.62, currency: "EUR" });
  assert.deepEqual(offerPrice({ price: { cents: 500, currency: "usd" } }), { amount: 5, currency: "USD" });
  assert.deepEqual(offerPrice({ price_cents: 1234, price_currency: "EUR" }), { amount: 12.34, currency: "EUR" });
  assert.deepEqual(offerPrice({ price: { cents: 0, currency: "EUR" } }), { amount: 0, currency: "EUR" });
  assert.equal(offerPrice({}).amount, null);
  assert.equal(offerPrice({ price: { currency: "EUR" } }).amount, null);
});

test("a foreign-currency price is converted to euros", async () => {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  const { results } = await fetchAll([product(6)], {
    ...FAST,
    rates: { EUR: 1, USD: 2 },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ 6: [{ price: { cents: 1000, currency: "USD" }, properties_hash: {} }] }) }),
  }).finally(() => (process.stdout.write = write));
  assert.equal(results[0].offers[0].price, 5);
});

// ---- The real API shape -----------------------------------------------------------
//
// Every test above feeds the fetcher a response written by hand, which is why the old
// price_cents fixture kept passing after CardTrader dropped the field. These use two
// offers captured by the probe on fix/cardtrader-probe (2026-11-25): one foil, one not,
// with the seller's strings redacted. Treat the file as a specimen — don't tidy it.
const SPECIMEN = require("./fixtures/cardtrader-products.json");
const specimenRun = (body = SPECIMEN, extra = {}) => {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  return fetchAll([product(292964)], {
    ...FAST,
    ...extra,
    fetch: async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }),
  }).finally(() => (process.stdout.write = write));
};
const OUTPUT_FIELDS = ["price", "priceStr", "foil", "condition", "qty", "seller", "language", "shipsToMe"];

test("specimen: every field of every offer is filled", async () => {
  const { results, missingFields } = await specimenRun();
  const offers = results[0].offers;
  assert.equal(offers.length, 2);
  for (const o of offers) {
    assert.deepEqual(Object.keys(o).sort(), [...OUTPUT_FIELDS].sort());
    for (const f of OUTPUT_FIELDS) assert.ok(o[f] !== null && o[f] !== undefined, `${f} is empty`);
  }
  assert.deepEqual(missingFields, []);
});

test("specimen: values map through correctly, foil and not", async () => {
  const [foil, plain] = (await specimenRun()).results[0].offers;
  assert.deepEqual(foil, { price: 2.09, priceStr: "2.09 €", foil: true, condition: "Near Mint", qty: 1, seller: "<redacted>", language: "es", shipsToMe: true });
  assert.deepEqual(plain, { price: 0.62, priceStr: "0.62 €", foil: false, condition: "Near Mint", qty: 1, seller: "<redacted>", language: "fr", shipsToMe: false });
});

test("specimen carries every required field, so the list matches the real API", () => {
  const get = (o, path) => path.split(".").reduce((v, k) => (v == null ? v : v[k]), o);
  for (const o of SPECIMEN[292964]) for (const f of REQUIRED_FIELDS) assert.notEqual(get(o, f), undefined, f);
});

// Drop one required field from every offer, as an API change would: the run must name it.
for (const field of REQUIRED_FIELDS) {
  test(`a run where no offer carries ${field} reports it`, async () => {
    const body = JSON.parse(JSON.stringify(SPECIMEN));
    const [head, last] = [field.split(".").slice(0, -1), field.split(".").pop()];
    for (const o of body[292964]) delete head.reduce((v, k) => v[k], o)[last];
    const lines = [];
    const { missingFields } = await specimenRun(body, { log: (l) => lines.push(l) });
    assert.deepEqual(missingFields, [field]);
    const hits = lines.filter((l) => l.includes("missing from all"));
    assert.equal(hits.length, 1);
    assert.match(hits[0], /an offer's fields: id, blueprint_id/);
  });
}

test("a field missing from only some offers is not reported", async () => {
  const body = JSON.parse(JSON.stringify(SPECIMEN));
  delete body[292964][0].user.can_sell_via_hub;
  assert.deepEqual((await specimenRun(body)).missingFields, []);
});

test("a run with no offers at all reports nothing missing", async () => {
  assert.deepEqual((await specimenRun({ 292964: [] })).missingFields, []);
});
