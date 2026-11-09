/* logManager.js is responsible for fetching call logs
from Twilio
 */

const twilio = require("twilio");
const { accountSid, authToken } = require("./token");
const pool = require("./db");
const { publish } = require("./messageEvents");
const { IRON_WING_WORKSPACE_ID } = require("./workspaceContext");

const client = twilio(accountSid, authToken);

exports.logMessage = async (message, connection) => {
  await pool.query(
    `INSERT INTO message_logs (message_sid, from_number, to_number, body, timestamp, workspace_id, provider_connection_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (message_sid) DO NOTHING;`,
    [
      message.MessageSid,
      message.From,
      message.To,
      message.Body,
      new Date(),
      connection?.workspaceId || IRON_WING_WORKSPACE_ID,
      connection?.id || null,
    ],
  );
  publish();
};

exports.logCall = async (callData, connection) => {
  try {
    console.log("📞 [DEBUG] Logging call:", callData);
    const result = await pool.query(
      `INSERT INTO call_logs (call_sid, timestamp, from_number, to_number, status, duration, direction, workspace_id, provider_connection_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (call_sid) DO NOTHING;`,
      [
        callData.CallSid,
        new Date(),
        callData.From,
        callData.To,
        callData.CallStatus,
        callData.Duration || 0,
        callData.Direction || "unknown",
        connection?.workspaceId || IRON_WING_WORKSPACE_ID,
        connection?.id || null,
      ],
    );
    if (result.rowCount) publish();
    console.log("✅ [DEBUG] Call logged successfully.");
  } catch (err) {
    console.error("❌ [ERROR] Failed to log call:", err.message);
  }
};

// Fetch Call Logs from Twilio API and Store in PostgreSQL
exports.syncCallLogs = async () => {
  try {
    console.log("📥 [DEBUG] Syncing database with Twilio call logs...");
    const calls = await client.calls.list({ limit: 50 });

    for (const call of calls) {
      await pool.query(
        `INSERT INTO call_logs (call_sid, timestamp, from_number, to_number, status, duration, direction)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (call_sid) DO UPDATE SET
           status = COALESCE(EXCLUDED.status, call_logs.status),
           duration = COALESCE(EXCLUDED.duration, call_logs.duration),
           direction = COALESCE(EXCLUDED.direction, call_logs.direction);`,
        [
          call.sid,
          call.startTime,
          call.from,
          call.to,
          call.status,
          call.duration,
          call.direction,
        ],
      );
    }

    console.log("✅ [DEBUG] Call logs synced from Twilio to the database.");
  } catch (err) {
    console.error("❌ [ERROR] Failed to sync call logs:", err.message);
  }
};

// Fetch SMS Logs from Twilio API and Store in PostgreSQL
exports.syncSmsLogs = async () => {
  try {
    console.log("📥 [DEBUG] Syncing database with Twilio sms logs...");
    const messages = await client.messages.list({ limit: 50 });

    for (const message of messages) {
      await pool.query(
        `INSERT INTO message_logs (message_sid, from_number, to_number, body, timestamp)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (message_sid) DO NOTHING;`,
        [
          message.sid,
          message.from,
          message.to,
          message.body,
          message.dateSent || message.dateCreated,
        ],
      );
    }

    console.log("✅ [DEBUG] SMS logs synced from Twilio to the database.");
  } catch (err) {
    console.error("❌ [ERROR] Failed to sync SMS logs:", err.message);
  }
};

function historyParams(req) {
  const page = Number(req.query?.page ?? 1);
  const pageSize = Number(req.query?.pageSize ?? 10);
  const search =
    typeof req.query?.search === "string"
      ? req.query.search.trim().slice(0, 120).toLowerCase()
      : "";
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 100000 ||
    ![10, 20, 50].includes(pageSize)
  )
    return null;
  return { offset: (page - 1) * pageSize, pageSize, search };
}

