const express = require("express");

const logger = require("../utils/logger");

function normalizeContact(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function createCloudWebhookRouter({ appendInboundMessage }) {
  const router = express.Router();

  // Meta calls this once, at setup time, to prove we control the endpoint.
  router.get("/cloud-webhook", (req, res) => {
    const expectedToken = process.env.WHATSAPP_CLOUD_API_VERIFY_TOKEN || "";
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && expectedToken && token === expectedToken) {
      logger.info("Cloud API webhook verified");
      return res.status(200).send(challenge);
    }

    logger.warn({ mode, tokenMatched: token === expectedToken }, "Cloud API webhook verification failed");
    return res.sendStatus(403);
  });

  // Meta calls this for every inbound message and delivery/read status
  // update. Reuses the same inbound-message store as the whatsapp-web.js
  // gateway so dashboard.py's existing /inbound-messages polling picks up
  // Cloud API replies without any changes on that side.
  router.post("/cloud-webhook", (req, res) => {
    try {
      const entries = req.body?.entry || [];
      for (const entry of entries) {
        const changes = entry?.changes || [];
        for (const change of changes) {
          const value = change?.value || {};

          for (const message of value.messages || []) {
            if (!message || message.type === undefined) {
              continue;
            }
            const body = String(
              message.text?.body
              || message.button?.text
              || message.interactive?.button_reply?.title
              || message.interactive?.list_reply?.title
              || ""
            ).trim();
            if (!body) {
              continue;
            }
            const record = {
              id: message.id || "",
              from: message.from || "",
              author: message.from || "",
              contact: normalizeContact(message.from),
              body,
              type: message.type || "",
              receivedAt: new Date(Number(message.timestamp || 0) * 1000 || Date.now()).toISOString(),
              source: "cloud_api",
            };
            appendInboundMessage(record);
            logger.info({ contact: record.contact, preview: body.slice(0, 120) }, "Cloud API inbound message saved");
          }

          for (const status of value.statuses || []) {
            logger.info(
              { messageId: status.id, status: status.status, recipient: status.recipient_id },
              "Cloud API message status update"
            );
          }
        }
      }
    } catch (error) {
      logger.warn({ error: error.message, stack: error.stack }, "Unable to process Cloud API webhook payload");
    }

    // Meta requires a fast 200 response regardless of processing outcome,
    // or it will retry (and eventually disable) the webhook.
    return res.sendStatus(200);
  });

  return router;
}

module.exports = { createCloudWebhookRouter };
