const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Must be set before whatsappClient is required - both are read once at
// module load time. WHATSAPP_CONTACT_SEND_RETRY_DELAY_MS keeps the retry
// tests below fast instead of actually waiting out the production 3s delay.
// WHATSAPP_CONTACT_SEND_RETRY_ATTEMPTS is pinned to 2 here so the
// multi-attempt retry tests below can exercise a real retry - the
// production default is intentionally 1 (see whatsappClient.js), since
// every attempt is a real WhatsApp send and multiplying that by attempts
// per contact id candidate is what caused a single click to produce
// multiple real sends in production.
process.env.WHATSAPP_CONTACT_SEND_RETRY_DELAY_MS = "10";
process.env.WHATSAPP_CONTACT_SEND_RETRY_ATTEMPTS = "2";
process.env.WHATSAPP_LID_ACK_TIMEOUT_MS = "20";

const whatsappClient = require("../src/whatsappClient");
const { sendContactMessage } = whatsappClient;
const {
  isProcessAlive,
  removeStaleSingletonLocks,
  isLidId,
  extractResolvedPhone,
  normalizeMessageContact,
  __setTestClient,
  sendMessageWithChatRetry,
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

// --- Bounded send retry for the "no chat created" false negative --------

function fakeReadyClient(sendMessageResults) {
  let callCount = 0;
  return {
    calls: [],
    async sendMessage(contactId, content, options) {
      const result = sendMessageResults[Math.min(callCount, sendMessageResults.length - 1)];
      callCount += 1;
      this.calls.push({ contactId, content, options });
      return result;
    },
  };
}

test("sendMessageWithChatRetry returns immediately on a first-try success", async () => {
  const sentMessage = { id: { _serialized: "abc123" } };
  const readyClient = fakeReadyClient([sentMessage]);
  const result = await sendMessageWithChatRetry(readyClient, "19196243916@c.us", null, "hello");
  assert.equal(result, sentMessage);
  assert.equal(readyClient.calls.length, 1);
});

test("sendMessageWithChatRetry retries a no-chat-created failure and succeeds on the next attempt", async () => {
  const sentMessage = { id: { _serialized: "abc123" } };
  // First attempt returns nothing (the "no chat created" false negative),
  // second attempt succeeds.
  const readyClient = fakeReadyClient([undefined, sentMessage]);
  const result = await sendMessageWithChatRetry(readyClient, "19196243916@c.us", null, "hello");
  assert.equal(result, sentMessage);
  assert.equal(readyClient.calls.length, 2);
});

test("sendMessageWithChatRetry gives up after a bounded number of attempts, not indefinitely", async () => {
  // Every attempt returns nothing - the retry must still stop.
  const readyClient = fakeReadyClient([undefined]);
  const result = await sendMessageWithChatRetry(readyClient, "19196243916@c.us", null, "hello");
  assert.equal(result, undefined);
  // WHATSAPP_CONTACT_SEND_RETRY_ATTEMPTS is pinned to 2 for this test file
  // (see the top of this file) - exactly that many calls, no more.
  assert.equal(readyClient.calls.length, 2);
});

test("sendMessageWithChatRetry passes media as caption when provided", async () => {
  const sentMessage = { id: { _serialized: "abc123" } };
  const readyClient = fakeReadyClient([sentMessage]);
  const media = { mimetype: "image/png" };
  await sendMessageWithChatRetry(readyClient, "19196243916@c.us", media, "caption text");
  assert.equal(readyClient.calls[0].content, media);
  assert.deepEqual(readyClient.calls[0].options, { caption: "caption text" });
});

test("SEND_ATTEMPTED_UNCONFIRMED is exported for callers to compare error.state against", () => {
  assert.equal(whatsappClient.SEND_ATTEMPTED_UNCONFIRMED, "SEND_ATTEMPTED_UNCONFIRMED");
});

// --- sendContactMessage: stop after a real dispatch, never send twice ----
//
// Root cause of the 2026-08-18 incident: for each of up to 2 contact id
// candidates (phone-based, then @lid), sendMessage() was retried up to
// CONTACT_SEND_RETRY_ATTEMPTS times, AND on an unacknowledged-but-dispatched
// message the code moved on to try the next candidate id too - up to 4 real
// client.sendMessage() calls for one logical message. These tests prove a
// candidate id that actually got as far as creating a message object (a
// rawId) stops the whole attempt instead of trying another candidate id.

function fakeReadyClientWithLid(phoneResult, lidResult) {
  const calls = [];
  return {
    calls,
    async getNumberId(digits) {
      return { _serialized: `${digits}00@lid` };
    },
    async sendMessage(contactId) {
      calls.push(contactId);
      return contactId.endsWith("@lid") ? lidResult : phoneResult;
    },
    on() {},
    off() {},
  };
}

test("sendContactMessage stops after a dispatched-but-unacknowledged message; never tries a second candidate id", async () => {
  // Phone candidate: sendMessage() returns a real message object with a raw
  // id (WhatsApp's client actually created and dispatched it) but no
  // _serialized id, and no message_ack ever arrives within the timeout.
  const phoneResult = { id: { id: "3EB0RAWID", _serialized: "" } };
  const lidResult = { id: { _serialized: "should-never-be-reached" } };
  const readyClient = fakeReadyClientWithLid(phoneResult, lidResult);
  __setTestClient(readyClient, whatsappClient._STATUS.READY);

  await assert.rejects(
    () => sendContactMessage({ contact: "+19196243916", message: "hello" }),
    (error) => {
      assert.equal(error.state, "SEND_ATTEMPTED_UNCONFIRMED");
      return true;
    }
  );

  assert.equal(readyClient.calls.length, 1, "must not try the @lid candidate after the phone candidate already dispatched a real message");
  assert.equal(readyClient.calls[0], "19196243916@c.us");
});

test("sendContactMessage still tries the next candidate id when the first produced no message at all", async () => {
  // Phone candidate: sendMessage() returns nothing at all, every attempt
  // (the genuine "no chat could be created" case) - trying the @lid
  // candidate afterward is still safe here since nothing was ever dispatched.
  const lidResult = { id: { _serialized: "abc123" } };
  const readyClient = fakeReadyClientWithLid(undefined, lidResult);
  __setTestClient(readyClient, whatsappClient._STATUS.READY);

  const result = await sendContactMessage({ contact: "+19196243916", message: "hello" });

  assert.equal(result.messageId, "abc123");
  assert.equal(readyClient.calls.length, 3, "2 attempts for the phone candidate (pinned WHATSAPP_CONTACT_SEND_RETRY_ATTEMPTS=2) + 1 for the @lid candidate that succeeded");
});
