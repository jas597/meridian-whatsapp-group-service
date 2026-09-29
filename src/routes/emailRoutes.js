const express = require("express");
const rateLimit = require("express-rate-limit");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { requireBearerSecret } = require("../middleware/auth");
const gmail = require("../gmailClient");

// Single Render instance, persistent disk. Save a claim BEFORE sending, so
// concurrent requests and restarts cannot silently send the same email twice.
function createEmailRouter({ env = process.env, makeTransport = gmail.createTransport } = {}) {
  const router = express.Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
  router.get("/email-status", requireBearerSecret, (_req, res) => {
    res.set("Cache-Control", "no-store").json(gmail.setup(env));
  });
  router.post("/verify-email", requireBearerSecret, limiter, async (_req, res) => {
    if (!gmail.setup(env).configured) return res.status(503).json({ success: false, ...gmail.setup(env) });
    try {
      await makeTransport(env).verify();
      return res.json({ success: true, sender: gmail.SENDER, authenticated: true });
    } catch {
      return res.status(503).json({ success: false, sender: gmail.SENDER, authenticated: false });
    }
  });
  router.post("/send-email", requireBearerSecret, limiter, async (req, res) => {
    const { to, subject, text } = req.body || {};
    if (typeof to !== "string" || to.length > 254 || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(to)
        || typeof subject !== "string" || !subject.trim() || subject.length > 250 || /[\r\n]/.test(subject)
        || typeof text !== "string" || !text.trim() || text.length > 20000) {
      return res.status(400).json({ success: false, error: "Provide one recipient, a subject, and plain-text message." });
    }
    const allowed = String(env.ALLOWED_EMAILS || "").toLowerCase().split(/[,;\s]+/).filter(Boolean);
    if (allowed.length && !allowed.includes(to.toLowerCase())) return res.status(403).json({ success: false, error: "Recipient is not allowed." });
    const key = req.get("x-idempotency-key") || "";
    if (!/^[a-zA-Z0-9_.:-]{1,200}$/.test(key)) return res.status(400).json({ success: false, error: "A valid X-Idempotency-Key is required." });
    if (!gmail.setup(env).configured) return res.status(503).json({ success: false, error: "Gmail is not connected.", state: "NOT_ATTEMPTED" });
    const dir = env.EMAIL_RECEIPTS_PATH || "/var/data/email-receipts";
    const file = path.join(dir, crypto.createHash("sha256").update(key).digest("hex") + ".json");
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ to: to.toLowerCase(), subject, text })).digest("hex");
    const unknown = { statusCode: 502, body: { success: false, state: "SEND_ATTEMPTED_UNCONFIRMED", error: "The send result is uncertain. Check Gmail Sent before sharing again." } };
    const save = (target, value, flags) => {
      const fd = fs.openSync(target, flags, 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    };
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      save(file, { fingerprint, ...unknown }, "wx");
      const dirFd = fs.openSync(dir, "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (error) {
      if (error.code !== "EEXIST") return res.status(503).json({ success: false, state: "NOT_ATTEMPTED", error: "Email receipt storage is unavailable." });
      try {
        const cached = JSON.parse(fs.readFileSync(file, "utf8"));
        if (cached.fingerprint !== fingerprint) return res.status(409).json({ success: false, error: "This request key was used with different content." });
        return res.status(cached.statusCode).json({ ...cached.body, cached: true });
      } catch { return res.status(unknown.statusCode).json(unknown.body); }
    }
    let outcome = unknown;
    try {
      const result = await makeTransport(env).sendMail({
        from: { name: "Meridian Convention Center", address: gmail.SENDER },
        replyTo: gmail.SENDER, to, subject, text,
        messageId: `<floor-plan-${crypto.createHash("sha256").update(key).digest("hex")}@meridianconvention.com>`,
      });
      const accepted = (result.accepted || []).some(address => String(address).toLowerCase() === to.toLowerCase());
      if (accepted && result.messageId) outcome = { statusCode: 200, body: { success: true, sender: gmail.SENDER, messageId: result.messageId, sentAt: new Date().toISOString() } };
    } catch (error) {
      // An explicit SMTP rejection is safe to report as failed. Timeouts and
      // dropped connections may happen after delivery: never retry them here.
      if (error.code === "EAUTH" || Number(error.responseCode) >= 400) outcome = { statusCode: 422, body: { success: false, state: "REJECTED", error: "Gmail rejected this send. Check the account configuration or recipient." } };
    }
    try {
      const temp = file + ".tmp";
      save(temp, { fingerprint, ...outcome }, "w");
      fs.renameSync(temp, file);
    } catch { /* The original durable unknown claim prevents an unsafe repeat. */ }
    return res.status(outcome.statusCode).json(outcome.body);
  });
  return router;
}

module.exports = { createEmailRouter };
