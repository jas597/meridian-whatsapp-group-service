const qrcode = require("qrcode");
const fs = require("fs");
const path = require("path");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

const logger = require("./utils/logger");

const STATUS = {
  STARTING: "starting",
  QR_REQUIRED: "qr_required",
  AUTHENTICATED: "authenticated",
  READY: "ready",
  DISCONNECTED: "disconnected",
};

const UNHEALTHY_WA_STATES = new Set([
  "CONFLICT",
  "UNPAIRED",
  "UNPAIRED_IDLE",
  "UNLAUNCHED",
  "PROXYBLOCK",
  "TOS_BLOCK",
  "SMB_TOS_BLOCK",
  "DEPRECATED_VERSION",
]);

const HEALTH_CHECK_INTERVAL_MS = Number(process.env.WHATSAPP_HEALTH_CHECK_INTERVAL_MS || 90000);
const HEALTH_CHECK_TIMEOUT_MS = Number(process.env.WHATSAPP_HEALTH_CHECK_TIMEOUT_MS || 15000);
const INIT_RETRY_DELAY_MS = Number(process.env.WHATSAPP_INIT_RETRY_DELAY_MS || 15000);
const INIT_MAX_RETRY_DELAY_MS = Number(process.env.WHATSAPP_INIT_MAX_RETRY_DELAY_MS || 300000);
const RESOLVE_CONTACT_TIMEOUT_MS = Number(process.env.WHATSAPP_RESOLVE_CONTACT_TIMEOUT_MS || 8000);
// No retry and no second candidate contact id for a contact-message send -
// see resolveContactIds() and sendContactMessage() below. A prior version
// of this file retried each candidate and tried up to two candidate ids
// (phone-based, then @lid) as a reachability fallback; production logs
// confirmed that let a single "Send to Jawa" click produce 4 real
// client.sendMessage() calls on 2026-08-18 and 2 on 2026-08-19, because
// every one of those extra attempts is itself a real send that can
// silently succeed despite reporting failure. One click must never be able
// to produce more than one real send, so there is no retry mechanism left
// to configure here.
const SEND_ATTEMPTED_UNCONFIRMED = "SEND_ATTEMPTED_UNCONFIRMED";

// Must match the clientId passed to LocalAuth in createClient() below - kept
// as one constant so the profile-lock cleanup can never drift out of sync
// with the directory whatsapp-web.js actually launches Chromium in.
const WHATSAPP_CLIENT_ID = "meridian-staff";

// Chromium creates these directly in the profile (userDataDir) root to stop
// two instances from sharing one profile. They are removed automatically on
// a clean shutdown, but survive an unclean one (crash, OOM kill, container
// restart) - Render's persistent disk keeps them even though the process
// that created them is gone, causing the next launch to fail with "Failed to
// launch the browser process ... profile appears to be in use".
const STALE_LOCK_FILE_NAMES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

let client;
let whatsappStatus = STATUS.STARTING;
let currentQrDataUrl = "";
let cachedGroupId = "";
let cachedGroupName = "";
let initializing = false;
let initializePromise = null;
let healthCheckTimer = null;
let healthCheckRunning = false;
let retryTimer = null;
let retryDelayMs = INIT_RETRY_DELAY_MS;

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function inboundMessagesFile() {
  return process.env.WHATSAPP_INBOUND_MESSAGES_FILE || "/var/data/whatsapp-inbound-messages.jsonl";
}

function normalizeMessageContact(value) {
  return String(value || "").replace(/@c\.us$|@g\.us$/i, "").replace(/[^\d]/g, "");
}

function isLidId(value) {
  return /@lid$/i.test(String(value || ""));
}

// Pure extraction step, split out from resolveSenderPhone() below purely so
// it's unit-testable without a real (or faked) whatsapp-web.js Client/
// Contact object. Given whatever Client.getContactById() resolved, decides
// whether it actually represents a usable phone number - never guesses from
// digit similarity: a still-@lid id (WhatsApp had no phone number to give
// us) is explicitly rejected rather than stored as if it were one.
function extractResolvedPhone(contact) {
  const resolvedId = contact && contact.id && contact.id._serialized ? contact.id._serialized : "";
  const resolvedNumber = contact && contact.number ? String(contact.number) : "";
  const candidate = resolvedNumber || resolvedId;
  if (candidate && !isLidId(candidate)) {
    return normalizeMessageContact(candidate);
  }
  return "";
}

