// Guards the Azure function's staging step. The function app mirrors the repo's
// directory layout so the relative requires in cloud/*.js resolve unchanged — which
// means the deploy's copy list and the code's require graph have to stay in sync.
//
// This runs the ACTUAL cp/mkdir lines from .github/workflows/azure-deploy.yml against a
// temp tree, then requires cloud/build-data.js out of it. Add a require to build-data
// without adding the file to the copy list and this fails here, instead of at 3am when
// the timer trigger throws MODULE_NOT_FOUND in Azure.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const WF = path.join(ROOT, ".github", "workflows", "azure-deploy.yml");
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;

// The staging step's body, pulled straight out of the workflow.
function stagingCommands() {
  const lines = fs.readFileSync(WF, "utf8").split("\n").map((l) => l.trim());
  return lines.filter(
    (l) => (l.startsWith("mkdir -p azure/functions") || l.startsWith("cp ")) && l.includes("azure/functions")
  );
}

test("the workflow still has a recognizable staging step", () => {
  const cmds = stagingCommands();
  assert.ok(cmds.length >= 2, `expected mkdir + cp lines in azure-deploy.yml, found ${cmds.length}`);
  assert.ok(cmds.some((c) => c.startsWith("mkdir -p")), "expected the mkdir line");
});

test("staged function app resolves build-data and normalizes config", { skip: !hasBash && "bash unavailable" }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "azure-stage-"));
  try {
    // Copy in only the sources the staging step reads from, so a missing source is a
    // failure here rather than something silently picked up from the real tree.
    fs.mkdirSync(path.join(tmp, "cloud"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "shared"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "config.json"), path.join(tmp, "config.json"));
    for (const f of fs.readdirSync(path.join(ROOT, "cloud")).filter((f) => f.endsWith(".js"))) {
      fs.copyFileSync(path.join(ROOT, "cloud", f), path.join(tmp, "cloud", f));
    }
    for (const f of fs.readdirSync(path.join(ROOT, "shared")).filter((f) => f.endsWith(".js"))) {
      fs.copyFileSync(path.join(ROOT, "shared", f), path.join(tmp, "shared", f));
    }

    execFileSync("bash", ["-ec", stagingCommands().join("\n")], { cwd: tmp });

    const staged = path.join(tmp, "azure", "functions");
    const { buildData } = require(path.join(staged, "cloud", "build-data.js"));
    assert.equal(typeof buildData, "function");

    const { normalizeCards } = require(path.join(staged, "shared", "cards.js"));
    const cfg = JSON.parse(fs.readFileSync(path.join(staged, "config.json"), "utf8"));
    assert.ok(normalizeCards(cfg).length > 0, "staged config.json must normalize to products");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("refreshData reads config from the app root it is staged into", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "azure", "functions", "src", "functions", "refreshData.js"),
    "utf8"
  );
  // src/functions/refreshData.js -> ../../config.json and ../../cloud/build-data
  assert.match(src, /require\(["']\.\.\/\.\.\/cloud\/build-data["']\)/);
  assert.match(src, /"\.\.",\s*"\.\.",\s*"config\.json"/);
  assert.match(src, /\$web/, "must publish into the static-website container");
});
