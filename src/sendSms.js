const { getProvider } = require("./providerContext");
const { IRON_WING_WORKSPACE_ID } = require("./workspaceContext");
const pool = require("./db");
const { publish } = require("./messageEvents");
const { saveStatus } = require("./conversations");
const { mayUseLine, usableLines } = require("./ringing");

const NOT_YOUR_LINE = "You can't send from this line.";

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
  if (!req.user)
    return res.status(401).json({ error: "Authentication required." });
  const workspaceId = req.workspace?.id || IRON_WING_WORKSPACE_ID;
  let provider;
  try {
    if (req.user.role === "owner") {
      provider = await getProvider(
        workspaceId,
        req.get?.("X-Connection-Number-Id"),
      );
    } else {
      // A member sends only from a line assigned to them: the one named by
      // localNumber, else their first. Nothing the browser sends can widen
      // that, and the workspace's active number is never a fallback.
      const lines = await usableLines(req.user, workspaceId, {
        voiceOnly: false,
      });
      const line = localNumber
        ? lines.find((own) => own.phoneNumber === localNumber)
        : lines[0];
      if (!line) return res.status(403).json({ error: NOT_YOUR_LINE });
      provider = await getProvider(workspaceId, line.numberId);
      if (!(await mayUseLine(req.user, provider)))
        return res.status(403).json({ error: NOT_YOUR_LINE });
    }
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
    // Not 502 or 504: Cloudflare replaces those with its own HTML page, and
    // the browser would never see this explanation.
    const rejected = error.status >= 400 && error.status < 500 && error.code;
    return res.status(rejected ? 422 : 503).json({
      error: rejected
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
