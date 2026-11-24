/* token.js is responsible for generating a Twilio Access Token for the browser client. 
It also initializes the Twilio client and exports it for reuse. The tokenGenerator function 
generates a new token with a unique identity and grants the necessary permission
for voice calls. The client object is exported for use in other modules. */

require("dotenv").config();
const twilio = require("twilio");
const AccessToken = require("twilio").jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
const nameGenerator = require("../name_generator");
const { identityFor } = require("./identity");

// Load Twilio credentials from .env
// console.log("🔍 Debugging ENV Variables:");
// console.log("TWILIO_ACCOUNT_SID:", process.env.TWILIO_ACCOUNT_SID);
// console.log("TWILIO_AUTH_TOKEN:", process.env.TWILIO_AUTH_TOKEN);
// console.log("TWILIO_TWIML_APP_SID:", process.env.TWILIO_TWIML_APP_SID);
// console.log("TWILIO_API_KEY:", process.env.TWILIO_API_KEY);
// console.log("TWILIO_API_SECRET:", process.env.TWILIO_API_SECRET);
// console.log("TWILIO_CALLER_ID:", process.env.TWILIO_CALLER_ID);

// Assign values correctly
const accountSid = process.env.TWILIO_ACCOUNT_SID || "";
const authToken = process.env.TWILIO_AUTH_TOKEN || "";
const appSid = process.env.TWILIO_TWIML_APP_SID || "";
const apiKey = process.env.TWILIO_API_KEY || "";
const apiSecret = process.env.TWILIO_API_SECRET || "";
const callerId = process.env.TWILIO_CALLER_ID || "";
let identity;

// Ensure required variables are imported from .env
if (
  !accountSid ||
  !authToken ||
  !appSid ||
  !apiKey ||
  !apiSecret ||
  !callerId
) {
  throw new Error(
    "❌ Missing required Twilio environment variables. Check your .env file.",
  );
} else console.log("✅ Twilio credentials loaded successfully from .env.");

// Initialize Twilio client once and export it for reuse
const client = twilio(accountSid, authToken);

// Generate Twilio Token for Browser client
function tokenGenerator() {
  identity = process.env.TWILIO_IDENTITY || identity || nameGenerator();
  if (!identity) {
    throw new Error("❌ [ERROR] identity is undefined in tokenGenerator()");
  }

  const accessToken = new AccessToken(accountSid, apiKey, apiSecret, {
    identity,
  });
  const grant = new VoiceGrant({
    outgoingApplicationSid: appSid,
    incomingAllow: true,
  });
  accessToken.addGrant(grant);
  console.log(`✅ [DEBUG] Token generated for identity: ${identity}`);
  // Include identity and token in a JSON response
  return {
    identity: identity,
    token: accessToken.toJwt(),
  };
}

function mint(credentials, tokenIdentity) {
  const accessToken = new AccessToken(
    credentials.accountSid,
    credentials.apiKeySid,
    credentials.apiKeySecret,
    { identity: tokenIdentity },
  );
  accessToken.addGrant(
    new VoiceGrant({
      outgoingApplicationSid: credentials.twimlAppSid,
      incomingAllow: true,
    }),
  );
  return { identity: tokenIdentity, token: accessToken.toJwt() };
}

// A softphone token for `user` on `provider`'s line, always under the user's
// own identity (src/identity.js). The bootstrap login on the legacy line
// keeps tokenGenerator(); a real user on it gets the legacy credentials under
// their own identity.
function tokenFor(user, provider) {
  if (provider.legacy) {
    if (user && user.bootstrap === true) return tokenGenerator();
    return mint(
      {
        accountSid,
        apiKeySid: apiKey,
        apiKeySecret: apiSecret,
        twimlAppSid: appSid,
      },
      identityFor(user, provider),
    );
  }
  if (!provider.voiceEnabled)
    throw new Error("This number does not support voice calls.");
  return mint(provider, identityFor(user, provider));
}

// Export credentials and tokenGenerator
module.exports = {
  accountSid,
  authToken,
  appSid,
  apiKey,
  apiSecret,
  callerId,
  client,
  tokenGenerator,
  tokenFor,
  getIdentity: () => identity || process.env.TWILIO_IDENTITY,
};
