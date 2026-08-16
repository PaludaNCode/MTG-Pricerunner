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
    } catch (e) {
      $("updated").textContent = "load failed: " + e;
    }
  }

  refresh();
  setInterval(refresh, cfg.intervalMs || 60000);
})();
