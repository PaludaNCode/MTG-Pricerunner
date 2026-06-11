// Parses a Cardmarket product page (guest or logged-in HTML) into normalized offers.
// Extracted from server.js so it can be unit-tested without starting the server.

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
    // Ship-to-me (only meaningful when logged in): a greyed cart button / "does not ship
    // to your country" tooltip = can't buy; a normal cart button = ships to you.
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

module.exports = { parseCardmarket };
