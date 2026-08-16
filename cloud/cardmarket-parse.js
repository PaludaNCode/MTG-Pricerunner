// Parses a Cardmarket product page into normalized offers.
// Kept separate from the fetcher so it can be unit-tested without any network.
//
// The offer table is server-rendered into `<div id="articleRow<N>">` blocks, so a
// regex sweep per block is enough — no DOM parser (and no dependency) needed.
// Cardmarket serves this HTML only behind Cloudflare, which is why the fetcher
// goes through Firecrawl rather than fetching the page directly.

// Cardmarket has two page shapes and we use both:
//
//   /Magic/Products/Singles/<Set>/<Card>  — one printing, offers all from that set
//   /Magic/Cards/<Card>                   — ALL printings of the card in one table
//
// The all-versions page is much cheaper (one scrape covers every printing, where
// CardTrader needs a separate blueprint per printing), but its rows are a mix of sets,
// so a row's set has to come from the row itself rather than from the product entry.
// Each row on that page links to the specific printing's product page; that link is
// both the set name and a per-offer URL. On a single-product page there is no such
// link — the row IS the product — so `variant`/`productUrl` come back null and the
// caller falls back to the config entry's own set. That keeps both shapes working.
// Two ways a row can name its printing, tried in order. The first also yields a
// per-offer link. Absolute and relative hrefs, and either quote style, because the
// first version of this only matched one shape and silently found nothing on the
// live page — every offer came back with no set at all.
const ROW_PRODUCT_LINK =
  /href=["'](?:https?:\/\/(?:www\.)?cardmarket\.com)?(\/[a-z]{2}\/Magic\/Products\/Singles\/([^/"']+)\/[^"'?#]+)(?=["'?#])/i;

// Fallback: the expansion rendered as a symbol rather than a link. Only tags that
// actually mention "expansion" are considered, so a "Foil" or seller tooltip can't be
// mistaken for a set name.
function expansionFromIcon(block) {
  const tags = block.match(/<[^>]+>/g) || [];
  for (const tag of tags) {
    if (!/expansion/i.test(tag)) continue;
    const label = tag.match(/(?:aria-label|data-bs-original-title|data-original-title|title)=["']([^"']+)["']/i);
    if (label && label[1].trim()) return label[1].trim();
  }
  return null;
}
// Cardmarket prefixes some Universes Beyond expansions with the whole brand, e.g.
// "Magic-The-Gathering-Marvel-Super-Heroes". Left alone that fills the Set column with
// six words of boilerplate and pushes the actual set name out of view.
// Consumes any separator after the brand too: the slug form gives "Magic The Gathering
// Marvel Super Heroes" but a tooltip can read "Magic: The Gathering - Marvel Super Heroes".
const stripBrand = (s) => String(s).replace(/^Magic:?\s+The\s+Gathering\b[\s:—–-]*/i, "").trim();
const unslug = (s) => stripBrand(decodeURIComponent(s).replace(/-/g, " "));

// Normalized offer shape (same contract as the CardTrader fetcher):
// { price:Number|null, priceStr, foil:Bool|null, condition, qty, seller,
//   location, language:String|null, shipsToMe:Bool|null, variant, productUrl }
// Where the offer list stops. The last row has no following row to bound it, so its
// block would otherwise run to the end of the document and absorb the footer and
// "related products" links — which is how one offer per card ended up labelled with a
// printing taken from page furniture rather than from the row itself.
const AFTER_TABLE = /<\/table>|<footer|id="pagination"|class="[^"]*pagination|js-loadmore/i;
const LAST_ROW_FALLBACK_CHARS = 6000;

function endOfLastRow(html, start, prevBlockLengths) {
  const rest = html.slice(start);
  const marker = rest.search(AFTER_TABLE);
  // Rows are near-identical in size; page furniture is not. Use the widest real row
  // seen as the bound when there is no marker to cut at.
  const cap = prevBlockLengths.length
    ? Math.ceil(Math.max(...prevBlockLengths) * 1.5)
    : LAST_ROW_FALLBACK_CHARS;
  const end = marker !== -1 ? Math.min(marker, cap) : Math.min(rest.length, cap);
  return start + end;
}

function parseCardmarket(html) {
  const offers = [];
  const rowStarts = [];
  const re = /id="articleRow(\d+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) rowStarts.push(m.index);
  const blockLengths = [];
  for (let i = 0; i < rowStarts.length; i++) {
    const end =
      i + 1 < rowStarts.length ? rowStarts[i + 1] : endOfLastRow(html, rowStarts[i], blockLengths);
    const block = html.slice(rowStarts[i], end);
    blockLengths.push(block.length);
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
    // Which printing this row is for — only present on the all-versions page.
    const prodMatch = block.match(ROW_PRODUCT_LINK);
    const iconSet = prodMatch ? null : expansionFromIcon(block);
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
        // null on a single-product page; the caller then uses the config entry's set.
        variant: prodMatch ? unslug(prodMatch[2]) : iconSet ? stripBrand(iconSet) : null,
        productUrl: prodMatch ? "https://www.cardmarket.com" + prodMatch[1] : null,
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
