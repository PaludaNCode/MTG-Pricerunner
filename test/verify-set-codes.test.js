const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { auditCodes, liveApi } = require("../cloud/verify-set-codes");

// The check runs in CI against the live API, but its decision table has to be provable
// offline — the environment that most needs the guard is the one that can't reach
// Scryfall. So the api object is faked here, exhaustively.
function fakeApi({ sets, cards = {}, printings = {}, setsDown = false, cardsDown = false, printingsDown = false }) {
  return {
    async listSets() {
      if (setsDown) return { reachable: false, why: "ENOTFOUND" };
      return { reachable: true, codes: new Map(Object.entries(sets)) };
    },
    async lookupCards(pairs) {
      if (cardsDown) return { reachable: false, why: "HTTP 429" };
      return { reachable: true, notFound: pairs.filter((p) => !cards[`${p.group}|${p.code}`]) };
    },
    async printingsOf(name) {
      if (printingsDown) return { reachable: false, why: "HTTP 500" };
      return { reachable: true, codes: printings[name] || [] };
    },
  };
}

test("a real code holding the card passes", async () => {
  const api = fakeApi({ sets: { HOB: "The Hobbit" }, cards: { "Giant's Boulder|HOB": true } });
  const r = await auditCodes([{ group: "Giant's Boulder", code: "HOB" }], api);
  assert.deepEqual(r.errors, []);
  assert.equal(r.checked, 1);
});

test("a code that names no Scryfall set fails", async () => {
  const api = fakeApi({ sets: { HOB: "The Hobbit" } });
  const r = await auditCodes([{ group: "Giant's Boulder", code: "ZZZ" }], api);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /not a Scryfall set code/);
});

// The HOB-vs-HOC case: both codes are real, so existence alone would wave it through.
test("a real set that doesn't contain the card fails", async () => {
  const api = fakeApi({
    sets: { HOB: "The Hobbit", HOC: "The Hobbit Commander" },
    cards: { "Giant's Boulder|HOB": true },
  });
  const r = await auditCodes([{ group: "Giant's Boulder", code: "HOC" }], api);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /not in HOC \(The Hobbit Commander\)/);
});

// Whoever has to fix a bad code may be in a session that can't reach Scryfall, so the
// error has to carry the answer rather than just the verdict.
test("a failure names the sets the card is actually in", async () => {
  const api = fakeApi({
    sets: { HOB: "The Hobbit", HOC: "The Hobbit Commander" },
    cards: { "Giant's Boulder|HOB": true },
    printings: { "Giant's Boulder": ["HOB"] },
  });
  const r = await auditCodes([{ group: "Giant's Boulder", code: "HOC" }], api);
  assert.match(r.errors[0], /Scryfall lists it in: HOB/);
});

test("a card name Scryfall has never heard of says so, instead of blaming the code", async () => {
  const api = fakeApi({ sets: { TMT: "Teenage Mutant Ninja Turtles" }, printings: {} });
  const r = await auditCodes([{ group: "Sewer Veillance Cam", code: "TMT" }], api);
  assert.match(r.errors[0], /no card named "Sewer Veillance Cam"; check the name/);
});

test("an unknown code still gets a suggestion", async () => {
  const api = fakeApi({
    sets: { MSH: "Marvel Super Heroes" },
    printings: { "Shuri, Wakandan Inventor": ["MSH", "PMSC"] },
  });
  const r = await auditCodes([{ group: "Shuri, Wakandan Inventor", code: "PMSH" }], api);
  assert.match(r.errors[0], /not a Scryfall set code/);
  assert.match(r.errors[0], /Scryfall lists it in: MSH, PMSC/);
});

test("codes are matched case-insensitively", async () => {
  const api = fakeApi({ sets: { ZEN: "Zendikar" }, cards: { "Arid Mesa|ZEN": true } });
  const r = await auditCodes([{ group: "Arid Mesa", code: "zen" }], api);
  assert.deepEqual(r.errors, []);
});

// allVersions entries span every printing and carry no single set, by design.
test("entries without a code are skipped, not failed", async () => {
  const api = fakeApi({ sets: {} });
  const r = await auditCodes([{ group: "Planar Nexus", code: null }], api);
  assert.deepEqual(r.errors, []);
  assert.equal(r.checked, 0);
});

test("one card watched on both sites is only looked up once", async () => {
  let asked = 0;
  const api = {
    async listSets() {
      return { reachable: true, codes: new Map([["ZEN", "Zendikar"]]) };
    },
    async lookupCards(pairs) {
      asked = pairs.length;
      return { reachable: true, notFound: [] };
    },
    async printingsOf() {
      return { reachable: true, codes: [] };
    },
  };
  const r = await auditCodes(
    [
      { group: "Arid Mesa", code: "ZEN" },
      { group: "Arid Mesa", code: "ZEN" },
    ],
    api,
  );
  assert.equal(asked, 1);
  assert.equal(r.checked, 1);
});

// Never a flaky gate: no answer from Scryfall must not read as a bad config.
test("an unreachable Scryfall skips everything instead of failing", async () => {
  const api = fakeApi({ sets: {}, setsDown: true });
  const r = await auditCodes([{ group: "Giant's Boulder", code: "HOB" }], api);
  assert.deepEqual(r.errors, []);
  assert.equal(r.checked, 0);
  assert.match(r.skipped[0], /unreachable/);
});

// The rate-limit storm that made the first version useless: it must degrade to a skip,
// never to a wall of false failures.
test("a rate-limited card lookup is skipped, not failed", async () => {
  const api = fakeApi({ sets: { HOB: "The Hobbit" }, cardsDown: true });
  const r = await auditCodes([{ group: "Giant's Boulder", code: "HOB" }], api);
  assert.deepEqual(r.errors, []);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /429/);
});

