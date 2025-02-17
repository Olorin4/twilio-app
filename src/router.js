/* router.je is responsible for handling all the incoming requests to the server. 
It is a collection of routes that are defined using the Express Router. 
The router.js file exports an instance of the Express Router that is used in 
the main index.js file to define the routes for the server. */

const Router = require("express").Router;
const { tokenGenerator } = require("./token");
const { voiceResponse } = require("./callResponse");
const { smsResponse } = require("./smsResponse");
const {
  getCallLogs,
  syncCallLogs,
  cleanupOldLogs,
  getLogsAsJSON,
} = require("./logManager");
const { sendFax, getFaxStatus } = require("./sendFax");

// Debugging
console.log("🔍 Checking tokenGenerator in router.js:", typeof tokenGenerator);

const router = new Router();

router.get("/", (req, res) => res.send("Twilio VoIP API is running!"));

// Webhook for generating an Access Token
router.get("/token", (req, res) => {
  try {
    const token = tokenGenerator();
    console.log("Token generated successfully");
    res.json(token);
  } catch (error) {
    console.error("Error generating token:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

// Webhook for handling voice calls
router.post("/voice", (req, res) => {
  try {
    console.log("📞 Received call webhook event:", req.body);
    logCall(req.body);
    res.set("Content-Type", "text/xml");
    res.send(voiceResponse(req.body));
  } catch (error) {
    console.error("Error processing voice request:", error);
    res
      .status(500)
      .send("<Response><Say>Call handling error.</Say></Response>");
  }
});

// Sync Call Logs from Twilio API to PostgreSQL Every 5 Minutes
setInterval(syncCallLogs, 5 * 60 * 1000);

// Webhook to Fetch Latest Call Logs from Database
router.get("/call-logs", async (req, res) => {
  try {
    await getCallLogs(req, res); // Ensures a single response
  } catch (error) {
    console.error("❌ [ERROR] Error fetching call logs:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to fetch logs" });
    }
  }
});

// Run Cleanup Every 365 Days
setInterval(exports.cleanupOldLogs, 365 * 24 * 60 * 60 * 1000);

// Webhook for handling incoming SMS
router.post("/sms", smsResponse);

// Webhook for fetching logged messages
router.get("/messages", getLogsAsJSON);

// Webhook for sending a fax
router.post("/fax", sendFax);
router.get("/fax/:faxSid", getFaxStatus);

module.exports = router;
