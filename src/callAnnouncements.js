const {
  twiml: { VoiceResponse },
} = require("twilio");
const pool = require("./db");
const { publish } = require("./messageEvents");
const { IRON_WING_WORKSPACE_ID } = require("./workspaceContext");

async function saveEvent(callSid, kind, complete, owner = {}) {
  if (
    !/^CA[0-9a-f]{32}$/i.test(callSid || "") ||
    !["missed", "closed"].includes(kind)
  )
    return false;
  const result = await pool.query(
    `INSERT INTO call_announcements (call_sid, workspace_id, provider_connection_id, kind, initiated_at, completed_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN NULL ELSE now() END, CASE WHEN $5 THEN now() ELSE NULL END)
     ON CONFLICT (call_sid) DO UPDATE SET
       initiated_at = COALESCE(call_announcements.initiated_at, EXCLUDED.initiated_at),
       completed_at = COALESCE(call_announcements.completed_at, EXCLUDED.completed_at)
     WHERE call_announcements.workspace_id = EXCLUDED.workspace_id
       AND call_announcements.provider_connection_id IS NOT DISTINCT FROM EXCLUDED.provider_connection_id
       AND call_announcements.kind = EXCLUDED.kind`,
    [
      callSid,
      owner.workspaceId || IRON_WING_WORKSPACE_ID,
      owner.id || null,
      kind,
      complete,
    ],
  );
  if (result.rowCount) publish();
  return Boolean(result.rowCount);
}

async function handle(req, res) {
  const kind = req.params.kind;
  const complete = req.params.phase === "complete";
  if (
    !["missed", "closed"].includes(kind) ||
    (req.params.phase && !complete) ||
    !/^CA[0-9a-f]{32}$/i.test(req.body.CallSid || "")
  )
    return res.sendStatus(400);
  const response = new VoiceResponse();
  if (
    !complete &&
    kind === "missed" &&
    ["completed", "answered"].includes(req.body.DialCallStatus)
  ) {
    response.hangup();
    return res.type("text/xml").send(response.toString());
  }
  try {
    await saveEvent(req.body.CallSid, kind, complete, req.providerConnection);
  } catch (error) {
    // Tracking must not prevent the caller from receiving the greeting.
    console.error("Call announcement tracking failed:", error.message);
  }
  if (!complete) {
    const ironWing =
      !req.providerConnection ||
      req.providerConnection.workspaceId === IRON_WING_WORKSPACE_ID;
    response.say(
      kind === "closed"
        ? "Hello! Thank you for calling Iron Wing Dispatching. Our office is currently closed. Please call back during business hours."
        : ironWing
          ? "Hello! Thank you for calling Iron Wing Dispatching. One of our representatives will call you back soon."
          : "Hello! Thank you for calling. One of our representatives will call you back soon.",
    );
    const prefix = req.providerConnection
      ? `/webhooks/${req.providerConnection.id}/announcement`
      : "/announcement";
    response.redirect(
      `${process.env.TWILIO_WEBHOOK_BASE_URL.replace(/\/$/, "")}${prefix}/${kind}/complete`,
    );
  } else response.hangup();
  return res.type("text/xml").send(response.toString());
}
module.exports = { handle, saveEvent };
