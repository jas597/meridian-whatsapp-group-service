const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Must be set before whatsappClient is required - read once at module load
// time. Keeps the message_ack-timeout test below fast instead of actually
// waiting out the production 20s timeout.
process.env.WHATSAPP_LID_ACK_TIMEOUT_MS = "20";

const whatsappClient = require("../src/whatsappClient");
const { sendContactMessage } = whatsappClient;
const {
  isProcessAlive,
  removeStaleSingletonLocks,
  isLidId,
  extractResolvedPhone,
  normalizeMessageContact,
  resolveContactIds,
  __setTestClient,
} = whatsappClient._internal;

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

// --- @lid identity resolution ------------------------------------------

test("isLidId recognizes @lid senders and rejects everything else", () => {
  assert.equal(isLidId("134492773699746@lid"), true);
  assert.equal(isLidId("19196243916@c.us"), false);
  assert.equal(isLidId("12345@g.us"), false);
  assert.equal(isLidId(""), false);
  assert.equal(isLidId(undefined), false);
});

test("normalizeMessageContact strips @c.us/@g.us but leaves @lid digits as-is (pre-existing behavior)", () => {
  assert.equal(normalizeMessageContact("19196243916@c.us"), "19196243916");
  assert.equal(normalizeMessageContact("134492773699746@lid"), "134492773699746");
});

test("extractResolvedPhone prefers contact.number when it is a real phone number", () => {
  const contact = { id: { _serialized: "134492773699746@lid" }, number: "19196243916" };
  assert.equal(extractResolvedPhone(contact), "19196243916");
});

test("extractResolvedPhone falls back to contact.id._serialized when number is missing but id resolved to @c.us", () => {
  const contact = { id: { _serialized: "19196243916@c.us" } };
  assert.equal(extractResolvedPhone(contact), "19196243916");
});

test("extractResolvedPhone returns empty when WhatsApp never resolved past the lid (never guesses)", () => {
  const contact = { id: { _serialized: "134492773699746@lid" } };
  assert.equal(extractResolvedPhone(contact), "");
});

test("extractResolvedPhone returns empty for a missing/null contact", () => {
  assert.equal(extractResolvedPhone(null), "");
  assert.equal(extractResolvedPhone(undefined), "");
  assert.equal(extractResolvedPhone({}), "");
});

test("SEND_ATTEMPTED_UNCONFIRMED is exported for callers to compare error.state against", () => {
  assert.equal(whatsappClient.SEND_ATTEMPTED_UNCONFIRMED, "SEND_ATTEMPTED_UNCONFIRMED");
});

// --- resolveContactIds: at most one candidate, always -----------------------

test("resolveContactIds returns exactly one @c.us candidate for a plain phone number", async () => {
  const ids = await resolveContactIds("+19196243916");
  assert.deepEqual(ids, ["19196243916@c.us"]);
});

test("resolveContactIds returns exactly one candidate for an already-qualified id", async () => {
  assert.deepEqual(await resolveContactIds("19196243916@c.us"), ["19196243916@c.us"]);
  assert.deepEqual(await resolveContactIds("134492773699746@lid"), ["134492773699746@lid"]);
  assert.deepEqual(await resolveContactIds("12345@g.us"), ["12345@g.us"]);
});

test("resolveContactIds returns an empty array for an unresolvable contact", async () => {
  assert.deepEqual(await resolveContactIds(""), []);
  assert.deepEqual(await resolveContactIds(null), []);
});

// --- sendContactMessage: exactly one client.sendMessage() call, always -----
//
// Root cause of two separate production incidents (2026-08-18: 4 real sends
// from one click; 2026-08-19: 2 real sends from one click, Jawa received the
// same message twice) was the combination of per-candidate retries and a
// second (@lid) candidate id as a reachability fallback - every one of those
// extra attempts is a REAL WhatsApp send that can silently succeed despite
// reporting failure. The fix removes both mechanisms entirely: there is
// structurally only ever one candidate id and one sendMessage() call per
// sendContactMessage() invocation, not just a low default that could be
// reconfigured back up.

function fakeReadyClient(sendMessageResult) {
  const calls = [];
  return {
    calls,
    async sendMessage(contactId, content, options) {
      calls.push({ contactId, content, options });
      return sendMessageResult;
    },
    on() {},
    off() {},
  };
}

test("sendContactMessage makes exactly one sendMessage() call on success", async () => {
  const sentMessage = { id: { _serialized: "abc123" } };
  const readyClient = fakeReadyClient(sentMessage);
  __setTestClient(readyClient, whatsappClient._STATUS.READY);

  const result = await sendContactMessage({ contact: "+19196243916", message: "hello" });

  assert.equal(result.messageId, "abc123");
  assert.equal(readyClient.calls.length, 1);
  assert.equal(readyClient.calls[0].contactId, "19196243916@c.us");
});

test("sendContactMessage makes exactly one sendMessage() call and does not retry when no chat could be created", async () => {
  // The genuine "no chat created" false negative - sendMessage() returns
  // nothing at all. There is no retry and no second candidate id to fall
  // back to; the call count must stay at 1.
  const readyClient = fakeReadyClient(undefined);
  __setTestClient(readyClient, whatsappClient._STATUS.READY);

  await assert.rejects(
    () => sendContactMessage({ contact: "+19196243916", message: "hello" }),
    (error) => {
      assert.equal(error.state, "SEND_ATTEMPTED_UNCONFIRMED");
      return true;
    }
  );

  assert.equal(readyClient.calls.length, 1, "no retry may occur - exactly one real send attempt, ever");
});

test("sendContactMessage makes exactly one sendMessage() call when dispatched but never acknowledged", async () => {
  // A rawId with no _serialized id means WhatsApp's client actually created
  // and dispatched a real outgoing message, but message_ack never arrives
  // within the timeout. There is no second candidate id to try.
  const sentMessage = { id: { id: "3EB0RAWID", _serialized: "" } };
  const readyClient = fakeReadyClient(sentMessage);
  __setTestClient(readyClient, whatsappClient._STATUS.READY);

  await assert.rejects(
    () => sendContactMessage({ contact: "+19196243916", message: "hello" }),
    (error) => {
      assert.equal(error.state, "SEND_ATTEMPTED_UNCONFIRMED");
      return true;
    }
  );

  assert.equal(readyClient.calls.length, 1, "no fallback candidate id may be tried after a real dispatch");
});

test("sendContactMessage passes media as caption when provided, still exactly one call", async () => {
  const sentMessage = { id: { _serialized: "abc123" } };
  const readyClient = fakeReadyClient(sentMessage);
  __setTestClient(readyClient, whatsappClient._STATUS.READY);
  const imageBase64 = Buffer.from("fake-image-bytes").toString("base64");

  await sendContactMessage({ contact: "+19196243916", message: "caption text", imageBase64, imageFilename: "photo.png" });

  assert.equal(readyClient.calls.length, 1);
  assert.deepEqual(readyClient.calls[0].options, { caption: "caption text" });
});
