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

// Only expose protocol codes. SMTP messages can contain account data or secrets.
function failureDetails(error) {
  const code = /^[A-Z0-9_]{1,40}$/.test(error?.code || "") ? error.code : "EMAIL_ERROR";
  const smtpCode = Number(error?.responseCode);
  const command = String(error?.command || "").split(" ")[0];
  const enhancedCode = String(error?.response || "").match(/\b[245]\.\d\.\d{1,3}\b/)?.[0];
  return {
    errorCode: code,
    ...(Number.isInteger(smtpCode) && smtpCode >= 400 && smtpCode <= 599 ? { smtpCode } : {}),
    ...(["AUTH", "CONN", "EHLO", "HELO", "MAIL", "RCPT", "DATA", "STARTTLS"].includes(command) ? { command } : {}),
    ...(enhancedCode ? { enhancedCode } : {}),
  };
}

async function verifyConnection(env = process.env, makeTransport = createTransport) {
  const state = setup(env);
  if (!state.configured) return { ...state, authenticated: false, errorCode: "EMAIL_NOT_CONFIGURED" };
  try {
    await makeTransport(env).verify();
    return { ...state, authenticated: true };
  } catch (error) {
    return { ...state, authenticated: false, ...failureDetails(error) };
  }
}

module.exports = { SENDER, setup, createTransport, failureDetails, verifyConnection };
