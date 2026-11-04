/* logManager.js is responsible for fetching call logs
from Twilio
 */

const twilio = require("twilio");
const { accountSid, authToken } = require("./token");
const pool = require("./db");
const { publish } = require("./messageEvents");

const client = twilio(accountSid, authToken);

exports.logMessage = async (message) => {
  await pool.query(
    `INSERT INTO message_logs (message_sid, from_number, to_number, body, timestamp)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (message_sid) DO NOTHING;`,
    [message.MessageSid, message.From, message.To, message.Body, new Date()],
  );
  publish();
};

exports.logCall = async (callData) => {
  try {
    console.log("📞 [DEBUG] Logging call:", callData);
    await pool.query(
      `INSERT INTO call_logs (call_sid, timestamp, from_number, to_number, status, duration, direction)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (call_sid) DO NOTHING;`,
      [
        callData.CallSid,
        new Date(),
        callData.From,
        callData.To,
        callData.CallStatus,
        callData.Duration || 0,
        callData.Direction || "unknown",
      ],
    );
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

    const result = await pool.query(
      `
      SELECT cl.id, 
             cl.from_number, 
             cl.to_number, 
             cl.direction,
             cl.duration,
             (cl.from_number = $1) AS outgoing,
             cl.timestamp,
             d.first_name AS driver_first_name, 
             d.last_name AS driver_last_name, 
             c.name AS company_name
      FROM call_logs cl
      LEFT JOIN driver d ON cl.driver_id = d.id
      LEFT JOIN company c ON d.company_id = c.id
      WHERE $2 = '' OR position($2 in lower(concat_ws(' ', cl.from_number, cl.to_number, d.first_name, d.last_name, c.name))) > 0
         OR EXISTS (SELECT 1 FROM phone_contacts pc WHERE pc.phone IN (cl.from_number, cl.to_number) AND position($2 in lower(pc.name)) > 0)
      ORDER BY cl.timestamp DESC NULLS LAST, cl.id DESC
      LIMIT $4 OFFSET $3;
    `,
      [
        process.env.TWILIO_CALLER_ID,
        params.search,
        params.offset,
        params.pageSize + 1,
      ],
    );

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
      WHERE $2 = '' OR position($2 in lower(concat_ws(' ', m.from_number, m.to_number, m.body, d.first_name, d.last_name, c.name))) > 0
         OR EXISTS (SELECT 1 FROM phone_contacts pc WHERE pc.phone IN (m.from_number, m.to_number) AND position($2 in lower(pc.name)) > 0)
      ORDER BY m.timestamp DESC NULLS LAST, m.id DESC
      LIMIT $4 OFFSET $3;
    `,
      [
        process.env.TWILIO_CALLER_ID,
        params.search,
        params.offset,
        params.pageSize + 1,
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
