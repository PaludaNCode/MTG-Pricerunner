// Validates every set code in config.json against Scryfall — from CI, where the network
// is open.
//
// config.json *requires* a code (test/config.test.js), and it is what the Set column
// shows at every width, but nothing checked that the code was real. A Claude Code web
// session can't check either: api.scryfall.com is off the egress allowlist, so a code
// added there is sourced second-hand (see the keyrune note in CLAUDE.md). This moves the
// guard to the one place with an unrestricted network, so a wrong code fails a PR
// instead of quietly mislabelling a printing on the live site.
//
// Two failures, both real:
//   - the code names no Scryfall set at all (a guess from the set name)
//   - the set exists but doesn't contain the card (the HOB-vs-HOC class of error, which
//     an existence check alone sails straight past)
//
// **Three requests, not one per card.** The first version asked per card with a 120ms
// throttle and a GitHub runner's shared IP earned an HTTP 429 on nearly every one — so
// the check skipped most of the config and reported that as success-ish. /cards/collection
// takes 75 identifiers at a time, so the whole config is one POST: no throttle to tune,
// and nothing to rate-limit.
//
// **A failure diagnoses itself.** Being told a code is wrong is half an answer when the
// right one can't be looked up from the session that has to fix it. So each failure
// costs one more request that asks Scryfall which sets *do* contain the card, and prints
// them. The fix is then in the CI log rather than a guess away.
//
// It must never become a flaky gate: anything that isn't a clear answer from Scryfall —
// unreachable, rate-limited, 5xx, or a payload with no sets in it — is reported and
// *skipped*, not failed. A check that cries wolf gets ignored.
const fs = require("fs");
const path = require("path");
const { normalizeCards } = require("../shared/cards");

const API = "https://api.scryfall.com";
// Scryfall asks for an identifying User-Agent and an explicit Accept.
const HEADERS = {
  Accept: "application/json",
  "User-Agent": "MTG-Pricerunner-CI/1.0 (+https://github.com/PaludaNCode/MTG-Pricerunner)",
};
const CHUNK = 75; // /cards/collection's documented maximum

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Distinguishes "Scryfall answered" from "we never got an answer". Only the first is
// allowed to fail the build. One retry on 429 — with so few requests it should never
// fire, but a shared runner IP is not ours to predict.
async function ask(url, init = {}, { retries = 1 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: init.headers || HEADERS,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    return { reachable: false, why: err.name === "TimeoutError" ? "timed out" : err.message };
  }
  if (res.status === 429 && retries > 0) {
    const wait = Number(res.headers.get("retry-after")) * 1000 || 2000;
    await sleep(wait);
    return ask(url, init, { retries: retries - 1 });
  }
  // 404 is a real answer here (no such set, no such card). 429/5xx are not.
  if (res.status === 429 || res.status >= 500) return { reachable: false, why: `HTTP ${res.status}` };
  let body = null;
  try {
    body = await res.json();
  } catch {
    return { reachable: false, why: "unparseable response" };
  }
  return { reachable: true, status: res.status, body };
}

// Content-Type is required: without it Scryfall rejects the POST, and the rejection is
// still valid JSON — which is how a version of this shipped "verifying" nothing at all.
const postJson = (url, payload) =>
  ask(url, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { ...HEADERS, "Content-Type": "application/json" },
  });

