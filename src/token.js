/* token.js is responsible for generating a Twilio Access Token for the browser client. 
It also initializes the Twilio client and exports it for reuse. The tokenGenerator function 
generates a new token with a unique identity and grants the necessary permission
for voice calls. The client object is exported for use in other modules. */

const twilio = require("twilio");
const AccessToken = require("twilio").jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
require("dotenv").config();

// Twilio credentials from .env
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const appSid = process.env.TWILIO_APP_SID;
const apiKey = process.env.TWILIO_API_KEY;
const apiSecret = process.env.TWILIO_API_SECRET;
const callerId = process.env.TWILIO_CALLER_ID;

// Initialize Twilio client once and export it for reuse
const client = twilio(accountSid, authToken);

// Generate twilio Token for Browser client
exports.tokenGenerator = function tokenGenerator() {
  identity = nameGenerator();
  const accessToken = new AccessToken(accountSid, apiKey, apiSecret, {
    ttl: 14400, // Extend expiration to 4 hours);
  });
  accessToken.identity = identity;

  const grant = new VoiceGrant({
    outgoingApplicationSid: appSid,
    incomingAllow: true, // Allow incoming calls
  });
  accessToken.addGrant(grant);

  return {
    identity,
    token: accessToken.toJwt(),
    client,
    accountSid,
    authToken,
    appSid,
    apiKey,
    apiSecret,
    callerId,
  };
};

// Export Twilio client and credentials for use in handler.js
// exports.client = client;
// exports.accountSid = TWILIO_ACCOUNT_SID;
// exports.callerId = TWILIO_FAX_NUMBER;
