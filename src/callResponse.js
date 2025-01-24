const VoiceResponse = require("twilio").twiml.VoiceResponse;

exports.voiceResponse = (req, res) => {
  const twiml = new VoiceResponse();

  // Connect the incoming call to a client
  const dial = twiml.dial();
  dial.client("your-client-name"); // Replace with the desired client name

  res.type("text/xml");
  res.send(twiml.toString());
};
