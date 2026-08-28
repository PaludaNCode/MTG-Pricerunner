// Dashboard renderer for the cloud static site.
// Usage: CardUI.renderGrid(data, { showShips, showSrc, source, selectable, selected, onToggle })
//   -> { totalOffers }
// selected is a Set of group names; onToggle(group, checked) fires on a tick box.
// source is "all" (default), "cardtrader" or "cardmarket" — see the filter below.
// Expects #grid and #watching elements in the page.
(function (global) {
  const COND_MAP = { MINT: "MT", "NEAR MINT": "NM", EXCELLENT: "EX", GOOD: "GD", "LIGHT PLAYED": "LP", "LIGHTLY PLAYED": "LP", PLAYED: "PL", "SLIGHTLY PLAYED": "SP", POOR: "PO" };
  // Offers from every site are merged into one price-sorted table per card, so each
  // row has to say where it came from.
  const SRC = { cardtrader: "CT", cardmarket: "CM" };
  const SRC_NAME = { cardtrader: "CardTrader", cardmarket: "Cardmarket" };
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

  // A Cardmarket row states its printing by name ("Zendikar Rising Extras"), and only
  // its thumbnail states a code — so a row scraped before that extraction existed, or
  // one with no thumbnail, has a name and nothing else. Rather than make the user spend
  // credits re-scraping for a code, resolve it from the CardTrader printings of the same
  // card, which are already on the page and carry config.json's curated Scryfall codes.
  // Every rule below has to be evidence, not a guess: an unresolved name keeps showing
  // the full name, which is only the status quo.
  const normSet = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  function resolveCode(variant, ctPrintings, soleCmPrinting) {
    const v = normSet(variant);
    if (!v) return "";
    const printings = ctPrintings.filter((p) => p.code);
    // 1. The two sites agree on the name — nothing to infer.
    const exact = printings.find((p) => normSet(p.variant) === v);
    if (exact) return exact.code;
    // 2. Cardmarket files promos as their own "<Set> Promos" expansion; Scryfall (and so
    //    config.json) prefixes those codes with P. Without such a printing to point at,
    //    give up rather than fall through and label a promo as the base set.
    if (/\bpromos?\b/.test(v)) {
      const promo = printings.find((p) => /^p/i.test(p.code));
      return promo ? promo.code : "";
    }
    // 3. "<Set> Extras" is Cardmarket's split for showcase and extended-art printings,
    //    which Scryfall keeps inside the base set.
    const base = printings.find((p) => !/^p/i.test(p.code) && v.startsWith(normSet(p.variant) + " "));
    if (base) return base.code;
    // 4. When every CardTrader printing of this card is the same set, that is the set,
    //    whatever either site calls it ("Secrets of Strixhaven" vs "Strixhaven"). Only
    //    when Cardmarket is showing one printing too: otherwise a card watched on one
    //    CardTrader printing would stamp that code onto every Cardmarket printing —
    //    confidently wrong, which is worse than the full name it replaced.
    if (!soleCmPrinting) return "";
    const codes = [...new Set(printings.map((p) => p.code))];
    return codes.length === 1 ? codes[0] : "";
  }

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
    // No Seller column: the name was eating a fifth of the table for something you
    // rarely act on, and the room is worth more to Set — which was truncating to "C…"
    // on phones. The seller is still one tap away through the Set link.
    // The Set cell is the official set code (`code` in config.json for CardTrader,
    // scraped from the row thumbnail for Cardmarket) at every width — a code is what
    // you actually compare printings by, and the full names were long enough to
    // truncate even on a desktop ("Starter Commander…"). The name is not lost: it is
    // the link's tooltip. Entries predating the field fall back to the full name, so
    // the column still has to tolerate one.
    cols.push({ key: "set", label: "Set", cell: (o) => `<a href="${esc(o._url)}" title="${esc(o._variant)}" target="_blank">${esc(o._code || o._variant)}</a>` });
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

    // Source filter. Applied to offers, not to cards: the tick box and the freshness
    // chip describe *scraping* Cardmarket, which is unrelated to which prices you are
    // looking at, so a card keeps both while showing only CardTrader rows. A card left
    // with nothing to show falls through to the "watching" chips, as an out-of-stock
    // card already does.
    const only = opts.source && opts.source !== "all" ? opts.source : null;

    let totalOffers = 0;
    const empty = []; const errored = new Set(); const cards = [];
    for (const g of order) {
      // An all-versions page for a card with one printing yields no per-row set, so the
      // offer would fall back to the entry's own label — "All printings" — which says
      // nothing. When CardTrader watches exactly one printing of this card, that is the
      // printing, so borrow its name and code.
      const ctPrintings = groups[g].filter((p) => p.site === "cardtrader");
      const distinct = new Set(ctPrintings.map((p) => `${p.variant}|${p.code}`));
      const solePrinting = distinct.size === 1 ? ctPrintings[0] : null;

      // Resolved per card, and memoised: a card with 30 offers from 3 printings should
      // run the rules three times, not thirty.
      const cmNames = new Set();
      for (const p of groups[g]) {
        if (p.site !== "cardmarket") continue;
        for (const o of p.offers || []) if (o.variant) cmNames.add(normSet(o.variant));
      }
      const resolved = new Map();
      const codeFor = (variant) => {
        if (!resolved.has(variant)) resolved.set(variant, resolveCode(variant, ctPrintings, cmNames.size === 1));
        return resolved.get(variant);
      };

      let merged = [];
      for (const p of groups[g]) {
        if (only && p.site !== only) continue;
        if (p.error) errored.add(g);
        const fallback = p.allVersions && solePrinting ? solePrinting : p;
        // An offer may carry its own set: Cardmarket's all-versions page returns one
        // table mixing every printing, so the row wins over the entry when it says so.
        for (const o of p.offers || [])
          merged.push({
            ...o,
            _variant: o.variant || fallback.variant || "",
            // A curated code beats the scraped one when the row's printing is known:
            // both sites abbreviate, and two spellings of one set in a single table
            // reads as two different printings. Scraped is the next best thing, and the
            // full name is what is left when neither knows.
            _code: o.variant ? codeFor(o.variant) || o.code || "" : o.code || fallback.code || "",
            _site: p.site,
            _url: o.productUrl || p.productUrl,
          });
      }
      merged.sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9));
      // Only a card with a Cardmarket entry can be refreshed on demand — CardTrader
      // is free and already refreshes everything every couple of minutes.
      const cmEntries = groups[g].filter((p) => p.site === "cardmarket");
      // Carried into the chips below rather than dropped: a card showing nothing is
      // exactly the one you want to re-scrape, so it has to stay pickable.
      if (!merged.length) { empty.push({ g, cmEntries }); continue; }
      totalOffers += merged.length;
      cards.push({ g, merged, cmEntries });
    }

    const selected = opts.selected || new Set();
    const pending = opts.pending || new Set();
    // Cards Cardmarket can refresh, per config.json (published in the CardTrader feed).
    // Falling back to "has scraped data" alone would hide every tick box until the
    // first scrape had already happened.
    const cmCards = opts.cardmarketCards ? new Set(opts.cardmarketCards) : null;
    // Credits are scarce enough that which cards get refreshed is a real choice, so
    // each refreshable card carries a tick box. The set lives in app.js (and
    // localStorage) rather than here, so a poll re-render doesn't clear it.
    const pickBox = (g, refreshable) =>
      opts.selectable && refreshable
        ? `<input type="checkbox" class="pick" data-group="${esc(g)}"${selected.has(g) ? " checked" : ""} aria-label="Include ${esc(g)} in the next Cardmarket refresh" title="Include in the next Cardmarket refresh">`
        : "";
    // One listener per box, reading the card name off the element rather than closing
    // over it, so the chips below can share the wiring with the cards above.
    const wirePicks = (root) => {
      if (!opts.onToggle) return;
      for (const box of root.querySelectorAll(".pick")) {
        box.addEventListener("change", () => opts.onToggle(box.dataset.group, box.checked));
      }
    };

    for (const { g, merged, cmEntries } of cards) {
      const refreshable = cmCards ? cmCards.has(g) : cmEntries.length > 0;
      const hiddenCount = merged.length - MAX_VISIBLE_ROWS;
      const collapsible = hiddenCount > 0;
      const collapsed = collapsible && !expandedGroups.has(g);
      const rows = merged.map((o, i) =>
        `<tr class="${priceClass(o.price)}${collapsible && i >= MAX_VISIBLE_ROWS ? " row-extra" : ""}">` + cols.map((c) => `<td class="c-${c.key}">${c.cell(o)}</td>`).join("") + "</tr>"
      ).join("");
      const toggle = collapsible ? `<tr class="row-toggle"><td colspan="${cols.length}"><button type="button">${collapsed ? `Show ${hiddenCount} more ▾` : "Show fewer ▴"}</button></td></tr>` : "";

      const pick = pickBox(g, refreshable);

      const card = document.createElement("div");
      card.className = "card" + (collapsed ? " is-collapsed" : "");
      card.innerHTML = `<h2>${pick}<span>${esc(g)}</span><span class="badges">${cmChip(cmEntries, pending.has(g), refreshable)}<span class="badge">${merged.length}</span></span></h2>
        <table>${colgroup}${head}${rows}${toggle}</table>`;
      wirePicks(card);
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
      // Under a filter these cards usually do have offers — just not from the source
      // you asked for. Saying "no offers yet" there would read as a fault.
      const why = only ? `no ${SRC_NAME[only]} offers` : "no offers yet";
      // A card with nothing to show carries the same tick box and freshness chip as one
      // with a table. It used to be a bare name, which made the card you most want to
      // re-scrape the only one you could not aim at: with no listings and no box, the
      // choices were "Select all" (the whole day's allowance) or an untargeted run that
      // takes the stalest cards. Cards are still ticked by name, so a card that gains
      // offers keeps its tick as it moves up into the grid.
      const chips = empty.map(({ g, cmEntries }) => {
        const refreshable = cmCards ? cmCards.has(g) : cmEntries.length > 0;
        const pick = pickBox(g, refreshable);
        return `<span class="chip${errored.has(g) ? " err" : ""}${pick ? " pickable" : ""}">${pick}<span>${esc(g)}</span>${cmChip(cmEntries, pending.has(g), refreshable)}</span>`;
      }).join("");
      watching.innerHTML = `<div class="label">Watching · ${why} (${empty.length})</div>
        <div class="chips">${chips}</div>`;
      wirePicks(watching);
    }
    return { totalOffers };
  }

  global.CardUI = { renderGrid, ageLabel };
})(window);
