// Normalizes the easy "paste a URL" config into full product objects.
// Config card shape: { url, group, variant, language? }
//   - site is derived from the URL host (cardtrader.com / cardmarket.com)
//   - blueprintId is extracted from a CardTrader URL (/cards/<id>-...)
//   - language defaults to config.defaultLanguage
// Legacy explicit entries ({ site, blueprintId, ... } or { site, url, ... }) still work.

function siteFromUrl(u = "") {
  if (/cardtrader\.com/i.test(u)) return "cardtrader";
  if (/cardmarket\.com/i.test(u)) return "cardmarket";
  return null;
}
function blueprintFromUrl(u = "") {
  const m = u.match(/\/cards\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function normalizeCards(cfg) {
  const def = cfg.defaultLanguage != null ? cfg.defaultLanguage : null;
  const list = cfg.cards || cfg.products || [];
  return list
    .map((c) => {
      const site = c.site || siteFromUrl(c.url || "");
      const blueprintId = c.blueprintId || (site === "cardtrader" ? blueprintFromUrl(c.url || "") : null);
      const language = c.language !== undefined ? c.language : def;
      const productUrl =
        site === "cardtrader" ? `https://www.cardtrader.com/en/cards/${blueprintId}` : c.url;
      const name = c.name || [c.group, c.variant].filter(Boolean).join(" — ") || c.url || "";
      return {
        site,
        blueprintId,
        url: c.url,
        group: c.group || name,
        variant: c.variant || "",
        language,
        name,
        productUrl,
      };
    })
    .filter((c) => c.site && (c.blueprintId || c.url));
}

module.exports = { normalizeCards };
