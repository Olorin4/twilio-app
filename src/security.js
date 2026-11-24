const crypto = require("crypto");
const twilio = require("twilio");
const { authenticate, hasEnabledOwner } = require("./users");

function equalSecret(a, b) {
  const hash = (value) => crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

const REALM = 'Basic realm="Iron Wing Dispatching", charset="UTF-8"';

function challenge(res) {
  res.set("WWW-Authenticate", REALM);
  return res.status(401).send("Authentication required.");
}

function credentialsFrom(req) {
  const authorization = req.get("authorization") || "";
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  return {
    username: decoded.slice(0, colon),
    password: decoded.slice(colon + 1),
  };
}

const bootstrapUser = () => ({
  id: null,
  username: "operator",
  displayName: "Operator",
  role: "owner",
  bootstrap: true,
  workspaceIds: [],
});

// Works out who is signing in. Returns a user, null for a bad login, or a
// string for a 503. Throws when the account store cannot be read.
async function loginFor({ username, password }) {
  const appPassword = process.env.APP_PASSWORD;
  // The shared operator password only works until the first owner exists.
  if (
    username === "operator" &&
    appPassword &&
    equalSecret(password, appPassword) &&
    !(await hasEnabledOwner())
  )
    return bootstrapUser();
  const user = await authenticate(username, password);
  if (user) return { ...user, bootstrap: false };
  if (username === "operator" && !appPassword && !(await hasEnabledOwner()))
    return "App login is not configured.";
  return null;
}

// Sets req.user to a signed-in User or the bootstrap operator. Fails closed:
// if the account store cannot be read, nobody gets in.
async function requireLogin(req, res, next) {
  const credentials = credentialsFrom(req);
  if (!credentials) return challenge(res);
  let user;
  try {
    user = await loginFor(credentials);
  } catch (error) {
    console.error("Login check failed:", error.message);
    return res.status(503).send("App login is unavailable.");
  }
  if (typeof user === "string") return res.status(503).send(user);
  if (!user) return challenge(res);
  req.user = user;
  res.set("Cache-Control", "no-store");
  return next();
}

function requireOwner(req, res, next) {
  if (req.user && req.user.role === "owner") return next();
  return res.status(403).json({ error: "Only an owner can change settings." });
}

function validateWebhook(req, res, next) {
  const baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!baseUrl || !token) return res.sendStatus(503);
  const signature = req.get("X-Twilio-Signature") || "";
  const url = baseUrl.replace(/\/$/, "") + req.originalUrl;
  if (!twilio.validateRequest(token, signature, url, req.body))
    return res.sendStatus(403);
  return next();
}

// Requests Twilio makes on its own, which carry a signature instead of the
// operator's login. Each of these routes validates that signature itself.
const webhookPaths = [
  /^\/(voice|sms|sms-status|call-status)$/,
  /^\/announcement\/(missed|closed)(\/complete)?$/,
  /^\/receptionist\/ended$/,
  /^\/transcription\/[0-9a-f-]{36}$/i,
  /^\/webhooks\/[0-9a-f-]{36}\/transcription\/[0-9a-f-]{36}$/i,
  /^\/webhooks\/[0-9a-f-]{36}\/(voice|sms|sms-status|call-status|announcement\/(missed|closed)(\/complete)?|receptionist\/ended)$/i,
];
function isTwilioWebhook(req) {
  return (
    req.method === "POST" && webhookPaths.some((path) => path.test(req.path))
  );
}

module.exports = {
  requireLogin,
  requireOwner,
  validateWebhook,
  isTwilioWebhook,
};
