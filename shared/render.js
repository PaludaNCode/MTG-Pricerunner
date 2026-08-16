// Dashboard renderer for the cloud static site.
// Usage: CardUI.renderGrid(data, { showShips, showSrc, selectable, selected, onToggle })
//   -> { totalOffers }
// selected is a Set of group names; onToggle(group, checked) fires on a tick box.
// Expects #grid and #watching elements in the page.
(function (global) {
  const COND_MAP = { MINT: "MT", "NEAR MINT": "NM", EXCELLENT: "EX", GOOD: "GD", "LIGHT PLAYED": "LP", "LIGHTLY PLAYED": "LP", PLAYED: "PL", "SLIGHTLY PLAYED": "SP", POOR: "PO" };
  // Offers from every site are merged into one price-sorted table per card, so each
  // row has to say where it came from.
  const SRC = { cardtrader: "CT", cardmarket: "CM" };
  const condAbbr = (c) => (c ? COND_MAP[c.toUpperCase()] || c : "");
  const priceClass = (p) => (p == null ? "" : p < 5 ? "p-green" : p < 10 ? "p-yellow" : p < 15 ? "p-orange" : "p-red");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

  // Compact age, e.g. 40m / 6h / 3d. Shared with app.js so the header and the per-card
  // chips can never disagree about how old something is.
  function ageLabel(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms) || ms < 0) return null;
    const mins = Math.round(ms / 60000);
    if (mins < 60) return mins + "m";
    const hours = Math.round(mins / 60);
    return hours < 48 ? hours + "h" : Math.round(hours / 24) + "d";
  }

  // Cardmarket freshness for one card. Unlike CardTrader (refetched every couple of
  // minutes, for free), a Cardmarket card is scraped only when the credit budget reaches
  // it — which can be hours or days — so each card has to say when that last happened.
  function cmChip(entries, pending, refreshable) {
    if (!refreshable) return "";
    if (pending) return '<span class="age pending" title="Refresh running — this card is in the queue">···</span>';
    const failed = entries.find((p) => p.error);
    const fetchedAt = entries.map((p) => p.fetchedAt).filter(Boolean).sort().pop();
    if (failed && !fetchedAt) {
      return `<span class="age err" title="Cardmarket: ${esc(failed.error)}">!</span>`;
    }
    if (!fetchedAt) return '<span class="age new" title="Cardmarket: not scraped yet">new</span>';
    const age = ageLabel(fetchedAt) || "?";
    const when = new Date(fetchedAt).toLocaleString();
    const suffix = failed ? ` — last attempt failed: ${failed.error}` : "";
    return `<span class="age${failed ? " err" : ""}" title="Cardmarket last scraped ${esc(when)} (${age} ago)${esc(suffix)}">${age}</span>`;
  }
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
      // Only a card with a Cardmarket entry can be refreshed on demand — CardTrader
      // is free and already refreshes everything every couple of minutes.
      const cmEntries = groups[g].filter((p) => p.site === "cardmarket");
      cards.push({ g, merged, cmEntries });
    }

    const selected = opts.selected || new Set();
    const pending = opts.pending || new Set();
    // Cards Cardmarket can refresh, per config.json (published in the CardTrader feed).
    // Falling back to "has scraped data" alone would hide every tick box until the
    // first scrape had already happened.
    const cmCards = opts.cardmarketCards ? new Set(opts.cardmarketCards) : null;
    for (const { g, merged, cmEntries } of cards) {
      const refreshable = cmCards ? cmCards.has(g) : cmEntries.length > 0;
      const hiddenCount = merged.length - MAX_VISIBLE_ROWS;
      const collapsible = hiddenCount > 0;
      const collapsed = collapsible && !expandedGroups.has(g);
      const rows = merged.map((o, i) =>
        `<tr class="${priceClass(o.price)}${collapsible && i >= MAX_VISIBLE_ROWS ? " row-extra" : ""}">` + cols.map((c) => `<td class="c-${c.key}">${c.cell(o)}</td>`).join("") + "</tr>"
      ).join("");
      const toggle = collapsible ? `<tr class="row-toggle"><td colspan="${cols.length}"><button type="button">${collapsed ? `Show ${hiddenCount} more ▾` : "Show fewer ▴"}</button></td></tr>` : "";

      // Credits are scarce enough that which cards get refreshed is a real choice, so
      // each refreshable card carries a tick box. The set lives in app.js (and
      // localStorage) rather than here, so a poll re-render doesn't clear it.
      const pick = opts.selectable && refreshable
        ? `<input type="checkbox" class="pick"${selected.has(g) ? " checked" : ""} aria-label="Include ${esc(g)} in the next Cardmarket refresh" title="Include in the next Cardmarket refresh">`
        : "";

      const card = document.createElement("div");
      card.className = "card" + (collapsed ? " is-collapsed" : "");
      card.innerHTML = `<h2>${pick}<span>${esc(g)}</span><span class="badges">${cmChip(cmEntries, pending.has(g), refreshable)}<span class="badge">${merged.length}</span></span></h2>
        <table>${colgroup}${head}${rows}${toggle}</table>`;
      const box = card.querySelector(".pick");
      if (box && opts.onToggle) box.addEventListener("change", () => opts.onToggle(g, box.checked));
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

  global.CardUI = { renderGrid, ageLabel };
})(window);
