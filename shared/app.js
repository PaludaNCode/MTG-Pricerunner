// Page bootstrap for the cloud static site.
// The page sets window.DASH = { url, intervalMs } before including this script;
// `url` points at the prebuilt data.json from GitHub Actions.
//
// CardTrader offers arrive prebuilt in data.json. Cardmarket can't be fetched by any
// server (Cloudflare — see docs/azure-hosting.md), so if the browser extension in
// extension/ is installed, those rows are filled in here instead, from your own logged-in
// session, at the moment you look at the page. Without the extension the Cardmarket rows
// stay as data.json left them (paused) and everything else is unaffected.
(function () {
  const cfg = window.DASH || {};
  const $ = (id) => document.getElementById(id);

  const hasCardmarketClient = typeof CardmarketClient !== "undefined";
  let bridgeChecked = false;
  let bridgeAvailable = false;

  function render(data) {
    const { totalOffers } = CardUI.renderGrid(data, { showShips: true });
    return totalOffers;
  }

  function setStatus(data, totalOffers, extra) {
    $("updated").textContent =
      (data.updatedAt ? "updated " + new Date(data.updatedAt).toLocaleString() : "starting…") +
      " · " + totalOffers + " offers" + (extra ? " · " + extra : "");
  }

  async function refresh() {
    let data;
    try {
      const sep = cfg.url.includes("?") ? "&" : "?";
      data = await (await fetch(cfg.url + sep + "t=" + Date.now())).json();
    } catch (e) {
      $("updated").textContent = "load failed: " + e;
      return;
    }

    // Render CardTrader immediately — Cardmarket may take a while and must never hold up
    // the data we already have.
    setStatus(data, render(data));

    const cmRows = (data.results || []).filter((r) => r.site === "cardmarket");
    if (!hasCardmarketClient || !cmRows.length) return;

    if (!bridgeChecked) {
      bridgeChecked = true;
      bridgeAvailable = await CardmarketClient.detect();
    }
    if (!bridgeAvailable) {
      setStatus(data, render(data), "Cardmarket needs the browser extension");
      return;
    }

    try {
      await CardmarketClient.fillOffers(cmRows, {
        onProgress: (done, total) => {
          // Re-render as rows land so prices appear progressively.
          setStatus(data, render(data), `Cardmarket ${done}/${total}`);
        },
      });
      const failed = cmRows.filter((r) => r.error).length;
      setStatus(data, render(data), failed ? `Cardmarket ${failed}/${cmRows.length} unavailable` : "Cardmarket live");
    } catch (e) {
      setStatus(data, render(data), "Cardmarket failed: " + (e.message || e));
    }
  }

  refresh();
  setInterval(refresh, cfg.intervalMs || 60000);
})();
