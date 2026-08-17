require("dotenv").config();

const express = require("express");
const helmet = require("helmet");

const logger = require("./src/utils/logger");
const whatsappClient = require("./src/whatsappClient");
const cloudApiClient = require("./src/cloudApiClient");
const { createMessageRouter } = require("./src/routes/messageRoutes");
const { createStatusRouter } = require("./src/routes/statusRoutes");
const { createCloudWebhookRouter } = require("./src/routes/cloudWebhookRoutes");
const { createCloudMessageRouter } = require("./src/routes/cloudMessageRoutes");
const { errorHandler, notFoundHandler } = require("./src/middleware/errorHandler");

process.on("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error(
    { error: error.message, stack: error.stack },
    "Unhandled promise rejection"
  );
});

process.on("uncaughtException", (error) => {
  logger.fatal(
    { error: error.message, stack: error.stack },
    "Uncaught exception"
  );
  process.exit(1);
});

function createApp(options = {}) {
  const app = express();
  const client = options.whatsappClient || whatsappClient;
  const cloudClient = options.cloudApiClient || cloudApiClient;

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(express.json({ limit: "8mb" }));

  app.use("/", createStatusRouter({ whatsappClient: client }));
  app.use("/", createMessageRouter({ whatsappClient: client }));
  app.use("/", createCloudWebhookRouter({ appendInboundMessage: client.appendInboundMessage }));
  app.use("/", createCloudMessageRouter({ cloudApiClient: cloudClient }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

async function start() {
  const port = Number(process.env.PORT || 3000);
  const app = createApp();

  app.listen(port, "0.0.0.0", async () => {
    logger.info({ port }, "meridian-whatsapp-group-service started");

    logger.info("Initializing WhatsApp client");
    // initializeWithRetry() never throws - a failed attempt schedules its
    // own backoff retry internally instead of leaving the service stuck
    // disconnected until someone happens to load /qr again.
    await whatsappClient.initializeWithRetry();
  });
}

if (require.main === module) {
  start();
}

module.exports = { createApp };
