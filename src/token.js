/* token.js is responsible for generating a Twilio Access Token for the browser client. 
It also initializes the Twilio client and exports it for reuse. The tokenGenerator function 
generates a new token with a unique identity and grants the necessary permission
for voice calls. The client object is exported for use in other modules. */

const config = require("./config");
const twilio = require("twilio");
const AccessToken = require("twilio").jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
const nameGenerator = require("../name_generator");

// Import Twilio credentials from config.js
const accountSid = config.TWILIO_ACCOUNT_SID;
const authToken = config.TWILIO_AUTH_TOKEN;
const appSid = config.TWILIO_TWIML_APP_SID;
const apiKey = config.TWILIO_API_KEY;
const apiSecret = config.TWILIO_API_SECRET;
const callerId = config.TWILIO_CALLER_ID;
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
  identity = process.env.TWILIO_IDENTITY || nameGenerator();
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
  getIdentity: () => identity,
};
