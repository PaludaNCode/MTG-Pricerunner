// Shared page bootstrap for the local watcher and the cloud static site.
// The page sets window.DASH = { url, intervalMs, showSrc? } before including this script.
// Both dashboards render identically; only the data source behind `url` differs
// (local: rolling scraper at /state, cloud: prebuilt data.json from GitHub Actions).
// showSrc: false hides the Src column — useful when a page has a single source.
(function () {
  const cfg = window.DASH || {};
  let firstRun = true;
  const seen = new Set();      // every offer key observed this session
  const newKeys = new Set();   // offers that appeared after first load (highlighted)
  const recentNew = new Map(); // group -> when it last gained an offer (sorts to top)
  const $ = (id) => document.getElementById(id);

  function notify(title, body) {
    if (window.Notification && Notification.permission === "granted") new Notification(title, { body });
  }

  // Mobile browsers give no visible hint of the permission state (and iOS Safari
  // lacks the Notification API entirely unless the page is opened from the Home
  // Screen), so mirror it next to the 🔔 button.
  function updateNotifStatus() {
    const el = $("notifStatus"); const btn = $("enableNotif");
    if (!el) return;
    if (!window.Notification) {
      el.textContent = "✕ unsupported"; el.className = "meta notif-bad"; btn.disabled = true;
      el.title = "This browser has no notification support. On iPhone/iPad: Share → Add to Home Screen, then open the page from that icon.";
    } else if (Notification.permission === "granted") {
      el.textContent = "✓ on"; el.className = "meta notif-on"; btn.disabled = true; el.title = "";
    } else if (Notification.permission === "denied") {
      el.textContent = "✕ blocked"; el.className = "meta notif-bad"; btn.disabled = true;
      el.title = "Notifications are blocked for this site — allow them in the browser's site settings.";
    } else {
      el.textContent = "off"; el.className = "meta"; btn.disabled = false;
      el.title = "Tap 🔔 to enable new-listing notifications.";
    }
  }

  async function refresh() {
    try {
      const sep = cfg.url.includes("?") ? "&" : "?";
      const data = await (await fetch(cfg.url + sep + "t=" + Date.now())).json();
      const { totalOffers, newAlerts } = CardUI.renderGrid(data, { showShips: true, showSrc: cfg.showSrc !== false, seen, firstRun, newKeys, recent: recentNew });
      if (newAlerts.length) notify("New JP listing!", newAlerts.join("\n"));
      $("fetching").textContent = data.current ? "⏳ " + data.current : "";
      $("updated").textContent =
        (data.updatedAt ? "updated " + new Date(data.updatedAt).toLocaleString() : "starting…") +
        " · " + totalOffers + " offers";
      firstRun = false;
    } catch (e) {
      $("updated").textContent = "load failed: " + e;
    }
    updateNotifStatus();
  }

  $("enableNotif").onclick = () => {
    if (!window.Notification) return;
    Promise.resolve(Notification.requestPermission()).then(updateNotifStatus);
  };
  updateNotifStatus();
  refresh();
  setInterval(refresh, cfg.intervalMs || 60000);
})();
