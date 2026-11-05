const pool = require("./db");
const { publish } = require("./messageEvents");
const ranks = {
  queued: 1,
  initiated: 2,
  ringing: 3,
  "in-progress": 4,
  completed: 5,
  busy: 5,
  failed: 5,
  "no-answer": 5,
  canceled: 5,
};
const sidPattern = /^CA[0-9a-f]{32}$/i;

async function saveLeg({ sid, parentSid, status, duration }) {
  if (
    !sidPattern.test(sid || "") ||
    !sidPattern.test(parentSid || "") ||
    !Object.hasOwn(ranks, status)
  )
    return false;
  const seconds =
    /^\d+$/.test(String(duration ?? "")) && Number(duration) <= 2147483647
      ? Number(duration)
      : null;
  await pool.query(
    `INSERT INTO twilio_call_legs (call_sid, parent_call_sid, status, status_rank, answered, duration)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (call_sid) DO UPDATE SET
      status = CASE WHEN EXCLUDED.status_rank > twilio_call_legs.status_rank THEN EXCLUDED.status ELSE twilio_call_legs.status END,
      status_rank = GREATEST(twilio_call_legs.status_rank, EXCLUDED.status_rank),
      answered = twilio_call_legs.answered OR EXCLUDED.answered,
      duration = GREATEST(twilio_call_legs.duration, EXCLUDED.duration),
      updated_at = now()`,
    [
      sid,
      parentSid,
      status,
      ranks[status],
      status === "in-progress" || status === "completed",
      seconds,
    ],
  );
  return true;
}
async function callback(req, res) {
  try {
    const ok = await saveLeg({
      sid: req.body.CallSid,
      parentSid: req.body.ParentCallSid,
      status: req.body.CallStatus,
      duration: req.body.CallDuration,
    });
    if (!ok) return res.sendStatus(400);
    publish();
    return res.sendStatus(204);
  } catch (error) {
    console.error("Call status callback failed:", error.message);
    return res.sendStatus(500);
  }
}
module.exports = { saveLeg, callback };
