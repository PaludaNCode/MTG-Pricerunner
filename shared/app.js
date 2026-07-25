// Page bootstrap for the cloud static site.
// The page sets window.DASH = { url, intervalMs } before including this script;
// `url` points at the prebuilt data.json from GitHub Actions.
(function () {
  const cfg = window.DASH || {};
  const $ = (id) => document.getElementById(id);

  async function refresh() {
    try {
      const sep = cfg.url.includes("?") ? "&" : "?";
      const data = await (await fetch(cfg.url + sep + "t=" + Date.now())).json();
      const { totalOffers } = CardUI.renderGrid(data, { showShips: true });
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
