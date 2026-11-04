/* router.je is responsible for handling all the incoming requests to the server. 
It is a collection of routes that are defined using the Express Router. 
The router.js file exports an instance of the Express Router that is used in 
the main index.js file to define the routes for the server. */

const Router = require("express").Router;
const { tokenGenerator } = require("./token");
const { voiceResponse } = require("./callResponse");
const { smsResponse } = require("./smsResponse");
const { logCall, getCallLogs, getMessageLogs } = require("./logManager");
const { sendFax, getFaxStatus } = require("./sendFax");
const { validateWebhook } = require("./security");
const contactsRouter = require("./contacts");
const { sendSms } = require("./sendSms");
const conversations = require("./conversations");
const { stream } = require("./messageEvents");

// Debugging
console.log("🔍 Checking tokenGenerator in router.js:", typeof tokenGenerator);

const router = new Router();

router.use("/contacts", contactsRouter);

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
router.post("/voice", validateWebhook, (req, res) => {
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

// Webhook for fetching latest call logs from database
router.get("/call-logs", getCallLogs);

// Webhook for handling incoming sms
router.post("/sms", validateWebhook, smsResponse);

// Webhook for fetching latest message logs from database
router.get("/message-logs", getMessageLogs);
router.post("/messages", sendSms);
router.post("/sms-status", validateWebhook, conversations.statusCallback);
router.get("/message-events", stream);
router.get("/conversations", conversations.list);
router.get("/conversation", conversations.thread);

// Webhook for sending a fax
router.post("/fax", sendFax);
router.get("/fax/:faxSid", getFaxStatus);

module.exports = router;
