// Launch Chromium for the two browser checks (verify-mobile.js, verify-refresh.js).
//
// CI runs `npx playwright install chromium`, so the build playwright pins is on disk and
// the plain launch() below is the normal path — this module changes nothing there. It
// exists for sandboxes (Claude Code on the web) that ship a *pre-installed* Chromium and
// point PLAYWRIGHT_BROWSERS_PATH at it: a playwright bump then asks for a build number
// the image doesn't have, and `playwright install` can't close the gap because
// cdn.playwright.dev is off the network allowlist. Without a fallback both checks die on
// "Executable doesn't exist" and the required UI smoke test simply can't be run.
//
// So: try the pinned build, and only if that fails look for a Chromium the image already
// has. A one-release skew between the browser and the client is fine for what these
// checks assert; a check that cannot run at all is not.
const fs = require("fs");
const path = require("path");
// playwright is required lazily, inside launchChromium(): CI runs `npm test` before
// `npm ci` because the unit tests are zero-dep, and a top-level require here would drag
// playwright into that step and fail it.

function isExecutableFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Highest build number first — if an image carries several, the newest is the closest
// match to whatever the current playwright wanted.
function buildNumber(name) {
  const m = /-(\d+)$/.exec(name);
  return m ? Number(m[1]) : -1;
}

function installedChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || root === "0") return null;

  // Some images symlink <root>/chromium straight at the binary.
  const direct = path.join(root, "chromium");
  if (isExecutableFile(direct)) return direct;

  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return null;
  }
  const dirs = entries
    .filter((e) => /^chromium(_headless_shell)?(-\d+)?$/.test(e))
    .sort((a, b) => buildNumber(b) - buildNumber(a));
  for (const dir of dirs) {
    for (const rel of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-linux/headless_shell", "chrome-headless-shell-linux64/chrome-headless-shell"]) {
      const bin = path.join(root, dir, rel);
      if (isExecutableFile(bin)) return bin;
    }
  }
  return null;
}

async function launchChromium(opts = {}) {
  const { chromium } = require("playwright");
  try {
    return await chromium.launch(opts);
  } catch (err) {
    const fallback = installedChromium();
    if (!fallback) throw err;
    console.warn(`playwright's pinned Chromium is unavailable; falling back to ${fallback}`);
    return await chromium.launch({ ...opts, executablePath: fallback });
  }
}

module.exports = { launchChromium, installedChromium };
