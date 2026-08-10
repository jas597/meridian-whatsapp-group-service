const express = require("express");
const rateLimit = require("express-rate-limit");

function createStatusRouter({ whatsappClient }) {
  const router = express.Router();

  // /qr can trigger a full reinitialize() (Puppeteer relaunch) when status is
  // disconnected/starting; without a limiter, rapid manual refreshes or a
  // monitor polling this page can repeatedly relaunch the client and worsen
  // instability instead of recovering from it.
  const qrLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 6,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.get("/health", (req, res) => {
    return res.json({
      success: true,
      service: "meridian-whatsapp-group-service",
      whatsappStatus: whatsappClient.getStatus(),
      timestamp: new Date().toISOString(),
    });
  });

  router.get("/qr", qrLimiter, async (req, res) => {
    const expectedKey = process.env.QR_PAGE_SECRET;
    const key = String(req.query.key || "");

    if (!expectedKey || key !== expectedKey) {
      return res.status(401).send("Unauthorized.");
    }

    const currentStatus = whatsappClient.getStatus();
    if (currentStatus === "disconnected" || currentStatus === "starting") {
      try {
        await whatsappClient.initializeWhatsApp();
      } catch (error) {
        // The page below still renders the current status; initialization errors are logged by the client.
      }
    }

    const qrDataUrl = whatsappClient.getQrDataUrl();
    const status = whatsappClient.getStatus();
    const qrMarkup = qrDataUrl
      ? `<img src="${qrDataUrl}" alt="WhatsApp QR code" />`
      : `<p>No QR code is available right now. Current status: <strong>${status}</strong>.</p>`;

    return res
      .type("html")
      .send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Meridian WhatsApp QR</title>
  <style>
    body { font-family: Arial, sans-serif; background:#f3f6fb; color:#0f172a; margin:0; padding:40px; }
    main { max-width:520px; margin:0 auto; background:#fff; border:1px solid #dbe4ef; border-radius:14px; padding:28px; box-shadow:0 20px 50px rgba(15,23,42,.08); }
    h1 { margin-top:0; }
    img { width:100%; max-width:360px; display:block; margin:24px auto; }
  </style>
</head>
<body>
  <main>
    <h1>Meridian WhatsApp Login</h1>
    <p>Scan this QR code from the Meridian WhatsApp account. Do not share this page publicly.</p>
    ${qrMarkup}
    <p>Status: <strong>${status}</strong></p>
  </main>
</body>
</html>`);
  });

  router.get("/groups", async (req, res) => {
    const expectedKey = process.env.QR_PAGE_SECRET;
    const key = String(req.query.key || "");

    if (!expectedKey || key !== expectedKey) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized.",
      });
    }

    try {
      const groups = await whatsappClient.listGroups();
      return res.json({
        success: true,
        whatsappStatus: whatsappClient.getStatus(),
        groups,
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        success: false,
        whatsappStatus: whatsappClient.getStatus(),
        error: error.message,
      });
    }
  });

  return router;
}

module.exports = { createStatusRouter };
