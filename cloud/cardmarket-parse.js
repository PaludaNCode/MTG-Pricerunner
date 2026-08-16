// Parses a Cardmarket product page into normalized offers.
// Kept separate from the fetcher so it can be unit-tested without any network.
//
// The offer table is server-rendered into `<div id="articleRow<N>">` blocks, so a
// regex sweep per block is enough — no DOM parser (and no dependency) needed.
// Cardmarket serves this HTML only behind Cloudflare, which is why the fetcher
// goes through Firecrawl rather than fetching the page directly.

// Normalized offer shape (same contract as the CardTrader fetcher):
// { price:Number|null, priceStr, foil:Bool|null, condition, qty, seller,
//   location, language:String|null, shipsToMe:Bool|null }
function parseCardmarket(html) {
  const offers = [];
  const rowStarts = [];
  const re = /id="articleRow(\d+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) rowStarts.push(m.index);
  for (let i = 0; i < rowStarts.length; i++) {
    const block = html.slice(rowStarts[i], i + 1 < rowStarts.length ? rowStarts[i + 1] : html.length);
    // Cardmarket prints European numbers: dot groups thousands, comma decimals.
    const pm = block.match(/fw-bold[^>]*>\s*([\d.]+),(\d{2})\s*(?:&euro;|€)/);
    let price = null;
    if (pm) price = parseFloat(pm[1].replace(/\./g, "") + "." + pm[2]);
    const sellerMatch = block.match(/\/Magic\/Users\/([^"?#]+)"/);
    const locMatch = block.match(/Item location:\s*([^"]+)"/);
    const condMatch = block.match(/article-condition condition-(\w+)/);
    const qtyMatch = block.match(/item-count[^>]*>\s*(\d+)\s*</);
    const isFoil = /title="Foil"|showMsgBox\(this,`Foil`\)/.test(block);
    // Ship-to-me is only knowable when logged in: a greyed cart button / "does not
    // ship to your country" tooltip = can't buy, a normal cart button = ships to you.
    // The scrape is always a guest session, so this is normally null (renders as "?").
    let shipsToMe;
    if (/Login\?redirectTo/i.test(block)) shipsToMe = null; // logged out → unknown
    else if (/btn-grey|does not ship to your country/i.test(block)) shipsToMe = false;
    else shipsToMe = true;
    if (price !== null || sellerMatch) {
      offers.push({
        price,
        priceStr: price !== null ? price.toFixed(2) + " €" : null,
        foil: isFoil,
        condition: condMatch ? condMatch[1].toUpperCase() : null,
        qty: qtyMatch ? parseInt(qtyMatch[1], 10) : null,
        seller: sellerMatch ? decodeURIComponent(sellerMatch[1]) : null,
        location: locMatch ? locMatch[1].trim() : null,
        language: null, // not reliably exposed by the guest HTML; the ?language= URL filters instead
        shipsToMe,
      });
    }
  }
  return offers;
}

// A Cloudflare interstitial is a 200 with a plausible-looking body, so "no offers"
// on its own can't tell a blocked scrape from a genuinely empty listing. Sniff the
// challenge markers explicitly and let the caller keep the previous data instead.
function looksBlocked(html) {
  return /Just a moment|cf-browser-verification|cf-challenge|Attention Required|Access denied|Enable JavaScript and cookies to continue/i.test(
    String(html || "").slice(0, 4000),
  );
}

module.exports = { parseCardmarket, looksBlocked };
