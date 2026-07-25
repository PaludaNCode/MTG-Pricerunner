const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseCardmarket, resolveTransport } = require("../cloud/cardmarket-core");

// Minimal HTML matching the shapes the parser's regexes target.
const row = (id, body) => `<div id="articleRow${id}" class="article-row">${body}</div>`;

const LOGGED_IN_PAGE =
  row(1, `
    <a href="/en/Magic/Users/GoodSeller">GoodSeller</a>
    <span title="Item location: Japan"></span>
    <span class="article-condition condition-NM"></span>
    <span title="Foil"></span>
    <span class="fw-bold">1.234,56 €</span>
    <span class="item-count">3</span>
    <button class="btn-primary">cart</button>
  `) +
  row(2, `
    <a href="/en/Magic/Users/Grey%20Seller">Grey Seller</a>
    <span class="article-condition condition-EX"></span>
    <span class="fw-bold">7,00 &euro;</span>
    <span class="item-count">1</span>
    <button class="btn-grey" title="does not ship to your country">cart</button>
  `);

const LOGGED_OUT_PAGE = row(9, `
  <a href="/en/Magic/Users/Someone">Someone</a>
  <span class="fw-bold">5,50 €</span>
  <a href="/en/Login?redirectTo=x">log in</a>
`);

test("parses price, seller, condition, qty, foil and shipsToMe per row", () => {
  const [a, b] = parseCardmarket(LOGGED_IN_PAGE);

  assert.equal(a.price, 1234.56); // thousands dot + decimal comma
  assert.equal(a.priceStr, "1234.56 €");
  assert.equal(a.seller, "GoodSeller");
  assert.equal(a.condition, "NM");
  assert.equal(a.qty, 3);
  assert.equal(a.foil, true);
  assert.equal(a.shipsToMe, true);
  assert.equal(a.location, "Japan");

  assert.equal(b.price, 7);
  assert.equal(b.seller, "Grey Seller"); // URL-decoded
  assert.equal(b.condition, "EX");
  assert.equal(b.foil, false);
  assert.equal(b.shipsToMe, false); // greyed cart = doesn't ship
});

test("logged-out page yields shipsToMe = null (unknown)", () => {
  const [o] = parseCardmarket(LOGGED_OUT_PAGE);
  assert.equal(o.price, 5.5);
  assert.equal(o.shipsToMe, null);
});

test("rows without price or seller are skipped, empty html yields no offers", () => {
  assert.equal(parseCardmarket(row(1, "<span>nothing useful</span>")).length, 0);
  assert.equal(parseCardmarket("").length, 0);
});

// The transport is the part that's actually broken, so pin its resolution: the default
// must stay "off" (a live deployment must never start scraping Cardmarket by accident),
// env must win over config, and anything unrecognized must fall back to "off".
test("transport defaults to off and env overrides config", () => {
  const saved = process.env.CARDMARKET_FETCH;
  delete process.env.CARDMARKET_FETCH;
  try {
    assert.equal(resolveTransport({}), "off");
    assert.equal(resolveTransport({ cardmarketFetch: "direct" }), "direct");
    assert.equal(resolveTransport({ cardmarketFetch: "nonsense" }), "off");
    assert.equal(resolveTransport({ cardmarketFetch: "cdp" }), "off"); // retired local-only mode

    process.env.CARDMARKET_FETCH = "proxy";
    assert.equal(resolveTransport({ cardmarketFetch: "off" }), "proxy");
  } finally {
    if (saved === undefined) delete process.env.CARDMARKET_FETCH;
    else process.env.CARDMARKET_FETCH = saved;
  }
});
