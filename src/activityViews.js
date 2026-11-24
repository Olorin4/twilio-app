const pool = require("./db");
const { publish } = require("./messageEvents");
const { IRON_WING_WORKSPACE_ID } = require("./workspaceContext");
const { lineScope, lineCondition, canSee } = require("./visibility");

// Unread state is shared per workspace, but each person counts and marks
// only what they may see. Both kinds counted here are inbound, so the line
// is the to_number.

async function counts(req, res) {
  try {
    const workspaceId = req.workspace?.id || IRON_WING_WORKSPACE_ID;
    const scope = await lineScope(req.user, workspaceId);
    const callVisible = lineCondition(scope, "c.to_number", "c.from_number", 3);
    const messageVisible = lineCondition(
      scope,
      "m.to_number",
      "m.from_number",
      3,
    );
    const result = await pool.query(
      `SELECT
      (SELECT count(*) FROM call_logs c, activity_view_settings s
       WHERE c.workspace_id = $2 AND c.direction = 'inbound' AND c.from_number NOT LIKE 'client:%' AND c.timestamp >= s.tracking_started_at
       AND ${callVisible.sql}
       AND NOT EXISTS (SELECT 1 FROM activity_views v WHERE v.kind = 'call' AND v.item_id = c.id)) AS calls,
      (SELECT count(*) FROM message_logs m, activity_view_settings s
       WHERE m.workspace_id = $2 AND m.to_number = ANY($1::text[]) AND NOT (m.from_number = ANY($1::text[]))
       AND m.timestamp >= s.tracking_started_at AND ${messageVisible.sql}
       AND NOT EXISTS (SELECT 1 FROM activity_views v WHERE v.kind = 'message' AND v.item_id = m.id)) AS messages`,
      [scope.numbers, workspaceId, ...callVisible.params],
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
    const workspaceId = req.workspace?.id || IRON_WING_WORKSPACE_ID;
    const visible = lineCondition(
      await lineScope(req.user, workspaceId),
      "c.to_number",
      "c.from_number",
      3,
    );
    // A call the person may not see is not found, like one that never was.
    const result = await pool.query(
      `WITH target AS (
        SELECT c.id FROM call_logs c WHERE c.id = $1::bigint AND c.direction = 'inbound'
          AND c.from_number NOT LIKE 'client:%' AND c.workspace_id = $2 AND ${visible.sql}
      ), marked AS (
        INSERT INTO activity_views (kind, item_id) SELECT 'call', id FROM target
        ON CONFLICT DO NOTHING RETURNING 1
      ) SELECT (SELECT count(*) FROM target) AS found, (SELECT count(*) FROM marked) AS inserted`,
      [req.params.id, workspaceId, ...visible.params],
    );
    const row = result.rows[0] || {};
    if (!Number(row.found)) return res.sendStatus(404);
    if (Number(row.inserted)) publish();
    res.sendStatus(204);
  } catch (error) {
    console.error("Mark call viewed failed:", error.message);
    res.sendStatus(500);
  }
}
async function markConversation(req, res) {
  const { phone, throughId, localNumber } = req.body || {};
  if (
    typeof phone !== "string" ||
    !/^\+[1-9]\d{1,14}$/.test(phone) ||
    !/^\d+$/.test(String(throughId || "")) ||
    (localNumber !== undefined &&
      (typeof localNumber !== "string" ||
        !/^\+[1-9]\d{1,14}$/.test(localNumber)))
  )
    return res.sendStatus(400);
  try {
    const workspaceId = req.workspace?.id || IRON_WING_WORKSPACE_ID;
    const scope = await lineScope(req.user, workspaceId);
    const workspaceNumbers = scope.numbers;
    if (
      localNumber &&
      (!workspaceNumbers.includes(localNumber) || !canSee(scope, localNumber))
    )
      return res.sendStatus(404);
    const visible = lineCondition(scope, "m.to_number", "m.from_number", 6);
    const result = await pool.query(
      `INSERT INTO activity_views (kind, item_id)
      SELECT 'message', m.id FROM message_logs m
      WHERE m.from_number = $1 AND m.to_number = ANY($2::text[]) AND m.id <= $3::bigint AND m.workspace_id = $4 AND ($5::text IS NULL OR m.to_number = $5)
      AND ${visible.sql}
      ON CONFLICT DO NOTHING`,
      [
        phone,
        workspaceNumbers,
        String(throughId),
        workspaceId,
        localNumber || null,
        ...visible.params,
      ],
    );
    if (result.rowCount) publish();
    res.sendStatus(204);
  } catch (error) {
    console.error("Mark conversation viewed failed:", error.message);
    res.sendStatus(500);
  }
}
module.exports = { counts, markCall, markConversation };
