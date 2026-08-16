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
const { chromium } = require("playwright");

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
const server = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
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
  const browser = await chromium.launch();

  const open = async (init) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
    (await page.locator("#updated").textContent()).includes("credits today"),
    "the header reports today's credit spend, not the file's age",
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

  console.log("select all / clear toggles every configured card at once");
  page = await open(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, "github_pat_testtoken123")`);
  check((await page.locator("#cm-all").count()) === 1, "the legend offers a select-all link");
  const allLabel = await page.locator("#cm-all").textContent();
  check(/Select all 4\b/.test(allLabel), "it names how many are configured: " + allLabel);
  check(
    (await page.locator("#legend").textContent()).includes("credits)"),
    "and what selecting them all would cost",
  );

  await page.locator("#cm-all").click();
  await page.waitForTimeout(400);
  check((await page.locator("#cm-refresh").textContent()).includes("(4)"), "all four are picked");
  check(
    (await page.locator("#grid .card .pick:checked").count()) === 4,
    "every Cardmarket-watched card is ticked",
  );
  check((await page.locator("#cm-all").textContent()).includes("Clear"), "the link flips to Clear");

  await page.locator("#cm-all").click();
  await page.waitForTimeout(400);
  check((await page.locator("#grid .card .pick:checked").count()) === 0, "clicking again clears them");
  check((await page.locator("#cm-refresh").textContent()).trim() === "↻ CM", "and the count goes away");
  await page.close();

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

  console.log("a rejected token is discarded so the next click can re-prompt");
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

  await browser.close();
  server.close();
  console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall refresh-button checks passed");
  process.exitCode = failures.length ? 1 : 0;
})();
