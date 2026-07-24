const express = require("express");
const rateLimit = require("express-rate-limit");

const { requireBearerSecret } = require("../middleware/auth");
const logger = require("../utils/logger");

const idempotencyCache = new Map();
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

function cleanIdempotencyCache(now = Date.now()) {
  for (const [key, value] of idempotencyCache.entries()) {
    if (now - value.createdAt > IDEMPOTENCY_TTL_MS) {
      idempotencyCache.delete(key);
    }
  }
}

function validatePayload(body) {
  const group = typeof body.group === "string" ? body.group.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const allowedGroupName = (process.env.ALLOWED_GROUP_NAME || "Meridian Staff").trim();

  if (!group || !message) {
    return { error: "group and message are required." };
  }

  if (message.length > 10000) {
    return { error: "message must be 10,000 characters or less." };
  }

  if (group !== allowedGroupName) {
    return { error: "Unauthorized group name." };
  }

  return { group, message };
}

function createMessageRouter({ whatsappClient }) {
  const router = express.Router();

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.post("/send-group-message", limiter, requireBearerSecret, async (req, res, next) => {
    cleanIdempotencyCache();

    const validation = validatePayload(req.body || {});
    if (validation.error) {
      return res.status(400).json({
        success: false,
        error: validation.error,
      });
    }

    const idempotencyKey = String(req.get("x-idempotency-key") || "").trim();
    if (idempotencyKey && idempotencyCache.has(idempotencyKey)) {
      const cached = idempotencyCache.get(idempotencyKey);
      return res.status(cached.statusCode).json(cached.body);
    }

    const preview = validation.message.slice(0, 160);
    logger.info({ group: validation.group, preview }, "Sending WhatsApp group message");

    try {
      const result = await whatsappClient.sendGroupMessage({
        group: validation.group,
        message: validation.message,
      });
      const body = {
        success: true,
        group: validation.group,
        messageId: result.messageId,
        sentAt: result.sentAt,
      };
      if (idempotencyKey) {
        idempotencyCache.set(idempotencyKey, {
          createdAt: Date.now(),
          statusCode: 200,
          body,
        });
      }
      return res.status(200).json(body);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      const body = {
        success: false,
        error: statusCode === 500 ? "Unable to send WhatsApp message." : error.message,
      };
      if (idempotencyKey) {
        idempotencyCache.set(idempotencyKey, {
          createdAt: Date.now(),
          statusCode,
          body,
        });
      }
      if (statusCode >= 500) {
        logger.error({ error: error.message, group: validation.group }, "WhatsApp send failed");
      } else {
        logger.warn({ error: error.message, group: validation.group }, "WhatsApp send rejected");
      }
      return res.status(statusCode).json(body);
    }
  });

  return router;
}

module.exports = {
  createMessageRouter,
  validatePayload,
  cleanIdempotencyCache,
  idempotencyCache,
};
