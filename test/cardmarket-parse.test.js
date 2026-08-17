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

test("an absolute product link identifies the printing too", () => {
  // The first attempt only matched relative hrefs and found nothing on the live page.
  const [o] = parseCardmarket(row(1, `
    <a href="https://www.cardmarket.com/en/Magic/Products/Singles/Onslaught/Windswept-Heath?language=7">ONS</a>
    <span class="fw-bold">30,00 €</span>
  `));
  assert.equal(o.variant, "Onslaught");
  assert.equal(o.productUrl, "https://www.cardmarket.com/en/Magic/Products/Singles/Onslaught/Windswept-Heath");
});

test("an expansion symbol names the printing when the row has no product link", () => {
  const [o] = parseCardmarket(row(1, `
    <span class="icon expansion-symbol" aria-label="Zendikar"></span>
    <span class="fw-bold">44,00 €</span>
  `));
  assert.equal(o.variant, "Zendikar", "the symbol's label is the only set signal in this shape");

  // Bootstrap's moved tooltip attribute, and the brand prefix stripped here too.
  const [o2] = parseCardmarket(row(1, `
    <span class="expansion" data-bs-original-title="Magic: The Gathering — Marvel Super Heroes"></span>
    <span class="fw-bold">4,00 €</span>
  `));
  assert.equal(o2.variant, "Marvel Super Heroes");
});

test("a non-expansion tooltip is never mistaken for a set", () => {
  const [o] = parseCardmarket(row(1, `
    <span title="Foil"></span>
    <a href="/en/Magic/Users/SomeSeller">SomeSeller</a>
    <span class="fw-bold">2,00 €</span>
  `));
  assert.equal(o.variant, null, "only tags mentioning 'expansion' count");
});

test("the last row stops at the table, not at the end of the page", () => {
  // Every row but the last is bounded by the next one. The last had nothing to stop it,
  // so it swallowed the footer — and one offer per card ended up wearing a set name
  // lifted from a "related products" link instead of from its own row.
  const html =
    row(1, '<span class="fw-bold">10,00 €</span><a href="/en/Magic/Users/S1">S1</a>') +
    row(2, '<span class="fw-bold">12,00 €</span><a href="/en/Magic/Users/S2">S2</a>') +
    '</table><footer><a href="/en/Magic/Products/Singles/Modern-Horizons-2/Arid-Mesa">also</a></footer>';

  const [a, b] = parseCardmarket(html);
  assert.equal(a.variant, null);
  assert.equal(b.variant, null, "the footer's printing must not attach to the last offer");
  assert.equal(b.seller, "S2", "and the row's own fields still parse");
  assert.equal(b.price, 12);
});

test("a genuine set on the last row still resolves", () => {
  const html =
    row(1, '<a href="/en/Magic/Products/Singles/Onslaught/Wooded-Foothills">a</a><span class="fw-bold">1,00 €</span>') +
    row(2, '<a href="/en/Magic/Products/Singles/Zendikar/Arid-Mesa">b</a><span class="fw-bold">2,00 €</span>') +
    "<footer>junk</footer>";
  const [a, b] = parseCardmarket(html);
  assert.equal(a.variant, "Onslaught");
  assert.equal(b.variant, "Zendikar", "bounding the last row must not blind it to its own link");
});

test("a single-row page is bounded by size when there is no table marker", () => {
  const html = row(1, '<span class="fw-bold">5,00 €</span>') + "x".repeat(20000) +
    '<a href="/en/Magic/Products/Singles/Modern-Horizons-2/Arid-Mesa">far away</a>';
  const [o] = parseCardmarket(html);
  assert.equal(o.variant, null, "a link 20k characters later is page furniture, not this row");
});

// The expansion LINK, not its tooltip. Real Cardmarket rows wrap the expansion symbol in
// an anchor to /Magic/Expansions/<Set>; reading the href beats reading the tooltip
// because it is markup rather than display text — no brand stripping, no localisation.
test("an expansion link names the printing when the row has no product link", () => {
  const offers = parseCardmarket(
    row(1, `
      <a href="/en/Magic/Users/S">S</a>
      <a href="https://www.cardmarket.com/en/Magic/Expansions/Commander-2016" class="expansion-symbol"></a>
      <span class="fw-bold">0,61 €</span>
    `) + "</table>",
  );
  assert.equal(offers[0].variant, "Commander 2016");
  assert.equal(offers[0].productUrl, null, "an expansion link is not a per-offer product URL");
});

test("a product link still wins over an expansion link on the same row", () => {
  const offers = parseCardmarket(
    row(1, `
      <a href="/en/Magic/Products/Singles/Zendikar/Arid-Mesa">x</a>
      <a href="/en/Magic/Expansions/Commander-2016" class="expansion-symbol"></a>
      <span class="fw-bold">1,00 €</span>
    `) + "</table>",
  );
  assert.equal(offers[0].variant, "Zendikar");
  assert.match(offers[0].productUrl, /\/Magic\/Products\/Singles\/Zendikar\//);
});
