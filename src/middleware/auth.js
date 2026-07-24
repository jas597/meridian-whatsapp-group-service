function requireBearerSecret(req, res, next) {
  const expected = process.env.WHATSAPP_WEBHOOK_SECRET;
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";

  if (!expected || !token || token !== expected) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized.",
    });
  }

  return next();
}

module.exports = { requireBearerSecret };
