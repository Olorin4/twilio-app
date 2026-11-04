const { client, callerId } = require("./token");
const pool = require("./db");

async function sendSms(req, res) {
  if (!req.is("application/json")) {
    return res.status(415).json({ error: "Use application/json." });
  }
  const { to, body } = req.body || {};
  if (
    typeof to !== "string" ||
    !/^\+[1-9]\d{1,14}$/.test(to.replace(/[ ()-]/g, ""))
  ) {
    return res
      .status(400)
      .json({
        error:
          "Enter a valid phone number with country code, such as +15551234567.",
      });
  }
  if (typeof body !== "string" || !body.trim() || body.length > 1600) {
    return res
      .status(400)
      .json({ error: "Enter a message of 1 to 1600 characters." });
  }
  let message;
  try {
    message = await client.messages.create({
      from: callerId,
      to: to.replace(/[ ()-]/g, ""),
      body,
    });
  } catch (error) {
    console.error("SMS send failed:", error.code || error.message);
    return res
      .status(502)
      .json({
        error:
          error.status >= 400 && error.status < 500 && error.code
            ? `Twilio rejected the message (error ${error.code}).`
            : "Could not confirm whether Twilio accepted the message. Check Twilio before retrying.",
      });
  }
  let saved = true;
  try {
    await pool.query(
      `INSERT INTO message_logs (message_sid, from_number, to_number, body, timestamp)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (message_sid) DO NOTHING`,
      [message.sid, callerId, to.replace(/[ ()-]/g, ""), body, new Date()],
    );
  } catch (error) {
    saved = false;
    console.error("Accepted SMS could not be saved:", error.message);
  }
  return res
    .status(202)
    .json({ sid: message.sid, status: message.status, saved });
}

module.exports = { sendSms };
