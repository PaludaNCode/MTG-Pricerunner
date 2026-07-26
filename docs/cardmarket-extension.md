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

## Try it now — step by step

Do these in order. Steps 1–3 are one-time; after that it's just step 4.

**1. Serve the dashboard locally.** In the repo:

```bash
node scripts/try-extension.js --serve
```

It prints a URL (`http://localhost:8788/`) and keeps running. It builds the page exactly
as the deploy does and writes a `data.json` containing just the Cardmarket cards from
`config.json`, so no CardTrader token is needed.

**2. Install the extension** (once — it survives restarts):

1. Open `chrome://extensions` **in your normal, everyday Chrome**.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this repo's `extension/` folder.

Chrome may nag about developer-mode extensions at startup; that's expected for an unpacked
extension and harmless.

**3. Make sure Cardmarket is happy in that Chrome.** Visit
[cardmarket.com](https://www.cardmarket.com/) in the same browser. If it shows a "Verify
you are human" check, clear it. Logging in is optional but makes the Ship column
meaningful (whether a seller actually ships to your country); logged out, prices still
parse but Ship is unknown.

**4. Open `http://localhost:8788/` in that Chrome.**

Expected: the header ends with `Cardmarket live`, and the Cardmarket rows fill in over
~10 seconds (they're fetched 2s apart, deliberately).

### If it doesn't work

| Symptom | Cause | Fix |
|---|---|---|
| Header says `Cardmarket needs the browser extension` | The content script didn't load | Confirm the extension is enabled in `chrome://extensions`, then hard-reload the page |
| Rows say `Cloudflare challenge — …` | That Chrome has no clearance yet | Do step 3 in the **same** browser, then reload |
| Rows say `no offers found on the page` | Either genuinely no Japanese listings, or Cardmarket changed its markup | Open the card's URL by hand; if offers are visible there, the parser needs updating |
| Ship column empty | Not logged in | Log in to Cardmarket in that browser |

## Don't try to test this with Playwright

**Measured 2026-07-26: a Playwright-driven browser cannot pass, and the reason is
inherent.** Cloudflare serves an automated (CDP-driven) browser a *non-interactive*
managed challenge that never completes — the page sits on "Performing security
verification" with **zero buttons or checkboxes**, so there is nothing a human can click to
clear it. Warming the profile by hand doesn't help, because there's no widget to interact
with. Automating the browser is precisely what Cloudflare detects, which makes a driven
browser the one browser this design can't use.

Two further traps found while testing:

- **Chrome 137+ removed the `--load-extension` switch** on the stable channel. Verified:
  `channel: "chrome"` loads no extension at all (`serviceWorkers().length === 0`), while
  Playwright's bundled Chromium loads it fine (`=== 1`). So a "just launch real Chrome with
  the extension" harness silently tests nothing.
- Clearance earned in one browser **does not** transfer to another — Cloudflare binds it to
  the IP, TLS fingerprint and User-Agent that earned it. Warming your own Chrome does
  nothing for a Playwright profile.

`node scripts/try-extension.js` (no `--serve`) still drives the extension via Playwright.
It's kept only to re-verify the above and to prove the plumbing works: it reports
`service worker: loaded` and `bridge: connected`, then correctly diagnoses the challenge
rather than claiming the cards have no offers. Use `--serve` for anything real.

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
