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

  const currentHour = new Date().getHours(); // Get the current hour in 24-hour format
  const businessHoursStart = 9; // Change this to your start hour
  const businessHoursEnd = 17; // Change this to your closing hour

  if (currentHour < businessHoursStart || currentHour >= businessHoursEnd) {
    // If the call is outside business hours, play the closed message
    console.log("🟠 [DEBUG] Outside business hours. Playing closed message.");
    twiml.say(
      "Hello! Thank you for calling Iron Wing Dispatching. Our office is currently closed. Please call back during business hours.",
    );
  } else if (toNumberOrClientName == callerId) {
    // Call is within business hours, attempt to connect to the client
    console.log("🟢 [DEBUG] Attempting to route call to browser-client...");
    let dial = twiml.dial({ timeout: 20 });

    dial.client(identity);

    // **This message only plays if no one answers within 20 seconds**
    twiml.say(
      "Hello! Thank you for calling Iron Wing Dispatching. One of our representatives will call you back soon.",
    );
  } else if (requestBody.To) {
    // Outgoing call logic
    let dial = twiml.dial({ callerId });
    const attr = isAValidPhoneNumber(toNumberOrClientName)
      ? "number"
      : "client";
    dial[attr]({}, toNumberOrClientName);
  }

  console.log("📞 Generated TwiML:", twiml.toString());
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
