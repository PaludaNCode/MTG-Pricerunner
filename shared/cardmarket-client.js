// Fetches Cardmarket offers from the page, through the browser-extension bridge
// (extension/), and parses them with shared/cardmarket-parse.js.
//
// Why it lives in the page rather than on a server: Cardmarket is behind Cloudflare, and
// no server-side transport gets through (see docs/azure-hosting.md). Your own browser
// already has a trusted, logged-in session — so the offers are read at the moment you
// look at the dashboard, using that session. Nothing is spoofed and nothing needs hosting.
//
// Degrades to a no-op when the extension isn't installed: the grid just shows whatever
// data.json had (a paused Cardmarket row).
(function (root) {
  const PAGE = "mtg-pricerunner";
  const BRIDGE = "mtg-pricerunner-bridge";

  // The dashboard re-fetches data.json every 60s. Cardmarket must NOT be re-scraped on
  // that cadence — it's a real site with rate limits, and prices don't move that fast.
  // Offers are cached for this long and reused across refreshes and page reloads.
  const CACHE_TTL_MS = 15 * 60 * 1000;
  // Space out requests within a batch. This is your own browsing session, but a burst of
  // 40 page loads still looks nothing like a human, so keep it deliberate.
  const REQUEST_GAP_MS = 2000;
  const BRIDGE_TIMEOUT_MS = 2000;
  const FETCH_TIMEOUT_MS = 35000;
  const CACHE_KEY = "cm-offers-v1";

  let nextId = 1;
  const pending = new Map();
  let bridgeReady = false;

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.source !== BRIDGE) return;
    if (msg.type === "CM_BRIDGE_READY") {
      bridgeReady = true;
      return;
    }
    if (msg.type === "CM_RESULT") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      p(msg);
    }
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Resolves true once the bridge announces itself. The content script may load before or
  // after this script, so ping as well as listen.
  function detect(timeoutMs = BRIDGE_TIMEOUT_MS) {
    if (bridgeReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (bridgeReady) return resolve(true);
        if (Date.now() - started > timeoutMs) return resolve(false);
        window.postMessage({ source: PAGE, type: "CM_BRIDGE_PING" }, window.location.origin);
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  function requestPage(url) {
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: "bridge timed out" });
      }, FETCH_TIMEOUT_MS);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      window.postMessage({ source: PAGE, type: "CM_FETCH", id, url }, window.location.origin);
    });
  }

  function loadCache() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  function saveCache(cache) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch {
      /* sessionStorage full or unavailable — caching is best-effort */
    }
  }

  function diagnose(res) {
    if (!res.ok) return res.error || "fetch failed";
    if (CardmarketParse.looksChallenged(res.html)) {
      return "Cloudflare challenge — open Cardmarket in a tab and pass it once, then reload";
    }
    if (res.status >= 400) return "HTTP " + res.status;
    return null;
  }

  // Fills in `offers` on each Cardmarket row, in place, using the cache where possible.
  // onProgress(done, total, row) is called after each row so the caller can re-render
  // incrementally rather than waiting for the whole batch.
  async function fillOffers(rows, { onProgress = () => {}, force = false } = {}) {
    const cache = loadCache();
    const now = Date.now();
    let done = 0;
    let fetched = 0;

    for (const row of rows) {
      const url = row.productUrl || row.url;
      const hit = cache[url];
      if (!force && hit && now - hit.at < CACHE_TTL_MS) {
        row.offers = hit.offers;
        row.error = hit.error || undefined;
        row.cmAgeMin = Math.round((now - hit.at) / 60000);
        onProgress(++done, rows.length, row);
        continue;
      }

      // Pace only between real network requests, so a fully-cached load stays instant.
      if (fetched > 0) await sleep(REQUEST_GAP_MS);
      fetched++;

      const res = await requestPage(url);
      const problem = diagnose(res);
      if (problem) {
        row.offers = [];
        row.error = problem;
      } else {
        row.offers = CardmarketParse.parseCardmarket(res.html);
        row.error = row.offers.length ? undefined : "no offers found on the page";
        if (CardmarketParse.looksLoggedOut(res.html)) {
          // Guest HTML still lists prices; it just can't say whether a seller ships to you.
          row.cmLoggedOut = true;
        }
      }
      row.cmAgeMin = 0;
      cache[url] = { at: now, offers: row.offers, error: row.error || null };
      onProgress(++done, rows.length, row);
    }

    saveCache(cache);
    return rows;
  }

  root.CardmarketClient = { detect, fillOffers, CACHE_TTL_MS };
})(typeof self !== "undefined" ? self : globalThis);
