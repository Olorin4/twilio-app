const pool = require("./db");
const { publish } = require("./messageEvents");
const { IRON_WING_WORKSPACE_ID } = require("./workspaceContext");
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
async function saveStatus(sid, status, errorCode, notify = true, owner = {}) {
  if (!/^SM[a-f0-9]{32}$/i.test(sid || "") || !(status in ranks)) return false;
  await pool.query(
    `INSERT INTO message_delivery (message_sid, status, status_rank, error_code, workspace_id, provider_connection_id)
    VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (message_sid) DO UPDATE
    SET status = EXCLUDED.status, status_rank = EXCLUDED.status_rank, error_code = EXCLUDED.error_code, updated_at = now()
    WHERE message_delivery.status_rank < EXCLUDED.status_rank AND message_delivery.workspace_id = EXCLUDED.workspace_id
    AND message_delivery.provider_connection_id IS NOT DISTINCT FROM EXCLUDED.provider_connection_id`,
    [
      sid,
      status,
      ranks[status],
      errorCode || null,
      owner.workspaceId || IRON_WING_WORKSPACE_ID,
      owner.id || null,
    ],
  );
  if (notify) publish();
  return true;
}
async function statusCallback(req, res) {
  try {
    if (
      !(await saveStatus(
        req.body.MessageSid,
        req.body.MessageStatus,
        req.body.ErrorCode,
        true,
        req.providerConnection,
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
async function numbersFor(workspaceId) {
  const result = await pool.query(
    `SELECT n.phone_number FROM connection_numbers n
    JOIN provider_connections c ON c.id = n.connection_id WHERE c.workspace_id = $1`,
    [workspaceId],
  );
  return [
    ...new Set([
      ...result.rows.map((row) => row.phone_number),
      ...(workspaceId === IRON_WING_WORKSPACE_ID ? numbers() : []),
    ]),
  ];
}
async function list(req, res) {
  try {
    const workspaceId = req.workspace?.id || IRON_WING_WORKSPACE_ID;
    const workspaceNumbers = await numbersFor(workspaceId);
    const result = await pool.query(
      `WITH messages AS (
      SELECT m.id, m.body, m.timestamp, CASE WHEN m.from_number = ANY($1::text[]) THEN m.to_number ELSE m.from_number END AS phone,
      CASE WHEN m.from_number = ANY($1::text[]) THEN m.from_number ELSE m.to_number END AS local_number,
      (m.to_number = ANY($1::text[]) AND NOT (m.from_number = ANY($1::text[]))
       AND m.timestamp >= (SELECT tracking_started_at FROM activity_view_settings WHERE id = true)
       AND NOT EXISTS (SELECT 1 FROM activity_views v WHERE v.kind = 'message' AND v.item_id = m.id)) AS unviewed
      FROM message_logs m WHERE m.workspace_id = $2 AND (m.from_number = ANY($1::text[]) OR m.to_number = ANY($1::text[]))
    ) SELECT DISTINCT ON (phone, local_number) phone, local_number, body, timestamp, count(*) FILTER (WHERE unviewed) OVER (PARTITION BY phone, local_number) AS unviewed_count FROM messages WHERE phone IS NOT NULL
      ORDER BY phone, local_number, timestamp DESC NULLS LAST, id DESC`,
      [workspaceNumbers, workspaceId],
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
  const localNumber = req.query.localNumber;
  if (
    typeof phone !== "string" ||
    !/^\+[1-9]\d{1,14}$/.test(phone) ||
    (before && !/^\d+$/.test(before)) ||
    (localNumber !== undefined &&
      (typeof localNumber !== "string" ||
        !/^\+[1-9]\d{1,14}$/.test(localNumber)))
  )
    return res.status(400).json({ error: "Invalid conversation request." });
  try {
    const workspaceId = req.workspace?.id || IRON_WING_WORKSPACE_ID;
    const workspaceNumbers = await numbersFor(workspaceId);
    if (localNumber && !workspaceNumbers.includes(localNumber))
      return res.status(404).json({ error: "Conversation not found." });
    const result = await pool.query(
      `SELECT m.id, m.message_sid, m.body, m.timestamp, (m.from_number = ANY($1::text[])) AS outgoing, d.status, d.error_code
      FROM message_logs m LEFT JOIN message_delivery d ON d.message_sid = m.message_sid AND d.workspace_id = m.workspace_id AND d.provider_connection_id IS NOT DISTINCT FROM m.provider_connection_id
      WHERE m.workspace_id = $4 AND ((m.from_number = ANY($1::text[]) AND m.to_number = $2) OR (m.to_number = ANY($1::text[]) AND m.from_number = $2))
      AND ($5::text IS NULL OR m.from_number = $5 OR m.to_number = $5)
      AND ($3::bigint IS NULL OR (COALESCE(m.timestamp, 'epoch'::timestamp), m.id) < (SELECT COALESCE(cursor.timestamp, 'epoch'::timestamp), cursor.id FROM message_logs cursor WHERE cursor.id = $3::bigint AND cursor.workspace_id = $4))
      ORDER BY m.timestamp DESC NULLS LAST, m.id DESC LIMIT 51`,
      [
        workspaceNumbers,
        phone,
        before || null,
        workspaceId,
        localNumber || null,
      ],
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
module.exports = {
  saveStatus,
  statusCallback,
  list,
  thread,
  numbers,
  numbersFor,
};