// Resolves a @lid sender back to a phone-number identity using
// whatsapp-web.js's own contact resolution (Client.getContactById()), which
// internally maps a lid to contact.phoneNumber when WhatsApp exposes that
// link (see node_modules/whatsapp-web.js's injected getContactModel(): it
// substitutes contact.phoneNumber for the id whenever the wid is a lid and a
// phone number is available). If resolution fails, times out, or WhatsApp
// has no phone number linked for this contact, an empty string is returned
// and the raw lid is all that gets stored, so nothing downstream can mistake
// it for a real phone number.
async function resolveSenderPhone(rawSenderId) {
  if (!client || !isLidId(rawSenderId)) {
    return "";
  }
  try {
    const contact = await withTimeout(
      client.getContactById(rawSenderId),
      RESOLVE_CONTACT_TIMEOUT_MS,
      "getContactById()"
    );
    return extractResolvedPhone(contact);
  } catch (error) {
    logger.warn(
      { rawSenderId, error: error.message, stack: error.stack },
      "Unable to resolve @lid sender to a phone number"
    );
    return "";
  }
}

function appendInboundMessage(record) {
  const filePath = inboundMessagesFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

function listInboundMessages({ since = "", contact = "", limit = 200 } = {}) {
  const filePath = inboundMessagesFile();
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const sinceTime = since ? Date.parse(since) : 0;
  const normalizedContact = normalizeMessageContact(contact);
  const rows = fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean)
    .filter((row) => {
      const rowTime = Date.parse(row.receivedAt || "");
      const rowContact = normalizeMessageContact(row.contact || row.from || "");
      return (!sinceTime || rowTime >= sinceTime)
        && (!normalizedContact || rowContact === normalizedContact);
    });

  return rows.slice(Math.max(rows.length - Number(limit || 200), 0));
}

function allowedGroupName() {
  return (process.env.ALLOWED_GROUP_NAME || "Meridian Staff").trim();
}

function configuredGroupId() {
  const rawGroupId = (process.env.WHATSAPP_GROUP_ID || "").trim();
  if (!rawGroupId) {
    return "";
  }
  return rawGroupId.endsWith("@g.us") ? rawGroupId : `${rawGroupId}@g.us`;
}

function getStatus() {
  return whatsappStatus;
}

function getQrDataUrl() {
  return currentQrDataUrl;
}

function sessionPath() {
  return process.env.WHATSAPP_SESSION_PATH || "/var/data/whatsapp-session";
}

