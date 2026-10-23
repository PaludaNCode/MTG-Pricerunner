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
