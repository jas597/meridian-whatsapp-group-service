function requireBearerSecret(req, res, next) {
  const expected = [
    process.env.WHATSAPP_WEBHOOK_SECRET,
    process.env.CRM_WHATSAPP_WEBHOOK_SECRET,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";

  if (!token || !expected.some((value) => token === value)) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized.",
    });
  }

  return next();
}

module.exports = { requireBearerSecret };
