// Drives the REAL extension in a real Chrome, against live Cardmarket.
//
// Unlike test/cardmarket-client.browser.test.js (which stubs the bridge), this loads
// extension/ for real, so it exercises the whole chain: content script -> service worker
// -> credentialed fetch -> parser -> grid. It therefore depends on the browser profile
// having a Cardmarket session, which is the one thing only a human can establish.
//
// ⚠️  MEASURED 2026-07-26: the Playwright-driven path CANNOT work, and that's inherent.
// Cloudflare serves an automated (CDP-driven) browser a NON-INTERACTIVE managed challenge
// that never completes: the page sits on "Performing security verification" with zero
// buttons or checkboxes in it, so there is nothing a human can click to clear it. Warming
// the profile by hand doesn't help either — there's no widget to interact with. Automating
// the browser is exactly what Cloudflare detects, so a driven browser is the one browser
// this design can't use.
//
// => Use `--serve` and open the dashboard in your OWN everyday Chrome. That is the real
//    (and only) validation path. Chrome 137+ also removed the --load-extension switch, so
//    install via chrome://extensions -> Load unpacked; that persists.
//
// Usage:
//   node scripts/try-extension.js --serve      # THE USEFUL ONE: serve the dashboard for
//                                              # your real Chrome, no automation at all
//   node scripts/try-extension.js              # drive it via Playwright (expect a
//                                              # challenge — kept to re-verify the above)
//   node scripts/try-extension.js --warmup     # open Cardmarket in the driven browser
//   node scripts/try-extension.js --keep-open  # leave the driven browser open at the end
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { normalizeCards } = require("../shared/cards");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const PROFILE = path.join(os.tmpdir(), "mtg-cm-probe-profile");
const WEB = path.join(os.tmpdir(), "mtg-cm-probe-web");

const WARMUP = process.argv.includes("--warmup");
const KEEP_OPEN = process.argv.includes("--keep-open");
const SERVE_ONLY = process.argv.includes("--serve");
const PROBE_URL = "https://www.cardmarket.com/en/Magic/Products/Singles/Aetherdrift/Stock-Up?language=7";

// Assembles the dashboard exactly as the deploy does, plus a data.json containing only
// the Cardmarket rows (paused, as the server emits them) so there's nothing to fetch
// from CardTrader and no API token needed.
function buildSite() {
  fs.rmSync(WEB, { recursive: true, force: true });
  fs.mkdirSync(WEB, { recursive: true });
  for (const f of ["ui.css", "render.js", "app.js", "favicon.svg", "cardmarket-parse.js", "cardmarket-client.js"]) {
    fs.copyFileSync(path.join(ROOT, "shared", f), path.join(WEB, f));
  }
  fs.copyFileSync(path.join(ROOT, "cloud", "web", "index.html"), path.join(WEB, "index.html"));

  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  const cm = normalizeCards(config).filter((p) => p.site === "cardmarket");
  const results = cm.map((p) => ({
    site: p.site,
    group: p.group,
    variant: p.variant,
    code: p.code,
    productUrl: p.productUrl,
    offers: [],
    paused: true,
    error: "Cardmarket paused — filled in by the browser",
  }));
  fs.writeFileSync(
    path.join(WEB, "data.json"),
    JSON.stringify({ updatedAt: new Date().toISOString(), results })
  );
  return results.length;
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

// preferredPort keeps the --serve URL stable between runs (so it can be bookmarked),
// falling back to an ephemeral port if something already holds it.
function serve(preferredPort = 0) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(WEB, rel === "/" ? "index.html" : path.basename(rel));
    if (!fs.existsSync(file)) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.once("error", () => server.listen(0, "127.0.0.1", () => resolve(server)));
    server.listen(preferredPort, "127.0.0.1", () => resolve(server));
  });
}

