// Page bootstrap for the cloud static site.
// The page sets window.DASH = { url, cmUrl?, intervalMs, showSrc? } before including
// this script. `url` is the CardTrader feed (refreshed every couple of minutes) and
// `cmUrl` the Cardmarket one (hourly at most, and often unchanged) — two files because
// the two workflows publish independently to their own branches.
// showSrc: false hides the Src column — useful if the data ever has a single source.
(function () {
  const cfg = window.DASH || {};
  const $ = (id) => document.getElementById(id);

  const bust = (u) => u + (u.includes("?") ? "&" : "?") + "t=" + Date.now();
  const load = async (u) => (u ? (await fetch(bust(u))).json() : null);

  async function refresh() {
    try {
      // Cardmarket must never take the page down with it: the branch may not exist yet,
      // and a failed scrape run is not a reason to hide CardTrader prices.
      const [ct, cm] = await Promise.all([load(cfg.url), load(cfg.cmUrl).catch(() => null)]);

      const data = {
        updatedAt: ct && ct.updatedAt,
        results: [...((ct && ct.results) || []), ...((cm && cm.results) || [])],
      };
      const { totalOffers } = CardUI.renderGrid(data, {
        showShips: true,
        showSrc: cfg.showSrc !== false,
        selectable: !!cfg.dispatch,
        selected: picks,
        pending,
        cardmarketCards: (ct && ct.meta && ct.meta.cardmarketCards) || null,
        onToggle,
      });

      $("updated").textContent =
        (data.updatedAt ? "updated " + new Date(data.updatedAt).toLocaleString() : "starting…") +
        " · " + totalOffers + " offers" +
        cmSummary(cm);
      renderLegend(cm);

      // Remembered so a manual refresh can tell when a genuinely new snapshot lands.
      window.__cmUpdatedAt = cm && cm.updatedAt;
      lastMeta = cm && cm.meta;
      syncButton();
    } catch (e) {
      $("updated").textContent = "load failed: " + e;
    }
  }

  // What the header says about Cardmarket. Deliberately NOT the age of cardmarket.json:
  // that file is rewritten by every run even when the budget scraped nothing, so it
  // would read "0m" while every card on screen was days old. Credit spend is the honest
  // global number; per-card ages live on the cards themselves.
  function cmSummary(cm) {
    const m = cm && cm.meta;
    if (!m) return " · CM never scraped";
    if (m.allowance == null) return " · CM " + (m.scrapes || 0) + " scraped today";
    return ` · CM ${m.credits || 0}/${Math.round(m.allowance)} credits today` +
      (m.remaining != null ? ` (${m.remaining} left)` : "");
  }

  // One line explaining the model, because "why is this card 3 days old?" and "what
  // will pressing this cost me?" are otherwise unanswerable from the page.
  function renderLegend(cm) {
    const el = $("legend");
    if (!el) return;
    const m = (cm && cm.meta) || null;
    const cost = m && m.costPerScrape;
    const left = m && m.allowance != null ? Math.max(0, m.allowance - (m.credits || 0)) : null;
    const affordable = left != null && cost ? Math.floor(left / cost) : null;
    el.innerHTML =
      '<span class="label">Cardmarket is scraped only when you ask.</span> ' +
      "Nothing refreshes it on a timer — it costs credits, so it waits for you. " +
      (cfg.dispatch ? "Tick the cards you want, then press ↻ CM. " : "") +
      "The chip on each card shows how long ago that card was last scraped" +
      (affordable != null
        ? `, and today's budget still covers about <b>${affordable} card${affordable === 1 ? "" : "s"}</b>.`
        : ". CardTrader keeps updating on its own, for free.");
  }

  // ---- On-demand Cardmarket refresh ------------------------------------------------
  // Triggering a workflow needs a GitHub PAT with Actions: write. This site is public,
  // so the token can never be baked into the page — it is typed once and kept in this
  // browser's localStorage, meaning the button only works for whoever holds a token.
  // Visitors without one can look but not spend.
  const TOKEN_KEY = "mtg-pricerunner.gh-token";
  // Which cards the next on-demand refresh should spend credits on. Empty = all of
  // them, rotated stalest-first by the fetcher (the hourly cron's normal behaviour).
  const PICKS_KEY = "mtg-pricerunner.cm-picks";
  const picks = new Set(loadPicks());

  function loadPicks() {
    try {
      const raw = JSON.parse(localStorage.getItem(PICKS_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }
  function onToggle(group, checked) {
    if (checked) picks.add(group);
    else picks.delete(group);
    localStorage.setItem(PICKS_KEY, JSON.stringify([...picks]));
    syncButton();
  }

  const btn = $("cm-refresh");
  const tokenInput = $("cm-token");
  const tokenToggle = $("cm-token-toggle");
  let polling = false;
  let lastMeta = null;
  // Cards the in-flight run is scraping, so they can show a spinner rather than a
  // stale age while the workflow is running.
  let pending = new Set();

  const getToken = () => (localStorage.getItem(TOKEN_KEY) || "").trim();

  // Inline feedback beats alert() here: on a phone the modal covers the field you need
  // to fix, and the message vanishes the moment you dismiss it.
  function notice(html, isError) {
    const el = $("notice");
    if (!el) return;
    el.innerHTML = html;
    el.className = "notice" + (isError ? " err" : "");
    el.hidden = !html;
  }

  // The field is only in the way once a token is stored, so it hides itself then and
  // the ⚿ button brings it back to change or clear it.
  function showTokenField(show, prefill) {
    if (!tokenInput) return;
    tokenInput.hidden = !show;
    if (show) {
      tokenInput.value = prefill ? getToken() : "";
      tokenInput.focus();
    }
  }

  function saveToken() {
    if (!tokenInput) return;
    const v = tokenInput.value.trim();
    // The two keys this project uses look nothing alike, and pasting the wrong one here
    // costs a confusing round-trip to GitHub for a 401. Catch it before that.
    if (/^fc-/i.test(v)) {
      notice(
        "That looks like the <b>Firecrawl</b> key (<code>fc-…</code>). It belongs in the repo's " +
          "GitHub secrets, not here — this field wants a <b>GitHub token</b> " +
          "(<code>github_pat_…</code> or <code>ghp_…</code>) so the page can start the workflow.",
        true,
      );
      return; // leave the field open with the text in it
    }
    if (v) localStorage.setItem(TOKEN_KEY, v);
    else localStorage.removeItem(TOKEN_KEY); // clearing the field forgets the token
    notice("");
    showTokenField(!v, false);
    syncButton();
  }

  const setBtn = (label, disabled, title) => {
    if (!btn) return;
    btn.textContent = label;
    btn.disabled = !!disabled;
    btn.title = title || "";
  };

  // Reflect the published credit ledger: a run with no allowance left would defer every
  // card, so say that instead of letting the button pretend otherwise.
  function budgetState(meta) {
    if (!meta || meta.allowance == null) return { spent: false, note: "" };
    const used = meta.credits || 0;
    const left = Math.max(0, meta.allowance - used);
    return {
      spent: left < (meta.costPerScrape || 1),
      note: `${used} of ${Math.round(meta.allowance)} credits used today`,
    };
  }

  // Single place that decides what the button says: mid-run > no token > no budget > ready.
  function syncButton() {
    if (!btn || polling) return;
    const label = picks.size ? `↻ CM (${picks.size})` : "↻ CM";
    if (!getToken()) return setBtn(label, true, "Enter a GitHub token (⚿) to refresh on demand");
    const b = budgetState(lastMeta);
    const scope = picks.size
      ? `Scrape the ${picks.size} ticked card(s)`
      : "Scrape Cardmarket — no cards ticked, so the stalest go first";
    setBtn(
      b.spent ? "CM budget spent" : label,
      b.spent,
      b.spent ? b.note + " — next allowance at 00:00 UTC" : scope + (b.note ? " · " + b.note : ""),
    );
  }

  async function dispatch() {
    const d = cfg.dispatch;
    const token = getToken();
    if (!token) {
      showTokenField(true, false);
      throw new Error("enter a GitHub token first");
    }
    const res = await fetch(
      `https://api.github.com/repos/${d.repo}/actions/workflows/${d.workflow}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        // `cards` empty means "whatever is stalest"; a tick list narrows the run to
        // exactly those, so a scarce allowance goes where it was asked to go.
        body: JSON.stringify({
          ref: d.ref || "main",
          inputs: { force: "true", cards: [...picks].join(",") },
        }),
      },
    );
    // 401/403 = the PAT is wrong or expired (they last a year). Drop it so the next
    // click asks again instead of failing forever.
    if (res.status === 401 || res.status === 403) {
      localStorage.removeItem(TOKEN_KEY);
      showTokenField(true, false);
      throw new Error(
        "GitHub rejected that token (" + res.status + "). It has been cleared. It needs to be a " +
          "GitHub token with <b>Actions: read and write</b> on this repo — not the Firecrawl key.",
      );
    }
    if (res.status !== 204) throw new Error("dispatch failed: HTTP " + res.status);
  }

  // The run takes ~30-60s, then publishes to the data-cm branch. Watch for the
  // snapshot's timestamp to move rather than guessing at a fixed delay.
  async function waitForNewData(before, deadline) {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      const cm = await load(cfg.cmUrl).catch(() => null);
      if (cm && cm.updatedAt && cm.updatedAt !== before) return true;
    }
    return false;
  }

  async function onRefresh() {
    if (polling) return;
    polling = true;
    const before = window.__cmUpdatedAt || null;
    try {
      notice("");
      setBtn("dispatching…", true);
      await dispatch();
      setBtn("scraping…", true, "Cardmarket scrape running");
      // Mark the cards this run covers, then repaint so the page shows what is happening.
      // Only ticked cards are knowable: with no ticks the fetcher chooses the stalest
      // ones server-side, and guessing here would put a spinner on the wrong cards.
      pending = new Set(picks);
      await refresh();
      setBtn("scraping…", true, "Cardmarket scrape running");
      const ok = await waitForNewData(before, Date.now() + 180000);
      pending = new Set();
      // Clear the flag first so the re-render's syncButton() can reflect the credits the
      // run just spent, then let a timeout message override it.
      polling = false;
      await refresh();
      if (!ok) setBtn("timed out", false, "no new snapshot within 3 min — check the Actions tab");
    } catch (e) {
      pending = new Set();
      polling = false;
      syncButton();
      notice(String(e.message || e), true);
    } finally {
      polling = false;
    }
  }

  if (btn && cfg.dispatch) {
    btn.addEventListener("click", onRefresh);
    if (tokenToggle) {
      tokenToggle.addEventListener("click", () => showTokenField(tokenInput.hidden, true));
    }
    if (tokenInput) {
      // Enter commits; blur commits too, so a click straight onto ↻ CM still works.
      tokenInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); saveToken(); }
        if (e.key === "Escape") showTokenField(false, false);
      });
      tokenInput.addEventListener("blur", saveToken);
      // No token yet? Lead with the field rather than a disabled button and no clue why.
      if (!getToken()) tokenInput.hidden = false;
    }
    syncButton();
  } else if (btn) {
    btn.hidden = true;
    if (tokenInput) tokenInput.hidden = true;
    if (tokenToggle) tokenToggle.hidden = true;
  }

  refresh();
  setInterval(refresh, cfg.intervalMs || 60000);
})();
