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
      if (!polling) {
        const b = budgetState(cm && cm.meta);
        setBtn(
          b.spent ? "CM budget spent" : "↻ CM",
          b.spent,
          b.note ? b.note + (b.spent ? " — next allowance at 00:00 UTC" : "") : "Scrape Cardmarket now",
        );
      }
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
  let polling = null;

  const setBtn = (label, disabled, title) => {
    if (!btn) return;
    btn.textContent = label;
    btn.disabled = !!disabled;
    if (title) btn.title = title;
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

  async function dispatch() {
    const d = cfg.dispatch;
    let token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      token = window.prompt(
        "GitHub token (fine-grained PAT, Actions: read and write on this repo).\n" +
          "Stored only in this browser — never sent anywhere but api.github.com.",
      );
      if (!token) return;
      localStorage.setItem(TOKEN_KEY, token.trim());
      token = token.trim();
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
      throw new Error("token rejected (" + res.status + ") — it was cleared, try again");
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
      setBtn(ok ? "↻ CM" : "timed out", false, ok ? "" : "no new snapshot within 3 min — check the Actions tab");
      await refresh();
    } catch (e) {
      setBtn("↻ CM", false);
      window.alert(String(e.message || e));
    } finally {
      polling = false;
    }
  }

  if (btn && cfg.dispatch) btn.addEventListener("click", onRefresh);
  else if (btn) btn.hidden = true;

  refresh();
  setInterval(refresh, cfg.intervalMs || 60000);
})();
