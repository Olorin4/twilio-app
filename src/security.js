const crypto = require("crypto");
const twilio = require("twilio");
const { authenticate, hasEnabledOwner, isCachedLogin } = require("./users");
const { createLoginLimiter } = require("./loginLimiter");

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

/* Failed logins are limited per client address (30 in a rolling minute) and
per address and username together (10), and a limited key is refused with 429
before any password hashing, so bad logins can't tie up the thread pool live
calls share. There is no bare per-username key: a stranger failing as `nick`
from their own address never locks `nick` out elsewhere. Successful logins
don't count. The 429 carries no WWW-Authenticate, so the browser does not
re-prompt in a loop. A login that is a live cache hit (no hashing) still
passes, so signed-in people keep working while their address is limited.

req.ip is only the client's address when Express trusts the edge nginx's
X-Forwarded-For (TRUST_PROXY, applied in index.js). Without it every client
is the proxy's address, so a limit would lock everyone out together: the
limiter is off and the server warns at startup. */
const loginLimiter = createLoginLimiter({
  limits: { ip: 30, ipuser: 10 },
  windowMs: 60000,
  maxKeys: 10000,
});
const LIMITED = "Too many sign-in attempts. Try again in a minute.";
function limitKeys(req, username) {
  if (!req.app?.get?.("trust proxy")) return [];
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  return [`ip:${ip}`, `ipuser:${ip}|${String(username).trim().toLowerCase()}`];
}

// TRUST_PROXY as Express's "trust proxy" value: unset or empty is off, a
// whole number is how many proxies to trust, anything else (for example
// "loopback, 172.16.0.0/12") is passed through.
function trustProxySetting(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  return /^\d+$/.test(text) ? Number(text) : text;
}

// Sets req.user to a signed-in User or the bootstrap operator. Fails closed:
// if the account store cannot be read, nobody gets in.
async function requireLogin(req, res, next) {
  const credentials = credentialsFrom(req);
  if (!credentials) return challenge(res);
  const keys = limitKeys(req, credentials.username);
  if (
    loginLimiter.blocked(keys) &&
    !isCachedLogin(credentials.username, credentials.password)
  ) {
    res.set("Retry-After", "60");
    return res.status(429).send(LIMITED);
  }
  let user;
  try {
    user = await loginFor(credentials);
  } catch (error) {
    if (error.code === "LOGIN_BUSY")
      return res.status(503).send("App login is busy. Try again.");
    console.error("Login check failed:", error.message);
    return res.status(503).send("App login is unavailable.");
  }
  if (typeof user === "string") return res.status(503).send(user);
  if (!user) {
    loginLimiter.fail(keys);
    return challenge(res);
  }
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
  resetLoginLimits: () => loginLimiter.clear(),
  trustProxySetting,
  requireOwner,
  validateWebhook,
  isTwilioWebhook,
};
