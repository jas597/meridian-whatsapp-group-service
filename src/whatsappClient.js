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
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
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

async function findGroupId({ forceRefresh = false } = {}) {
  if (cachedGroupId && !forceRefresh) {
    return cachedGroupId;
  }
  return cacheGroupId();
}

async function initialize() {
  if (client || initializing) {
    return;
  }

  initializing = true;
  whatsappStatus = STATUS.STARTING;
  client = createClient();

  client.on("qr", async (qr) => {
    whatsappStatus = STATUS.QR_REQUIRED;
    currentQrDataUrl = await qrcode.toDataURL(qr);
    logger.info("WhatsApp QR code generated");
  });

  client.on("authenticated", () => {
    whatsappStatus = STATUS.AUTHENTICATED;
    currentQrDataUrl = "";
    logger.info("WhatsApp authenticated");
  });

  client.on("auth_failure", (message) => {
    whatsappStatus = STATUS.QR_REQUIRED;
    cachedGroupId = "";
    logger.error({ message }, "WhatsApp authentication failure");
  });

  client.on("ready", async () => {
    whatsappStatus = STATUS.READY;
    currentQrDataUrl = "";
    logger.info("WhatsApp client ready");
    try {
      await cacheGroupId();
    } catch (error) {
      logger.error({ error: error.message }, "Unable to cache WhatsApp group");
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
    await client.initialize();
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
  initialize,
  getStatus,
  getQrDataUrl,
  sendGroupMessage,
  _STATUS: STATUS,
};