// A bad code must still be caught when the set list came through, even if the bulk
// lookup dies afterwards — the two failures are independent.
test("a nonexistent code fails even while the card lookup is being skipped", async () => {
  const api = fakeApi({ sets: { HOB: "The Hobbit" }, cardsDown: true });
  const r = await auditCodes(
    [
      { group: "Giant's Boulder", code: "HOB" },
      { group: "Made Up Card", code: "ZZZ" },
    ],
    api,
  );
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /not a Scryfall set code/);
  assert.equal(r.skipped.length, 1);
});

test("a failing suggestion lookup still leaves a usable error", async () => {
  const api = fakeApi({ sets: { HOB: "The Hobbit" }, printingsDown: true });
  const r = await auditCodes([{ group: "Giant's Boulder", code: "ZZZ" }], api);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /not a Scryfall set code$/);
});

test("every bad code is reported, not just the first", async () => {
  const api = fakeApi({ sets: { HOB: "The Hobbit" } });
  const r = await auditCodes(
    [
      { group: "A", code: "XXX" },
      { group: "B", code: "YYY" },
    ],
    api,
  );
  assert.equal(r.errors.length, 2);
});

// --- the live fetch path -----------------------------------------------------------
// The fakes above prove the decision table; these prove the HTTP layer that feeds it.
// A 404 or an error body from /sets parses perfectly well as JSON, and reading it as
// "Scryfall has no sets" would fail every code in config.json at once — so the empty
// payload has to count as no answer. Only builtins here: `npm test` runs before
// `npm ci` and must stay dep-free.
const SETS = { data: [{ code: "hob", name: "The Hobbit" }, { code: "zen", name: "Zendikar" }] };

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
      if (u.pathname === "/cards/collection") {
        // Scryfall rejects a POST with no Content-Type, and the rejection is valid
        // JSON — the exact response that once made this check pass while verifying
        // nothing. The stub reproduces it rather than being generous.
        if (!/application\/json/.test(req.headers["content-type"] || "")) {
          return json(415, { object: "error", code: "unsupported_media_type", details: "Content-Type must be application/json" });
        }
        if (mode === "badCollection") return json(200, { object: "list", data: [] });
        let raw = "";
        req.on("data", (c) => (raw += c));
        return req.on("end", () => {
          const ids = JSON.parse(raw).identifiers || [];
          json(200, {
            data: ids.filter((i) => i.set === "hob"),
            not_found: ids.filter((i) => i.set !== "hob"),
          });
        });
      }
      if (u.pathname === "/cards/search") {
        const q = u.searchParams.get("q") || "";
        if (/Giant's Boulder/.test(q)) return json(200, { data: [{ set: "hob" }, { set: "hob" }] });
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

// The whole point of the rewrite: one POST covers the config, so there is no per-card
// request to be rate-limited.
test("live: the whole config goes out as a single collection POST", async () => {
  const r = await withServer("ok", () =>
    liveApi.lookupCards([
      { group: "Giant's Boulder", code: "HOB" },
      { group: "Arid Mesa", code: "ZEN" },
    ]),
  );
  assert.equal(r.reachable, true);
  assert.deepEqual(r.notFound, [{ group: "Arid Mesa", code: "ZEN" }]);
});

test("live: printingsOf dedupes the set codes it reports", async () => {
  const r = await withServer("ok", () => liveApi.printingsOf("Giant's Boulder"));
  assert.deepEqual(r, { reachable: true, codes: ["HOB"] });
});

test("live: a name Scryfall 404s on comes back as no printings, not as an outage", async () => {
  const r = await withServer("ok", () => liveApi.printingsOf("Nonexistent Card"));
  assert.deepEqual(r, { reachable: true, codes: [] });
});

test("live: an audit against a dead Scryfall skips instead of failing", async () => {
  const r = await withServer("down", () =>
    auditCodes([{ group: "Giant's Boulder", code: "HOB" }], liveApi),
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.checked, 0);
});

test("live: a full audit through real HTTP catches the wrong set and names the right one", async () => {
  const r = await withServer("ok", () =>
    auditCodes([{ group: "Giant's Boulder", code: "ZEN" }], liveApi),
  );
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /not in ZEN \(Zendikar\)/);
  assert.match(r.errors[0], /Scryfall lists it in: HOB/);
});

// The defect that shipped: the POST went out without a Content-Type, Scryfall rejected
// it, the rejection parsed as JSON, and an absent not_found read as "nothing missing" —
// so the check reported every code verified while checking none of them. Two guards, so
// neither the cause nor the class can come back.
test("live: the collection POST declares application/json", async () => {
  const r = await withServer("ok", () =>
    liveApi.lookupCards([{ group: "Giant's Boulder", code: "HOB" }]),
  );
  assert.equal(r.reachable, true, "a POST without Content-Type is rejected by Scryfall");
  assert.deepEqual(r.notFound, []);
});

test("live: a collection reply that accounts for nothing is no answer, not a pass", async () => {
  const r = await withServer("badCollection", () =>
    liveApi.lookupCards([{ group: "Giant's Boulder", code: "ZEN" }]),
  );
  assert.equal(r.reachable, false, "an unshaped reply must never read as 'nothing missing'");
  assert.match(r.why, /unexpected \/cards\/collection payload/);
});

test("live: an audit over a mis-shaped collection reply skips instead of passing", async () => {
  const r = await withServer("badCollection", () =>
    auditCodes([{ group: "Giant's Boulder", code: "ZEN" }], liveApi),
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.checked, 0, "nothing may be reported as checked when nothing was");
  assert.match(r.skipped[0], /not confirmed/);
});
