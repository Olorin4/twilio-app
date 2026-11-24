/* Softphone identities. Each signed-in person gets their own Twilio Client
identity per line: u<userId>_c<connectionId> on a connection number and
u<userId>_legacy on the legacy number (ids lowercase, without dashes). The
bootstrap login keeps the identities used before user accounts existed:
connection_<connectionId>, and getIdentity() on the legacy number. */

const HEX = "[0-9a-f]{32}";
const USER_CONNECTION = new RegExp(`^u(${HEX})_c(${HEX})$`);
const USER_LEGACY = new RegExp(`^u(${HEX})_legacy$`);
const BOOTSTRAP_CONNECTION = new RegExp(`^connection_(${HEX})$`);

const compact = (id) => String(id).replace(/-/g, "").toLowerCase();
const dashed = (hex) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
// Required lazily: token.js requires this module.
const legacyIdentity = () => {
  const { getIdentity } = require("./token");
  return typeof getIdentity === "function" ? getIdentity() : undefined;
};

function identityFor(user, provider) {
  if (!user) throw new Error("A softphone identity needs a signed-in user.");
  if (!provider) throw new Error("A softphone identity needs a line.");
  if (user.bootstrap === true)
    return provider.legacy
      ? legacyIdentity()
      : `connection_${compact(provider.id)}`;
  if (!user.id) throw new Error("This user has no id.");
  const userPart = `u${compact(user.id)}`;
  return provider.legacy
    ? `${userPart}_legacy`
    : `${userPart}_c${compact(provider.id)}`;
}

// Accepts an identity with or without Twilio's "client:" prefix.
function parseIdentity(identity) {
  if (typeof identity !== "string") return null;
  const name = identity.startsWith("client:")
    ? identity.slice("client:".length)
    : identity;
  let match = USER_CONNECTION.exec(name);
  if (match)
    return {
      userId: dashed(match[1]),
      connectionId: dashed(match[2]),
      legacy: false,
      bootstrap: false,
    };
  match = USER_LEGACY.exec(name);
  if (match)
    return {
      userId: dashed(match[1]),
      connectionId: null,
      legacy: true,
      bootstrap: false,
    };
  match = BOOTSTRAP_CONNECTION.exec(name);
  if (match)
    return {
      userId: null,
      connectionId: dashed(match[1]),
      legacy: false,
      bootstrap: true,
    };
  const legacy = legacyIdentity();
  if (legacy && name === legacy)
    return { userId: null, connectionId: null, legacy: true, bootstrap: true };
  return null;
}

// True when a Twilio `From` is a softphone of this line: any user's identity
// for it or the bootstrap one.
function isClientOf(from, provider) {
  if (!provider || typeof from !== "string" || !from.startsWith("client:"))
    return false;
  const parsed = parseIdentity(from);
  if (!parsed) return false;
  if (provider.legacy) return parsed.legacy;
  if (!provider.id || parsed.legacy) return false;
  return compact(parsed.connectionId) === compact(provider.id);
}

module.exports = { identityFor, parseIdentity, isClientOf };
