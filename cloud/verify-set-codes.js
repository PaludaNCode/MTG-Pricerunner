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
// It must never become a flaky gate: anything that isn't a clear answer from Scryfall —
// unreachable, rate-limited, 5xx — is reported and *skipped*, not failed. A check that
// cries wolf gets ignored, and then it may as well not exist.
const fs = require("fs");
const path = require("path");
const { normalizeCards } = require("../shared/cards");

const API = "https://api.scryfall.com";
// Scryfall asks for an identifying User-Agent and an explicit Accept.
const HEADERS = {
  Accept: "application/json",
  "User-Agent": "MTG-Pricerunner-CI/1.0 (+https://github.com/PaludaNCode/MTG-Pricerunner)",
};
// Their guidance is 50-100ms between requests; stay on the polite side of it.
const THROTTLE_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Distinguishes "Scryfall answered" from "we never got an answer". Only the first is
// allowed to fail the build.
async function ask(url) {
  let res;
  try {
    res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  } catch (err) {
    return { reachable: false, why: err.name === "TimeoutError" ? "timed out" : err.message };
  }
  // 404 is a real answer here (no such set, no such card). 429/5xx are not.
  if (res.status === 429 || res.status >= 500) {
    return { reachable: false, why: `HTTP ${res.status}` };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    return { reachable: false, why: "unparseable response" };
  }
  return { reachable: true, status: res.status, body };
}

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
  async cardInSet(name, code) {
    // name: is a substring match on the full card name, so a double-faced card whose
    // group is only the front face ("Agadeem's Awakening") still matches.
    const q = encodeURIComponent(`set:${code} name:"${name.replace(/"/g, "")}"`);
    const r = await ask(`${API}/cards/search?q=${q}&unique=prints`);
    if (!r.reachable) return r;
    if (r.status === 404) return { reachable: true, found: false };
    return { reachable: true, found: (r.body?.total_cards || 0) > 0 };
  },
};

// Pure over the api object so the whole decision table is unit-testable offline —
// which matters, because the environment that most needs this check can't reach
// Scryfall to exercise it.
async function auditCodes(entries, api, { throttleMs = THROTTLE_MS } = {}) {
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
    pairs.push(e);
  }

  for (const [i, e] of pairs.entries()) {
    const code = String(e.code).toUpperCase();
    if (!sets.codes.has(code)) {
      errors.push(`${e.group} — "${e.code}" is not a Scryfall set code`);
      continue;
    }
    if (i > 0 && throttleMs) await sleep(throttleMs);
    const hit = await api.cardInSet(e.group, code);
    if (!hit.reachable) {
      skipped.push(`${e.group} (${code}) — ${hit.why}`);
      continue;
    }
    if (!hit.found) {
      errors.push(`${e.group} — no card by that name in ${code} (${sets.codes.get(code)})`);
    }
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
  if (skipped.length && !checked) {
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
