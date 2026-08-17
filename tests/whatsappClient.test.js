const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const whatsappClient = require("../src/whatsappClient");
const { isProcessAlive, removeStaleSingletonLocks } = whatsappClient._internal;

function makeTempProfileDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wa-profile-test-"));
}

// Whether this environment allows creating symlinks without elevated
// privileges (Windows dev machines typically do not; the production Linux
// container does). Tests that need a real SingletonLock symlink are skipped
// where it isn't available - the non-symlink code path they'd otherwise
// exercise is already covered separately below.
let symlinksSupported = true;
try {
  const probeDir = makeTempProfileDir();
  fs.symlinkSync("probe-target", path.join(probeDir, "probe-link"));
  fs.rmSync(probeDir, { recursive: true, force: true });
} catch (error) {
  symlinksSupported = false;
}

test("isProcessAlive returns true for the current process", () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test("isProcessAlive returns false for a pid that is almost certainly not running", () => {
  // Not a real guarantee on every system, but astronomically unlikely to
  // collide with a live pid in a short-lived test run.
  assert.equal(isProcessAlive(999999), false);
});

test("isProcessAlive returns false for invalid input", () => {
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-5), false);
  assert.equal(isProcessAlive(NaN), false);
  assert.equal(isProcessAlive(undefined), false);
});

test("removeStaleSingletonLocks does nothing when no lock file exists", () => {
  const dir = makeTempProfileDir();
  try {
    const removed = removeStaleSingletonLocks(dir);
    assert.equal(removed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeStaleSingletonLocks removes a lock that is not a symlink (can't verify a live owner)", () => {
  const dir = makeTempProfileDir();
  try {
    fs.writeFileSync(path.join(dir, "SingletonLock"), "not-a-symlink");
    fs.writeFileSync(path.join(dir, "SingletonSocket"), "");
    fs.writeFileSync(path.join(dir, "SingletonCookie"), "");

    const removed = removeStaleSingletonLocks(dir);

    assert.equal(removed, true);
    assert.equal(fs.existsSync(path.join(dir, "SingletonLock")), false);
    assert.equal(fs.existsSync(path.join(dir, "SingletonSocket")), false);
    assert.equal(fs.existsSync(path.join(dir, "SingletonCookie")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeStaleSingletonLocks removes a lock pointing at a dead pid", { skip: !symlinksSupported }, () => {
  const dir = makeTempProfileDir();
  try {
    // whatsapp-web.js/Chromium never actually launches a process with this
    // pid in this test, so it is guaranteed dead.
    fs.symlinkSync(`${os.hostname()}-999999`, path.join(dir, "SingletonLock"));
    fs.writeFileSync(path.join(dir, "SingletonSocket"), "");
    fs.writeFileSync(path.join(dir, "SingletonCookie"), "");

    const removed = removeStaleSingletonLocks(dir);

    assert.equal(removed, true);
    assert.equal(fs.existsSync(path.join(dir, "SingletonLock")), false);
    assert.equal(fs.existsSync(path.join(dir, "SingletonSocket")), false);
    assert.equal(fs.existsSync(path.join(dir, "SingletonCookie")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeStaleSingletonLocks leaves a lock in place when it points at a live pid", { skip: !symlinksSupported }, () => {
  const dir = makeTempProfileDir();
  try {
    fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(dir, "SingletonLock"));

    const removed = removeStaleSingletonLocks(dir);

    assert.equal(removed, false);
    assert.equal(fs.existsSync(path.join(dir, "SingletonLock")), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sessionUserDataDir matches the LocalAuth clientId used by createClient", () => {
  const previous = process.env.WHATSAPP_SESSION_PATH;
  process.env.WHATSAPP_SESSION_PATH = "/tmp/example-session-path";
  try {
    // Re-require is unnecessary: sessionUserDataDir() reads the env var at
    // call time, not at module load time.
    const dir = whatsappClient._internal.sessionUserDataDir();
    assert.equal(dir, path.join("/tmp/example-session-path", "session-meridian-staff"));
  } finally {
    if (previous === undefined) {
      delete process.env.WHATSAPP_SESSION_PATH;
    } else {
      process.env.WHATSAPP_SESSION_PATH = previous;
    }
  }
});
