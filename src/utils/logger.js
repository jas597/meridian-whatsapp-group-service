const pino = require("pino");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "authorization",
      "WHATSAPP_WEBHOOK_SECRET",
      "QR_PAGE_SECRET",
    ],
    remove: true,
  },
});

module.exports = logger;