const liveApi = {
  async listSets() {
    const r = await ask(`${API}/sets`);
    if (!r.reachable) return r;
    const codes = new Map();
    for (const s of r.body?.data || []) codes.set(String(s.code).toUpperCase(), s.name);
    // An empty or unshaped payload is not evidence that no set exists — a 404 or an
    // error body parses fine and would otherwise condemn every code in config.json at
    // once. No sets means no answer.
    if (!codes.size) return { reachable: false, why: `unexpected /sets payload (HTTP ${r.status})` };
    return { reachable: true, codes };
  },

  // One POST per 75 cards. Returns the pairs Scryfall could not match.
  async lookupCards(pairs) {
    const notFound = [];
    for (let i = 0; i < pairs.length; i += CHUNK) {
      const slice = pairs.slice(i, i + CHUNK);
      const r = await postJson(`${API}/cards/collection`, {
        identifiers: slice.map((p) => ({ name: p.group, set: String(p.code).toLowerCase() })),
      });
      if (!r.reachable) return r;
      // A rejected POST answers with a perfectly valid JSON error object, and reading
      // its absent not_found as "nothing missing" turns a broken check into a green
      // one. Demand the shape a real answer has: both arrays present, and one entry
      // accounted for per identifier sent.
      const data = r.body?.data;
      const missing = r.body?.not_found;
      if (!Array.isArray(data) || !Array.isArray(missing) || data.length + missing.length !== slice.length) {
        return {
          reachable: false,
          why: `unexpected /cards/collection payload (HTTP ${r.status}${r.body?.details ? `: ${r.body.details}` : ""})`,
        };
      }
      for (const id of missing) {
        notFound.push({ group: id.name, code: String(id.set || "").toUpperCase() });
      }
    }
    return { reachable: true, notFound };
  },

  // Only ever called for something already failing, to turn "wrong" into "here's right".
  async printingsOf(name) {
    const q = encodeURIComponent(`!"${name.replace(/"/g, "")}"`);
    const r = await ask(`${API}/cards/search?q=${q}&unique=prints`);
    if (!r.reachable) return r;
    if (r.status === 404) return { reachable: true, codes: [] }; // no card by that name at all
    const codes = [...new Set((r.body?.data || []).map((c) => String(c.set).toUpperCase()))];
    return { reachable: true, codes };
  },
};

// Pure over the api object so the whole decision table is unit-testable offline —
// which matters, because the environment that most needs this check can't reach
// Scryfall to exercise it.
async function auditCodes(entries, api) {
  const errors = [];
  const skipped = [];

  const sets = await api.listSets();
  if (!sets.reachable) {
    return { errors, skipped: [`Scryfall unreachable (${sets.why}) — set codes not verified`], checked: 0 };
  }

  const seen = new Set();
  const pairs = [];
  for (const e of entries) {
    if (!e.code) continue; // allVersions entries carry no single set, by design
    const key = `${e.group}|${e.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ group: e.group, code: String(e.code).toUpperCase() });
  }

  // Turns a bare "that's wrong" into the answer, since whoever has to fix it may not be
  // able to reach Scryfall themselves.
  const suggest = async (group, code) => {
    const p = await api.printingsOf(group);
    if (!p.reachable) return "";
    if (!p.codes.length) return ` — Scryfall has no card named "${group}"; check the name`;
    if (p.codes.includes(code)) return ""; // caller decides; nothing to suggest
    return ` — Scryfall lists it in: ${p.codes.join(", ")}`;
  };

  const known = [];
  for (const p of pairs) {
    if (sets.codes.has(p.code)) known.push(p);
    else errors.push(`${p.group} — "${p.code}" is not a Scryfall set code${await suggest(p.group, p.code)}`);
  }

  const found = await api.lookupCards(known);
  if (!found.reachable) {
    skipped.push(`card lookup did not complete (${found.why}) — ${known.length} code(s) not confirmed`);
    return { errors, skipped, checked: pairs.length - known.length };
  }

  for (const miss of found.notFound) {
    const where = await suggest(miss.group, miss.code);
    errors.push(
      `${miss.group} — not in ${miss.code} (${sets.codes.get(miss.code) || "?"})${where}`,
    );
  }

  return { errors, skipped, checked: pairs.length };
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));
  const { errors, skipped, checked } = await auditCodes(normalizeCards(cfg), liveApi);

  for (const s of skipped) console.warn(`skipped: ${s}`);
  for (const e of errors) console.error(`WRONG SET CODE: ${e}`);

  if (errors.length) {
    console.error(`\n${errors.length} bad set code(s) in config.json — see above.`);
    process.exit(1);
  }
  if (!checked) {
    console.warn("\nSet codes were NOT verified this run (Scryfall did not answer). Not failing the build.");
    return;
  }
  console.log(`${checked} set code(s) verified against Scryfall${skipped.length ? `, ${skipped.length} skipped` : ""}.`);
}

if (require.main === module) {
  main().catch((err) => {
    // An unexpected crash in the checker is not evidence of a bad config.
    console.warn(`set-code check could not run: ${err.message}`);
  });
}

// liveApi is exported so the real fetch path can be exercised against a
// Scryfall-shaped stub; nothing else should reach for it.
module.exports = { auditCodes, liveApi };
