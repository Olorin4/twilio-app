const { getProvider } = require("./providerContext");
const { IRON_WING_WORKSPACE_ID } = require("./workspaceContext");
const pool = require("./db");
const { publish } = require("./messageEvents");
const { saveStatus } = require("./conversations");

async function sendSms(req, res) {
  if (!req.is("application/json")) {
    return res.status(415).json({ error: "Use application/json." });
  }
  const { to, body, localNumber } = req.body || {};
  if (
    typeof to !== "string" ||
    !/^\+[1-9]\d{1,14}$/.test(to.replace(/[ ()-]/g, ""))
  ) {
    return res.status(400).json({
      error:
        "Enter a valid phone number with country code, such as +15551234567.",
    });
  }
  if (
    localNumber !== undefined &&
    (typeof localNumber !== "string" || !/^\+[1-9]\d{1,14}$/.test(localNumber))
  )
    return res.status(400).json({ error: "Invalid sending number." });
  if (typeof body !== "string" || !body.trim() || body.length > 1600) {
    return res
      .status(400)
      .json({ error: "Enter a message of 1 to 1600 characters." });
  }
  let provider;
  try {
    provider = await getProvider(
      req.workspace?.id || IRON_WING_WORKSPACE_ID,
      req.get?.("X-Connection-Number-Id"),
    );
    if (!provider.smsEnabled)
      return res
        .status(409)
        .json({ error: "The selected number does not support SMS." });
    if (localNumber && localNumber !== provider.phoneNumber)
      return res.status(409).json({
        error: "Select this conversation's sending number before replying.",
      });
  } catch {
    return res
      .status(503)
      .json({ error: "Could not load the selected Twilio connection." });
  }
  let message;
  try {
    message = await provider.client.messages.create({
      from: provider.phoneNumber,
      to: to.replace(/[ ()-]/g, ""),
      body,
      ...(process.env.TWILIO_WEBHOOK_BASE_URL
        ? {
            statusCallback:
              process.env.TWILIO_WEBHOOK_BASE_URL.replace(/\/$/, "") +
              (provider.legacy
                ? "/sms-status"
                : `/webhooks/${provider.id}/sms-status`),
          }
        : {}),
    });
  } catch (error) {
    console.error("SMS send failed:", error.code || error.message);
    return res.status(502).json({
      error:
        error.status >= 400 && error.status < 500 && error.code
          ? `Twilio rejected the message (error ${error.code}).`
          : "Could not confirm whether Twilio accepted the message. Check Twilio before retrying.",
    });
  }
  let saved = true;
  try {
    await pool.query(
      `INSERT INTO message_logs (message_sid, from_number, to_number, body, timestamp, workspace_id, provider_connection_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (message_sid) DO NOTHING`,
      [
        message.sid,
        provider.phoneNumber,
        to.replace(/[ ()-]/g, ""),
        body,
        new Date(),
        provider.workspaceId,
        provider.id || null,
      ],
    );
  } catch (error) {
    saved = false;
    console.error("Accepted SMS could not be saved:", error.message);
  }
  if (saved) publish();
  if (message.status) {
    try {
      await saveStatus(message.sid, message.status, undefined, true, provider);
    } catch (error) {
      console.error("SMS status could not be saved:", error.message);
    }
  }
  return res
    .status(202)
    .json({ sid: message.sid, status: message.status, saved });
}

module.exports = { sendSms };
