const express = require("express");
const rateLimit = require("express-rate-limit");

const { requireBearerSecret } = require("../middleware/auth");
const logger = require("../utils/logger");

function resolvePhoneNumberId(body) {
  const explicit = String(body.phoneNumberId || "").trim();
  if (explicit) {
    return explicit;
  }
  const from = String(body.from || "").trim().toLowerCase();
  if (from === "kim") {
    return process.env.WHATSAPP_CLOUD_API_KIM_PHONE_NUMBER_ID || "";
  }
  return process.env.WHATSAPP_CLOUD_API_PHONE_NUMBER_ID || "";
}

function createCloudMessageRouter({ cloudApiClient }) {
  const router = express.Router();

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 40,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.post("/cloud/send-template", limiter, requireBearerSecret, async (req, res) => {
    const body = req.body || {};
    const phoneNumberId = resolvePhoneNumberId(body);
    try {
      const result = await cloudApiClient.sendTemplateMessage({
        phoneNumberId,
        to: body.to,
        templateName: body.templateName,
        languageCode: body.languageCode,
        components: body.components,
      });
      return res.status(200).json({ success: true, messageId: result.messageId });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      logger.warn({ error: error.message, to: body.to }, "Cloud API template send failed");
      return res.status(statusCode).json({ success: false, error: error.message });
    }
  });

  router.post("/cloud/send-text", limiter, requireBearerSecret, async (req, res) => {
    const body = req.body || {};
    const phoneNumberId = resolvePhoneNumberId(body);
    try {
      const result = await cloudApiClient.sendTextMessage({
        phoneNumberId,
        to: body.to,
        text: body.message,
      });
      return res.status(200).json({ success: true, messageId: result.messageId });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      logger.warn({ error: error.message, to: body.to }, "Cloud API text send failed");
      return res.status(statusCode).json({ success: false, error: error.message });
    }
  });

  router.post("/cloud/send-image", limiter, requireBearerSecret, async (req, res) => {
    const body = req.body || {};
    const phoneNumberId = resolvePhoneNumberId(body);
    try {
      const result = await cloudApiClient.sendImageMessage({
        phoneNumberId,
        to: body.to,
        imageBase64: body.imageBase64,
        caption: body.caption,
      });
      return res.status(200).json({ success: true, messageId: result.messageId });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      logger.warn({ error: error.message, to: body.to }, "Cloud API image send failed");
      return res.status(statusCode).json({ success: false, error: error.message });
    }
  });

  return router;
}

module.exports = { createCloudMessageRouter };
