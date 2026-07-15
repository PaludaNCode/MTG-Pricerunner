# CardTrader API × MTG-Pricerunner — feature analysis

*July 2026. Analysis of what the CardTrader API offers vs. what the app uses today,
and a ranked list of new features we could build on the gap. Endpoint/field specifics
should be re-verified against the [official API reference](https://www.cardtrader.com/docs/api/full/reference)
before implementing — the reference wasn't reachable from the analysis sandbox
(network policy), so API details below come from the fetcher code, prior integration
knowledge, and secondary sources.*

## 1. What the app uses today

| Deployment | Source | Endpoint | Fields consumed |
|---|---|---|---|
| Cloud | CardTrader official API | `GET /api/v2/marketplace/products?blueprint_id=` (bearer token) | `price_cents`, `price_currency`, `quantity`, `properties_hash.{condition, mtg_language, mtg_foil}`, `user.{username, can_sell_via_hub}` |
| Local | CardTrader website JSON | `/en/cards/<id>.json?page=` | same + `layered_price_cents`, `user.country_code`, `formatted_min_shipping_cost` |
| Local | Cardmarket HTML (CDP/curl) | product page scrape | price, condition, qty, seller, location, foil, ships-to-me |

Everything is **one endpoint deep**: fetch offers per blueprint, filter to one
language client-side, render a sorted table. Alerting is session-only — the browser
diffs offer keys against a `seen` set and fires a `Notification`; close the tab and
alerts stop existing.

**Fields we already receive but drop or don't render:** seller country
(`location` — captured by the local fetchers, never shown), shipping cost
(`formatted_min_shipping_cost`, local only), and the offer `properties_hash`
extras (`signed`, `altered`, graded where present). The cloud fetcher doesn't
capture location/shipping at all, though the API returns per-offer `user` data.

## 2. What the API offers that we don't use

**Catalog endpoints** (same bearer token):

- `GET /games`, `GET /categories`, `GET /expansions` — the full catalog tree.
- `GET /blueprints/export?expansion_id=` — full blueprint metadata: card `name`,
  `version` (the variant, e.g. "Extended Art"), `expansion_id`, **`scryfall_id`**,
  **`card_market_ids`**, `tcg_player_id`, image URL, editable/fixed properties
  (collector number etc.). This is the Rosetta stone between CardTrader,
  Cardmarket and Scryfall.
- `GET /marketplace/products?expansion_id=` — **every offer in a whole set in one
  request** (the endpoint we use accepts either `blueprint_id` or `expansion_id`,
  and supports `foil`/`language` filters server-side).

**Account-scope endpoints** (would need broader token scopes; listed for completeness):
inventory (`/products/export`, product CRUD), orders, and full **cart/checkout** —
programmatic purchase including CardTrader Zero.

**Rate limits:** documented as roughly 200 requests / 10 s general, ~10 req/s on
marketplace search. Our fetcher paces at 1 request / 250 ms for ~33 cards (~10 s
per run) — an order of magnitude of headroom for more cards or extra
metadata calls.

## 2b. Cardmarket Price Guide — free daily market prices, no scraping

Cardmarket publishes its **[Price Guide](https://www.cardmarket.com/en/Magic/Data/Price-Guide)**
(under *Data → Price Guide*) as downloadable files, free for everyone since their
[2023 announcement](https://news.cardmarket.com/en/Magic/were-making-the-price-guide-and-product-catalogue-available-for-download)
— previously API-users-only. Key facts:

- **Formats:** gzipped CSV and JSON, refreshed **once per day**. Download URLs are
  linked from the Price Guide page and live on their S3 downloads host, per game
  (Magic = game id 1) — reportedly
  `downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_1.json`, with a
  matching `productList/products_singles_1.json` catalogue (verify the exact URLs on
  the page; they weren't reachable from this analysis sandbox).
- **Per-product metrics** ([field docs](https://api.cardmarket.com/ws/documentation/API_2.0:PriceGuide)):
  `idProduct`, Avg. Sell Price, **Low Price**, **Trend Price**, German Pro Low,
  Suggested Price, plus **AVG1 / AVG7 / AVG30** (average *sale* price over the last
  1/7/30 days) — each in a non-foil and a foil variant.
- **No login, no Cloudflare drama:** these are static file downloads, so a GitHub
  Actions runner can fetch them — unlike the Cardmarket offer pages, which need the
  local CDP/Chrome dance.
- **Caveat:** the guide is per *product* (printing), aggregated across **all
  languages** — there is no JP-only trend price. It's a reference baseline, not a
  substitute for the offer-level JP data we scrape.

**Mapping to our cards is already solved:** CardTrader's `blueprints/export`
returns `card_market_ids`, and Scryfall returns `cardmarket_id` — either one links
a watched blueprint to `idProduct` in the price guide with no manual config.

This unlocks two features directly:

- **Deal detection (feeds F1/F2):** show each card's Trend/AVG7 next to the lowest
  live offer and flag offers meaningfully below trend — "4.20 € vs 7.80 € trend" is
  a much stronger alert signal than a raw threshold, and thresholds could even
  default to a % of trend.
- **Cloud-side Cardmarket presence at last:** the cloud site can't scrape
  Cardmarket offers, but it *can* show daily Cardmarket trend/low prices per card
  as a reference column — closing part of the local-vs-cloud feature gap for free.

The daily file covers all ~100k Magic products (a few MB gzipped); the data
workflow would download it once a day (cache by `Last-Modified`), pluck the
handful of `idProduct`s we watch, and write them into `data.json`.

## 3. Feature ideas, ranked

### Tier 1 — high value, low effort, both deployments

**F1. Target-price alerts.** Add optional `alertBelow` (EUR) per card in
`config.json`. `render.js` highlights qualifying rows and `app.js` notifies only
for new offers *under the threshold* instead of every new offer (today a 40 €
listing on a 5 € card pings the same as a steal). Pure config + shared-UI change,
no new API calls, backward compatible with old `data.json`.

**F2. Price history + trend.** `update-data.yml` already runs every few minutes;
it just overwrites the past. Append a bounded `history.json` next to `data.json`
on the `data` branch: per group, one `{date, minPrice, offerCount}` point per day
(pull the previous file from `raw.githubusercontent.com` before the force-push,
append, cap at ~90 days — keeps the orphan-commit model intact). UI: a Δ badge
("▼ 18% vs last week") and/or a tiny sparkline in the card header. This is the
foundation for "is this price actually good?" — which is the whole point of the app.

**F3. Card images.** `blueprints/export` gives an image (and `scryfall_id` as a
fallback via Scryfall's free image API). Fetch once per blueprint (they're
immutable — cache in the repo or in `data.json`), show a thumbnail in the card
header or on tap/hover. Big glanceability win on phones for near-zero request cost.

**F4. Auto-fill card metadata / config validation.** Today `group`, `variant` and
`code` are hand-typed per config entry (and CI fails on a missing `code`).
Blueprint metadata contains the card name, variant/version, and expansion —
either auto-derive so a config entry is *just a URL*, or keep the fields but add
a CI check that they match the blueprint (catches typos like a wrong set code).

**F5. Render what we already fetch.** Show seller country (already parsed
locally; add to the cloud fetcher from `user.country_code`), shipping cost where
known, a badge for signed/altered offers (currently indistinguishable from clean
copies — matters for value), and drop offers from sellers on vacation if the API
flags them (they can't be bought anyway).

### Tier 2 — medium effort, high leverage

**F6. Server-side push notifications (closes the biggest UX gap).** Cloud alerts
only exist while a tab is open. Since the data workflow already diffs implicitly
(previous `data.json` is one raw-URL fetch away), add a workflow step: diff new
vs. previous offers, and on a new offer below a card's `alertBelow`, POST to a
push channel — [ntfy.sh](https://ntfy.sh) (zero-signup topic, free iOS/Android
apps), a Telegram bot, or a Discord webhook. Real phone push with no server,
no page open, ~30 lines of workflow/Node. Pairs perfectly with F1's thresholds.

**F7. Expansion sniping mode.** A config entry like
`{ "expansionId": ..., "language": "jp", "alertBelow": 5 }` using
`marketplace/products?expansion_id=` — watch an *entire set* for cheap JP
listings in one request. Also an efficiency win when several watched cards share
a set (one call instead of N).

**F8. Same-seller basket view.** We already know the seller per offer. Aggregate
across all watched cards: "seller *tanuki_mtg* has 3 of your cards, 11.40 € total"
— plus a CardTrader-Zero-only toggle (`can_sell_via_hub` is already fetched;
Zero purchases combine into one shipment, so multi-card Zero baskets are the
real-money optimization).

**F9. Cardmarket URL auto-derivation.** `blueprints/export` includes
`card_market_ids`. The local watcher could derive the Cardmarket product from
the CardTrader URL, so each card is configured once instead of twice (today the
5 Cardmarket entries duplicate CardTrader ones by hand).

**F10. Sold-offer velocity.** The same diff that powers F6 can count
*disappeared* offers: "3 JP copies sold this week" per card. Disappearance ≠
sale (sellers delist too) but as a trend it signals urgency — nice on the card
header next to the offer count.

### Tier 3 — larger bets / lower priority

- **F11. PWA install** (manifest + service worker): home-screen app, offline
  last-known prices, and it's the prerequisite for iOS Web Push if we ever want
  browser-native push instead of F6's ntfy approach.
- **F12. Buy via cart API.** Checkout endpoints exist, so a "buy now" button is
  *possible* — but it means a purchase-scoped token in a browser page and real
  money on a bug. Recommend keeping deep links to the product page instead.
- **F13. Local config editor.** `POST /config` on the local server + a small
  form so adding a card is paste-URL-in-the-dashboard instead of editing JSON.
- **F14. Display-currency picker.** FX rates are already fetched; showing JPY/DKK
  is a rendering toggle.

## 4. Suggested first slice

**F1 + F2 + F6 — the alerting trilogy.** They compound: history (F2) tells you
what a good price *is*, thresholds (F1) encode it, push (F6) delivers it with the
tab closed. All three fit the existing architecture (config → workflow → data
branch → shared renderer) without new infrastructure, and F1 alone is shippable
in one small PR.

The Cardmarket Price Guide (§2b) slots straight into that slice: it gives every
watched card a daily Trend/AVG7 baseline for one HTTP download a day, making both
the Δ badges and the alert thresholds *market-relative* instead of hand-tuned.
