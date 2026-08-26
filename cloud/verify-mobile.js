// UI smoke test: serve cloud/web, render the dashboard at three viewports,
// screenshot, and FAIL (exit 1) on horizontal overflow, zero rendered cards, or a
// header status rail that has lost its shape (2x2 on phones, one row above 480px).
// Self-contained: copies the shared UI into web/ and falls back to the committed
// fixture when no live data.json exists (CI never hits the real APIs).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { launchChromium } = require("./launch-browser");

const WEB = path.join(__dirname, "web");
const SHARED = path.join(__dirname, "..", "shared");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

for (const f of ["ui.css", "render.js", "app.js", "favicon.svg"]) {
  fs.copyFileSync(path.join(SHARED, f), path.join(WEB, f));
}
// Both feeds get a fixture fallback: the page merges CardTrader and Cardmarket, and the
// smoke test should exercise that merge (it is what puts the Src column on screen).
for (const [live, fixture] of [
  ["data.json", "fixture-data.json"],
  ["cardmarket.json", "fixture-cardmarket.json"],
]) {
  if (!fs.existsSync(path.join(WEB, live))) {
    fs.copyFileSync(path.join(__dirname, fixture), path.join(WEB, live));
    console.log(`no live ${live} — using ${fixture}`);
  }
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

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await launchChromium();
  let failed = false;
  for (const [name, vp] of [["mobile", { width: 390, height: 844 }], ["narrow", { width: 320, height: 700 }], ["desktop", { width: 1440, height: 900 }]]) {
    const page = await browser.newPage({ viewport: vp });
    await page.goto(`http://localhost:${port}/`);
    await page.waitForSelector("#grid .card", { timeout: 10000 }).catch(() => {});
    const cards = await page.locator("#grid .card").count();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    // The header rail is the one part of the layout that changes shape with width rather
    // than just size — a grid of labelled fields, folded to 2x2 below 480px. Overflow
    // alone would not catch it collapsing, because a rail that has lost its columns
    // simply gets taller. Field count varies legitimately (CM balance appears only once a
    // run has read the Firecrawl balance), so assert the arrangement, not the number.
    const rail = await page.evaluate(() => {
      const f = [...document.querySelectorAll("header .rail > div")];
      const uniq = (xs) => new Set(xs).size;
      return {
        fields: f.length,
        cols: uniq(f.map((e) => Math.round(e.getBoundingClientRect().left))),
        rows: uniq(f.map((e) => Math.round(e.getBoundingClientRect().top))),
      };
    });
    const phone = vp.width <= 480;
    const railOk = rail.fields >= 3 && rail.rows === (phone ? 2 : 1) && rail.cols === (phone ? 2 : rail.fields);
    const ok = cards > 0 && overflow <= 0 && railOk;
    if (!ok) failed = true;
    console.log(
      `${name}: ${cards} cards, horizontal overflow = ${overflow}px, ` +
        `rail ${rail.rows}x${rail.cols} of ${rail.fields} fields ${railOk ? "" : "(expected " + (phone ? "2 columns" : "one row") + ") "}` +
        (ok ? "OK" : "FAIL"),
    );
    await page.screenshot({ path: path.join(__dirname, `shot-${name}.png`), fullPage: false });
    await page.close();
  }
  await browser.close();
  server.close();
  process.exitCode = failed ? 1 : 0;
})();
