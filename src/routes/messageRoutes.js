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
  const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64.trim() : "";
  const imageFilename = typeof body.imageFilename === "string" ? body.imageFilename.trim() : "staff-schedule.png";
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

  return { group, message, imageBase64, imageFilename };
}

function allowedContacts() {
  return String(process.env.ALLOWED_CONTACTS || "")
    .split(/[,\n;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeContactForComparison(contact) {
  return String(contact || "").replace(/[^\d]/g, "");
}

function validateContactPayload(body) {
  const contact = typeof body.contact === "string" ? body.contact.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64.trim() : "";
  const imageFilename = typeof body.imageFilename === "string" ? body.imageFilename.trim() : "staff-schedule.png";

  if (!contact || (!message && !imageBase64)) {
    return { error: "contact and message or imageBase64 are required." };
  }

  if (message.length > 10000) {
    return { error: "message must be 10,000 characters or less." };
  }

  const allowed = allowedContacts();
  if (allowed.length > 0) {
    const normalizedContact = normalizeContactForComparison(contact);
    const isAllowed = allowed.some((allowedContact) => (
      allowedContact === contact
      || normalizeContactForComparison(allowedContact) === normalizedContact
    ));
    if (!isAllowed) {
      return { error: "Unauthorized contact." };
    }
  }

  return { contact, message, imageBase64, imageFilename };
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
      logger.info({ group: validation.group, idempotencyKey }, "Returning cached WhatsApp send response");
      return res.status(cached.statusCode).json({
        ...cached.body,
        cached: true,
      });
    }

    const preview = validation.message.slice(0, 160);
    logger.info({ group: validation.group, preview }, "Sending WhatsApp group message");

    try {
      const result = await whatsappClient.sendGroupMessage({
        group: validation.group,
        message: validation.message,
        imageBase64: validation.imageBase64,
        imageFilename: validation.imageFilename,
      });
      const body = {
        success: true,
        group: validation.group,
        messageId: result.messageId,
        sentAt: result.sentAt,
        cached: false,
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
      const errorMessage = error && error.message ? error.message : "Unable to send WhatsApp message.";
      const body = {
        success: false,
        error: errorMessage,
      };
      if (idempotencyKey) {
        idempotencyCache.set(idempotencyKey, {
          createdAt: Date.now(),
          statusCode,
          body,
        });
      }
      if (statusCode >= 500) {
        logger.error({ error: error.message, stack: error.stack, group: validation.group }, "WhatsApp send failed");
      } else {
        logger.warn({ error: error.message, group: validation.group }, "WhatsApp send rejected");
      }
      return res.status(statusCode).json(body);
    }
  });

  router.post("/send-contact-message", limiter, requireBearerSecret, async (req, res) => {
    cleanIdempotencyCache();

    const validation = validateContactPayload(req.body || {});
    if (validation.error) {
      return res.status(400).json({
        success: false,
        error: validation.error,
      });
    }

    const idempotencyKey = String(req.get("x-idempotency-key") || "").trim();
    if (idempotencyKey && idempotencyCache.has(idempotencyKey)) {
      const cached = idempotencyCache.get(idempotencyKey);
      logger.info({ contact: validation.contact, idempotencyKey }, "Returning cached WhatsApp contact send response");
      return res.status(cached.statusCode).json({
        ...cached.body,
        cached: true,
      });
    }

    const preview = validation.message.slice(0, 160);
    logger.info({ contact: validation.contact, preview }, "Sending WhatsApp contact message");

    try {
      const result = await whatsappClient.sendContactMessage({
        contact: validation.contact,
        message: validation.message,
        imageBase64: validation.imageBase64,
        imageFilename: validation.imageFilename,
      });
      const body = {
        success: true,
        contact: validation.contact,
        contactId: result.contactId,
        messageId: result.messageId,
        sentAt: result.sentAt,
        cached: false,
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
      const errorMessage = error && error.message ? error.message : "Unable to send WhatsApp message.";
      const body = {
        success: false,
        error: errorMessage,
      };
      // error.state distinguishes "attempted but WhatsApp never positively
      // confirmed it" from every other kind of failure - callers must not
      // treat the two the same (see whatsappClient.sendContactMessage()).
      if (error.state) {
        body.state = error.state;
      }
      if (idempotencyKey) {
        idempotencyCache.set(idempotencyKey, {
          createdAt: Date.now(),
          statusCode,
          body,
        });
      }
      if (statusCode >= 500) {
        logger.error({ error: error.message, stack: error.stack, contact: validation.contact, state: error.state }, "WhatsApp contact send failed");
      } else {
        logger.warn({ error: error.message, contact: validation.contact, state: error.state }, "WhatsApp contact send rejected");
      }
      return res.status(statusCode).json(body);
    }
  });

  router.get("/inbound-messages", requireBearerSecret, (req, res) => {
    const since = typeof req.query.since === "string" ? req.query.since : "";
    const contact = typeof req.query.contact === "string" ? req.query.contact : "";
    const limit = Number(req.query.limit || 200);

    try {
      const messages = whatsappClient.listInboundMessages({
        since,
        contact,
        limit: Number.isFinite(limit) ? limit : 200,
      });
      return res.json({
        success: true,
        messages,
      });
    } catch (error) {
      logger.error(
        { error: error.message, stack: error.stack },
        "Unable to list WhatsApp inbound messages"
      );
      return res.status(500).json({
        success: false,
        error: "Unable to list WhatsApp inbound messages.",
      });
    }
  });

  return router;
}

module.exports = {
  createMessageRouter,
  validatePayload,
  validateContactPayload,
  cleanIdempotencyCache,
  idempotencyCache,
};
