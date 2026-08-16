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

  // Rough age of the Cardmarket snapshot. It legitimately lags — the scrape is metered —
  // so say so rather than letting stale prices look live.
  function ageLabel(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms) || ms < 0) return null;
    const mins = Math.round(ms / 60000);
    if (mins < 60) return mins + "m";
    const hours = Math.round(mins / 60);
    return hours < 48 ? hours + "h" : Math.round(hours / 24) + "d";
  }

  async function refresh() {
    try {
      // Cardmarket must never take the page down with it: the branch may not exist yet,
      // and a failed scrape run is not a reason to hide CardTrader prices.
      const [ct, cm] = await Promise.all([load(cfg.url), load(cfg.cmUrl).catch(() => null)]);

      const data = {
        updatedAt: ct && ct.updatedAt,
        results: [...((ct && ct.results) || []), ...((cm && cm.results) || [])],
      };
      const { totalOffers } = CardUI.renderGrid(data, { showShips: true, showSrc: cfg.showSrc !== false });

      const cmAge = cm && cm.updatedAt ? ageLabel(cm.updatedAt) : null;
      $("updated").textContent =
        (data.updatedAt ? "updated " + new Date(data.updatedAt).toLocaleString() : "starting…") +
        " · " + totalOffers + " offers" +
        (cmAge ? " · CM " + cmAge : "");

      // Remembered so a manual refresh can tell when a genuinely new snapshot lands.
      window.__cmUpdatedAt = cm && cm.updatedAt;
      lastMeta = cm && cm.meta;
      syncButton();
    } catch (e) {
      $("updated").textContent = "load failed: " + e;
    }
  }

  // ---- On-demand Cardmarket refresh ------------------------------------------------
  // Triggering a workflow needs a GitHub PAT with Actions: write. This site is public,
  // so the token can never be baked into the page — it is typed once and kept in this
  // browser's localStorage, meaning the button only works for whoever holds a token.
  // Visitors without one can look but not spend.
  const TOKEN_KEY = "mtg-pricerunner.gh-token";
  const btn = $("cm-refresh");
  const tokenInput = $("cm-token");
  const tokenToggle = $("cm-token-toggle");
  let polling = false;
  let lastMeta = null;

  const getToken = () => (localStorage.getItem(TOKEN_KEY) || "").trim();

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
    if (v) localStorage.setItem(TOKEN_KEY, v);
    else localStorage.removeItem(TOKEN_KEY); // clearing the field forgets the token
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
    if (!getToken()) return setBtn("↻ CM", true, "Enter a GitHub token (⚿) to refresh on demand");
    const b = budgetState(lastMeta);
    setBtn(
      b.spent ? "CM budget spent" : "↻ CM",
      b.spent,
      b.spent ? b.note + " — next allowance at 00:00 UTC" : b.note || "Scrape Cardmarket now",
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
        body: JSON.stringify({ ref: d.ref || "main", inputs: { force: "true" } }),
      },
    );
    // 401/403 = the PAT is wrong or expired (they last a year). Drop it so the next
    // click asks again instead of failing forever.
    if (res.status === 401 || res.status === 403) {
      localStorage.removeItem(TOKEN_KEY);
      showTokenField(true, false);
      throw new Error("token rejected (" + res.status + ") — it was cleared, enter a new one");
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
      setBtn("dispatching…", true);
      await dispatch();
      setBtn("scraping…", true, "Cardmarket scrape running");
      const ok = await waitForNewData(before, Date.now() + 180000);
      // Clear the flag first so the re-render's syncButton() can reflect the credits the
      // run just spent, then let a timeout message override it.
      polling = false;
      await refresh();
      if (!ok) setBtn("timed out", false, "no new snapshot within 3 min — check the Actions tab");
    } catch (e) {
      polling = false;
      syncButton();
      window.alert(String(e.message || e));
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
