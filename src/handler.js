/* handler.js is responsible for handling incoming calls, messages, faxes and logs
and then exporting them for use in router.js. */

const VoiceResponse = require("twilio").twiml.VoiceResponse;
const AccessToken = require("twilio").jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
const nameGenerator = require("../name_generator");
const fs = require("fs");
const path = require("path");
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
if (!callerId) {
  throw new Error("Caller ID is missing in Twilio configuration.");
}
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

  // If the request to the /voice endpoint is TO your Twilio Number,
  // then it is an incoming call towards your Twilio.Device.
  if (toNumberOrClientName == callerId) {
    let dial = twiml.dial();
    if (global.browserClientConnected) {
      dial.client(identity);
    } else {
      twiml.say(
        "Hello, our office is currently closed. Please call back during business hours.",
      );
    }
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
    twiml.say(
      "Hello, our office is currently closed. Please call back during business hours.",
    );
  }
  console.log("📞 Generated TwiML:", twiml.toString()); // ✅ Log the response for debugging
  return twiml.toString();
};

exports.logCall = (callData) => {
  try {
    if (!fs.existsSync(logFilePath)) fs.writeFileSync(logFilePath, ""); // Create an empty file
    const logMessage = `[${new Date().toISOString()}] Call from: ${callData.From}, To: ${callData.To}, Status: ${callData.CallStatus}\n`;
    fs.appendFileSync(logFilePath, logMessage);
    console.log("✅ Call logged:", logMessage);
  } catch (error) {
    console.error("❌ Error writing call log:", error);
  }
};

// Retrieve call logs as JSON
exports.getCallLogs = (req, res) => {
  const logFilePath = path.join(__dirname, "calls.log");
  try {
    console.log("📁 Checking log file:", logFilePath);
    if (!fs.existsSync(logFilePath)) return res.json([]); // Return empty if no logs exist
    console.log("📖 Reading log file...");
    const logData = fs.readFileSync(logFilePath, "utf8");
    if (!logData.trim()) {
      console.warn("⚠️ Log file is empty.");
      return res.json([]);
    }
    console.log("✅ Log file read successfully!");
    const logs = logData
      .trim()
      .split("\n")
      .map((line) => {
        const [timestamp, details] = line.split("] ");
        return { timestamp: timestamp.replace("[", ""), details };
      });
    console.log("📜 Parsed logs:", logs);
    res.json(logs);
  } catch (err) {
    console.error("❌ Error reading call logs:", err);
    res.status(500).json({ error: "Failed to retrieve logs" });
  }
};

// Handle Incoming SMS
exports.smsResponse = (req, res) => {
  const twiml = new MessagingResponse();
  // Extract SMS details from request body
  const from = req.body.From; // The sender's phone number
  const body = req.body.Body; // The message text

  // Log message to console
  console.log(`Received message from ${from}: ${body}`);

  // Define the log file path
  const logFilePath = path.join(__dirname, "messages.log");

  // Ensure the log file exists or create it
  try {
    if (!fs.existsSync(logFilePath)) {
      fs.writeFileSync(logFilePath, ""); // Create an empty file
    }

    // Append the new message to the log file
    const logMessage = `From: ${from}, Message: ${body}\n`;
    fs.appendFileSync(logFilePath, logMessage);
    console.log("Message saved to messages.log");
  } catch (error) {
    console.error("Error writing to log file:", error);
  }

  // Respond with a TwiML message
  // const incomingMessage = req.body.Body.toLowerCase(); // The incoming SMS content
  // if (incomingMessage.includes("hello")) {
  //   twiml.message("Hello! How can we assist you today?");
  // } else if (incomingMessage.includes("help")) {
  //   twiml.message("Sure, what do you need help with?");
  // } else {
  //   twiml.message(
  //     "Thank you for your message! We will get back to you shortly.",
  //   );
  // }

  res.type("text/xml");
  res.send(twiml.toString());
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

// Send a fax
exports.sendFax = async (req, res) => {
  try {
    const { to, mediaUrl } = req.body; // Get recipient & document URL from request

    if (!to || !mediaUrl) {
      return res
        .status(400)
        .json({ success: false, error: "Missing 'to' or 'mediaUrl'" });
    }

    const fax = await client.fax.faxes.create({
      from: process.env.TWILIO_CALLER_ID, // Load from environment variable
      to,
      mediaUrl,
      statusCallback: `https://${process.env.SERVER_IP}/fax-status`,
    });

    console.log(`Fax sent! SID: ${fax.sid}`);
    res.json({ success: true, faxSid: fax.sid });
  } catch (error) {
    console.error("Failed to send fax:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error,
    });
  }
};

// Fetch Fax Status
exports.getFaxStatus = async (req, res) => {
  try {
    const { faxSid } = req.params;

    if (!faxSid) {
      return res.status(400).json({ success: false, error: "Missing fax SID" });
    }

    const fax = await client.fax.faxes(faxSid).fetch();
    console.log(`Fax status: ${fax.status}`);

    res.json({ success: true, status: fax.status });
  } catch (error) {
    console.error("Failed to fetch fax status:", error);
    res.status(500).json({ success: false, error: error.message });
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
