/* smsResponse.js is responsible for handling incoming 
SMS messages. */

const MessagingResponse = require("twilio").twiml.MessagingResponse;
const { logMessage } = require("./logManager");

exports.smsResponse = async (req, res) => {
  const twiml = new MessagingResponse();
  // Extract SMS details from request body
  const from = req.body.From; // The sender's phone number
  const body = req.body.Body; // The message text

  // Log message to console
  console.log(`Received message from ${from}: ${body}`);

  try {
    if (req.providerConnection)
      await logMessage(req.body, req.providerConnection);
    else await logMessage(req.body);
  } catch (error) {
    console.error("Error saving incoming SMS:", error.message);
    return res.sendStatus(500);
  }

  // Respond with a TwiML message (not yet active)
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