// Fetch Call Logs
exports.getCallLogs = async (req, res) => {
  const params = historyParams(req);
  if (!params)
    return res.status(400).json({ error: "Invalid page or page size." });
  try {
    console.log("📥 [DEBUG] Fetching call log from postgreSQL...");

    const callQuery = `
      SELECT cl.id, 
             cl.from_number, 
             cl.to_number, 
             cl.direction,
             COALESCE((SELECT leg.status FROM twilio_call_legs leg WHERE (cl.from_number = $1 OR cl.from_number LIKE 'client:%') AND leg.parent_call_sid = cl.call_sid AND leg.workspace_id = cl.workspace_id AND leg.provider_connection_id IS NOT DISTINCT FROM cl.provider_connection_id ORDER BY leg.updated_at DESC LIMIT 1), cl.status) AS status,
             (cl.direction = 'inbound' AND cl.from_number NOT LIKE 'client:%' AND EXISTS (SELECT 1 FROM twilio_call_legs leg WHERE leg.parent_call_sid = cl.call_sid AND leg.workspace_id = cl.workspace_id AND leg.provider_connection_id IS NOT DISTINCT FROM cl.provider_connection_id AND leg.status IN ('busy', 'failed', 'no-answer', 'canceled') AND NOT leg.answered) AND NOT EXISTS (SELECT 1 FROM twilio_call_legs leg WHERE leg.parent_call_sid = cl.call_sid AND leg.workspace_id = cl.workspace_id AND leg.provider_connection_id IS NOT DISTINCT FROM cl.provider_connection_id AND leg.answered)) AS missed,
             EXISTS (SELECT 1 FROM twilio_call_legs leg WHERE leg.parent_call_sid = cl.call_sid AND leg.workspace_id = cl.workspace_id AND leg.provider_connection_id IS NOT DISTINCT FROM cl.provider_connection_id AND leg.answered) AS answered,
             (SELECT json_build_object('kind', a.kind, 'initiated', a.initiated_at IS NOT NULL, 'completed', a.completed_at IS NOT NULL) FROM call_announcements a WHERE a.call_sid = cl.call_sid AND a.workspace_id = cl.workspace_id AND a.provider_connection_id IS NOT DISTINCT FROM cl.provider_connection_id) AS announcement,
             (cl.direction = 'inbound' AND cl.from_number NOT LIKE 'client:%' AND cl.timestamp >= (SELECT tracking_started_at FROM activity_view_settings WHERE id = true)
              AND NOT EXISTS (SELECT 1 FROM activity_views v WHERE v.kind = 'call' AND v.item_id = cl.id)) AS unviewed,
             COALESCE((SELECT leg.duration FROM twilio_call_legs leg WHERE cl.direction = 'inbound' AND leg.parent_call_sid = cl.call_sid AND leg.workspace_id = cl.workspace_id AND leg.provider_connection_id IS NOT DISTINCT FROM cl.provider_connection_id AND (leg.answered OR cl.from_number = $1 OR cl.from_number LIKE 'client:%') AND leg.duration IS NOT NULL ORDER BY leg.updated_at DESC LIMIT 1), cl.duration) AS duration,
             (cl.from_number = $1 OR cl.from_number LIKE 'client:%') AS outgoing,
             CASE WHEN cl.from_number LIKE 'client:%' THEN
               (SELECT child.from_number FROM twilio_call_legs leg JOIN call_logs child ON child.call_sid = leg.call_sid
                AND child.workspace_id = cl.workspace_id AND child.provider_connection_id IS NOT DISTINCT FROM cl.provider_connection_id
                WHERE leg.parent_call_sid = cl.call_sid AND leg.workspace_id = cl.workspace_id
                  AND leg.provider_connection_id IS NOT DISTINCT FROM cl.provider_connection_id
                  AND child.from_number ~ '^[+][1-9][0-9]{1,14}$'
                ORDER BY leg.updated_at DESC LIMIT 1)
             WHEN cl.direction LIKE 'outbound%' OR cl.from_number = $1 THEN cl.from_number
             ELSE cl.to_number END AS local_number,
             cl.timestamp,
             d.first_name AS driver_first_name, 
             d.last_name AS driver_last_name, 
             c.name AS company_name
      FROM call_logs cl
      LEFT JOIN driver d ON cl.driver_id = d.id
      LEFT JOIN company c ON d.company_id = c.id
      WHERE cl.workspace_id = $5
        AND NOT EXISTS (
          SELECT 1 FROM twilio_call_legs leg
          JOIN call_logs parent ON parent.call_sid = leg.parent_call_sid
            AND parent.workspace_id = cl.workspace_id
            AND parent.provider_connection_id IS NOT DISTINCT FROM cl.provider_connection_id
          WHERE leg.call_sid = cl.call_sid
            AND leg.workspace_id = cl.workspace_id
            AND leg.provider_connection_id IS NOT DISTINCT FROM cl.provider_connection_id
        )
        AND ($2 = '' OR position($2 in lower(concat_ws(' ', cl.from_number, cl.to_number, d.first_name, d.last_name, c.name))) > 0
         OR EXISTS (SELECT 1 FROM phone_contacts pc WHERE pc.workspace_id = $5 AND pc.phone IN (cl.from_number, cl.to_number) AND position($2 in lower(pc.name)) > 0))
    `;
    const grouped = req.query?.grouped === "true";
    const query = grouped
      ? `WITH calls AS (${callQuery}), keyed AS (
          SELECT calls.*, CASE
            WHEN COALESCE(CASE WHEN direction LIKE 'outbound%' OR outgoing THEN to_number ELSE from_number END, '') = ''
              THEN 'unknown:' || id::text
            ELSE 'phone:' || regexp_replace(CASE WHEN direction LIKE 'outbound%' OR outgoing THEN to_number ELSE from_number END, '[[:space:]().-]', '', 'g')
          END AS group_key FROM calls
        ), groups AS (
          SELECT group_key, MAX(timestamp) AS latest, MAX(id) AS newest_id
          FROM keyed GROUP BY group_key
          ORDER BY latest DESC NULLS LAST, newest_id DESC
          LIMIT $4 OFFSET $3
        )
        SELECT groups.group_key, json_agg(
          jsonb_set(to_jsonb(keyed) - 'group_key', '{timestamp}',
            COALESCE(to_jsonb(keyed.timestamp AT TIME ZONE 'UTC'), 'null'::jsonb))
          ORDER BY keyed.timestamp DESC NULLS LAST, keyed.id DESC
        ) AS calls
        FROM groups JOIN keyed USING (group_key)
        GROUP BY groups.group_key, groups.latest, groups.newest_id
        ORDER BY groups.latest DESC NULLS LAST, groups.newest_id DESC`
      : `${callQuery} ORDER BY cl.timestamp DESC NULLS LAST, cl.id DESC LIMIT $4 OFFSET $3`;
    const result = await pool.query(query, [
      process.env.TWILIO_CALLER_ID,
      params.search,
      params.offset,
      params.pageSize + 1,
      req.workspace?.id || IRON_WING_WORKSPACE_ID,
    ]);

    res.set("X-Has-More", String(result.rows.length > params.pageSize));
    res.json(result.rows.slice(0, params.pageSize));
  } catch (err) {
    console.error("❌ [ERROR] Failed to fetch call log:", err.message);
    res
      .status(500)
      .json({ error: "Failed to fetch logs", details: err.message });
  }
};

