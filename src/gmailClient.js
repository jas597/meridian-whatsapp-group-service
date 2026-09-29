const nodemailer = require("nodemailer");

const SENDER = "info@meridianconvention.com";

function setup(env = process.env) {
  return {
    sender: SENDER,
    configured: env.GMAIL_USER === SENDER && Boolean(env.GMAIL_APP_PASSWORD?.trim()),
  };
}

function createTransport(env = process.env) {
  if (!setup(env).configured) {
    const error = new Error("Authorize info@meridianconvention.com with a Gmail app password in Render.");
    error.statusCode = 503;
    throw error;
  }
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: SENDER, pass: env.GMAIL_APP_PASSWORD.replace(/\s/g, "") },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

module.exports = { SENDER, setup, createTransport };
