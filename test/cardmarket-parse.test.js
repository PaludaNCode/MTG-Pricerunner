const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseCardmarket, looksBlocked } = require("../cloud/cardmarket-parse");

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

test("guest page yields shipsToMe = null (unknown) — the normal scrape case", () => {
  const [o] = parseCardmarket(LOGGED_OUT_PAGE);
  assert.equal(o.price, 5.5);
  assert.equal(o.shipsToMe, null);
});

test("rows without price or seller are skipped, empty html yields no offers", () => {
  assert.equal(parseCardmarket(row(1, "<span>nothing useful</span>")).length, 0);
  assert.equal(parseCardmarket("").length, 0);
});

test("looksBlocked spots a Cloudflare interstitial but not a real page", () => {
  assert.equal(looksBlocked("<html><title>Just a moment...</title></html>"), true);
  assert.equal(looksBlocked("<html><body>Enable JavaScript and cookies to continue</body></html>"), true);
  assert.equal(looksBlocked(LOGGED_OUT_PAGE), false);
  assert.equal(looksBlocked(""), false);
  assert.equal(looksBlocked(null), false);
});

// The all-versions page (/Magic/Cards/<Name>) mixes printings in one table; each row
// links to its own printing. That link is the only per-row set signal, and getting it
// wrong would label every offer with one set.
const ALL_VERSIONS_PAGE =
  row(1, `
    <a href="/en/Magic/Products/Singles/Commander-2016/Runehorn-Hellkite">C16</a>
    <a href="/en/Magic/Users/SellerA">SellerA</a>
    <span class="article-condition condition-NM"></span>
    <span class="fw-bold">4,50 €</span>
    <span class="item-count">2</span>
  `) +
  row(2, `
    <a href="/en/Magic/Products/Singles/Starter-Commander-Decks/Runehorn-Hellkite">SCD</a>
    <a href="/en/Magic/Users/SellerB">SellerB</a>
    <span class="article-condition condition-EX"></span>
    <span class="fw-bold">3,20 €</span>
    <span class="item-count">1</span>
  `);

test("all-versions rows carry their own set and product URL", () => {
  const [a, b] = parseCardmarket(ALL_VERSIONS_PAGE);

  assert.equal(a.variant, "Commander 2016"); // de-slugged from the row's product link
  assert.equal(a.productUrl, "https://www.cardmarket.com/en/Magic/Products/Singles/Commander-2016/Runehorn-Hellkite");
  assert.equal(a.price, 4.5);
  assert.equal(a.seller, "SellerA");

  assert.equal(b.variant, "Starter Commander Decks");
  assert.equal(b.seller, "SellerB");
  assert.notEqual(a.variant, b.variant, "two printings in one table must not collapse to one set");
});

test("single-product rows report no set, so the config entry's own set is used", () => {
  const [o] = parseCardmarket(LOGGED_OUT_PAGE);
  assert.equal(o.variant, null);
  assert.equal(o.productUrl, null);
});

test("a seller link is never mistaken for a printing link", () => {
  const [o] = parseCardmarket(row(1, `
    <a href="/en/Magic/Users/Products-Singles-Trickster">Tricky</a>
    <span class="fw-bold">1,00 €</span>
  `));
  assert.equal(o.variant, null, "only /Magic/Products/Singles/ links identify a printing");
});

test("Universes Beyond set names lose the 'Magic The Gathering' prefix", () => {
  // Real Cardmarket path shape: /Products/Singles/Magic-The-Gathering-Marvel-Super-Heroes/…
  const [o] = parseCardmarket(row(1, `
    <a href="/en/Magic/Products/Singles/Magic-The-Gathering-Marvel-Super-Heroes/Hawkeyes-Bow">MSH</a>
    <span class="fw-bold">9,00 €</span>
  `));
  assert.equal(o.variant, "Marvel Super Heroes", "the brand prefix would crowd out the Set column");

  // A set that merely starts with a similar word keeps its name intact.
  const [o2] = parseCardmarket(row(1, `
    <a href="/en/Magic/Products/Singles/Magic-Origins/Some-Card">ORI</a>
    <span class="fw-bold">1,00 €</span>
  `));
  assert.equal(o2.variant, "Magic Origins");
});
