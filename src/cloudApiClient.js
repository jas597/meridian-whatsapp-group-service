const logger = require("./utils/logger");

const GRAPH_API_VERSION = process.env.WHATSAPP_CLOUD_API_VERSION || "v21.0";

function graphApiUrl(phoneNumberId, endpoint) {
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/${endpoint}`;
}

function accessToken() {
  return process.env.WHATSAPP_CLOUD_API_TOKEN || "";
}

function normalizeRecipient(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

async function callGraphApi(phoneNumberId, body) {
  const token = accessToken();
  if (!token) {
    const error = new Error("WHATSAPP_CLOUD_API_TOKEN is not configured.");
    error.statusCode = 500;
    throw error;
  }
  if (!phoneNumberId) {
    const error = new Error("phoneNumberId is required.");
    error.statusCode = 400;
    throw error;
  }

  const url = graphApiUrl(phoneNumberId, "messages");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMessage = responseBody?.error?.message || `Graph API returned HTTP ${response.status}.`;
    logger.error({ phoneNumberId, status: response.status, responseBody }, "Cloud API send failed");
    const error = new Error(errorMessage);
    error.statusCode = response.status;
    error.graphError = responseBody?.error;
    throw error;
  }

  const messageId = responseBody?.messages?.[0]?.id || "";
  logger.info({ phoneNumberId, to: body.to, messageId }, "Cloud API message sent");
  return { messageId, raw: responseBody };
}

// Business-initiated messages outside an active 24h customer service session
// require a pre-approved template. Use this to open/re-open a conversation.
async function sendTemplateMessage({ phoneNumberId, to, templateName, languageCode = "en_US", components = [] }) {
  const recipient = normalizeRecipient(to);
  if (!recipient) {
    const error = new Error("A valid recipient phone number is required.");
    error.statusCode = 400;
    throw error;
  }
  if (!templateName) {
    const error = new Error("templateName is required.");
    error.statusCode = 400;
    throw error;
  }

  return callGraphApi(phoneNumberId, {
    messaging_product: "whatsapp",
    to: recipient,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      components,
    },
  });
}

// Free-form text. Only deliverable within 24h of the recipient's last
// message to us (an active "customer service" session) - otherwise Meta
// rejects it and a template must be used instead.
async function sendTextMessage({ phoneNumberId, to, text }) {
  const recipient = normalizeRecipient(to);
  if (!recipient) {
    const error = new Error("A valid recipient phone number is required.");
    error.statusCode = 400;
    throw error;
  }
  const body = String(text || "").trim();
  if (!body) {
    const error = new Error("text is required.");
    error.statusCode = 400;
    throw error;
  }

  return callGraphApi(phoneNumberId, {
    messaging_product: "whatsapp",
    to: recipient,
    type: "text",
    text: { body, preview_url: false },
  });
}

async function sendImageMessage({ phoneNumberId, to, imageBase64, caption = "" }) {
  const recipient = normalizeRecipient(to);
  if (!recipient) {
    const error = new Error("A valid recipient phone number is required.");
    error.statusCode = 400;
    throw error;
  }
  const cleanData = String(imageBase64 || "").includes(",")
    ? imageBase64.split(",").pop()
    : imageBase64;
  if (!cleanData) {
    const error = new Error("imageBase64 is required.");
    error.statusCode = 400;
    throw error;
  }

  // Cloud API requires media to be uploaded first to get a media id, rather
  // than accepting inline base64 on the message send call itself.
  const token = accessToken();
  const uploadUrl = graphApiUrl(phoneNumberId, "media");
  const form = new FormData();
  const buffer = Buffer.from(cleanData, "base64");
  form.append("file", new Blob([buffer], { type: "image/png" }), "schedule.png");
  form.append("messaging_product", "whatsapp");
  form.append("type", "image/png");

  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const uploadBody = await uploadResponse.json().catch(() => ({}));
  if (!uploadResponse.ok || !uploadBody.id) {
    const errorMessage = uploadBody?.error?.message || `Media upload returned HTTP ${uploadResponse.status}.`;
    logger.error({ phoneNumberId, status: uploadResponse.status, uploadBody }, "Cloud API media upload failed");
    const error = new Error(errorMessage);
    error.statusCode = uploadResponse.status;
    throw error;
  }

  return callGraphApi(phoneNumberId, {
    messaging_product: "whatsapp",
    to: recipient,
    type: "image",
    image: { id: uploadBody.id, caption },
  });
}

module.exports = {
  sendTemplateMessage,
  sendTextMessage,
  sendImageMessage,
};
