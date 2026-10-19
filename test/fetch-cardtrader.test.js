// A dropped connection on one card must not take the whole run down: the fetcher
// retries it, and if it keeps failing reports it on that card alone.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fetchAll } = require("../cloud/fetch-cardtrader");

const product = (id) => ({ site: "cardtrader", group: "Card " + id, name: "Card " + id, blueprintId: id });
const reset = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
const ok = (id) => ({
  ok: true,
  status: 200,
  json: async () => ({ [id]: [{ price_cents: 1234, price_currency: "EUR", quantity: 1, properties_hash: {} }] }),
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

test("the first rejected response is described once, body and server included", async () => {
  const lines = [];
  const blocked = {
    ok: false,
    status: 403,
    headers: new Headers({ server: "cloudflare", "cf-ray": "abc123-CPH" }),
    text: async () => "<html>\n  <title>Attention Required! | Cloudflare</title>\n</html>",
  };
  const write = process.stdout.write;
  process.stdout.write = () => true;
  const { results } = await fetchAll([product(5), product(6)], { ...FAST, log: (l) => lines.push(l), fetch: async () => blocked }).finally(
    () => (process.stdout.write = write),
  );
  assert.equal(results[0].error, "HTTP 403");
  assert.equal(results[1].error, "HTTP 403");
  const described = lines.filter((l) => l.startsWith("[ct] first rejected response"));
  assert.equal(described.length, 1);
  assert.match(described[0], /HTTP 403 via cloudflare, cf-ray abc123-CPH: <html> <title>Attention Required! \| Cloudflare<\/title> <\/html>/);
});
