const { test } = require("node:test");
const assert = require("node:assert/strict");
const { auditCodes } = require("../cloud/verify-set-codes");

// The check runs in CI against the live API, but its decision table has to be provable
// offline — the environment that most needs the guard is the one that can't reach
// Scryfall. So the api object is faked here, exhaustively.
function fakeApi({ sets, cards = {}, setsDown = false, cardsDown = false }) {
  return {
    async listSets() {
      if (setsDown) return { reachable: false, why: "ENOTFOUND" };
      return { reachable: true, codes: new Map(Object.entries(sets)) };
    },
    async cardInSet(name, code) {
      if (cardsDown) return { reachable: false, why: "HTTP 429" };
      return { reachable: true, found: !!cards[`${name}|${code}`] };
    },
  };
}

const NO_THROTTLE = { throttleMs: 0 };

test("a real code holding the card passes", async () => {
  const api = fakeApi({ sets: { HOB: "The Hobbit" }, cards: { "Giant's Boulder|HOB": true } });
  const r = await auditCodes([{ group: "Giant's Boulder", code: "HOB" }], api, NO_THROTTLE);
  assert.deepEqual(r.errors, []);
  assert.equal(r.checked, 1);
});

test("a code that names no Scryfall set fails", async () => {
  const api = fakeApi({ sets: { HOB: "The Hobbit" } });
  const r = await auditCodes([{ group: "Giant's Boulder", code: "ZZZ" }], api, NO_THROTTLE);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /not a Scryfall set code/);
});

// The HOB-vs-HOC case: both codes are real, so existence alone would wave it through.
test("a real set that doesn't contain the card fails", async () => {
  const api = fakeApi({
    sets: { HOB: "The Hobbit", HOC: "The Hobbit Commander" },
    cards: { "Giant's Boulder|HOB": true },
  });
  const r = await auditCodes([{ group: "Giant's Boulder", code: "HOC" }], api, NO_THROTTLE);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /no card by that name in HOC/);
});

test("codes are matched case-insensitively", async () => {
  const api = fakeApi({ sets: { ZEN: "Zendikar" }, cards: { "Arid Mesa|ZEN": true } });
  const r = await auditCodes([{ group: "Arid Mesa", code: "zen" }], api, NO_THROTTLE);
  assert.deepEqual(r.errors, []);
});

// allVersions entries span every printing and carry no single set, by design.
test("entries without a code are skipped, not failed", async () => {
  const api = fakeApi({ sets: {} });
  const r = await auditCodes([{ group: "Planar Nexus", code: null }], api, NO_THROTTLE);
  assert.deepEqual(r.errors, []);
  assert.equal(r.checked, 0);
});

test("one card watched on both sites is only queried once", async () => {
  let calls = 0;
  const api = {
    async listSets() {
      return { reachable: true, codes: new Map([["ZEN", "Zendikar"]]) };
    },
    async cardInSet() {
      calls++;
      return { reachable: true, found: true };
    },
  };
  const entries = [
    { group: "Arid Mesa", code: "ZEN" },
    { group: "Arid Mesa", code: "ZEN" },
  ];
  const r = await auditCodes(entries, api, NO_THROTTLE);
  assert.equal(calls, 1);
  assert.equal(r.checked, 1);
});

// Never a flaky gate: no answer from Scryfall must not read as a bad config.
test("an unreachable Scryfall skips everything instead of failing", async () => {
  const api = fakeApi({ sets: {}, setsDown: true });
  const r = await auditCodes([{ group: "Giant's Boulder", code: "HOB" }], api, NO_THROTTLE);
  assert.deepEqual(r.errors, []);
  assert.equal(r.checked, 0);
  assert.match(r.skipped[0], /unreachable/);
});

test("a rate-limited card query is skipped, not failed", async () => {
  const api = fakeApi({ sets: { HOB: "The Hobbit" }, cardsDown: true });
  const r = await auditCodes([{ group: "Giant's Boulder", code: "HOB" }], api, NO_THROTTLE);
  assert.deepEqual(r.errors, []);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /429/);
});

