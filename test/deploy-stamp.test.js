// Guards the deploy-time cache-bust step in update.yml: extracts the actual
// sed + grep-guard commands from the workflow and runs them against the
// committed cloud/web/index.html, so restructuring the page (or the workflow)
// in a way that breaks the stamp fails CI here instead of failing the deploy.
// Skipped where bash isn't available (Windows dev box) — CI always runs it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const wf = fs.readFileSync(path.join(ROOT, ".github", "workflows", "update.yml"), "utf8");
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;

test("deploy cache-bust stamps all four asset links and nothing else", { skip: !hasBash && "bash unavailable" }, () => {
  const cmds = wf.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("sed -i") || l.startsWith("grep -c"));
  assert.equal(cmds.length, 2, "expected the sed line and its grep guard in update.yml");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-test-"));
  fs.mkdirSync(path.join(tmp, "cloud", "web"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "cloud", "web", "index.html"), path.join(tmp, "cloud", "web", "index.html"));

  execFileSync("bash", ["-ec", cmds.join("\n")], { cwd: tmp, env: { ...process.env, GITHUB_SHA: "cafef00d" } });

  const out = fs.readFileSync(path.join(tmp, "cloud", "web", "index.html"), "utf8");
  const assets = [
    'href="ui.css?v=cafef00d"',
    'href="favicon.svg?v=cafef00d"',
    'src="render.js?v=cafef00d"',
    'src="cardmarket-parse.js?v=cafef00d"',
    'src="cardmarket-client.js?v=cafef00d"',
    'src="app.js?v=cafef00d"',
  ];
  assert.equal(
    (out.match(/\?v=cafef00d/g) || []).length,
    assets.length,
    `exactly the ${assets.length} asset links must be stamped`
  );
  for (const link of assets) {
    assert.ok(out.includes(link), `missing stamped link: ${link}`);
  }
  assert.ok(out.includes("data/data.json"), "the data.json URL must not be stamped");
  fs.rmSync(tmp, { recursive: true, force: true });
});
