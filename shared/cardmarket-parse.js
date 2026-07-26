// Cardmarket offer-row parser. Loaded BOTH in the browser (by the dashboard, to parse
// HTML the extension bridge fetched) and in Node (by cloud/cardmarket-core.js), so there
// is exactly one copy of these selectors to maintain.
//
// Pure string -> offers. No network, no DOM APIs — deliberately regex-based rather than
// DOMParser so Node can use it unchanged.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CardmarketParse = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  // Normalized offer shape used by the front-end:
  // { price:Number|null, priceStr, currency, foil:Bool|null, condition, qty,
  //   seller, location, language:String|null, shipsToMe:Bool|null, shipCost:String|null }
  function parseCardmarket(html) {
    const offers = [];
    const rowStarts = [];
    const re = /id="articleRow(\d+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) rowStarts.push(m.index);
    for (let i = 0; i < rowStarts.length; i++) {
      const block = html.slice(rowStarts[i], i + 1 < rowStarts.length ? rowStarts[i + 1] : html.length);
      const pm = block.match(/fw-bold[^>]*>\s*([\d.]+),(\d{2})\s*(?:&euro;|€)/);
      let price = null;
      if (pm) price = parseFloat(pm[1].replace(/\./g, "") + "." + pm[2]);
      const sellerMatch = block.match(/\/Magic\/Users\/([^"?#]+)"/);
      const locMatch = block.match(/Item location:\s*([^"]+)"/);
      const condMatch = block.match(/article-condition condition-(\w+)/);
      const qtyMatch = block.match(/item-count[^>]*>\s*(\d+)\s*</);
      const isFoil = /title="Foil"|showMsgBox\(this,`Foil`\)/.test(block);
      // Ship-to-me (only meaningful when logged in): a greyed cart button / "does not
      // ship to your country" tooltip = can't buy; a normal cart button = ships to you.
      let shipsToMe;
      if (/Login\?redirectTo/i.test(block)) shipsToMe = null; // logged out → unknown
      else if (/btn-grey|does not ship to your country/i.test(block)) shipsToMe = false;
      else shipsToMe = true;
      if (price !== null || sellerMatch) {
        offers.push({
          price,
          priceStr: price !== null ? price.toFixed(2) + " €" : null,
          currency: "EUR",
          foil: isFoil,
          condition: condMatch ? condMatch[1].toUpperCase() : null,
          qty: qtyMatch ? parseInt(qtyMatch[1], 10) : null,
          seller: sellerMatch ? decodeURIComponent(sellerMatch[1]) : null,
          location: locMatch ? locMatch[1].trim() : null,
          language: null, // not reliably exposed by Cardmarket guest HTML
          shipsToMe, // true/false when logged in, null when logged out
          shipCost: null,
        });
      }
    }
    return offers;
  }

  // Distinguishes "Cloudflare stopped us" from "we got the page but it had no rows", so
  // callers never report a challenge as an empty listing.
  const CHALLENGE_RE =
    /Just a moment|cf-browser-verification|Attention Required|Verify you are human|Access denied|cf-challenge/i;

  function looksChallenged(html) {
    return CHALLENGE_RE.test((html || "").slice(0, 4000));
  }

  function looksLoggedOut(html) {
    return /Login\?redirectTo/i.test(html || "");
  }

  return { parseCardmarket, looksChallenged, looksLoggedOut };
});
