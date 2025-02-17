/* callResponse.js is responsible for handling incoming calls, messages, faxes and logs
and then exporting them for use in router.js. */

const VoiceResponse = require("twilio").twiml.VoiceResponse;
const { callerId, getIdentity } = require("./token");

// Debugging twilio credentials imports
// console.log("✔ Debugging handler.js credentials:");
// if (!callerId) throw new Error("Caller ID is missing in Twilio configuration.");
console.log("✔ Twilio credentials correctly imported into handler.js");

// Handle Incoming Calls
exports.voiceResponse = function voiceResponse(requestBody) {
  const toNumberOrClientName = requestBody.To;
  console.log("📞 Incoming call to:", requestBody.To);
  let twiml = new VoiceResponse();

  const identity = getIdentity(); // Get the latest identity
  console.log(`🔍 [DEBUG] Dialing client: ${identity}`);

  // If the request is to our Twilio Number, route to browser
  if (toNumberOrClientName == callerId) {
    console.log("🟢 [DEBUG] Attempting to route call to browser-client...");
    let dial = twiml.dial({ timeout: 20 }); // Wait for 20 seconds before failing over
    dial.client(identity);
    // If no answer, Twilio will play this message
    twiml.say(
      "Hello! Thank you for calling Iron Wing Dispatching. One of our representatives will call you back soon.",
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
      "Hello! Thank you for calling Iron Wing Dispatching. Our office is currently closed. Please call back during business hours.",
    );

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
//
