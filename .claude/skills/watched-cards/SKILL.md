---
name: watched-cards
description: Add or remove a watched card in this repo's config.json — the price watcher's list of MTG printings. Use this whenever someone pastes a CardTrader or Cardmarket URL and wants it watched, asks to stop watching / drop / remove a card, or asks to change which printings are tracked, even if they don't mention config.json. Removing a Cardmarket card in particular needs a cleanup step that is easy to miss and leaves stale prices on the live site if skipped.
---

# Adding and removing watched cards

`config.json` is the whole watchlist. Editing it is a one-line change, which is exactly
why it goes wrong: the interesting parts are the set code (a wrong one silently
mislabels a printing), whether the card deserves a Cardmarket entry at all (each one
costs real money per refresh), and — on removal — a cleanup step that nothing reminds
you about.

CI catches a lot. Twelve config invariants are enforced in `test/config.test.js`, and
`cloud/verify-set-codes.js` validates every code against Scryfall from the Actions
runner. Lean on those rather than eyeballing. What follows is the part CI cannot check.

## The entry format

```json
{ "url": "…", "group": "Card Name", "variant": "Printing", "code": "SCRYFALL" }
```

- `group` is the card name, and it is also the join key: CardTrader and Cardmarket
  entries sharing a `group` render as one card with one price-sorted table.
- `variant` is the printing as a human reads it ("Zendikar", "Prerelease", "Promos",
  "Extended Art").
- `code` is the official **Scryfall** set code, shown in the Set column at every width.
- `language` defaults to `defaultLanguage` (Japanese) — don't set it per card.

## Adding a card

**1. Work out the set code — do not guess it.** The set name does not determine the
code: The Hobbit is `HOB` but its Commander decks are `HOC`, and a confidently wrong
code mislabels the printing on a public page.

`api.scryfall.com` and `cardtrader.com` are both off the egress allowlist in a Claude
Code web session (`curl` gets `CONNECT tunnel failed, response 403`), and
`CARDTRADER_TOKEN` is a repo secret, not a session variable. The working fallback is the
**`keyrune` npm package**, because registry.npmjs.org *is* allowlisted and keyrune's
identifiers are Scryfall codes:

```bash
cd "$(mktemp -d)" && curl -sS -O "$(curl -sS https://registry.npmjs.org/keyrune \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["versions"][d["dist-tags"]["latest"]]["dist"]["tarball"])')" \
  && tar xzf keyrune-*.tgz && grep -i "<set name>" package/CHANGELOG.md
```

The changelog names every set as `<Name> (<CODE>)`. Cross-check the answer against a
code already in `config.json` for a set you can identify, so you know the source agrees
with this repo's conventions. If you still can't establish it, ask — CI will reject a
wrong code anyway, and a question costs less than a red build.

**2. Decide whether it needs a Cardmarket entry.** This is the cheapest knob in the
project and the one most worth thinking about: every Cardmarket entry costs a Firecrawl
credit each time it is refreshed, while CardTrader is a free API call. A card only worth
watching on CardTrader simply has no Cardmarket URL — it renders CT rows with no tick box
and no freshness chip, which is correct, not broken.

Default to CardTrader only unless the person asks for Cardmarket. If they do, pick the
URL shape deliberately:

| Shape | When | Fields |
|---|---|---|
| `/Magic/Cards/<Card-Name>` | you want every printing; one scrape covers them all | `"variant": "All printings"`, `"allVersions": true`, **no** `code` |
| `/Magic/Products/Singles/<Set>/<Card>` | only certain printings matter | normal `variant` + `code` |

Both must keep `?language=7` — that query is Cardmarket's only language filter, and CI
checks it. CardTrader has no all-versions equivalent, so it always needs one URL per
printing.

**3. Add the entry** next to related cards, keeping the file's one-line-per-entry style.
Never reformat `config.json` with a JSON pretty-printer: it explodes ~57 compact entries
into hundreds of lines and buries the real change.

**4. Verify, then ship.** `npm test` locally; open a PR and let CI check the set code
against Scryfall. Never push to `main`.

After merge the CardTrader feed picks the card up within a couple of minutes. Cardmarket
shows nothing until someone presses ↻ CM — **that spends credits, so don't trigger it
unless asked.**

## Removing a card

Steps 1–3 are ordinary. Step 4 is the one that gets forgotten.

**1. Remove every entry for that `group`** — both the CardTrader printings and any
Cardmarket entry. Removing only one side leaves a half-watched card.

```bash
grep -in "<card name>" config.json     # find them all first
```

**2. Check nothing else references it** (fixtures and tests may name a card):

```bash
grep -rli "<card name>" --exclude-dir=node_modules --exclude-dir=.git .
```

If a test fixture uses the card, leave the fixture alone — fixtures are captured
specimens, not live config.

**3. `npm test`, PR, merge.** The config test that matters here runs one way only: every
Cardmarket group needs a CardTrader card to attach to. Dropping both sides together
keeps it satisfied; dropping only the CardTrader side breaks it.

**4. Purge the Cardmarket feed — this is the step that gets missed.**

The page merges two feeds. `data.json` (CardTrader) is rebuilt every couple of minutes,
so a removed card disappears from it on its own. `cardmarket.json` is rewritten **only
when a Cardmarket run happens**, and nothing starts one but a human — so a card removed
from `config.json` keeps showing its last scraped offers on the live site indefinitely.
This is not hypothetical: one card sat on the site for a day and a half this way.

The fix costs nothing. A **balance-only** run scrapes nothing, is allowed through the
overnight quiet window, and republishes `cardmarket.json` rebuilt from the *current*
config — `mergeResults` maps over today's products, so the removed card is simply not
emitted:

```
Actions → Update Cardmarket data → Run workflow → balance_only: true
```

or dispatch it directly (the site's free "check credit balance" link does the same
thing). Only do this **after** the removal is merged to `main`, since the workflow reads
`config.json` from the default branch.

**5. Confirm it actually went.** Check the published feed rather than the page, which is
CDN-cached:

```bash
curl -sS https://raw.githubusercontent.com/PaludaNCode/MTG-Pricerunner/data-cm/cardmarket.json \
  | python3 -c "import json,sys; d=json.load(sys.stdin); \
    print([r['group'] for r in d['results'] if '<card name>'.lower() in r['group'].lower()] or 'gone')"
```

Then sanity-check that the run was surgical: the other cards should keep their offers,
and `meta.costPerScrape` / `meta.remaining` should carry across. A balance-only run
must never blank the rest of the file.

Caching means the page lags the feed: `raw.githubusercontent.com` caches ~5 minutes, and
the Pages HTML up to ~20. Test in a private tab before concluding something failed.

## Things worth not relearning

- **Never push to `main`.** Branch → PR → wait for the `checks` job → merge. Merging
  *is* the release; the deploy workflow publishes to Pages on push.
- **A scraping Cardmarket run costs money.** `balance_only` is free; a normal run is
  not. Never start one to "check whether it worked" — read the published JSON instead.
- **Don't add a `schedule:` or `push:` trigger to `update-cardmarket.yml`.** It is
  dispatch-only by design, precisely so nothing can spend credits on its own.
- **`meta.cardmarketCards` comes from the CardTrader feed**, not the Cardmarket one, so
  the tick boxes exist before the first scrape. Dropping a Cardmarket entry removes the
  card's tick box automatically; nothing else to edit.
