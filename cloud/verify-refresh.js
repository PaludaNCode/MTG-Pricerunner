// Behaviour test for the header's "↻ CM" button, driven in a real browser because the
// whole feature is browser-side: localStorage token handling, the GitHub dispatch
// payload, and the budget-aware disabled state. Every api.github.com call is stubbed —
// this never touches the network. Exits non-zero on any failed check.
//
// Guards the things that break silently: the wrong workflow name, a dropped `force`
// input (which would make a manual refresh a no-op whenever the TTL is unexpired), or
// an expired token that sticks around and fails forever.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { launchChromium } = require("./launch-browser");

const WEB = path.join(__dirname, "web");
const SHARED = path.join(__dirname, "..", "shared");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
const TOKEN_KEY = "mtg-pricerunner.gh-token";
const DISPATCH_PATH = "/repos/PaludaNCode/MTG-Pricerunner/actions/workflows/update-cardmarket.yml/dispatches";

for (const f of ["ui.css", "render.js", "app.js", "favicon.svg"]) {
  fs.copyFileSync(path.join(SHARED, f), path.join(WEB, f));
}
if (!fs.existsSync(path.join(WEB, "data.json"))) {
  fs.copyFileSync(path.join(__dirname, "fixture-data.json"), path.join(WEB, "data.json"));
}

// Cardmarket is served from memory so a test can rewrite its `meta` between cases.
let cm = JSON.parse(fs.readFileSync(path.join(__dirname, "fixture-cardmarket.json"), "utf8"));
// The ledger's `day` is stamped to the current UTC day. The fixture's own date is fixed,
// and the page now treats a ledger from another day as "nothing spent today" — so left
// alone, every case below would silently exercise the stale path and none would cover
// the ordinary one. The stale path gets its own case, with its own explicit day.
const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
cm.meta.day = TODAY;
// The CardTrader feed is served from memory for the same reason as Cardmarket: one case
// needs to withhold meta.cardmarketCards to prove that an unknown list hides nothing.
let ct = JSON.parse(fs.readFileSync(path.join(WEB, "data.json"), "utf8"));
const server = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  if (u === "/data.json") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(ct));
  }
  if (u === "/cardmarket.json") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(cm));
  }
  const file = path.join(WEB, u === "/" ? "index.html" : u);
  try {
    res.setHeader("Content-Type", MIME[path.extname(file)] || "text/plain");
    res.end(fs.readFileSync(file));
  } catch {
    res.statusCode = 404;
    res.end("nope");
  }
});

