// Shared dashboard renderer for both the local watcher and the cloud static site.
// Usage: CardUI.renderGrid(data, { showShips, showSrc, seen, firstRun, newKeys, recent }) -> { totalOffers }
// seen: Set of every offer key observed this session (drives the new-offer diff).
// newKeys: Set of offer keys that appeared *after* first load (rows get highlighted).
// recent: Map of group -> timestamp of its latest new offer (groups float to the top).
// Groups with more than MAX_VISIBLE_ROWS offers collapse the rest behind a
// "Show more" toggle; expandedGroups keeps the choice across refetch re-renders.
// Expects #grid and #watching elements in the page.
(function (global) {
  const MAX_VISIBLE_ROWS = 10;
  const expandedGroups = new Set();
  const COND_MAP = { MINT: "MT", "NEAR MINT": "NM", EXCELLENT: "EX", GOOD: "GD", "LIGHT PLAYED": "LP", "LIGHTLY PLAYED": "LP", PLAYED: "PL", "SLIGHTLY PLAYED": "SP", POOR: "PO" };
  const SRC = { cardtrader: "CT", cardmarket: "CM" };
  const condAbbr = (c) => (c ? COND_MAP[c.toUpperCase()] || c : "");
  const priceClass = (p) => (p == null ? "" : p < 5 ? "p-green" : p < 10 ? "p-yellow" : p < 15 ? "p-orange" : "p-red");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
  function shipCell(o) {
    if (o.shipsToMe === true) return '<span class="yes">✓</span>';
    if (o.shipsToMe === false) return '<span class="no">✗</span>';
    return '<span class="unk">?</span>';
  }

  function columns(opts) {
    const cols = [
      { key: "price", label: "Price", cell: (o) => esc(o.priceStr || "–") + (o.foil ? ' <span class="foil">✦</span>' : "") },
      { key: "cond", label: "Cond", cell: (o) => condAbbr(o.condition) },
      { key: "qty", label: "Qty", cell: (o) => (o.qty != null ? o.qty : "") },
    ];
    if (opts.showShips) cols.push({ key: "ship", label: opts.shipLabel || "Ship", cell: shipCell });
    if (opts.showSrc) cols.push({ key: "src", label: "Src", cell: (o) => SRC[o._site] || o._site });
    cols.push({ key: "seller", label: "Seller", cell: (o) => esc(o.seller) });
    // Phones show the official set code (`code` in config.json) instead of the
    // full variant name; data.json entries predating the field fall back to it.
    cols.push({ key: "set", label: "Set", cell: (o) => `<a href="${esc(o._url)}" target="_blank"><span class="set-full">${esc(o._variant)}</span><span class="set-code">${esc(o._code || o._variant)}</span></a>` });
    return cols;
  }

  function renderGrid(data, opts) {
    opts = opts || {};
    const grid = document.getElementById("grid");
    const watching = document.getElementById("watching");
    grid.innerHTML = "";
    watching.innerHTML = "";

    const cols = columns(opts);
    const colgroup = "<colgroup>" + cols.map((c) => `<col class="c-${c.key}">`).join("") + "</colgroup>";
    const head = "<tr>" + cols.map((c) => `<th class="c-${c.key}">${c.label}</th>`).join("") + "</tr>";

    const groups = {}; const order = [];
    for (const p of data.results) {
      const g = p.group || p.name;
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push(p);
    }

    let totalOffers = 0;
    const empty = []; const errored = new Set(); const cards = [];
    for (const g of order) {
      let merged = [];
      for (const p of groups[g]) {
        if (p.error) errored.add(g);
        for (const o of p.offers || []) merged.push({ ...o, _variant: p.variant || "", _code: p.code || "", _site: p.site, _url: p.productUrl });
      }
      merged.sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9));
      if (!merged.length) { empty.push(g); continue; }
      totalOffers += merged.length;

      // Diff against the session's seen set: offers appearing after first load
      // get remembered in newKeys (row highlight) and bump the group in recent
      // (sorts it to the top below).
      let newCount = 0;
      for (const o of merged) {
        const key = g + "#" + o._variant + "#" + o._site + "#" + o.seller + "#" + o.price;
        o._new = opts.newKeys ? opts.newKeys.has(key) : false;
        if (opts.seen && !opts.seen.has(key)) {
          opts.seen.add(key);
          if (!opts.firstRun) {
            if (opts.newKeys) { opts.newKeys.add(key); o._new = true; }
            if (opts.recent) opts.recent.set(g, Date.now());
          }
        }
        if (o._new) newCount++;
      }
      cards.push({ g, merged, newCount });
    }

    // Groups that gained offers this session float to the top, most recent
    // first; ties (and everything else) keep the config.json order.
    const rank = (g) => (opts.recent && opts.recent.get(g)) || 0;
    cards.sort((a, b) => rank(b.g) - rank(a.g));

    for (const { g, merged, newCount } of cards) {
      const collapsible = merged.length > MAX_VISIBLE_ROWS;
      const rows = merged.map((o, i) =>
        `<tr class="${priceClass(o.price)}${o._new ? " is-new" : ""}${collapsible && i >= MAX_VISIBLE_ROWS ? " extra" : ""}">` + cols.map((c) => `<td class="c-${c.key}">${c.cell(o)}</td>`).join("") + "</tr>"
      ).join("");
      const toggle = collapsible
        ? `<tr class="toggle-row"><td colspan="${cols.length}"><button type="button" class="toggle-rows"><span class="when-collapsed">Show ${merged.length - MAX_VISIBLE_ROWS} more ▾</span><span class="when-expanded">Show less ▴</span></button></td></tr>`
        : "";

      const card = document.createElement("div");
      card.className = "card" + (collapsible && !expandedGroups.has(g) ? " is-collapsed" : "");
      card.innerHTML = `<h2><span>${esc(g)}</span><span class="badges">${newCount ? `<span class="badge badge-new">+${newCount} new</span>` : ""}<span class="badge">${merged.length}</span></span></h2>
        <table>${colgroup}${head}${rows}${toggle}</table>`;
      if (collapsible) card.querySelector(".toggle-rows").addEventListener("click", () => {
        if (expandedGroups.has(g)) expandedGroups.delete(g); else expandedGroups.add(g);
        card.classList.toggle("is-collapsed", !expandedGroups.has(g));
      });
      grid.appendChild(card);
    }

    if (empty.length) {
      watching.innerHTML = `<div class="label">Watching · no offers yet (${empty.length})</div>
        <div class="chips">${empty.map((g) => `<span class="chip${errored.has(g) ? " err" : ""}">${esc(g)}</span>`).join("")}</div>`;
    }
    return { totalOffers };
  }

  global.CardUI = { renderGrid };
})(window);