// Get SMS logs
exports.getMessageLogs = async (req, res) => {
  const params = historyParams(req);
  if (!params)
    return res.status(400).json({ error: "Invalid page or page size." });
  try {
    console.log("📥 [DEBUG] Fetching message log from postgreSQL...");

    const result = await pool.query(
      `
      SELECT m.id, 
             m.from_number, 
             m.to_number, 
             (m.from_number = $1) AS outgoing,
             m.body, 
             m.timestamp,
             d.first_name AS driver_first_name, 
             d.last_name AS driver_last_name,  
             c.name AS company_name
      FROM message_logs m
      LEFT JOIN driver d ON m.driver_id = d.id
      LEFT JOIN company c ON d.company_id = c.id
      WHERE m.workspace_id = $5 AND ($2 = '' OR position($2 in lower(concat_ws(' ', m.from_number, m.to_number, m.body, d.first_name, d.last_name, c.name))) > 0
         OR EXISTS (SELECT 1 FROM phone_contacts pc WHERE pc.workspace_id = $5 AND pc.phone IN (m.from_number, m.to_number) AND position($2 in lower(pc.name)) > 0))
      ORDER BY m.timestamp DESC NULLS LAST, m.id DESC
      LIMIT $4 OFFSET $3;
    `,
      [
        process.env.TWILIO_CALLER_ID,
        params.search,
        params.offset,
        params.pageSize + 1,
        req.workspace?.id || IRON_WING_WORKSPACE_ID,
      ],
    );

    res.set("X-Has-More", String(result.rows.length > params.pageSize));
    res.json(result.rows.slice(0, params.pageSize));
  } catch (err) {
    console.error("❌ [ERROR] Failed to fetch message log:", err.message);
    res
      .status(500)
      .json({ error: "Failed to fetch messages", details: err.message });
  }
};

// // Cleanup Function (Deletes Logs Older Than 1 Year)
// exports.cleanupOldLogs = async () => {
//   try {
//     // Check if any logs older than 1 year exist
//     const { rowCount } = await pool.query(
//       "SELECT * FROM call_logs WHERE timestamp < NOW() - INTERVAL '1 year';",
//     );
//     if (rowCount === 0) {
//       console.log("🛑 [INFO] No old call logs found. Cleanup skipped.");
//       return;
//     }

//     console.log("🗑 [DEBUG] Deleting call logs older than 1 year...");
//     await pool.query(
//       "DELETE FROM call_logs WHERE timestamp < NOW() - INTERVAL '1 year';",
//     );
//     console.log("✅ [DEBUG] Old call logs deleted.");
//   } catch (err) {
//     console.error("❌ [ERROR] Failed to delete old logs:", err.message);
//   }
// };
