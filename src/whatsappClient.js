const qrcode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");

const logger = require("./utils/logger");

const STATUS = {
  STARTING: "starting",
  QR_REQUIRED: "qr_required",
  AUTHENTICATED: "authenticated",
  READY: "ready",
  DISCONNECTED: "disconnected",
};

let client;
let whatsappStatus = STATUS.STARTING;
let currentQrDataUrl = "";
let cachedGroupId = "";
let initializing = false;
let initializePromise = null;

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function allowedGroupName() {
  return (process.env.ALLOWED_GROUP_NAME || "Meridian Staff").trim();
}

function getStatus() {
  return whatsappStatus;
}

function getQrDataUrl() {
  return currentQrDataUrl;
}

function createClient() {
  const sessionPath = process.env.WHATSAPP_SESSION_PATH || "/var/data/whatsapp-session";

  return new Client({
    authStrategy: new LocalAuth({
      clientId: "meridian-staff",
      dataPath: sessionPath,
    }),
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

  const groupName = allowedGroupName();
  const chats = await client.getChats();
  const group = chats.find((chat) => chat.isGroup === true && chat.name === groupName);
  cachedGroupId = group ? group.id._serialized : "";

  if (cachedGroupId) {
    logger.info({ group: groupName }, "WhatsApp group cached");
  } else {
    logger.warn({ group: groupName }, "WhatsApp group not found");
  }

  return cachedGroupId;
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
  if (cachedGroupId && !forceRefresh) {
    return cachedGroupId;
  }
  return cacheGroupIdWithRetry();
}

async function initializeWhatsApp() {
  if (whatsappStatus === STATUS.READY) {
    logger.info("WhatsApp client already ready; skipping initialization");
    return client;
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
    whatsappStatus = STATUS.AUTHENTICATED;
    currentQrDataUrl = "";
    logger.info("WhatsApp authenticated");
  });

  client.on("auth_failure", (message) => {
    whatsappStatus = STATUS.QR_REQUIRED;
    cachedGroupId = "";
    logger.error({ message }, "WhatsApp auth_failure");
  });

  client.on("ready", async () => {
    whatsappStatus = STATUS.READY;
    currentQrDataUrl = "";
    logger.info("WhatsApp client ready");
    try {
      await cacheGroupIdWithRetry();
    } catch (error) {
      logger.error({ error: error.message, stack: error.stack }, "Unable to cache WhatsApp group");
    }
  });

  client.on("disconnected", (reason) => {
    whatsappStatus = STATUS.DISCONNECTED;
    cachedGroupId = "";
    logger.warn({ reason }, "WhatsApp disconnected");
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
    currentQrDataUrl = "";
    throw error;
  } finally {
    initializing = false;
  }
}

async function sendGroupMessage({ group, message }) {
  if (whatsappStatus !== STATUS.READY) {
    const error = new Error("WhatsApp is not ready.");
    error.statusCode = 503;
    throw error;
  }

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
    const sentMessage = await client.sendMessage(groupId, message);
    return {
      messageId: sentMessage && sentMessage.id ? sentMessage.id._serialized : "",
      sentAt: new Date().toISOString(),
    };
  } catch (firstError) {
    logger.warn({ error: firstError.message, group }, "Send failed; refreshing group cache");
    groupId = await findGroupId({ forceRefresh: true });
    if (!groupId) {
      const error = new Error("WhatsApp group not found.");
      error.statusCode = 404;
      throw error;
    }

    const sentMessage = await client.sendMessage(groupId, message);
    return {
      messageId: sentMessage && sentMessage.id ? sentMessage.id._serialized : "",
      sentAt: new Date().toISOString(),
    };
  }
}

module.exports = {
  initialize: initializeWhatsApp,
  initializeWhatsApp,
  getStatus,
  getQrDataUrl,
  sendGroupMessage,
  _STATUS: STATUS,
};
