/* handler.js is responsible for handling incoming calls, messages, faxes and logs
and then exporting them for use in router.js. */

const VoiceResponse = require("twilio").twiml.VoiceResponse;
const AccessToken = require("twilio").jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
const nameGenerator = require("../name_generator");
// const statusFile = path.join(__dirname, "client-status.json");
const {
  accountSid,
  authToken,
  appSid,
  apiKey,
  apiSecret,
  callerId,
} = require("./token");

// Debugging twilio credentials imports
console.log("✔ Debugging handler.js credentials:");
console.log("accountSid:", accountSid);
console.log("authToken:", authToken);
console.log("appSid:", appSid);
if (!callerId) throw new Error("Caller ID is missing in Twilio configuration.");
console.log("✔ Twilio credentials correctly imported into handler.js");

let identity;

exports.tokenGenerator = function tokenGenerator() {
  identity = nameGenerator();

  const accessToken = new AccessToken(accountSid, apiKey, apiSecret);
  accessToken.identity = identity;
  const grant = new VoiceGrant({
    outgoingApplicationSid: appSid,
    incomingAllow: true,
  });
  accessToken.addGrant(grant);
  // Include identity and token in a JSON response
  return {
    identity: identity,
    token: accessToken.toJwt(),
  };
};

// Handle Incoming Calls
exports.voiceResponse = function voiceResponse(requestBody) {
  const toNumberOrClientName = requestBody.To;
  console.log("📞 Incoming call to:", requestBody.To);
  let twiml = new VoiceResponse();

  // If the request is to our Twilio Number, route to browser
  if (toNumberOrClientName == callerId) {
    console.log("🟢 [DEBUG] Attempting to route call to browser-client...");
    let dial = twiml.dial({ timeout: 20 }); // Wait for 20 seconds before failing over
    dial.client(identity);
    // If no answer, Twilio will play this message
    twiml.say(
      "Hello, thank you for calling Iron Wing Dispatching. One of our representatives willl call you back soon.",
    );
  } else if (requestBody.To) {
    // This is an outgoing call
    let dial = twiml.dial({ callerId });
    // Check if the 'To' parameter is a Phone Number or Client Name
    // in order to use the appropriate TwiML noun
    const attr = isAValidPhoneNumber(toNumberOrClientName)
      ? "number"
      : "client";
    dial[attr]({}, toNumberOrClientName);
  } else
    twiml.say(
      "Hello, , thank you for calling Iron Wing Dispatching. Our office is currently closed. Please call back during business hours.",
    );

  console.log("📞 Generated TwiML:", twiml.toString()); //  Log for debugging
  return twiml.toString();
};

/**
 * Checks if the given value is valid as phone number
 * @param {Number|String} number
 * @return {Boolean}
 */
function isAValidPhoneNumber(number) {
  return /^[\d\+\-\(\) ]+$/.test(number);
}