// Mirrors whatsapp-web.js's own LocalAuth path (dataPath + "session-" +
// clientId) so the lock cleanup always looks in exactly the directory
// Chromium will actually launch in.
function sessionUserDataDir() {
  return path.join(sessionPath(), `session-${WHATSAPP_CLIENT_ID}`);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    // Signal 0 sends nothing; it only checks whether the process exists and
    // is reachable by this user, without affecting it.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

// SingletonLock is a symlink whose target encodes "<hostname>-<pid>". If
// that pid is not a live process, the lock predates this run (the normal
// case after a crash, an OOM kill, or a container restart on this
// single-instance service - the persistent disk keeps the lock file, but the
// process that held it no longer exists in the new container) and is safe to
// clear. If the pid *is* alive, something may genuinely still hold the
// profile, so the lock is left in place rather than risk two Chromium
// instances on the same profile at once.
function removeStaleSingletonLocks(dirPath) {
  const lockPath = path.join(dirPath, "SingletonLock");
  let lockTarget = "";
  let hasLock = true;

  try {
    lockTarget = fs.readlinkSync(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      hasLock = false;
    }
    // Any other error (not a symlink, permissions, etc.) - can't confirm a
    // live owner, so fall through and treat the lock as stale. On this
    // service's single-instance, ephemeral-container deployment, a lock
    // that survives to this point was always left by a process that no
    // longer exists in the current container.
  }

  if (!hasLock) {
    return false;
  }

  const match = /-(\d+)$/.exec(lockTarget);
  const pid = match ? Number(match[1]) : NaN;
  if (lockTarget && isProcessAlive(pid)) {
    logger.warn({ lockTarget }, "Chromium SingletonLock appears to be held by a live process; leaving it in place");
    return false;
  }

  let removedAny = false;
  for (const fileName of STALE_LOCK_FILE_NAMES) {
    try {
      fs.rmSync(path.join(dirPath, fileName), { force: true });
      removedAny = true;
    } catch (error) {
      // Best-effort cleanup; a failure here just means Chromium's own launch
      // will fail again below with its usual error, which is no worse than
      // today's behavior.
    }
  }
  if (removedAny) {
    logger.info({ dirPath }, "Stale Chromium profile lock removed");
  }
  return removedAny;
}

function requireReadyClient() {
  if (!client || whatsappStatus !== STATUS.READY) {
    const error = new Error("WhatsApp is not ready.");
    error.statusCode = 503;
    throw error;
  }
  return client;
}

async function destroyExistingClient(reason) {
  if (!client) {
    return;
  }

  const existingClient = client;
  client = undefined;
  cachedGroupId = "";
  cachedGroupName = "";
  currentQrDataUrl = "";

  try {
    await existingClient.destroy();
    logger.info({ reason }, "Destroyed existing WhatsApp client");
  } catch (error) {
    logger.warn(
      { reason, error: error.message, stack: error.stack },
      "Unable to destroy existing WhatsApp client"
    );
  }
}

// Marks the client unhealthy from any code path (event handler or health
// check) so requireReadyClient() and /qr both see it immediately, instead of
// only reacting to whatsapp-web.js's own "disconnected" event, which is not
// reliably emitted on every real disconnect (silent/"ghost" connections).
function markDisconnected(reason) {
  if (whatsappStatus === STATUS.DISCONNECTED) {
    return;
  }
  whatsappStatus = STATUS.DISCONNECTED;
  cachedGroupId = "";
  cachedGroupName = "";
  currentQrDataUrl = "";
  initializing = false;
  stopHealthCheck();
  logger.warn({ reason }, "WhatsApp marked disconnected");
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// whatsapp-web.js can leave the client in a "ghost ready" state: the last
// event we saw was `ready`, but the underlying Puppeteer page/session is no
// longer actually connected, and no `disconnected` event ever fires to tell
// us. client.getState() talks to the live page, so it is used here as an
// active cross-check instead of only trusting cached event state.
async function runHealthCheck() {
  if (healthCheckRunning || !client || whatsappStatus !== STATUS.READY) {
    return;
  }
  healthCheckRunning = true;
  try {
    const state = await withTimeout(client.getState(), HEALTH_CHECK_TIMEOUT_MS, "getState()");
    if (state !== "CONNECTED") {
      logger.warn({ state }, "WhatsApp health check found non-CONNECTED state");
      markDisconnected(`health check state=${state}`);
      await destroyExistingClient("health check unhealthy state");
    }
  } catch (error) {
    logger.warn(
      { error: error.message, stack: error.stack },
      "WhatsApp health check failed; treating client as disconnected"
    );
    markDisconnected(`health check error: ${error.message}`);
    await destroyExistingClient("health check error");
  } finally {
    healthCheckRunning = false;
  }
}

function startHealthCheck() {
  stopHealthCheck();
  if (HEALTH_CHECK_INTERVAL_MS <= 0) {
    return;
  }
  healthCheckTimer = setInterval(() => {
    runHealthCheck().catch((error) => {
      logger.warn({ error: error.message, stack: error.stack }, "Unhandled health check error");
    });
  }, HEALTH_CHECK_INTERVAL_MS);
  if (typeof healthCheckTimer.unref === "function") {
    healthCheckTimer.unref();
  }
}

function stopHealthCheck() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

function createClient() {
  return new Client({
    authStrategy: new LocalAuth({
      clientId: WHATSAPP_CLIENT_ID,
      dataPath: sessionPath(),
    }),
    webVersionCache: {
      type: "remote",
      remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html",
      strict: false,
    },
    puppeteer: {
      headless: true,
      defaultViewport: {
        width: 800,
        height: 600,
      },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-client-side-phishing-detection",
        "--disable-default-apps",
        "--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints",
        "--disable-hang-monitor",
        "--disable-popup-blocking",
        "--disable-prompt-on-repost",
        "--disable-renderer-backgrounding",
        "--disable-sync",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-first-run",
        "--safebrowsing-disable-auto-update",
      ],
    },
  });
}

async function cacheGroupId() {
  if (!client || whatsappStatus !== STATUS.READY) {
    return "";
  }

  const configuredId = configuredGroupId();
  if (configuredId) {
    cachedGroupId = configuredId;
    cachedGroupName = allowedGroupName();
    logger.info({ group: cachedGroupName, groupId: cachedGroupId }, "Using configured WhatsApp group ID");
    return cachedGroupId;
  }

  const groupName = allowedGroupName();
  const chats = await listGroupChats();
  const normalizedGroupName = groupName.toLowerCase();
  const group = chats.find((chat) => (
    chat.isGroup === true
    && typeof chat.name === "string"
    && chat.name.trim().toLowerCase() === normalizedGroupName
  ));
  cachedGroupId = group ? group.id._serialized : "";
  cachedGroupName = cachedGroupId ? groupName : "";

  if (cachedGroupId) {
    logger.info({ group: groupName, groupId: cachedGroupId }, "WhatsApp group cached");
  } else {
    const groupNames = chats
      .filter((chat) => chat.isGroup === true && typeof chat.name === "string")
      .map((chat) => chat.name)
      .slice(0, 20);
    logger.warn({ group: groupName, groupCount: groupNames.length, groupNames }, "WhatsApp group not found");
  }

  return cachedGroupId;
}

async function listGroupChats() {
  try {
    const chats = await client.getChats();
    const groups = chats
      .filter((chat) => chat.isGroup === true && chat.id && chat.id._serialized)
      .map((chat) => ({
        id: {
          _serialized: chat.id._serialized,
        },
        isGroup: true,
        name: chat.name || "",
      }));

    if (groups.length > 0) {
      return groups;
    }
  } catch (error) {
    logger.warn(
      { error: error.message, stack: error.stack },
      "client.getChats() group listing failed"
    );
  }

  if (!client.pupPage) {
    return [];
  }

  return client.pupPage.evaluate(() => {
    const store = window.Store || {};
    const chatCollection = store.Chat;
    const rawChats = chatCollection && typeof chatCollection.getModelsArray === "function"
      ? chatCollection.getModelsArray()
      : [];

    return rawChats
      .filter((chat) => {
        const id = chat && chat.id;
        const serialized = id && (id._serialized || `${id.user || ""}@${id.server || ""}`);
        return serialized && serialized.endsWith("@g.us");
      })
      .map((chat) => {
        const id = chat.id || {};
        return {
          id: {
            _serialized: id._serialized || `${id.user || ""}@${id.server || ""}`,
          },
          isGroup: true,
          name: chat.name || chat.formattedTitle || chat.contact?.name || "",
        };
      })
      .filter((chat) => chat.id && chat.id._serialized);
  });
}

async function listGroups() {
  if (!client || whatsappStatus !== STATUS.READY) {
    const error = new Error("WhatsApp is not ready.");
    error.statusCode = 503;
    throw error;
  }

  const chats = await listGroupChats();
  return chats
    .map((chat) => ({
      id: chat.id._serialized,
      name: chat.name || "",
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function cacheGroupIdWithRetry({ attempts = 4, delayMs = 3000 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const groupId = await cacheGroupId();
      if (groupId) {
        return groupId;
      }
    } catch (error) {
      lastError = error;
      logger.warn(
        { attempt, attempts, error: error.message, stack: error.stack },
        "WhatsApp group cache attempt failed"
      );
    }

    if (attempt < attempts) {
      await wait(delayMs);
    }
  }

  if (lastError) {
    throw lastError;
  }

  return "";
}

async function findGroupId({ forceRefresh = false } = {}) {
  const configuredId = configuredGroupId();
  if (configuredId) {
    return configuredId;
  }

  if (cachedGroupId && cachedGroupName === allowedGroupName() && !forceRefresh) {
    return cachedGroupId;
  }
  return cacheGroupIdWithRetry();
}

async function initializeWhatsApp() {
  if (whatsappStatus === STATUS.READY) {
    if (!client) {
      logger.warn("WhatsApp status was ready without a client; reinitializing");
      whatsappStatus = STATUS.DISCONNECTED;
    } else {
      logger.info("WhatsApp client already ready; skipping initialization");
      return client;
    }
  }

  if (whatsappStatus === STATUS.DISCONNECTED && client) {
    await destroyExistingClient("reinitialize after disconnected status");
  }

  if (initializePromise) {
    logger.info("WhatsApp client initialization already in progress");
    return initializePromise;
  }

  initializePromise = initializeInternal();
  try {
    return await initializePromise;
  } finally {
    initializePromise = null;
  }
}

async function initializeInternal() {
  if (client || initializing) {
    logger.info({ status: whatsappStatus }, "WhatsApp client already created; skipping duplicate initialization");
    return client;
  }

  initializing = true;
  whatsappStatus = STATUS.STARTING;
  logger.info("WhatsApp client initialization started");
  client = createClient();

  client.on("qr", async (qr) => {
    whatsappStatus = STATUS.QR_REQUIRED;
    currentQrDataUrl = await qrcode.toDataURL(qr);
    logger.info("WhatsApp QR received");
  });

  client.on("authenticated", () => {
    // whatsapp-web.js is known to fire authenticated/ready more than once
    // during initial sync; only act (and log) on the first occurrence so
    // duplicate events don't spam logs or reset already-good state.
    if (whatsappStatus === STATUS.AUTHENTICATED || whatsappStatus === STATUS.READY) {
      return;
    }
    whatsappStatus = STATUS.AUTHENTICATED;
    currentQrDataUrl = "";
    logger.info("WhatsApp authenticated");
  });

  client.on("auth_failure", (message) => {
    whatsappStatus = STATUS.QR_REQUIRED;
    cachedGroupId = "";
    cachedGroupName = "";
    stopHealthCheck();
    logger.error({ message }, "WhatsApp auth_failure");
  });

  client.on("ready", async () => {
    if (whatsappStatus === STATUS.READY) {
      return;
    }
    whatsappStatus = STATUS.READY;
    currentQrDataUrl = "";
    logger.info("WhatsApp client ready");
    startHealthCheck();
  });

  // change_state reflects whatsapp-web.js's own internal WAState (from the
  // live page), which can diverge from our event-driven whatsappStatus.
  // Bad states (conflict/unpaired/blocked) are treated as an immediate
  // disconnect instead of waiting for the next health-check tick or for a
  // `disconnected` event that may never come.
  client.on("change_state", (state) => {
    logger.info({ state }, "WhatsApp state changed");
    if (UNHEALTHY_WA_STATES.has(state)) {
      markDisconnected(`change_state=${state}`);
      destroyExistingClient(`change_state=${state}`).catch((error) => {
        logger.warn({ error: error.message }, "Unable to destroy client after bad change_state");
      });
    }
  });

  client.on("message", async (message) => {
    try {
      if (!message || message.fromMe) {
        return;
      }
      const from = String(message.from || "");
      const author = String(message.author || "");
      const body = String(message.body || "").trim();
      if (!body) {
        return;
      }
      const rawSenderId = author || from;
      const lid = isLidId(rawSenderId) ? normalizeMessageContact(rawSenderId) : "";
      const resolvedPhone = lid ? await resolveSenderPhone(rawSenderId) : "";
      // "contact" keeps its historical meaning (the identity every existing
      // consumer reads first) but now prefers a positively resolved phone
      // number over raw @lid digits, which were never a phone number to
      // begin with - falls back to the previous raw-digits behavior only
      // when resolution isn't possible, so nothing regresses for senders
      // that were never lid-based.
      const contact = resolvedPhone || normalizeMessageContact(rawSenderId);
      const record = {
        id: message.id && message.id._serialized ? message.id._serialized : "",
        from,
        author,
        senderId: rawSenderId,
        lid,
        resolvedPhone,
        contact,
        body,
        type: message.type || "",
        receivedAt: new Date(Number(message.timestamp || 0) * 1000 || Date.now()).toISOString(),
      };
      appendInboundMessage(record);
      logger.info(
        { contact, lid: lid || undefined, resolvedPhone: resolvedPhone || undefined, preview: body.slice(0, 120) },
        "WhatsApp inbound message saved"
      );
    } catch (error) {
      logger.warn(
        { error: error.message, stack: error.stack },
        "Unable to save WhatsApp inbound message"
      );
    }
  });

  client.on("disconnected", (reason) => {
    markDisconnected(`disconnected event: ${reason}`);
    client = undefined;
  });

  client.on("loading_screen", (percent, message) => {
    logger.info({ percent, message }, "WhatsApp loading");
  });

  const dirPath = sessionUserDataDir();
  try {
    if (removeStaleSingletonLocks(dirPath)) {
      logger.info({ dirPath }, "Cleared stale Chromium profile lock before launch");
    }
  } catch (error) {
    logger.warn(
      { error: error.message, stack: error.stack, dirPath },
      "Unable to check/clear Chromium profile lock; continuing with launch attempt"
    );
  }

  const failedClient = client;
  try {
    logger.info("Calling whatsapp-web.js client.initialize()");
    await client.initialize();
    logger.info({ status: whatsappStatus }, "whatsapp-web.js client.initialize() returned");
    return client;
  } catch (error) {
    logger.error(
      { error: error.message, stack: error.stack },
      "WhatsApp initialization failed"
    );
    whatsappStatus = STATUS.DISCONNECTED;
    client = undefined;
    cachedGroupId = "";
    cachedGroupName = "";
    currentQrDataUrl = "";
    stopHealthCheck();

    // A partially-launched browser (Chromium started, then the page/session
    // setup failed) can otherwise be left running as an orphan holding the
    // profile lock, which would make every subsequent attempt fail the same
    // way even after this one gives up. destroy() is safe to call here: it
    // only closes the browser process if one is connected and never touches
    // the saved LocalAuth session data (that's a separate, never-called-here
    // logout() method).
    try {
      await failedClient.destroy();
    } catch (destroyError) {
      logger.warn(
        { error: destroyError.message, stack: destroyError.stack },
        "Unable to clean up browser process after failed initialization"
      );
    }

    throw error;
  } finally {
    initializing = false;
  }
}

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleRetry() {
  if (retryTimer) {
    // A retry is already pending; let it run rather than stacking another
    // one on top (this is what keeps a burst of failures from turning into
    // overlapping retry loops).
    return;
  }
  const delayMs = retryDelayMs;
  logger.warn({ delayMs }, "WhatsApp initialization retry scheduled");
  retryTimer = setTimeout(() => {
    retryTimer = null;
    initializeWithRetry();
  }, delayMs);
  if (typeof retryTimer.unref === "function") {
    retryTimer.unref();
  }
  retryDelayMs = Math.min(retryDelayMs * 2, INIT_MAX_RETRY_DELAY_MS);
}

// Used for the initial startup attempt so a launch failure (e.g. a transient
// Chromium/profile problem) doesn't just get logged once and left for a
// human to notice and fix via the /qr page. Backs off exponentially between
// attempts (capped) instead of hammering Chromium immediately again. Manual
// reinitialization via /qr still goes through initializeWhatsApp() directly
// and is unaffected by this loop.
async function initializeWithRetry() {
  clearRetryTimer();
  try {
    await initializeWhatsApp();
    retryDelayMs = INIT_RETRY_DELAY_MS;
  } catch (error) {
    scheduleRetry();
  }
}

function buildImageMedia(imageBase64, imageFilename = "staff-schedule.png") {
  const data = String(imageBase64 || "").trim();
  if (!data) {
    return null;
  }
  const cleanData = data.includes(",") ? data.split(",").pop() : data;
  return new MessageMedia("image/png", cleanData, imageFilename || "staff-schedule.png");
}

async function sendGroupMessage({ group, message, imageBase64, imageFilename }) {
  const readyClient = requireReadyClient();

  const allowed = allowedGroupName();
  if (group !== allowed) {
    const error = new Error("Unauthorized group name.");
    error.statusCode = 400;
    throw error;
  }

  let groupId = await findGroupId();
  if (!groupId) {
    const error = new Error("WhatsApp group not found.");
    error.statusCode = 404;
    throw error;
  }

  try {
    const media = buildImageMedia(imageBase64, imageFilename);
    const sentMessage = media
      ? await readyClient.sendMessage(groupId, media, { caption: message })
      : await readyClient.sendMessage(groupId, message);
    const messageId = sentMessage && sentMessage.id ? sentMessage.id._serialized : "";
    logger.info({ group, groupId, messageId }, "WhatsApp group message sent");
    return {
      messageId,
      sentAt: new Date().toISOString(),
    };
  } catch (firstError) {
    logger.warn({ error: firstError.message, stack: firstError.stack, group }, "Send failed; refreshing group cache");
    groupId = await findGroupId({ forceRefresh: true });
    if (!groupId) {
      const error = new Error("WhatsApp group not found.");
      error.statusCode = 404;
      throw error;
    }

    const media = buildImageMedia(imageBase64, imageFilename);
    const sentMessage = media
      ? await readyClient.sendMessage(groupId, media, { caption: message })
      : await readyClient.sendMessage(groupId, message);
    const messageId = sentMessage && sentMessage.id ? sentMessage.id._serialized : "";
    logger.info({ group, groupId, messageId }, "WhatsApp group message sent after cache refresh");
    return {
      messageId,
      sentAt: new Date().toISOString(),
    };
  }
}

function normalizeContactTarget(contact) {
  const value = String(contact || "").trim();
  if (!value) {
    return "";
  }
  if (value.endsWith("@c.us") || value.endsWith("@g.us") || value.endsWith("@lid")) {
    return value;
  }
  const digits = value.replace(/[^\d]/g, "");
  if (!digits) {
    return "";
  }
  return digits;
}

// Deliberately resolves to AT MOST ONE contact id. This used to also
// resolve a @lid candidate via getNumberId() and try it as a fallback if
// the phone-based (@c.us) send looked like it failed - but every candidate
// is a REAL client.sendMessage() call, and "looked like it failed" is not
// reliable (WhatsApp's own false-negative behavior is the whole reason the
// old retry/fallback logic existed). Confirmed in production on
// 2026-08-19: one "Send to Jawa" click resolved two candidates
// (@c.us and @lid), both reported "no chat created", and Jawa received the
// message twice anyway - both sends had actually gone through. One click
// must never be able to produce more than one real send, so there is only
// ever one candidate now. @c.us (phone-number-based) is what
// whatsapp-web.js requires to *create* a brand-new chat, so it is the one
// used here.
async function resolveContactIds(contact) {
  const normalized = normalizeContactTarget(contact);
  if (!normalized) {
    return [];
  }
  if (normalized.endsWith("@c.us") || normalized.endsWith("@g.us") || normalized.endsWith("@lid")) {
    return [normalized];
  }
  return [`${normalized}@c.us`];
}

function messageSerializedId(message) {
  return message && message.id && message.id._serialized ? message.id._serialized : "";
}

// The raw WhatsApp message id (a string like "3EB0...") is assigned
// independent of the chat/remote key, so it stays reliable even for @lid
// contacts where _serialized construction is broken in this library
// version.
function rawMessageId(message) {
  return message && message.id ? String(message.id.id || "") : "";
}

const MESSAGE_ACK = {
  ERROR: -1,
  PENDING: 0,
  SERVER: 1,
};

// Chat-history verification (getChatById) is broken for @lid contacts, and
// "sendMessage() didn't throw" turned out to be an unreliable signal too -
// it can resolve even when WhatsApp never actually delivers the message.
// message_ack is WhatsApp's own delivery signal: ACK_SERVER (1) or higher
// means the server actually accepted the message, which is the only signal
// here we can trust as real confirmation. No ack (or ACK_ERROR) means the
// send did not go through, regardless of what sendMessage() resolved with.
function waitForMessageAck(rawId, timeoutMs) {
  return new Promise((resolve) => {
    if (!client || typeof client.on !== "function" || !rawId) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (typeof client.off === "function") {
        client.off("message_ack", handler);
      }
      clearTimeout(timer);
      resolve(result);
    };
    const handler = (message, ack) => {
      if (rawMessageId(message) !== rawId) {
        return;
      }
      if (ack === MESSAGE_ACK.ERROR) {
        finish(false);
        return;
      }
      if (ack >= MESSAGE_ACK.SERVER) {
        finish(true);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    client.on("message_ack", handler);
  });
}

async function sendContactMessage({ contact, message, imageBase64, imageFilename }) {
  const readyClient = requireReadyClient();

  const contactIds = await resolveContactIds(contact);
  if (!contactIds.length) {
    const error = new Error("WhatsApp contact not found.");
    error.statusCode = 404;
    throw error;
  }
  const contactId = contactIds[0];

  // Exactly one client.sendMessage() call - no retry, no second candidate
  // id. Every attempt here is a real WhatsApp send; retrying it and/or
  // trying a second candidate id is exactly what caused one "Send to Jawa"
  // click to produce 4 real sends on 2026-08-18 and 2 on 2026-08-19 (the
  // gateway's own false-negative behavior - reporting failure even when
  // the send actually went through - means every extra attempt is a real
  // risk of an extra real delivery, not a safe retry of a truly-failed
  // send). getChatById()-based chat-history verification has also proven
  // unreliable in production, and sendMessage() not throwing is NOT
  // reliable evidence of delivery either. message_ack is WhatsApp's own
  // delivery signal; only that (ACK_SERVER or higher) counts as real
  // confirmation.
  const media = buildImageMedia(imageBase64, imageFilename);
  const sentMessage = media
    ? await readyClient.sendMessage(contactId, media, { caption: message })
    : await readyClient.sendMessage(contactId, message);

  const directMessageId = messageSerializedId(sentMessage);
  if (directMessageId) {
    logger.info({ contact, contactId, messageId: directMessageId }, "WhatsApp contact message sent");
    return {
      messageId: directMessageId,
      contactId,
      sentAt: new Date().toISOString(),
    };
  }

  const rawId = rawMessageId(sentMessage);
  if (!rawId) {
    // sendMessage() returned nothing usable at all - internally this means
    // WhatsApp's own findOrCreateLatestChat() could not resolve/create a
    // chat for this id. This is genuinely uncertain, not a confirmed
    // failure - the message may still have reached the recipient
    // (confirmed to happen in production). Callers must not record this as
    // a plain send failure; error.state distinguishes it so they can
    // record a distinct "attempted but unconfirmed" status instead. There
    // is no retry and no second candidate id here - see the comment above.
    logger.error({ contact, contactId, reason: "no chat/message created" }, "WhatsApp contact send unconfirmed - no message object created");
    const error = new Error("WhatsApp could not positively confirm the contact message send.");
    error.statusCode = 502;
    error.state = SEND_ATTEMPTED_UNCONFIRMED;
    throw error;
  }

  const ackTimeoutMs = Number(process.env.WHATSAPP_LID_ACK_TIMEOUT_MS || 20000);
  const acknowledged = await waitForMessageAck(rawId, ackTimeoutMs);
  if (acknowledged) {
    logger.info({ contact, contactId, messageId: rawId }, "WhatsApp contact message sent and acknowledged by server");
    return {
      messageId: rawId,
      contactId,
      sentAt: new Date().toISOString(),
    };
  }

  logger.warn(
    { contact, contactId, rawId },
    "No message_ack received within timeout; a message was dispatched but unconfirmed"
  );
  const error = new Error("WhatsApp could not positively confirm the contact message send.");
  error.statusCode = 502;
  error.state = SEND_ATTEMPTED_UNCONFIRMED;
  throw error;
}

module.exports = {
  initialize: initializeWhatsApp,
  initializeWhatsApp,
  initializeWithRetry,
  getStatus,
  getQrDataUrl,
  listGroups,
  listInboundMessages,
  appendInboundMessage,
  sendGroupMessage,
  sendContactMessage,
  _STATUS: STATUS,
  SEND_ATTEMPTED_UNCONFIRMED,
  // Exposed for unit testing only - pure filesystem/process helpers with no
  // dependency on the module's internal WhatsApp client state.
  _internal: {
    isProcessAlive,
    removeStaleSingletonLocks,
    sessionUserDataDir,
    isLidId,
    resolveSenderPhone,
    extractResolvedPhone,
    normalizeMessageContact,
    resolveContactIds,
    // Test-only hook so sendContactMessage()'s real send logic (including
    // the "exactly one client.sendMessage() call" guarantee) can be
    // exercised against a fake client, without needing a real WhatsApp
    // session. Never called outside tests.
    __setTestClient(fakeClient, status) {
      client = fakeClient;
      whatsappStatus = status || STATUS.READY;
    },
  },
};