// A bad code must still be caught when the set list came through, even if a later
// card query dies — the two failures are independent.
test("a nonexistent code fails even while other queries are being skipped", async () => {
  const api = fakeApi({ sets: { HOB: "The Hobbit" }, cardsDown: true });
  const r = await auditCodes(
    [
      { group: "Giant's Boulder", code: "HOB" },
      { group: "Made Up Card", code: "ZZZ" },
    ],
    api,
    NO_THROTTLE,
  );
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /not a Scryfall set code/);
  assert.equal(r.skipped.length, 1);
});

test("every bad code is reported, not just the first", async () => {
  const api = fakeApi({ sets: { HOB: "The Hobbit" } });
  const r = await auditCodes(
    [
      { group: "A", code: "XXX" },
      { group: "B", code: "YYY" },
    ],
    api,
    NO_THROTTLE,
  );
  assert.equal(r.errors.length, 2);
});

// --- the live fetch path -----------------------------------------------------------
// The fakes above prove the decision table; these prove the HTTP layer that feeds it.
// A 404 or an error body from /sets parses perfectly well as JSON, and reading it as
// "Scryfall has no sets" would fail every code in config.json at once — so the empty
// payload has to count as no answer. Only builtins here: `npm test` runs before
// `npm ci` and must stay dep-free.
const http = require("node:http");
const { liveApi } = require("../cloud/verify-set-codes");

const SETS = { data: [{ code: "hob", name: "The Hobbit" }, { code: "zen", name: "Zendikar" }] };

// Routes are chosen per-request by the mode the test sets, so one server covers all.
function withServer(mode, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      const json = (code, body) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (mode === "down") return res.writeHead(503).end("{}");
      if (u.pathname === "/sets") return json(200, mode === "emptySets" ? {} : SETS);
      if (u.pathname === "/cards/search") {
        const q = u.searchParams.get("q") || "";
        if (/set:HOB/.test(q) && /Giant's Boulder/.test(q)) return json(200, { total_cards: 1 });
        return json(404, { object: "error", code: "not_found" });
      }
      return json(404, {});
    });
    server.listen(0, async () => {
      const port = server.address().port;
      const real = global.fetch;
      global.fetch = (url, opts) =>
        real(String(url).replace("https://api.scryfall.com", `http://127.0.0.1:${port}`), opts);
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      } finally {
        global.fetch = real;
        server.close();
      }
    });
  });
}

test("live: listSets parses Scryfall's payload and upper-cases the codes", async () => {
  const r = await withServer("ok", () => liveApi.listSets());
  assert.equal(r.reachable, true);
  assert.equal(r.codes.get("HOB"), "The Hobbit");
});

test("live: an empty /sets payload counts as no answer, not as zero sets", async () => {
  const r = await withServer("emptySets", () => liveApi.listSets());
  assert.equal(r.reachable, false, "an unshaped payload must not condemn every code");
  assert.match(r.why, /unexpected \/sets payload/);
});

test("live: a 5xx is unreachable rather than an answer", async () => {
  const r = await withServer("down", () => liveApi.listSets());
  assert.equal(r.reachable, false);
  assert.match(r.why, /503/);
});

test("live: a card present in the set is found", async () => {
  const r = await withServer("ok", () => liveApi.cardInSet("Giant's Boulder", "HOB"));
  assert.deepEqual(r, { reachable: true, found: true });
});

test("live: Scryfall's 404-for-no-results reads as 'not in that set', not as an outage", async () => {
  const r = await withServer("ok", () => liveApi.cardInSet("Giant's Boulder", "ZEN"));
  assert.deepEqual(r, { reachable: true, found: false });
});

test("live: an audit against a dead Scryfall skips instead of failing", async () => {
  const r = await withServer("down", () =>
    auditCodes([{ group: "Giant's Boulder", code: "HOB" }], liveApi, { throttleMs: 0 }),
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.checked, 0);
});
