const crypto = require("crypto");
const twilio = require("twilio");

function equalSecret(a, b) {
  const hash = (value) => crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

function requireLogin(req, res, next) {
  const password = process.env.APP_PASSWORD;
  if (!password) return res.status(503).send("App login is not configured.");
  const authorization = req.get("authorization") || "";
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
  const decoded = match ? Buffer.from(match[1], "base64").toString("utf8") : "";
  const valid = equalSecret(decoded, `operator:${password}`);
  if (!valid) {
    res.set("WWW-Authenticate", 'Basic realm="Iron Wing Dispatching", charset="UTF-8"');
    return res.status(401).send("Authentication required.");
  }
  res.set("Cache-Control", "no-store");
  return next();
}

function validateWebhook(req, res, next) {
  const baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!baseUrl || !token) return res.sendStatus(503);
  const signature = req.get("X-Twilio-Signature") || "";
  const url = baseUrl.replace(/\/$/, "") + req.originalUrl;
  if (!twilio.validateRequest(token, signature, url, req.body)) return res.sendStatus(403);
  return next();
}

module.exports = { requireLogin, validateWebhook };
