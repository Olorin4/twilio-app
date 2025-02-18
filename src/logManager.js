/* logManager.js is responsible for fetching call logs
from Twilio
 */

const twilio = require("twilio");
const { accountSid, authToken } = require("./token");
const { Pool } = require("pg");

// Configure PostgreSQL connection
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASS,
  port: process.env.DB_PORT,
});

const client = twilio(accountSid, authToken);

// Fetch Call Logs with Driver & Company Info
exports.getCallLogs = async (req, res) => {
  try {
    console.log("📥 [DEBUG] Fetching call logs from PostgreSQL...");

    const result = await pool.query(`
      SELECT cl.*, d.name AS driver_name, c.name AS company_name
      FROM call_logs cl
      LEFT JOIN drivers d ON CAST(cl.driver_id AS INTEGER) = d.id
      LEFT JOIN companies c ON d.company_id = c.id
      ORDER BY cl.timestamp DESC LIMIT 10;
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ [ERROR] Failed to fetch call logs:", err.message);
    res
      .status(500)
      .json({ error: "Failed to fetch logs", details: err.message });
  }
};

// Get SMS logs as JSON
exports.getMessageLogs = async (req, res) => {
  try {
    console.log("📥 [DEBUG] Fetching messages from database...");

    const result = await pool.query(`
      SELECT m.*, d.name AS driver_name, c.name AS company_name
      FROM messages m
      LEFT JOIN drivers d ON CAST(m.driver_id AS INTEGER) = d.id
      LEFT JOIN companies c ON d.company_id = c.id
      ORDER BY m.timestamp DESC LIMIT 10;
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ [ERROR] Failed to fetch messages:", err.message);
    res
      .status(500)
      .json({ error: "Failed to fetch messages", details: err.message });
  }
};

// Fetch Call Logs from Twilio API and Store in PostgreSQL
exports.syncCallLogs = async () => {
  try {
    console.log("📥 [DEBUG] Fetching latest call logs from Twilio...");
    const calls = await client.calls.list({ limit: 50 });

    for (const call of calls) {
      await pool.query(
        `INSERT INTO call_logs (call_sid, timestamp, from_number, to_number, status, duration, direction, driver_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
         ON CONFLICT (call_sid) DO NOTHING;`,
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

    console.log("✅ [DEBUG] Call logs synced from Twilio to PostgreSQL.");
  } catch (err) {
    console.error("❌ [ERROR] Failed to sync call logs:", err.message);
  }
};

// Fetch SMS Logs from Twilio API and Store in PostgreSQL
exports.syncSmsLogs = async () => {
  try {
    console.log("📥 [DEBUG] Fetching latest SMS logs from Twilio...");
    const messages = await client.messages.list({ limit: 50 });

    for (const message of messages) {
      await pool.query(
        `INSERT INTO messages (from_number, to_number, body, timestamp, driver_id)
         VALUES ($1, $2, $3, $4, NULL)
         ON CONFLICT (from_number, to_number, body, timestamp) DO NOTHING;`,
        [message.from, message.to, message.body, message.dateSent],
      );
    }

    console.log("✅ [DEBUG] SMS logs synced from Twilio to PostgreSQL.");
  } catch (err) {
    console.error("❌ [ERROR] Failed to sync SMS logs:", err.message);
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
