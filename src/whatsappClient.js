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

let client;
let whatsappStatus = STATUS.STARTING;
let currentQrDataUrl = "";
let cachedGroupId = "";
let cachedGroupName = "";
let initializing = false;
let initializePromise = null;
let healthCheckTimer = null;
let healthCheckRunning = false;

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
  const sessionPath = process.env.WHATSAPP_SESSION_PATH || "/var/data/whatsapp-session";

  return new Client({
    authStrategy: new LocalAuth({
      clientId: "meridian-staff",
      dataPath: sessionPath,
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
      const contact = normalizeMessageContact(author || from);
      const record = {
        id: message.id && message.id._serialized ? message.id._serialized : "",
        from,
        author,
        contact,
        body,
        type: message.type || "",
        receivedAt: new Date(Number(message.timestamp || 0) * 1000 || Date.now()).toISOString(),
      };
      appendInboundMessage(record);
      logger.info({ contact, preview: body.slice(0, 120) }, "WhatsApp inbound message saved");
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

  try {
    logger.info("Calling whatsapp-web.js client.initialize()");
    await client.initialize();
    logger.info({ status: whatsappStatus }, "whatsapp-web.js client.initialize() returned");
    return client;
  } catch (error) {
    logger.error(
      { error: error.message, stack: error.stack },
      "WhatsApp initialization error"
    );
    whatsappStatus = STATUS.DISCONNECTED;
    client = undefined;
    cachedGroupId = "";
    cachedGroupName = "";
    currentQrDataUrl = "";
    stopHealthCheck();
    throw error;
  } finally {
    initializing = false;
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

function resolveContactIds(contact) {
  const normalized = normalizeContactTarget(contact);
  if (!normalized) {
    return [];
  }
  if (normalized.endsWith("@c.us") || normalized.endsWith("@g.us") || normalized.endsWith("@lid")) {
    return [normalized];
  }
  const phoneChatId = `${normalized}@c.us`;
  logger.info({ contact, phoneChatId }, "Using phone chat id for WhatsApp contact");
  return [phoneChatId];
}

function messageSerializedId(message) {
  return message && message.id && message.id._serialized ? message.id._serialized : "";
}

async function verifyRecentContactMessage({ contact, contactId, message, attemptStartedAtMs }) {
  if (!client || typeof client.getChatById !== "function") {
    return "";
  }
  const verifyDelayMs = Number(process.env.WHATSAPP_CONTACT_VERIFY_DELAY_MS || 2500);
  if (verifyDelayMs > 0) {
    await wait(Math.min(10000, verifyDelayMs));
  }
  try {
    const chat = await client.getChatById(contactId);
    if (!chat || typeof chat.fetchMessages !== "function") {
      return "";
    }
    const recentMessages = await chat.fetchMessages({ limit: 12 });
    const expectedBody = String(message || "").trim();
    for (const recentMessage of recentMessages.slice().reverse()) {
      if (!recentMessage || !recentMessage.fromMe) {
        continue;
      }
      const timestampMs = Number(recentMessage.timestamp || 0) * 1000;
      if (timestampMs && timestampMs < attemptStartedAtMs - 10000) {
        continue;
      }
      const recentBody = String(recentMessage.body || recentMessage.caption || "").trim();
      if (expectedBody && recentBody !== expectedBody) {
        continue;
      }
      const messageId = messageSerializedId(recentMessage);
      if (messageId) {
        logger.info({ contact, contactId, messageId }, "Verified WhatsApp contact message in chat history");
        return messageId;
      }
    }
  } catch (error) {
    logger.warn(
      { contact, contactId, error: error.message, stack: error.stack },
      "Unable to verify WhatsApp contact message in chat history"
    );
  }
  return "";
}

async function sendContactMessage({ contact, message, imageBase64, imageFilename }) {
  const readyClient = requireReadyClient();

  const contactIds = resolveContactIds(contact);
  if (!contactIds.length) {
    const error = new Error("WhatsApp contact not found.");
    error.statusCode = 404;
    throw error;
  }

  const media = buildImageMedia(imageBase64, imageFilename);
  const attempts = [];
  for (const contactId of contactIds) {
    const attemptStartedAtMs = Date.now();
    const sentMessage = media
      ? await readyClient.sendMessage(contactId, media, { caption: message })
      : await readyClient.sendMessage(contactId, message);
    const directMessageId = messageSerializedId(sentMessage);
    const verifiedMessageId = directMessageId || await verifyRecentContactMessage({
      contact,
      contactId,
      message,
      attemptStartedAtMs,
    });
    attempts.push({ contactId, directMessageId, verifiedMessageId });
    const messageId = directMessageId || verifiedMessageId;
    if (messageId) {
      logger.info({ contact, contactId, messageId }, "WhatsApp contact message sent");
      return {
        messageId,
        contactId,
        sentAt: new Date().toISOString(),
      };
    }
    logger.warn({ contact, contactId, sentMessage }, "WhatsApp contact send returned no message id; trying next contact id");
  }
  const error = new Error("WhatsApp did not confirm the contact message send.");
  error.statusCode = 502;
  logger.error({ contact, attempts }, "WhatsApp contact send failed for all contact ids");
  throw error;
}

module.exports = {
  initialize: initializeWhatsApp,
  initializeWhatsApp,
  getStatus,
  getQrDataUrl,
  listGroups,
  listInboundMessages,
  sendGroupMessage,
  sendContactMessage,
  _STATUS: STATUS,
};
