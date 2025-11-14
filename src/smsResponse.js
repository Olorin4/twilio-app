/* smsResponse.js is responsible for handling incoming 
SMS messages. */

const fs = require("fs");
const path = require("path");
const { smsLogPath } = require("./logManager");

exports.smsResponse = (req, res) => {
  const twiml = new MessagingResponse();
  // Extract SMS details from request body
  const from = req.body.From; // The sender's phone number
  const body = req.body.Body; // The message text

  // Log message to console
  console.log(`Received message from ${from}: ${body}`);

  // Ensure the log file exists or create it
  try {
    if (!fs.existsSync(smsLogPath)) fs.writeFileSync(smsLogPath, "");
    // Append the new message to the log file
    const logMessage = `From: ${from}, Message: ${body}\n`;
    fs.appendFileSync(smsLogPath, logMessage);
    console.log("Message saved to messages.log");
  } catch (error) {
    console.error("Error writing to log file:", error);
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
