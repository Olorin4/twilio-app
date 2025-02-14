/* token.js is responsible for generating a Twilio Access Token for the browser client. 
It also initializes the Twilio client and exports it for reuse. The tokenGenerator function 
generates a new token with a unique identity and grants the necessary permission
for voice calls. The client object is exported for use in other modules. */

require("dotenv").config();
const twilio = require("twilio");
const nameGenerator = require("../name_generator");
const AccessToken = require("twilio").jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

// Load Twilio credentials from .env
console.log("🔍 Debugging ENV Variables:");
console.log("TWILIO_ACCOUNT_SID:", process.env.TWILIO_ACCOUNT_SID);
console.log("TWILIO_AUTH_TOKEN:", process.env.TWILIO_AUTH_TOKEN);
console.log("TWILIO_TWIML_APP_SID:", process.env.TWILIO_TWIML_APP_SID);
console.log("TWILIO_API_KEY:", process.env.TWILIO_API_KEY);
console.log("TWILIO_API_SECRET:", process.env.TWILIO_API_SECRET);
console.log("TWILIO_CALLER_ID:", process.env.TWILIO_CALLER_ID);

// Assign values correctly
const accountSid = process.env.TWILIO_ACCOUNT_SID || "";
const authToken = process.env.TWILIO_AUTH_TOKEN || "";
const appSid = process.env.TWILIO_TWIML_APP_SID || "";
const apiKey = process.env.TWILIO_API_KEY || "";
const apiSecret = process.env.TWILIO_API_SECRET || "";
const callerId = process.env.TWILIO_CALLER_ID || "";

// Ensure required variables are set
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
}
console.log("✅ Twilio credentials loaded successfully.");

// Initialize Twilio client once and export it for reuse
const client = twilio(accountSid, authToken);
let identity;

// Generate Twilio Token for Browser client
function tokenGenerator() {
  identity = nameGenerator();
  const accessToken = new AccessToken(accountSid, apiKey, apiSecret, {
    ttl: 14400,
  });

  accessToken.identity = identity;
  accessToken.addGrant(
    new VoiceGrant({ outgoingApplicationSid: appSid, incomingAllow: true }),
  );

  // Include identity and token in a JSON response
  return { identity, token: accessToken.toJwt() };
}

// Export credentials and tokenGenerator
module.exports = {
  accountSid,
  authToken,
  appSid,
  apiKey,
  apiSecret,
  callerId,
  tokenGenerator,
  identity,
  client,
};
