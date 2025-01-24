const VoiceResponse = require("twilio").twiml.VoiceResponse;
const AccessToken = require("twilio").jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
const fs = require("fs");
const path = require("path");
const nameGenerator = require("../name_generator");
const config = require("../config");

let identity;

exports.tokenGenerator = function tokenGenerator() {
  identity = nameGenerator();

  const accessToken = new AccessToken(
    config.accountSid,
    config.apiKey,
    config.apiSecret,
  );
  accessToken.identity = identity;
  const grant = new VoiceGrant({
    outgoingApplicationSid: config.twimlAppSid,
    incomingAllow: true,
  });
  accessToken.addGrant(grant);

  // Include identity and token in a JSON response
  return {
    identity: identity,
    token: accessToken.toJwt(),
  };
};

exports.voiceResponse = function voiceResponse(requestBody) {
  const toNumberOrClientName = requestBody.To;
  const callerId = config.callerId;
  let twiml = new VoiceResponse();

  // If the request to the /voice endpoint is TO your Twilio Number,
  // then it is an incoming call towards your Twilio.Device.
  if (toNumberOrClientName == callerId) {
    let dial = twiml.dial();

    // This will connect the caller with your Twilio.Device/client
    dial.client(identity);
  } else if (requestBody.To) {
    // This is an outgoing call

    // set the callerId
    let dial = twiml.dial({ callerId });

    // Check if the 'To' parameter is a Phone Number or Client Name
    // in order to use the appropriate TwiML noun
    const attr = isAValidPhoneNumber(toNumberOrClientName)
      ? "number"
      : "client";
    dial[attr]({}, toNumberOrClientName);
  } else {
    twiml.say("Thanks for calling!");
  }

  return twiml.toString();
};

exports.getLogsAsJSON = (req, res) => {
  const logFilePath = path.join(__dirname, "messages.log");

  try {
    if (!fs.existsSync(logFilePath)) {
      console.warn("Log file does not exist. Returning empty array.");
      return res.json([]); // Return an empty array
    }

    const logData = fs.readFileSync(logFilePath, "utf8");
    const messages = logData
      .trim()
      .split("\n")
      .map((line) => {
        const [from, body] = line.split(", Message: ");
        return {
          from: from.replace("From: ", "").trim(),
          body: body.trim(),
        };
      });

    res.json(messages);
  } catch (err) {
    console.error("Error reading log file:", err);
    res.status(500).json({ error: "Failed to read log file" });
  }
};

/**
 * Checks if the given value is valid as phone number
 * @param {Number|String} number
 * @return {Boolean}
 */
function isAValidPhoneNumber(number) {
  return /^[\d\+\-\(\) ]+$/.test(number);
}
