const twilio = require("twilio");

// Twilio credentials
const accountSid = "your_account_sid"; // Replace with your Twilio Account SID
const authToken = "your_auth_token"; // Replace with your Twilio Auth Token

// Twilio client
const client = twilio(accountSid, authToken);

// Send a fax
client.fax.faxes
  .create({
    from: "+14092351185", // Your Twilio phone number (must be fax-enabled)
    to: "+18552151627", // EIN application fax number
    mediaUrl: "https://example.com/document.pdf", // Publicly accessible URL to the document
    statusCallback: "https://your-server.com/fax-status",
  })
  .then((fax) => console.log(`Fax sent! SID: ${fax.sid}`))
  .catch((error) => console.error("Failed to send fax:", error));

client.fax
  .faxes("your_fax_sid")
  .fetch()
  .then((fax) => console.log(`Fax status: ${fax.status}`))
  .catch((error) => console.error("Failed to fetch fax status:", error));
