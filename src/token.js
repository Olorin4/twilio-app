/* token.js is responsible for generating a Twilio Access Token for the browser client. 
It also initializes the Twilio client and exports it for reuse. The tokenGenerator function 
generates a new token with a unique identity and grants the necessary permission
for voice calls. The client object is exported for use in other modules. */

require("dotenv").config();
const twilio = require("twilio");
const AccessToken = require("twilio").jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

// Load Twilio credentials from .env
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const appSid = process.env.TWILIO_APP_SID;
const apiKey = process.env.TWILIO_API_KEY;
const apiSecret = process.env.TWILIO_API_SECRET;
const callerId = process.env.TWILIO_CALLER_ID;

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
    "Missing required Twilio environment variables. Check your .env file.",
  );
}

// Initialize Twilio client once and export it for reuse
const client = twilio(accountSid, authToken);

// Generate twilio Token for Browser client
exports.tokenGenerator = function tokenGenerator() {
  identity = `user_${Math.floor(Math.random() * 10000)}`;
  const accessToken = new AccessToken(accountSid, apiKey, apiSecret, {
    ttl: 14400, // Extend expiration to 4 hours);
  });

  accessToken.identity = identity;
  accessToken.addGrant(
    new VoiceGrant({ outgoingApplicationSid: appSid, incomingAllow: true }),
  );

  const grant = new VoiceGrant({
    outgoingApplicationSid: appSid,
    incomingAllow: true, // Allow incoming calls
  });
  accessToken.addGrant(grant);

  return {
    identity,
    token: accessToken.toJwt(),
  };
};

// Export Twilio credentials and tokenGenerator
module.exports = {
  accountSid,
  authToken,
  appSid,
  apiKey,
  apiSecret,
  callerId,
  tokenGenerator,
};
