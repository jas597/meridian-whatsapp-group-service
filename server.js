require("dotenv").config();

const express = require("express");
const helmet = require("helmet");

const logger = require("./src/utils/logger");
const whatsappClient = require("./src/whatsappClient");
const { createMessageRouter } = require("./src/routes/messageRoutes");
const { createStatusRouter } = require("./src/routes/statusRoutes");
const { errorHandler, notFoundHandler } = require("./src/middleware/errorHandler");

function createApp(options = {}) {
  const app = express();
  const client = options.whatsappClient || whatsappClient;

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "64kb" }));

  app.use("/", createStatusRouter({ whatsappClient: client }));
  app.use("/", createMessageRouter({ whatsappClient: client }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

async function start() {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();

  whatsappClient.initialize().catch((error) => {
    logger.error({ error: error.message }, "WhatsApp client initialization failed");
  });

  app.listen(port, () => {
    logger.info({ port }, "meridian-whatsapp-group-service started");
  });
}

if (require.main === module) {
  start();
}

module.exports = { createApp };
