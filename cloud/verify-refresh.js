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

  console.log("typing a token into the field stores it and arms the button");
  await page.fill("#cm-token", "test-token-123");
  await page.press("#cm-token", "Enter");
  await page.waitForTimeout(200);
  check(
    (await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY)) === "test-token-123",
    "token saved to localStorage",
  );
  check(await page.locator("#cm-token").isHidden(), "field hides itself once a token is set");
  check(await page.locator("#cm-refresh").isEnabled(), "refresh is now armed");
  check((await page.getAttribute("#cm-refresh", "title")).includes("10 of 33"), "tooltip reports the day's credit use");

  console.log("clicking dispatches the Cardmarket workflow with force=true");
  let sent = null;
  await page.route("https://api.github.com/**", (route) => {
    const r = route.request();
    sent = { url: r.url(), method: r.method(), headers: r.headers(), body: JSON.parse(r.postData() || "{}") };
    route.fulfill({ status: 204, body: "" });
  });
  await page.locator("#cm-refresh").click();
  await page.waitForTimeout(800);
  check(!!sent, "a dispatch was sent");
  check(sent && sent.method === "POST" && sent.url.endsWith(DISPATCH_PATH), "targets the Cardmarket workflow's dispatch endpoint");
  check(sent && sent.body.ref === "main", "dispatches against main");
  check(sent && sent.body.inputs && sent.body.inputs.force === "true", "sends force=true so the TTL is ignored");
  check(sent && sent.body.inputs.cards === "", "no ticks = empty card list = the normal rotation");
  check(sent && sent.headers.authorization === "Bearer test-token-123", "authorises with the token from localStorage");
  check((await page.locator("#cm-refresh").textContent()).includes("scraping"), "button reports progress while the run is in flight");
  await page.close();

  console.log("ticking cards narrows the refresh to those cards");
  page = await open(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, "test-token-123")`);
  const boxes = page.locator("#grid .card .pick");
  const cardCount = await page.locator("#grid .card").count();
  check((await boxes.count()) === cardCount - 1, "every card gets a tick box except the CardTrader-only one");
  check(
    (await page.locator("#grid .card", { hasText: "Seeker of Skybreak" }).locator(".pick").count()) === 0,
    "a card with no Cardmarket entry cannot be picked — nothing to refresh",
  );

  await boxes.nth(0).check();
  await boxes.nth(1).check();
  check((await page.locator("#cm-refresh").textContent()).includes("(2)"), "the button counts the picks");
  let picked = null;
  await page.route("https://api.github.com/**", (route) => {
    picked = JSON.parse(route.request().postData() || "{}");
    route.fulfill({ status: 204, body: "" });
  });
  await page.locator("#cm-refresh").click();
  await page.waitForTimeout(800);
  check(
    picked && picked.inputs.cards === "Runehorn Hellkite,Stock Up",
    "only the ticked cards are sent, by name: " + (picked && picked.inputs.cards),
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

  console.log("the key button reopens the field, and emptying it forgets the token");
  page = await open(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, "test-token-123")`);
  check(await page.locator("#cm-token").isHidden(), "field starts hidden when a token exists");
  await page.locator("#cm-token-toggle").click();
  check(!(await page.locator("#cm-token").isHidden()), "key button reveals the field");
  check((await page.inputValue("#cm-token")) === "test-token-123", "field is prefilled so it can be edited");
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
  page = await open(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, "test-token-123")`);
  await page.waitForTimeout(300);
  check(await page.locator("#cm-refresh").isDisabled(), "button is disabled");
  check((await page.locator("#cm-refresh").textContent()).toLowerCase().includes("budget"), "button says the budget is spent");
  await page.close();

  console.log("a rejected token is discarded so the next click can re-prompt");
  cm.meta.credits = 10;
  page = await open(
    `localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, "expired"); window.alert = () => {};`,
  );
  await page.route("https://api.github.com/**", (r) => r.fulfill({ status: 401, body: "{}" }));
  await page.locator("#cm-refresh").click();
  await page.waitForTimeout(600);
  check(
    (await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY)) === null,
    "the 401'd token was cleared from localStorage",
  );
  check(!(await page.locator("#cm-token").isHidden()), "the field reopens so a new token can be entered");
  await page.close();

  await browser.close();
  server.close();
  console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall refresh-button checks passed");
  process.exitCode = failures.length ? 1 : 0;
})();
