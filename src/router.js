/* router.je is responsible for handling all the incoming requests to the server. 
It is a collection of routes that are defined using the Express Router. 
The router.js file exports an instance of the Express Router that is used in 
the main index.js file to define the routes for the server. */

const { tokenGenerator } = require("./token");
const {
  voiceResponse,
  smsResponse,
  getLogsAsJSON,
  sendFax,
  getFaxStatus,
} = require("./handler");

// Debugging
console.log("🔍 Checking tokenGenerator in router.js:", typeof tokenGenerator);

const Router = require("express").Router;
const router = new Router();

router.get("/", (req, res) => {
  res.send("Twilio VoIP API is running!");
});

// Route for generating an Access Token
router.get("/token", (req, res) => {
  try {
    const token = tokenGenerator();
    console.error("EToken generated successfully");
    res.json(token);
  } catch (error) {
    console.error("Error generating token:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

// Route for handling voice calls
router.post("/voice", (req, res) => {
  res.set("Content-Type", "text/xml");
  res.send(voiceResponse(req.body));
});

// Route for handling incoming SMS
router.post("/sms", smsResponse);

// Route for fetching logged messages
router.get("/messages", getLogsAsJSON);

// Route for sending a fax
router.post("/fax", sendFax);
router.get("/fax/:faxSid", getFaxStatus);

module.exports = router;
