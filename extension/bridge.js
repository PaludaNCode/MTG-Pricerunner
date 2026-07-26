// Content script injected into the dashboard only (see manifest content_scripts).
//
// A content script can't fetch Cardmarket itself — in MV3 content-script fetches are
// still subject to CORS — so this is purely a relay between the page and the service
// worker, over window.postMessage.
//
// Protocol (page -> bridge -> worker -> bridge -> page):
//   page:   { source: "mtg-pricerunner", type: "CM_FETCH", id, url }
//   bridge: { source: "mtg-pricerunner-bridge", type: "CM_RESULT", id, ok, status, html?, error? }
//   bridge announces itself with { source: "mtg-pricerunner-bridge", type: "CM_BRIDGE_READY" }
(function () {
  const PAGE = "mtg-pricerunner";
  const BRIDGE = "mtg-pricerunner-bridge";

  function reply(id, payload) {
    window.postMessage({ source: BRIDGE, type: "CM_RESULT", id, ...payload }, window.location.origin);
  }

  window.addEventListener("message", (ev) => {
    // Only trust messages this page posted to itself. Without this, any embedded frame
    // could drive the bridge.
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.source !== PAGE || msg.type !== "CM_FETCH") return;
    if (typeof msg.url !== "string" || typeof msg.id !== "number") return;

    try {
      chrome.runtime.sendMessage({ type: "CM_FETCH", url: msg.url }, (res) => {
        // A missing response means the worker was torn down or the extension reloaded.
        if (chrome.runtime.lastError) {
          reply(msg.id, { ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        reply(msg.id, res || { ok: false, error: "no response from extension" });
      });
    } catch (e) {
      reply(msg.id, { ok: false, error: String(e.message || e) });
    }
  });

  // The page uses this to decide whether to offer Cardmarket at all. Announce on load and
  // on request, since the page's script may start listening either before or after us.
  function announce() {
    window.postMessage({ source: BRIDGE, type: "CM_BRIDGE_READY" }, window.location.origin);
  }
  window.addEventListener("message", (ev) => {
    if (ev.source === window && ev.data && ev.data.source === PAGE && ev.data.type === "CM_BRIDGE_PING") announce();
  });
  announce();
})();
