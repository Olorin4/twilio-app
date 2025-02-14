/* router.je is responsible for handling all the incoming requests to the server. 
It is a collection of routes that are defined using the Express Router. 
The router.js file exports an instance of the Express Router that is used in 
the main index.js file to define the routes for the server. */

const Router = require("express").Router;
const {
  tokenGenerator,
  voiceResponse,
  logCall,
  getCallLogs,
  smsResponse,
  getLogsAsJSON,
  sendFax,
  getFaxStatus,
} = require("./handler");

// Debugging
console.log("🔍 Checking tokenGenerator in router.js:", typeof tokenGenerator);

const router = new Router();

router.get("/", (req, res) => {
  res.send("Twilio VoIP API is running!");
});

// Checks if Browser App is open
router.post("/client-status", (req, res) => {
  global.browserClientConnected = req.body.connected;
  console.log(
    `🔄 Browser client connection status: ${global.browserClientConnected}`,
  );
  res.json({ status: "updated" });
});

// Webhook for generating an Access Token
router.get("/token", (req, res) => {
  try {
    const token = tokenGenerator();
    console.log("EToken generated successfully");
    res.json(token);
  } catch (error) {
    console.error("Error generating token:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

// Webhook for handling voice calls
router.post("/voice", (req, res) => {
  try {
    console.log("📞 Received webhook event:", req.body);
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

// Webhook for fetching logged calls
router.get("/call-logs", (req, res) => {
  try {
    if (!fs.existsSync("calls.log")) return res.json([]);
    res.json(getCallLogs(req, res));
  } catch (error) {
    console.error("Error fetching call logs:", error);
    res.status(500).json({ error: "Failed to fetch logs" });
  }
});

// Webhook for handling incoming SMS
router.post("/sms", smsResponse);

// Webhook for fetching logged messages
router.get("/messages", getLogsAsJSON);

// Webhook for sending a fax
router.post("/fax", sendFax);
router.get("/fax/:faxSid", getFaxStatus);

module.exports = router;
