/* handler.js is responsible for handling incoming calls, messages, faxes and logs
and then exporting them for use in router.js. */

const VoiceResponse = require("twilio").twiml.VoiceResponse;
const MessagingResponse = require("twilio").twiml.MessagingResponse;
const fs = require("fs");
const path = require("path");
const tokenGenerator = require("./token");

// Debug Twilio credentials
console.log("TWILIO_ACCOUNT_SID:", accountSid);
console.log("TWILIO_AUTH_TOKEN:", authToken);
console.log("TWILIO_APP_SID:", appSid);
console.log("TWILIO_API_KEY:", apiKey);
console.log("TWILIO_API_SECRET:", apiSecret);
console.log("TWILIO_CALLER_ID:", callerId);

// Handle Incoming Calls
exports.voiceResponse = function voiceResponse(requestBody) {
  const toNumberOrClientName = requestBody.To;
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
    twiml.say(
      "Hello, our office is currently closed. Please call back during business hours.",
    );
  }

  return twiml.toString();
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
