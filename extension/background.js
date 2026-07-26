// Service worker: the only thing in this extension that touches the network.
//
// It exists because the browser itself blocks the dashboard from reading Cardmarket:
// Cardmarket sends no Access-Control-Allow-Origin (so a page fetch() can't read the
// response) and X-Frame-Options: SAMEORIGIN (so an iframe's DOM can't be read either).
// An extension with host permissions is exempt from CORS, and its requests carry your
// own cookies from your own browser and IP — so Cloudflare sees the same trusted session
// you get when you browse Cardmarket by hand. Nothing is spoofed or bypassed.
//
// Deliberately dumb: fetch a URL, return the text. All parsing lives in the page
// (shared/cardmarket-parse.js) so this stays small and auditable.

// This worker holds your Cardmarket session cookies, so it must never become a general
// credentialed proxy. Two independent guards:
//   1. manifest content_scripts only inject the bridge on the dashboard's own origins,
//      so only those pages can send messages here at all;
//   2. this allowlist, so even a compromised dashboard can only reach Cardmarket.
const ALLOWED_HOSTS = [/(^|\.)cardmarket\.com$/i];

function isAllowed(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return ALLOWED_HOSTS.some((re) => re.test(u.hostname));
}

// Cardmarket pages are a few hundred KB; refuse anything absurd rather than pump it
// through postMessage.
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 30000;

async function fetchPage(url) {
  if (!isAllowed(url)) return { ok: false, error: "url not allowed: " + url };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      credentials: "include", // your own session — this is the whole point
      redirect: "follow",
      signal: ac.signal,
      headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });
    const html = await res.text();
    if (html.length > MAX_BYTES) return { ok: false, status: res.status, error: "response too large" };
    return { ok: true, status: res.status, html };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "timed out" : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "CM_FETCH") return false;
  fetchPage(msg.url).then(sendResponse);
  return true; // keep the message channel open for the async reply
});