const failures = [];
function check(ok, msg) {
  console.log((ok ? "  ok   " : "  FAIL ") + msg);
  if (!ok) failures.push(msg);
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await launchChromium();

  // Every page opens with the quiet window switched off unless a case asks for one.
  // Without this the whole suite would depend on what time CI runs: from 00:00 to 08:00
  // UTC the button is deliberately disabled, and every assertion below about an armed
  // button would fail — a check that only passes in office hours is worse than none.
  // `init` keeps its original contract (a script string or function run before load).
  // `quiet` pins the Cardmarket quiet window, defaulting to off.
  const open = async (init, quiet) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    // The page assigns window.DASH inline and app.js reads it; intercept the assignment
    // so the hours are already pinned by the time the reader sees the object.
    await page.addInitScript(([startHour, endHour]) => {
      let held;
      Object.defineProperty(window, "DASH", {
        configurable: true,
        get: () => held,
        set: (v) => {
          held = v;
          if (held) {
            held.quietStartHour = startHour;
            held.quietEndHour = endHour;
          }
        },
      });
    }, quiet || [0, 0]);
    if (init) await page.addInitScript(init);
    await page.goto(`http://localhost:${port}/`);
    await page.waitForSelector("#grid .card");
    return page;
  };

  console.log("no token stored -> the field is offered and the button holds back");
  let page = await open();
  check(!(await page.locator("#cm-token").isHidden()), "token field is visible from the start");
  check(await page.locator("#cm-refresh").isDisabled(), "refresh is disabled until a token exists");
  check((await page.getAttribute("#cm-refresh", "title")).toLowerCase().includes("token"), "tooltip explains why");

  console.log("pasting the Firecrawl key by mistake is caught before GitHub sees it");
  await page.fill("#cm-token", "fc-ea49871110ee4e57a225b3dfbbb1574a");
  await page.press("#cm-token", "Enter");
  await page.waitForTimeout(200);
  check(
    (await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY)) === null,
    "the Firecrawl key is not stored as a GitHub token",
  );
  check(!(await page.locator("#notice").isHidden()), "an inline notice explains the mix-up");
  check(
    (await page.locator("#notice").textContent()).includes("Firecrawl"),
    "the notice names which key was pasted",
  );
  check(await page.locator("#cm-refresh").isDisabled(), "the button stays disabled");

  console.log("typing a token into the field stores it and arms the button");
  await page.fill("#cm-token", "github_pat_testtoken123");
  await page.press("#cm-token", "Enter");
  await page.waitForTimeout(200);
  check(
    (await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY)) === "github_pat_testtoken123",
    "token saved to localStorage",
  );
  check(await page.locator("#notice").isHidden(), "the notice clears once a real token is entered");
  check(await page.locator("#cm-token").isHidden(), "field hides itself once a token is set");
  check(await page.locator("#cm-refresh").isEnabled(), "refresh is now armed");
  check((await page.getAttribute("#cm-refresh", "title")).includes("10 of 33"), "tooltip reports the day's credit use");

  console.log("clicking dispatches the Cardmarket workflow with force=true");
  let sent = null;
  // The page now follows the run through the Actions API as well as dispatching it.
  const json = (o) => ({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
  const runsReply = () =>
    json({ workflow_runs: [{ id: 7, run_number: 12, created_at: new Date().toISOString(), html_url: "https://example.com/run" }] });
  const jobsReply = (status, conclusion, steps) => json({ jobs: [{ status, conclusion, steps }] });
  await page.route("https://api.github.com/**", (route) => {
    const r = route.request();
    const u = r.url();
    if (u.includes("/dispatches")) {
      sent = { url: u, method: r.method(), headers: r.headers(), body: JSON.parse(r.postData() || "{}") };
      return route.fulfill({ status: 204 });
    }
    if (u.includes("/runs?event=")) return route.fulfill(runsReply());
    if (u.includes("/jobs")) {
      return route.fulfill(
        jobsReply("in_progress", null, [
          { name: "Set up job", status: "completed", conclusion: "success" },
          { name: "Scrape Cardmarket -> cloud/web/cardmarket.json", status: "in_progress", conclusion: null },
        ]),
      );
    }
    return route.fulfill(json({}));
  });
  await page.locator("#cm-refresh").click();
  await page.waitForTimeout(800);
  check(!!sent, "a dispatch was sent");
  check(sent && sent.method === "POST" && sent.url.endsWith(DISPATCH_PATH), "targets the Cardmarket workflow's dispatch endpoint");
  check(sent && sent.body.ref === "main", "dispatches against main");
  check(sent && sent.body.inputs && sent.body.inputs.force === "true", "sends force=true so the TTL is ignored");
  check(sent && sent.body.inputs.cards === "", "no ticks = empty card list = the normal rotation");
  check(sent && sent.body.inputs.balance_only === "false", "a scrape is not a balance check");
  check((await page.locator("#grid table th.c-seller").count()) === 0, "the Seller column is gone");
  check((await page.locator("#grid table th.c-src").count()) > 0, "the Src column is present");
  check(sent && sent.headers.authorization === "Bearer github_pat_testtoken123", "authorises with the token from localStorage");
  check((await page.locator("#cm-refresh").textContent()).match(/queued|scraping/), "button reports progress: " + await page.locator("#cm-refresh").textContent());
  await page.waitForTimeout(3500);
  const prog = await page.locator("#notice").textContent();
  check(prog.includes("scraping Cardmarket"), "the notice names the step actually running: " + prog.slice(0, 90));
  check(prog.includes("run #12"), "and links the run");

  console.log("each card says when it was last scraped");
  check(
    (await page.locator("#grid .card .age").count()) === 4,
    "an age chip on every Cardmarket-watched card, including one never scraped",
  );
  check(
    (await page.locator("#grid .card", { hasText: "Skateboard" }).locator(".age.new").count()) === 1,
    "a card the config watches but has never scraped says 'new', not nothing",
  );
  check(
    (await page.locator("#grid .card", { hasText: "Seeker of Skybreak" }).locator(".age").count()) === 0,
    "Seeker of Skybreak has nothing to scrape, so it shows no age",
  );
  check(
    (await page.locator("#grid .card .age").first().getAttribute("title")).includes("last scraped"),
    "the chip's tooltip gives the exact timestamp",
  );
  check(
    (await page.locator("#legend").textContent()).includes("only when you ask"),
    "the legend says Cardmarket is on-demand, not scheduled",
  );
  check(
    /CM CREDITS/i.test(await page.locator("#stats").textContent()) &&
      /\/ \d+ today/.test(await page.locator("#stats").textContent()),
    "the header's status rail reports today's credit spend against the allowance, not the file's age",
  );
  await page.close();

  console.log("ticking cards narrows the refresh to those cards");
  page = await open(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, "github_pat_testtoken123")`);
  const boxes = page.locator("#grid .card .pick");
  const cardCount = await page.locator("#grid .card").count();
  check((await boxes.count()) === cardCount - 1, "every Cardmarket-watched card gets a tick box, including never-scraped ones");
  check(
    (await page.locator("#grid .card", { hasText: "Seeker of Skybreak" }).locator(".pick").count()) === 0,
    "a card with no Cardmarket entry cannot be picked — nothing to refresh",
  );

  await boxes.nth(0).check();
  await boxes.nth(1).check();
  check((await page.locator("#cm-refresh").textContent()).includes("(2)"), "the button counts the picks");
  let picked = null;
  // Only the dispatch carries the selection; the run/jobs polls must not be mistaken
  // for it now that the page follows the run.
  await page.route("https://api.github.com/**", (route) => {
    const u = route.request().url();
    if (u.includes("/dispatches")) {
      picked = JSON.parse(route.request().postData() || "{}");
      return route.fulfill({ status: 204 });
    }
    if (u.includes("/runs?event=")) return route.fulfill(runsReply());
    if (u.includes("/jobs")) {
      return route.fulfill(
        jobsReply("in_progress", null, [
          { name: "Scrape Cardmarket -> cloud/web/cardmarket.json", status: "in_progress", conclusion: null },
        ]),
      );
    }
    return route.fulfill(json({}));
  });
  await page.locator("#cm-refresh").click();
  await page.waitForTimeout(800);
  check(
    picked && picked.inputs.cards === "Runehorn Hellkite,Stock Up",
    "only the ticked cards are sent, by name: " + (picked && picked.inputs.cards),
  );
  check(
    (await page.locator("#grid .card .age.pending").count()) === 2,
    "the two ticked cards show a spinner while the run is in flight",
  );
  // Same page, not a new one: browser.newPage() gets a fresh context, so a reload is
  // the only way to prove the picks came back from localStorage rather than memory.
  await page.reload();
  await page.waitForSelector("#grid .card");
  check(
    (await page.locator("#grid .card .pick:checked").count()) === 2,
    "the two picks survive a reload",
  );
  check((await page.locator("#cm-refresh").textContent()).includes("(2)"), "and the button still counts them");
  await page.close();

  console.log("select all / clear are buttons in the control strip, not words in the legend");
  page = await open(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, "github_pat_testtoken123")`);
  check((await page.locator(".controls #cm-all").count()) === 1, "the strip holds a Select all button");
  check((await page.locator(".controls #cm-none").count()) === 1, "and a Clear button");
  check((await page.locator("#legend #cm-all").count()) === 0, "the legend no longer hides one in its prose");
  check(await page.locator("#cm-none").isDisabled(), "Clear is dead while nothing is ticked");
  check(
    (await page.locator("#pick-count").textContent()).includes("stalest"),
    "the readout says what an untouched selection does: " + (await page.locator("#pick-count").textContent()),
  );

  await page.locator("#cm-all").click();
  await page.waitForTimeout(400);
  check((await page.locator("#cm-refresh").textContent()).includes("(5)"), "all five are picked");
  check(
    (await page.locator("#grid .card .pick:checked").count()) === 4,
    "every Cardmarket-watched card with offers is ticked",
  );
  check(
    (await page.locator("#watching .chip .pick:checked").count()) === 1,
    "and so is the one with no offers — Select all covers the configured list, not the grid",
  );
  const readout = await page.locator("#pick-count").textContent();
  check(/5 of 5 selected/.test(readout), "the readout counts them: " + readout);
  check(/~25 credits/.test(readout), "and prices the press before it happens: " + readout);
  check(await page.locator("#cm-all").isDisabled(), "Select all has nothing left to do");

  await page.locator("#cm-none").click();
  await page.waitForTimeout(400);
  check((await page.locator("#grid .card .pick:checked").count()) === 0, "Clear unticks them");
  check((await page.locator("#watching .pick:checked").count()) === 0, "including the one in the watching chips");
  check((await page.locator("#cm-refresh").textContent()).trim() === "↻ CM", "and the count goes away");
  check(await page.locator("#cm-none").isDisabled(), "Clear disables itself again");
  await page.close();

  // The card with nothing on screen is the one you most want to re-scrape, and until the
  // chips carried a tick box it was the only card you could not aim a run at: the choices
  // were Select all (the whole day's allowance) or an untargeted stalest-first run.
  console.log("a Cardmarket-watched card with no offers can be re-scraped on its own");
  page = await open(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, "github_pat_testtoken123")`);
  const emptyChip = page.locator("#watching .chip", { hasText: "Empty Watch" });
  check((await emptyChip.locator(".pick").count()) === 1, "it has a tick box in the watching chips");
  check(
    (await page.locator("#watching .chip", { hasText: "Broken Watch" }).locator(".pick").count()) === 0,
    "a card Cardmarket does not watch still has none — nothing to refresh",
  );
  check((await emptyChip.locator(".age.new").count()) === 1, "and the chip says it has never been scraped");
  await emptyChip.locator(".pick").check();
  check((await page.locator("#cm-refresh").textContent()).includes("(1)"), "ticking it arms the button for one card");
  let lone = null;
  await page.route("https://api.github.com/**", (route) => {
    const u = route.request().url();
    if (u.includes("/dispatches")) {
      lone = JSON.parse(route.request().postData() || "{}");
      return route.fulfill({ status: 204 });
    }
    if (u.includes("/runs?event=")) return route.fulfill(runsReply());
    if (u.includes("/jobs")) {
      return route.fulfill(
        jobsReply("in_progress", null, [
          { name: "Scrape Cardmarket -> cloud/web/cardmarket.json", status: "in_progress", conclusion: null },
        ]),
      );
    }
    return route.fulfill(json({}));
  });
  await page.locator("#cm-refresh").click();
  await page.waitForTimeout(800);
  check(lone && lone.inputs.cards === "Empty Watch", "that one card is the whole run: " + (lone && lone.inputs.cards));
  check((await emptyChip.locator(".age.pending").count()) === 1, "and its chip shows the run in flight");
  await page.reload();
  await page.waitForSelector("#grid .card");
  check(
    (await page.locator("#watching .chip .pick:checked").count()) === 1,
    "the tick survives a reload, as the grid's do",
  );
  await page.close();

  console.log("the source filter narrows the grid without refetching anything");
  page = await open(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, "github_pat_testtoken123")`);
  // Any network call now would be a bug: both feeds are already in memory.
  await page.route("**/*.json", (route) => route.abort());
  const srcCount = () => page.locator("#grid table td.c-src").count();
  const cmRows = () => page.locator("#grid table td.c-src", { hasText: "CM" }).count();
  check((await cmRows()) > 0, "both sources show by default");
  check((await page.locator('#src-filter button[data-src="all"]').getAttribute("aria-pressed")) === "true", "Both is the default segment");

  await page.locator('#src-filter button[data-src="cardtrader"]').click();
  await page.waitForTimeout(200);
  check((await srcCount()) === 0, "one source on screen means the Src column is dropped");
  check(
    (await page.locator("#grid .card", { hasText: "Runehorn Hellkite" }).locator("td").count()) > 0,
    "CardTrader offers are still there",
  );
  check(
    (await page.evaluate(() => document.body.classList.contains("one-source"))),
    "body.one-source is set so the column widths still sum to 100",
  );
  check(
    (await page.locator("#grid .card", { hasText: "Runehorn Hellkite" }).locator(".pick").count()) === 1,
    "the tick box survives the filter — it refreshes Cardmarket, whatever is on screen",
  );

  await page.locator('#src-filter button[data-src="cardmarket"]').click();
  await page.waitForTimeout(200);
  check(
    (await page.locator("#grid .card", { hasText: "Seeker of Skybreak" }).count()) === 0,
    "a card with no Cardmarket offers drops out of the grid",
  );
  check(
    (await page.locator("#watching").textContent()).includes("no Cardmarket offers"),
    "and is listed as filtered out, not as broken: " + (await page.locator("#watching .label").textContent()),
  );

  await page.unroute("**/*.json"); // the reload needs the feeds back
  await page.reload();
  await page.waitForSelector("#grid .card");
  check(
    (await page.locator('#src-filter button[data-src="cardmarket"]').getAttribute("aria-pressed")) === "true",
    "the choice survives a reload",
  );
  await page.locator('#src-filter button[data-src="all"]').click();
  await page.waitForTimeout(200);
  check((await srcCount()) > 0, "Both brings the Src column back");
  await page.close();

  console.log("a Cardmarket row with no scraped code borrows one from the CardTrader printings");
  page = await open();
  const cellFor = (card, title) =>
    page.locator("#grid .card", { hasText: card }).locator(`td.c-set a[title="${title}"]`).first().textContent();

  // The fixture leaves Runehorn's Cardmarket rows codeless, as everything scraped before
  // the thumbnail extraction is. Nobody should have to spend a credit to get a code.
  check(
    (await cellFor("Runehorn Hellkite", "Commander 2016")) === "C16",
    "the name CardTrader also uses resolves to its curated code",
  );
  check(
    (await cellFor("Runehorn Hellkite", "Starter Commander Decks")) === "Starter Commander Decks",
    "a name that matches nothing keeps the full name rather than guessing a code: " +
      (await cellFor("Runehorn Hellkite", "Starter Commander Decks")),
  );
  check(
    (await cellFor("Stock Up", "Aetherdrift")) === "DFT",
    "a row that did carry a scraped code still shows it",
  );
  check(
    (await page.locator("#grid .card", { hasText: "Runehorn Hellkite" }).locator("td.c-set a").first().getAttribute("title")).length > 3,
    "the full set name survives as the link tooltip at every width",
  );
  await page.close();

  console.log("the strip is pinned on a desktop and scrolls away on a phone");
  // A short viewport is the point: the fixture grid is not tall enough to scroll at 900px.
  for (const [label, vp, pinned] of [
    ["desktop", { width: 1440, height: 500 }, true],
    ["phone", { width: 390, height: 500 }, false],
  ]) {
    page = await browser.newPage({ viewport: vp });
    await page.goto(`http://localhost:${port}/`);
    await page.waitForSelector("#grid .card");
    await page.evaluate(() => window.scrollTo(0, 600));
    await page.waitForTimeout(150);
    const box = await page.locator(".controls").boundingBox();
    const onScreen = !!box && box.y >= 0 && box.y + box.height <= vp.height;
    check(onScreen === pinned, `${label}: strip ${pinned ? "stays put" : "scrolls off"} — y=${box && Math.round(box.y)}`);
    check(
      (await page.locator("header").boundingBox()).y >= 0,
      `${label}: the header is pinned either way`,
    );
    await page.close();
  }

  console.log("the balance check runs the workflow without scraping");
  page = await open(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, "github_pat_testtoken123")`);
  check((await page.locator("#cm-balance").count()) === 1, "the legend offers a free balance check");
  let balanceReq = null;
  await page.route("https://api.github.com/**", (route) => {
    const u = route.request().url();
    if (u.includes("/dispatches")) {
      balanceReq = JSON.parse(route.request().postData() || "{}");
      return route.fulfill({ status: 204 });
    }
    if (u.includes("/runs?event=")) return route.fulfill(runsReply());
    if (u.includes("/jobs")) {
      return route.fulfill(
        jobsReply("in_progress", null, [{ name: "Set up job", status: "in_progress", conclusion: null }]),
      );
    }
    return route.fulfill(json({}));
  });
  await page.locator("#cm-balance").click();
  await page.waitForTimeout(800);
  check(balanceReq && balanceReq.inputs.balance_only === "true", "sends balance_only=true");
  check(balanceReq && balanceReq.inputs.force === "false", "does not force a scrape");
  check(balanceReq && balanceReq.inputs.cards === "", "and asks for no cards");
  check(
    (await page.locator("#grid .card .age.pending").count()) === 0,
    "no card is marked as scraping — nothing is being scraped",
  );
  await page.close();

  console.log("the key button reopens the field, and emptying it forgets the token");
  page = await open(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, "github_pat_testtoken123")`);
  check(await page.locator("#cm-token").isHidden(), "field starts hidden when a token exists");
  await page.locator("#cm-token-toggle").click();
  check(!(await page.locator("#cm-token").isHidden()), "key button reveals the field");
  check((await page.inputValue("#cm-token")) === "github_pat_testtoken123", "field is prefilled so it can be edited");
  await page.fill("#cm-token", "");
  await page.press("#cm-token", "Enter");
  await page.waitForTimeout(200);
  check(
    (await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY)) === null,
    "clearing the field forgets the token",
  );
  check(await page.locator("#cm-refresh").isDisabled(), "refresh disarms again");
  await page.close();

  console.log("no allowance left -> the button refuses instead of firing a no-op run");
  cm = JSON.parse(JSON.stringify(cm));
  cm.meta.credits = cm.meta.allowance;
  page = await open(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, "github_pat_testtoken123")`);
  await page.waitForTimeout(300);
  check(await page.locator("#cm-refresh").isDisabled(), "button is disabled");
  check((await page.locator("#cm-refresh").textContent()).toLowerCase().includes("budget"), "button says the budget is spent");
  await page.close();

  // Issue #69: cardmarket.json is only rewritten when a run happens, and nothing runs
  // on a timer — so past 00:00 UTC the published ledger still carries yesterday's spend.
  // Reading it as today's greyed out the one button that would refresh the figure, on
  // the very morning the whole allowance was available again.
  console.log("yesterday's spend does not spend today's allowance");
  cm = JSON.parse(JSON.stringify(cm));
  cm.meta.day = YESTERDAY;
  cm.meta.credits = cm.meta.allowance;
  page = await open(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, "github_pat_testtoken123")`);
  await page.waitForTimeout(300);
  check(await page.locator("#cm-refresh").isEnabled(), "the button is armed on the new day");
  check(
    !(await page.locator("#cm-refresh").textContent()).toLowerCase().includes("budget"),
    "and does not claim the budget is spent",
  );
  const staleTip = await page.getAttribute("#cm-refresh", "title");
  check(!/\b3[0-9] of 33\b/.test(staleTip), "the tooltip does not report yesterday's spend as today's: " + staleTip);
  check(staleTip.includes(YESTERDAY), "it names the day the published ledger came from instead");
  const railText = await page.locator("#stats").textContent();
  check(/0 \/ 33 today/.test(railText), "the rail reports no spend today, not yesterday's: " + railText);
  const creditTip = await page.evaluate(() => {
    const d = [...document.querySelectorAll("#stats > div")].find((x) => x.querySelector("dt").textContent === "CM credits");
    return d ? d.querySelector("dd").title : "";
  });
  check(
    creditTip.includes(YESTERDAY),
    "with the ledger's own day in the tooltip, so the 0 is not mistaken for a run that spent nothing: " + creditTip,
  );
  check(
    /covers about <b>6 cards<\/b>/.test(await page.locator("#legend").innerHTML()),
    "and the legend prices the full allowance again",
  );
  await page.close();

  console.log("a rejected token is discarded so the next click can re-prompt");
  cm.meta.day = TODAY;
  cm.meta.credits = 10;
  page = await open(
    `localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, "expired"); window.alert = () => {};`,
  );
  await page.route("https://api.github.com/**", (r) => r.fulfill({ status: 401, body: "{}" })); // dispatch fails first
  await page.locator("#cm-refresh").click();
  await page.waitForTimeout(600);
  check(
    (await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY)) === null,
    "the 401'd token was cleared from localStorage",
  );
  check(!(await page.locator("#cm-token").isHidden()), "the field reopens so a new token can be entered");
  check(
    (await page.locator("#notice").textContent()).includes("Actions: read and write"),
    "the 401 notice says what the token actually needs",
  );
  await page.close();

  // Cardmarket has no scheduler, so the quiet window is a guard on the on-demand path.
  // The workflow is the real enforcement (a run started inside the window scrapes
  // nothing); the button's job is to say so rather than spend a dispatch on a no-op.
  // The window is pinned to cover every hour, so this case is independent of the clock.
  console.log("inside the quiet window the button explains itself instead of firing");
  page = await open(
    `localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, "github_pat_testtoken123")`,
    [0, 24],
  );
  check(await page.locator("#cm-refresh").isDisabled(), "button is disabled during quiet hours");
  check(
    (await page.locator("#cm-refresh").textContent()).includes("quiet hours"),
    "and says why, rather than looking broken",
  );
  const quietTitle = (await page.getAttribute("#cm-refresh", "title")).toLowerCase();
  check(quietTitle.includes("utc"), "the tooltip names the window in UTC");
  check(quietTitle.includes("balance"), "and points at the free balance check, which still works");
  // No "nothing was dispatched" assertion here: a disabled button emits no click, so it
  // could never fail and would only look like coverage. The disabled state above is the
  // guarantee, and the workflow-side refusal — the one that actually protects credits —
  // is pinned by test/quiet-hours.test.js.
  await page.close();

  // The other side of the same switch: outside the window the button is armed as before.
  // Both halves matter — a guard stuck on would be as broken as one stuck off.
  console.log("outside the window the button is armed as usual");
  page = await open(
    `localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, "github_pat_testtoken123")`,
    [0, 0],
  );
  check(!(await page.locator("#cm-refresh").isDisabled()), "button is armed outside quiet hours");
  check(
    !(await page.locator("#cm-refresh").textContent()).includes("quiet"),
    "and says nothing about quiet hours",
  );
  await page.close();

  // A card dropped from config.json keeps its offers in cardmarket.json until a run
  // happens, and nothing but a human starts one — so the page has to stop showing it on
  // its own. meta.cardmarketCards (from the CardTrader feed, rebuilt every couple of
  // minutes) is the live list of what is still watched there.
  console.log("a Cardmarket card no longer in config.json stops being rendered");
  const ghost = {
    site: "cardmarket",
    group: "Verdant Catacombs",
    variant: "Zendikar",
    code: "ZEN",
    productUrl: "https://www.cardmarket.com/en/Magic/Products/Singles/Zendikar/Verdant-Catacombs?language=7",
    fetchedAt: new Date().toISOString(),
    offers: [{ price: 42, priceStr: "42,00 €", foil: false, condition: "NM", qty: 1, seller: "x", shipsToMe: null }],
  };
  cm.results.push(ghost);
  page = await open();
  const bodyText = await page.locator("#grid").textContent();
  check(!bodyText.includes("Verdant Catacombs"), "the dropped card is gone from the grid");
  check(bodyText.includes("Runehorn Hellkite"), "a still-watched Cardmarket card is untouched");
  check(!(await page.locator("#grid").textContent()).includes("42,00"), "and its stale offer is not shown");
  await page.close();

  // The other half of the rule: an unknown list must not hide anything. If the
  // CardTrader feed failed there is no list, and blanking every Cardmarket row would
  // turn one outage into two — so absence of the list means "don't filter", while an
  // empty list means "nothing is watched" and is honoured.
  console.log("when the watched list is unavailable, nothing is hidden");
  const realMeta = ct.meta;
  ct = { ...ct, meta: {} };
  page = await open();
  const noMetaText = await page.locator("#grid").textContent();
  check(noMetaText.includes("Verdant Catacombs"), "with no list, the Cardmarket row still renders");
  await page.close();
  ct = { ...ct, meta: realMeta };

  cm.results = cm.results.filter((r) => r.group !== "Verdant Catacombs");

  await browser.close();
  server.close();
  console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall refresh-button checks passed");
  process.exitCode = failures.length ? 1 : 0;
})();
