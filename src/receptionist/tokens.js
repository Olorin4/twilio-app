/* Single-use tokens that tie a ConversationRelay WebSocket to the call the
voice webhook just approved. The webhook is signature-checked, so only a call
Twilio really sent us can obtain one. Tokens live in memory: the app runs as
one process, and a restart simply sends in-flight calls to the fallback. */

const crypto = require("crypto");

const TTL_MS = 60_000;
const pending = new Map();

function mint(context) {
  const now = Date.now();
  for (const [token, entry] of pending)
    if (entry.expires <= now) pending.delete(token);
  const token = crypto.randomBytes(32).toString("base64url");
  pending.set(token, { context, expires: now + TTL_MS });
  return token;
}

// Any attempt removes the token, so a wrong guess for a call cannot be
// retried and a token can never be replayed.
function consume(token, callSid) {
  if (typeof token !== "string") return null;
  const entry = pending.get(token);
  if (!entry) return null;
  pending.delete(token);
  if (entry.expires <= Date.now()) return null;
  if (entry.context.callSid !== callSid) return null;
  return entry.context;
}

module.exports = { mint, consume };
