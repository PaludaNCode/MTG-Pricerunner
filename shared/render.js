// Shared dashboard renderer for both the local watcher and the cloud static site.
// Usage: CardUI.renderGrid(data, { showShips, showSrc, seen, firstRun }) -> { totalOffers, newAlerts }
// Expects #grid and #watching elements in the page.
(function (global) {
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
    const empty = []; const errored = new Set(); const newAlerts = [];
    for (const g of order) {
      let merged = [];
      for (const p of groups[g]) {
        if (p.error) errored.add(g);
        for (const o of p.offers || []) merged.push({ ...o, _variant: p.variant || "", _code: p.code || "", _site: p.site, _url: p.productUrl });
      }
      merged.sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9));
      if (!merged.length) { empty.push(g); continue; }
      totalOffers += merged.length;

      const rows = merged.map((o) => {
        if (opts.seen) {
          const key = g + "#" + o._variant + "#" + o._site + "#" + o.seller + "#" + o.price;
          if (!opts.seen.has(key)) { opts.seen.add(key); if (!opts.firstRun) newAlerts.push(`${g} (${o._variant}): ${o.priceStr} from ${o.seller || "?"}`); }
        }
        return `<tr class="${priceClass(o.price)}">` + cols.map((c) => `<td class="c-${c.key}">${c.cell(o)}</td>`).join("") + "</tr>";
      }).join("");

      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `<h2><span>${esc(g)}</span><span class="badge">${merged.length}</span></h2>
        <table>${colgroup}${head}${rows}</table>`;
      grid.appendChild(card);
    }

    if (empty.length) {
      watching.innerHTML = `<div class="label">Watching · no offers yet (${empty.length})</div>
        <div class="chips">${empty.map((g) => `<span class="chip${errored.has(g) ? " err" : ""}">${esc(g)}</span>`).join("")}</div>`;
    }
    return { totalOffers, newAlerts };
  }

  global.CardUI = { renderGrid };
})(window);
