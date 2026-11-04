const pool = require("./db");
const { publish } = require("./messageEvents");
const ranks = {
  accepted: 1,
  scheduled: 1,
  queued: 2,
  sending: 3,
  sent: 4,
  failed: 5,
  delivered: 5,
  undelivered: 5,
  canceled: 5,
};
async function saveStatus(sid, status, errorCode) {
  if (!/^SM[a-f0-9]{32}$/i.test(sid || "") || !(status in ranks)) return false;
  await pool.query(
    `INSERT INTO message_delivery (message_sid, status, status_rank, error_code)
    VALUES ($1, $2, $3, $4) ON CONFLICT (message_sid) DO UPDATE
    SET status = EXCLUDED.status, status_rank = EXCLUDED.status_rank, error_code = EXCLUDED.error_code, updated_at = now()
    WHERE message_delivery.status_rank < EXCLUDED.status_rank`,
    [sid, status, ranks[status], errorCode || null],
  );
  publish();
  return true;
}
async function statusCallback(req, res) {
  try {
    if (
      !(await saveStatus(
        req.body.MessageSid,
        req.body.MessageStatus,
        req.body.ErrorCode,
      ))
    )
      return res.sendStatus(400);
    return res.sendStatus(204);
  } catch (error) {
    console.error("SMS status update failed:", error.message);
    return res.sendStatus(500);
  }
}
function numbers() {
  return [
    process.env.TWILIO_CALLER_ID,
    ...(process.env.TWILIO_PREVIOUS_NUMBERS || "").split(","),
  ]
    .map((n) => (n || "").trim())
    .filter((n) => /^\+[1-9]\d{1,14}$/.test(n));
}
async function list(req, res) {
  try {
    const result = await pool.query(
      `WITH messages AS (
      SELECT m.id, m.body, m.timestamp, CASE WHEN m.from_number = ANY($1::text[]) THEN m.to_number ELSE m.from_number END AS phone
      FROM message_logs m WHERE m.from_number = ANY($1::text[]) OR m.to_number = ANY($1::text[])
    ) SELECT DISTINCT ON (phone) phone, body, timestamp FROM messages WHERE phone IS NOT NULL
      ORDER BY phone, timestamp DESC NULLS LAST, id DESC`,
      [numbers()],
    );
    return res.json(
      result.rows.sort(
        (a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0),
      ),
    );
  } catch (error) {
    console.error("Conversation list failed:", error.message);
    return res.status(500).json({ error: "Could not load conversations." });
  }
}
async function thread(req, res) {
  const phone = req.query.phone;
  const before = req.query.before;
  if (
    typeof phone !== "string" ||
    !/^\+[1-9]\d{1,14}$/.test(phone) ||
    (before && !/^\d+$/.test(before))
  )
    return res.status(400).json({ error: "Invalid conversation request." });
  try {
    const result = await pool.query(
      `SELECT m.id, m.message_sid, m.body, m.timestamp, (m.from_number = ANY($1::text[])) AS outgoing, d.status, d.error_code
      FROM message_logs m LEFT JOIN message_delivery d ON d.message_sid = m.message_sid
      WHERE ((m.from_number = ANY($1::text[]) AND m.to_number = $2) OR (m.to_number = ANY($1::text[]) AND m.from_number = $2))
      AND ($3::bigint IS NULL OR (COALESCE(m.timestamp, 'epoch'::timestamp), m.id) < (SELECT COALESCE(cursor.timestamp, 'epoch'::timestamp), cursor.id FROM message_logs cursor WHERE cursor.id = $3::bigint))
      ORDER BY m.timestamp DESC NULLS LAST, m.id DESC LIMIT 51`,
      [numbers(), phone, before || null],
    );
    res.json({
      messages: result.rows.slice(0, 50).reverse(),
      hasMore: result.rows.length > 50,
    });
  } catch (error) {
    console.error("Conversation load failed:", error.message);
    res.status(500).json({ error: "Could not load conversation." });
  }
}
module.exports = { saveStatus, statusCallback, list, thread };
