/* handler.js is responsible for handling incoming calls, messages, faxes and logs
and then exporting them for use in router.js. */

const VoiceResponse = require("twilio").twiml.VoiceResponse;
const AccessToken = require("twilio").jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
const nameGenerator = require("../name_generator");
const fs = require("fs");
const path = require("path");
const statusFile = path.join(__dirname, "client-status.json");
const logFilePath = path.join(__dirname, "calls.log");
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

// Ensure the status file exists at startup
function initializeClientStatus() {
  if (!fs.existsSync(statusFile)) {
    fs.writeFileSync(statusFile, JSON.stringify({ connected: false }));
    console.log(
      "🟢 [DEBUG] Created missing client-status.json with `connected: false`",
    );
  }
}

// Read client status from file
function getClientStatus() {
  try {
    if (fs.existsSync(statusFile)) {
      const data = fs.readFileSync(statusFile, "utf8");
      return JSON.parse(data).connected;
    }
  } catch (error) {
    console.error("❌ [ERROR] Failed to read client status:", error);
  }
  return false;
}

// Update client status and save it to file
function updateClientStatus(status) {
  try {
    console.log(`🟢 [DEBUG] Received status update: ${status}`);

    if (typeof status === "boolean") {
      console.log(`📝 [DEBUG] Writing status to file: ${statusFile}`);

      // Ensure the write actually happens
      fs.writeFileSync(
        statusFile,
        JSON.stringify({ connected: status }),
        "utf8",
      );

      // Double-check the file after writing
      const confirmWrite = fs.readFileSync(statusFile, "utf8");
      console.log(`✅ [DEBUG] File updated. Current content: ${confirmWrite}`);
    } else console.warn("⚠️ [WARNING] Invalid status received:", status);
  } catch (error) {
    console.error("❌ [ERROR] Failed to update client status:", error);
  }
}

// API Route: Update Browser Client Status
exports.updateClientStatus = (req, res) => {
  const status = req.body.connected;
  updateClientStatus(status);
  res.json({ status: "updated", connected: status });
};

// Handle Incoming Calls
exports.voiceResponse = function voiceResponse(requestBody) {
  const toNumberOrClientName = requestBody.To;
  console.log("📞 Incoming call to:", requestBody.To);
  let twiml = new VoiceResponse();
  const isClientConnected = getClientStatus();

  // If the request to the /voice endpoint is TO your Twilio Number,
  // then it is an incoming call towards your Twilio.Device.
  if (toNumberOrClientName == callerId) {
    let dial = twiml.dial();
    if (isClientConnected) {
      console.log("🟢 [DEBUG] Browser client is online. Routing call...");
      dial.client("browser-client");
    } else {
      console.log(
        "🔴 [DEBUG] No browser client connected. Sending auto-message...",
      );
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
    console.log("📞 [DEBUG] Logging call:", callData); // ✅ Debugging call data
    if (!fs.existsSync(logFilePath)) fs.writeFileSync(logFilePath, ""); // Create file if missing
    const logMessage = `[${new Date().toISOString()}] Call from: ${callData.From}, To: ${callData.To || "Unknown"}, Status: ${callData.CallStatus || "Unknown"}\n`;
    fs.appendFileSync(logFilePath, logMessage);
    console.log("✅ [DEBUG] Call logged:", logMessage);
  } catch (error) {
    console.error("❌ [ERROR] Error writing call log:", error);
  }
};

// Retrieve call logs as JSON
exports.getCallLogs = (req, res) => {
  try {
    console.log("📥 [DEBUG] /call-logs API called!"); // ✅ Log when API is hit
    const logFilePath = path.join(__dirname, "calls.log");

    console.log("📁 [DEBUG] Checking log file at:", logFilePath); // Logs path
    console.log("📂 [DEBUG] Current directory:", __dirname); // Logs working directory

    if (!fs.existsSync(logFilePath)) {
      console.warn("⚠️ [WARN] Log file does not exist at:", logFilePath);
      return res.json([]);
    }

    console.log("📖 [DEBUG] Reading log file...");
    const logData = fs.readFileSync(logFilePath, "utf8").trim();

    if (!logData) {
      console.warn("⚠️ [WARN] Log file is empty.");
      return res.json([]);
    }

    console.log("✅ [DEBUG] Raw log file content:\n", logData);

    const logs = logData
      .split("\n")
      .map((line) => {
        const match = line.match(
          /^\[(.*?)\] Call from: (.*?), To: (.*?), Status: (.*?)$/,
        );
        if (!match) {
          console.warn("⚠️ [WARN] Skipping malformed log line:", line);
          return null;
        }

        return {
          timestamp: match[1],
          from: match[2],
          to: match[3],
          status: match[4],
        };
      })
      .filter(Boolean); // Remove null values

    console.log("📜 [DEBUG] Parsed logs:", logs);
    res.json(logs);
  } catch (err) {
    console.error("❌ [ERROR] Failed to read call logs:", err.message);
    res
      .status(500)
      .json({ error: "Failed to fetch logs", details: err.message });
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

// Initialize status file at startup
initializeClientStatus();

/**
 * Checks if the given value is valid as phone number
 * @param {Number|String} number
 * @return {Boolean}
 */
function isAValidPhoneNumber(number) {
  return /^[\d\+\-\(\) ]+$/.test(number);
}
