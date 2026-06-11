// Temp verification: serve cloud/web, screenshot mobile + desktop viewports.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const WEB = path.join(__dirname, "web");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

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
  const browser = await chromium.launch();
  for (const [name, vp] of [["mobile", { width: 390, height: 844 }], ["narrow", { width: 320, height: 700 }], ["desktop", { width: 1440, height: 900 }]]) {
    const page = await browser.newPage({ viewport: vp });
    await page.goto(`http://localhost:${port}/`);
    await page.waitForSelector("#grid .card");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(`${name}: horizontal overflow = ${overflow}px`);
    await page.screenshot({ path: path.join(__dirname, `shot-${name}.png`), fullPage: false });
    await page.close();
  }
  await browser.close();
  server.close();
})();
