const logger = require("../utils/logger");

function notFoundHandler(req, res) {
  return res.status(404).json({
    success: false,
    error: "Not found.",
  });
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  logger.error(
    {
      error: error.message,
      path: req.path,
      method: req.method,
    },
    "Unhandled request error"
  );

  return res.status(500).json({
    success: false,
    error: "Unable to send WhatsApp message.",
  });
}

module.exports = { errorHandler, notFoundHandler };
