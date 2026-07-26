# Cardmarket prices via your own browser

Cardmarket prices are read **client-side, by your own browser, at the moment you open the
dashboard** — using the session you already have. No server, no VM, no monthly cost.

```
dashboard page                    extension                    cardmarket.com
──────────────                    ─────────                    ──────────────
app.js sees a
cardmarket row
      │ postMessage CM_FETCH
      ▼
  bridge.js  ──chrome.runtime──▶ background.js ──fetch(credentials)──▶ product page
 (content script)                (service worker)                            │
      ◀───────────── HTML ──────────────┘                                    │
      │                                          your cookies, your IP,  ────┘
      ▼                                          your real Chrome
cardmarket-parse.js
parses offers → grid
```

## Why it has to work this way

Three separate walls, and the first two have nothing to do with Cloudflare:

1. **CORS.** Cardmarket sends no `Access-Control-Allow-Origin`, so JavaScript on the
   dashboard can `fetch()` the page but is not allowed to *read* the response.
2. **Framing.** `X-Frame-Options: SAMEORIGIN`, so loading it in an `<iframe>` and reading
   the DOM is blocked too.
3. **Cloudflare.** Every server-side transport is challenged — measured in
   `docs/azure-hosting.md`; even a headed browser with a fresh profile gets a `403`.

A browser extension with host permissions clears all three: extension fetches are exempt
from CORS, and the request carries **your** cookies, TLS fingerprint, and IP. Cloudflare
sees the same trusted, logged-in session you get when you browse Cardmarket by hand.
Nothing is spoofed, no challenge is bypassed, and there is no proxy in the middle.

The trade-off: prices are only fetched while the dashboard is open in that browser. For a
price watcher that's the moment you actually care, so it costs nothing real — but a phone
without the extension shows the Cardmarket rows as paused.

## Install (Chrome / Edge, ~1 minute)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this repo's `extension/` folder.
4. Open the dashboard. The header shows `Cardmarket live` once rows fill in.

It's a permanent install — it survives restarts. Chrome may nag about developer-mode
extensions on startup; that's expected for an unpacked extension and harmless.

If a row says **"Cloudflare challenge — open Cardmarket in a tab and pass it once"**, do
exactly that: visit cardmarket.com in the same browser, clear the challenge, reload the
dashboard. Being logged in also makes the Ship column meaningful (whether a seller ships
to your country); logged out, prices still parse but Ship is unknown.

## What the extension can and cannot do

The permission it requests is `*://*.cardmarket.com/*` — nothing else. It has no access to
any other site.

It's ~40 lines of real code and worth reading before you trust it:

- `extension/background.js` — the only part that touches the network. Fetches a URL and
  returns the text. It holds your Cardmarket cookies, so it enforces an **allowlist**: it
  refuses any URL that isn't `https://…cardmarket.com`, which stops it from ever being
  used as a general credentialed proxy.
- `extension/bridge.js` — a relay. Injected **only** into the dashboard's own origins (see
  `manifest.json` → `content_scripts.matches`), so no other page can talk to the worker. It
  ignores messages that didn't come from its own window.
- No parsing, no storage, no analytics, no remote code.

Parsing lives in `shared/cardmarket-parse.js` — in the repo, versioned with the site, and
shared with the Node fetcher so there's one copy of the selectors.

### Rate limiting

The dashboard re-fetches `data.json` every 60s, but Cardmarket must not be hit on that
cadence. `shared/cardmarket-client.js` enforces:

- a **15 minute cache** (`sessionStorage`), so refreshes and reloads reuse offers;
- a **2 second gap** between requests within a batch;
- sequential requests only — never a burst.

Prices move far slower than 15 minutes, so this costs you nothing and keeps the request
pattern modest. Don't lower these.

### Adding cards

Add the Cardmarket URL to `config.json` like any other card — `shared/cards.js` derives
`site` from the host. Use the `?language=7` (Japanese) form:

```json
{ "url": "https://www.cardmarket.com/en/Magic/Products/Singles/Aetherdrift/Stock-Up?language=7",
  "group": "Stock Up", "variant": "Aetherdrift", "code": "DFT" }
```

The server emits it as a paused row; your browser fills it in. `cardmarketFetch` stays
`"off"` — it only governs server-side attempts, which don't work.

## Testing without a Cardmarket session

`test/cardmarket-client.browser.test.js` drives the whole page-side path in a real browser
against a **stubbed** bridge, covering parsing, challenge detection, the cache, and
graceful degradation when the extension isn't installed. It needs no Cardmarket access:

```bash
node --test test/cardmarket-client.browser.test.js
```

To check whether a *server-side* transport has become possible again (it hasn't):

```bash
node cloud/probe-cardmarket.js direct
```

## Honest caveats

- **The parser is regex over HTML.** If Cardmarket changes markup, rows go to "no offers
  found on the page" — a visible failure, not a silently wrong price, but it will need a
  fix in `shared/cardmarket-parse.js`.
- **Automated reading is still against Cardmarket's Terms of Use**, even from your own
  browser. The risk is far lower than a datacenter scraper — it's your real session at
  human-ish rates — but it isn't zero, and it's your account.
- **Chrome only** as written (MV3). Firefox needs a manifest tweak.