(async () => {
  const cardCount = buildSite();
  const server = await serve(SERVE_ONLY ? 8788 : 0);
  const port = server.address().port;
  // "localhost" (not 127.0.0.1) so it matches the manifest's content_scripts pattern.
  const dash = `http://localhost:${port}/`;

  if (SERVE_ONLY) {
    console.log("Dashboard is serving — now open it in your OWN Chrome:");
    console.log("");
    console.log(`    ${dash}`);
    console.log("");
    console.log(`(${cardCount} Cardmarket cards, from config.json)`);
    console.log("");
    console.log("One-time extension install, if you haven't already:");
    console.log("  1. chrome://extensions");
    console.log("  2. turn on Developer mode (top right)");
    console.log("  3. Load unpacked -> select:");
    console.log(`     ${EXT}`);
    console.log("");
    console.log("Then reload the dashboard. The header shows 'Cardmarket live' when rows fill in.");
    console.log("If a row reports a Cloudflare challenge, visit cardmarket.com in that same");
    console.log("Chrome once, clear it, and reload.");
    console.log("");
    console.log("Ctrl+C to stop serving.");
    await new Promise(() => {}); // serve until interrupted
    return;
  }

  console.log(`profile   : ${PROFILE}`);
  console.log(`extension : ${EXT}`);
  console.log(`dashboard : ${dash}  (${cardCount} Cardmarket cards)`);
  console.log("");
  console.log("NOTE: a Playwright-driven browser gets a non-interactive Cloudflare challenge");
  console.log("      that cannot be cleared. Use --serve and your own Chrome instead.");
  console.log("");

  // Extensions require a headed browser and a persistent profile.
  //
  // Playwright's BUNDLED Chromium, not channel:"chrome": Chrome 137+ removed the
  // --load-extension switch on the stable channel, so a real-Chrome run loads no
  // extension at all (verified: serviceWorkers()==0 with chrome, ==1 with chromium).
  // Warmup and scraping must also use the same binary — Cloudflare binds clearance to the
  // fingerprint that earned it, so warming in one browser and fetching in another wastes it.
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1400, height: 950 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });

  try {
    if (WARMUP) {
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(PROBE_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
      console.log("Chrome is open on Cardmarket.");
      console.log("Pass the 'Verify you are human' check (and log in, if you want the Ship");
      console.log("column to work). This profile is reused, so it only has to be done once.");
      console.log("");
      console.log("Waiting up to 5 minutes for offer rows to appear…");
      try {
        await page.waitForSelector(".article-row", { timeout: 300000 });
        console.log("✅ Cardmarket offer rows are visible — the profile is warm.");
        console.log("   Re-run without --warmup to drive the extension.");
      } catch {
        console.log("⚠️  No offer rows appeared. The profile is probably still challenged.");
      }
      return;
    }

    // Does the service worker exist? If the extension failed to load, nothing else matters.
    const sw = ctx
      .serviceWorkers()
      .concat(await Promise.race([
        ctx.waitForEvent("serviceworker", { timeout: 5000 }).then((w) => [w]).catch(() => []),
      ]));
    console.log(`service worker : ${sw.length ? "loaded (" + sw[0].url() + ")" : "NOT DETECTED"}`);

    const page = ctx.pages()[0] || (await ctx.newPage());
    page.on("console", (m) => {
      if (m.type() === "error") console.log("  [page error] " + m.text());
    });
    await page.goto(dash, { waitUntil: "domcontentloaded" });

    const bridge = await page.evaluate(() => CardmarketClient.detect(8000));
    console.log(`bridge         : ${bridge ? "connected" : "NOT CONNECTED"}`);
    if (!bridge) {
      console.log("");
      console.log("The content script didn't answer. Check that manifest.json's");
      console.log("content_scripts matches include http://localhost/*.");
      return;
    }

    console.log("");
    console.log("Fetching Cardmarket through the extension (2s apart, force-refresh)…");
    const out = await page.evaluate(async () => {
      const rows = (await (await fetch("data.json")).json()).results.filter((r) => r.site === "cardmarket");
      await CardmarketClient.fillOffers(rows, { force: true });
      return rows.map((r) => ({
        group: r.group,
        variant: r.variant,
        url: r.productUrl,
        n: r.offers.length,
        error: r.error || null,
        loggedOut: !!r.cmLoggedOut,
        cheapest: r.offers.length ? r.offers.map((o) => o.price).filter((p) => p != null).sort((a, b) => a - b)[0] : null,
        sample: r.offers.slice(0, 3).map((o) => `${o.priceStr} ${o.condition || "?"} ${o.seller || "?"}`),
      }));
    });

    console.log("");
    let ok = 0;
    let challenged = 0;
    for (const r of out) {
      if (r.n) {
        ok++;
        console.log(`✅ ${r.group} — ${r.variant}: ${r.n} offers, cheapest ${r.cheapest?.toFixed(2)} €`);
        for (const s of r.sample) console.log(`      ${s}`);
      } else {
        if (/challenge/i.test(r.error || "")) challenged++;
        console.log(`❌ ${r.group} — ${r.variant}: ${r.error}`);
      }
    }

    console.log("");
    console.log(`RESULT: ${ok}/${out.length} cards returned live offers.`);
    if (challenged) {
      console.log(`${challenged} were blocked by a Cloudflare challenge.`);
      console.log("Run:  node scripts/try-extension.js --warmup");
      console.log("…pass the check once in the window that opens, then re-run this.");
    }
    if (out.some((r) => r.loggedOut)) {
      console.log("Note: not logged in — prices parse, but the Ship column can't be determined.");
    }
    process.exitCode = ok ? 0 : 1;

    if (KEEP_OPEN) {
      console.log("");
      console.log("--keep-open: leaving the browser up. Ctrl+C to quit.");
      await new Promise(() => {});
    }
  } finally {
    if (!KEEP_OPEN) await ctx.close().catch(() => {});
    server.close();
  }
})();
