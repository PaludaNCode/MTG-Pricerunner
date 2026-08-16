// Dashboard renderer for the cloud static site.
// Usage: CardUI.renderGrid(data, { showShips, showSrc }) -> { totalOffers }
// Expects #grid and #watching elements in the page.
(function (global) {
  const COND_MAP = { MINT: "MT", "NEAR MINT": "NM", EXCELLENT: "EX", GOOD: "GD", "LIGHT PLAYED": "LP", "LIGHTLY PLAYED": "LP", PLAYED: "PL", "SLIGHTLY PLAYED": "SP", POOR: "PO" };
  // Offers from every site are merged into one price-sorted table per card, so each
  // row has to say where it came from.
  const SRC = { cardtrader: "CT", cardmarket: "CM" };
  const condAbbr = (c) => (c ? COND_MAP[c.toUpperCase()] || c : "");
  const priceClass = (p) => (p == null ? "" : p < 5 ? "p-green" : p < 10 ? "p-yellow" : p < 15 ? "p-orange" : "p-red");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
  // Cards cap at this many offer rows; the rest collapse behind a toggle.
  // Expanded groups are remembered so the poll re-render doesn't snap them shut.
  const MAX_VISIBLE_ROWS = 8;
  const expandedGroups = new Set();

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
        // An offer may carry its own set: Cardmarket's all-versions page returns one
        // table mixing every printing, so the row wins over the entry when it says so.
        for (const o of p.offers || [])
          merged.push({
            ...o,
            _variant: o.variant || p.variant || "",
            _code: o.code || (o.variant ? "" : p.code || ""),
            _site: p.site,
            _url: o.productUrl || p.productUrl,
          });
      }
      merged.sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9));
      if (!merged.length) { empty.push(g); continue; }
      totalOffers += merged.length;
      cards.push({ g, merged });
    }

    for (const { g, merged } of cards) {
      const hiddenCount = merged.length - MAX_VISIBLE_ROWS;
      const collapsible = hiddenCount > 0;
      const collapsed = collapsible && !expandedGroups.has(g);
      const rows = merged.map((o, i) =>
        `<tr class="${priceClass(o.price)}${collapsible && i >= MAX_VISIBLE_ROWS ? " row-extra" : ""}">` + cols.map((c) => `<td class="c-${c.key}">${c.cell(o)}</td>`).join("") + "</tr>"
      ).join("");
      const toggle = collapsible ? `<tr class="row-toggle"><td colspan="${cols.length}"><button type="button">${collapsed ? `Show ${hiddenCount} more ▾` : "Show fewer ▴"}</button></td></tr>` : "";

      const card = document.createElement("div");
      card.className = "card" + (collapsed ? " is-collapsed" : "");
      card.innerHTML = `<h2><span>${esc(g)}</span><span class="badges"><span class="badge">${merged.length}</span></span></h2>
        <table>${colgroup}${head}${rows}${toggle}</table>`;
      if (collapsible) {
        const btn = card.querySelector(".row-toggle button");
        btn.addEventListener("click", () => {
          const nowCollapsed = card.classList.toggle("is-collapsed");
          if (nowCollapsed) expandedGroups.delete(g); else expandedGroups.add(g);
          btn.textContent = nowCollapsed ? `Show ${hiddenCount} more ▾` : "Show fewer ▴";
        });
      }
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
