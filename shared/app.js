// Shared page bootstrap for the local watcher and the cloud static site.
// The page sets window.DASH = { url, intervalMs, showSrc? } before including this script.
// Both dashboards render identically; only the data source behind `url` differs
// (local: rolling scraper at /state, cloud: prebuilt data.json from GitHub Actions).
// showSrc: false hides the Src column — useful when a page has a single source.
(function () {
  const cfg = window.DASH || {};
  const $ = (id) => document.getElementById(id);

  async function refresh() {
    try {
      const sep = cfg.url.includes("?") ? "&" : "?";
      const data = await (await fetch(cfg.url + sep + "t=" + Date.now())).json();
      const { totalOffers } = CardUI.renderGrid(data, { showShips: true, showSrc: cfg.showSrc !== false });
      $("fetching").textContent = data.current ? "⏳ " + data.current : "";
      $("updated").textContent =
        (data.updatedAt ? "updated " + new Date(data.updatedAt).toLocaleString() : "starting…") +
        " · " + totalOffers + " offers";
    } catch (e) {
      $("updated").textContent = "load failed: " + e;
    }
  }

  refresh();
  setInterval(refresh, cfg.intervalMs || 60000);
})();
