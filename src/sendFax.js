/* sendFax.js is responsible for sending a fax using 
the Twilio API. The sendFax function sends a fax to a 
recipient with a specified media URL. The getFaxStatus 
function fetches the status of a fax using its SID. */

const twilio = require("twilio");
const { client } = require("./token");

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
