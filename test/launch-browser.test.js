const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { installedChromium } = require("../cloud/launch-browser");

// The fallback only ever runs after playwright's own launch has failed, so what matters
// is that it finds a real binary when the image has one and stays out of the way when it
// doesn't — a wrong guess would turn a clear "executable missing" into a launch error.
function withEnv(env, fn) {
  const saved = { CHROMIUM_PATH: process.env.CHROMIUM_PATH, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH };
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pw-browsers-"));
}

function touch(root, rel) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "");
  return p;
}

test("no browsers path means no fallback: the pinned-build error stands", () => {
  withEnv({ CHROMIUM_PATH: undefined, PLAYWRIGHT_BROWSERS_PATH: undefined }, () => {
    assert.equal(installedChromium(), null);
  });
});

test("an explicit CHROMIUM_PATH wins over anything on disk", () => {
  const root = tmpRoot();
  touch(root, "chromium-1194/chrome-linux/chrome");
  withEnv({ CHROMIUM_PATH: "/somewhere/else/chrome", PLAYWRIGHT_BROWSERS_PATH: root }, () => {
    assert.equal(installedChromium(), "/somewhere/else/chrome");
  });
});

test("finds a versioned build directory", () => {
  const root = tmpRoot();
  const bin = touch(root, "chromium-1194/chrome-linux/chrome");
  withEnv({ CHROMIUM_PATH: undefined, PLAYWRIGHT_BROWSERS_PATH: root }, () => {
    assert.equal(installedChromium(), bin);
  });
});

test("prefers the highest build number when the image carries several", () => {
  const root = tmpRoot();
  touch(root, "chromium-1194/chrome-linux/chrome");
  const newer = touch(root, "chromium-1201/chrome-linux/chrome");
  withEnv({ CHROMIUM_PATH: undefined, PLAYWRIGHT_BROWSERS_PATH: root }, () => {
    assert.equal(installedChromium(), newer);
  });
});

test("takes <root>/chromium when the image symlinks it straight at the binary", () => {
  const root = tmpRoot();
  const real = touch(root, "chromium-1194/chrome-linux/chrome");
  fs.symlinkSync(real, path.join(root, "chromium"));
  withEnv({ CHROMIUM_PATH: undefined, PLAYWRIGHT_BROWSERS_PATH: root }, () => {
    assert.equal(installedChromium(), path.join(root, "chromium"));
  });
});

test("PLAYWRIGHT_BROWSERS_PATH=0 means browsers live in node_modules, not a shared root", () => {
  withEnv({ CHROMIUM_PATH: undefined, PLAYWRIGHT_BROWSERS_PATH: "0" }, () => {
    assert.equal(installedChromium(), null);
  });
});

test("an empty browsers root yields no candidate", () => {
  const root = tmpRoot();
  withEnv({ CHROMIUM_PATH: undefined, PLAYWRIGHT_BROWSERS_PATH: root }, () => {
    assert.equal(installedChromium(), null);
  });
});

test("ignores directories that only look like a browser", () => {
  const root = tmpRoot();
  touch(root, "ffmpeg-1011/ffmpeg-linux");
  touch(root, "firefox-1500/firefox/firefox");
  withEnv({ CHROMIUM_PATH: undefined, PLAYWRIGHT_BROWSERS_PATH: root }, () => {
    assert.equal(installedChromium(), null);
  });
});
