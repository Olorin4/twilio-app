const Router = require("express").Router;
const { tokenGenerator, voiceResponse, getLogsAsJSON } = require("./handler");
const { smsResponse } = require("./smsResponse");

const router = new Router();

// Route for generating an Access Token
router.get("/token", (req, res) => {
  res.send(tokenGenerator());
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

module.exports = router;
