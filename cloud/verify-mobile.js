// UI smoke test: serve cloud/web, render the dashboard at three viewports,
// screenshot, and FAIL (exit 1) on horizontal overflow or zero rendered cards.
// Also exercises the >10-offer row collapse on the desktop pass.
// Self-contained: copies the shared UI into web/ and falls back to the committed
// fixture when no live data.json exists (CI never hits the real APIs).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const WEB = path.join(__dirname, "web");
const SHARED = path.join(__dirname, "..", "shared");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

for (const f of ["ui.css", "render.js", "app.js"]) {
  fs.copyFileSync(path.join(SHARED, f), path.join(WEB, f));
}
if (!fs.existsSync(path.join(WEB, "data.json"))) {
  fs.copyFileSync(path.join(__dirname, "fixture-data.json"), path.join(WEB, "data.json"));
  console.log("no live data.json — using fixture-data.json");
}

const server = http.createServer((req, res) => {
  const file = path.join(WEB, req.url.split("?")[0] === "/" ? "index.html" : req.url.split("?")[0]);
  try {
    res.setHeader("Content-Type", MIME[path.extname(file)] || "text/plain");
    res.end(fs.readFileSync(file));
  } catch {
    res.statusCode = 404; res.end("nope");
  }
});

// Functional check of the >10-offer collapse (render.js): 10 visible rows plus
// a "Show N more" toggle, click shows all, expansion survives a re-render.
// Runs against whichever card has a toggle — the fixture's 13-offer "Deep Stack"
// in CI; skipped (with a note) if a live data.json has no such card.
async function checkCollapse(page) {
  const r = await page.evaluate(async () => {
    const find = () => [...document.querySelectorAll("#grid .card")].find((c) => c.querySelector(".more-toggle"));
    let card = find();
    if (!card) return null;
    const visible = () => [...card.querySelectorAll("tr")].filter((tr) => tr.querySelector("td") && getComputedStyle(tr).display !== "none").length;
    const total = card.querySelectorAll("tr").length - 1; // minus the header row
    const out = { total, collapsed: visible(), label: card.querySelector(".more-toggle").textContent };
    card.querySelector(".more-toggle").click();
    out.expanded = visible();
    out.labelOpen = card.querySelector(".more-toggle").textContent;
    // Re-render like the poll loop does: the expansion must stick.
    const data = await (await fetch("data.json")).json();
    CardUI.renderGrid(data, {});
    card = find();
    out.afterRerender = visible();
    card.querySelector(".more-toggle").click(); // leave it collapsed for the screenshot
    out.recollapsed = visible();
    return out;
  });
  if (!r) { console.log("collapse: no card with >10 offers in data.json — skipped"); return false; }
  const ok =
    r.collapsed === 10 &&
    r.label === `Show ${r.total - 10} more` &&
    r.expanded === r.total &&
    r.labelOpen === "Show less" &&
    r.afterRerender === r.total &&
    r.recollapsed === 10;
  console.log(`collapse: ${r.collapsed}/${r.total} rows, "${r.label}" -> ${r.expanded} rows, survives re-render = ${r.afterRerender === r.total} ${ok ? "OK" : "FAIL " + JSON.stringify(r)}`);
  return !ok;
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch();
  let failed = false;
  for (const [name, vp] of [["mobile", { width: 390, height: 844 }], ["narrow", { width: 320, height: 700 }], ["desktop", { width: 1440, height: 900 }]]) {
    const page = await browser.newPage({ viewport: vp });
    await page.goto(`http://localhost:${port}/`);
    await page.waitForSelector("#grid .card", { timeout: 10000 }).catch(() => {});
    const cards = await page.locator("#grid .card").count();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const ok = cards > 0 && overflow <= 0;
    if (!ok) failed = true;
    console.log(`${name}: ${cards} cards, horizontal overflow = ${overflow}px ${ok ? "OK" : "FAIL"}`);
    if (name === "desktop" && (await checkCollapse(page))) failed = true;
    await page.screenshot({ path: path.join(__dirname, `shot-${name}.png`), fullPage: false });
    await page.close();
  }
  await browser.close();
  server.close();
  process.exitCode = failed ? 1 : 0;
})();
