const pool = require("./db");
const { publish } = require("./messageEvents");
const { numbers } = require("./conversations");

async function counts(req, res) {
  try {
    const result = await pool.query(
      `SELECT
      (SELECT count(*) FROM call_logs c, activity_view_settings s
       WHERE c.direction = 'inbound' AND c.timestamp >= s.tracking_started_at
       AND NOT EXISTS (SELECT 1 FROM activity_views v WHERE v.kind = 'call' AND v.item_id = c.id)) AS calls,
      (SELECT count(*) FROM message_logs m, activity_view_settings s
       WHERE m.to_number = ANY($1::text[]) AND NOT (m.from_number = ANY($1::text[]))
       AND m.timestamp >= s.tracking_started_at
       AND NOT EXISTS (SELECT 1 FROM activity_views v WHERE v.kind = 'message' AND v.item_id = m.id)) AS messages`,
      [numbers()],
    );
    res.json({
      calls: Number(result.rows[0].calls),
      messages: Number(result.rows[0].messages),
    });
  } catch (error) {
    console.error("Activity counts failed:", error.message);
    res.status(500).json({ error: "Could not load unviewed activity." });
  }
}
async function markCall(req, res) {
  if (!/^\d+$/.test(req.params.id)) return res.sendStatus(400);
  try {
    const result = await pool.query(
      `INSERT INTO activity_views (kind, item_id)
      SELECT 'call', id FROM call_logs WHERE id = $1::bigint AND direction = 'inbound'
      ON CONFLICT DO NOTHING`,
      [req.params.id],
    );
    if (result.rowCount) publish();
    res.sendStatus(204);
  } catch (error) {
    console.error("Mark call viewed failed:", error.message);
    res.sendStatus(500);
  }
}
async function markConversation(req, res) {
  const { phone, throughId } = req.body || {};
  if (
    typeof phone !== "string" ||
    !/^\+[1-9]\d{1,14}$/.test(phone) ||
    !/^\d+$/.test(String(throughId || ""))
  )
    return res.sendStatus(400);
  try {
    const result = await pool.query(
      `INSERT INTO activity_views (kind, item_id)
      SELECT 'message', m.id FROM message_logs m
      WHERE m.from_number = $1 AND m.to_number = ANY($2::text[]) AND m.id <= $3::bigint
      ON CONFLICT DO NOTHING`,
      [phone, numbers(), String(throughId)],
    );
    if (result.rowCount) publish();
    res.sendStatus(204);
  } catch (error) {
    console.error("Mark conversation viewed failed:", error.message);
    res.sendStatus(500);
  }
}
module.exports = { counts, markCall, markConversation };
