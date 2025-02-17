/* logManager.js is responsible for fetching call logs
from Twilio
 */

const { Pool } = require("pg");
const twilio = require("twilio");
const { accountSid, authToken } = require("./token");

// Configure PostgreSQL connection
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

const client = twilio(accountSid, authToken);

// Function to Find Driver or Client ID Based on Phone Number
async function findUserId(phoneNumber) {
  try {
    // Search for driver
    const driverResult = await pool.query(
      "SELECT id FROM drivers WHERE phone_number = $1",
      [phoneNumber],
    );
    if (driverResult.rows.length > 0)
      return { driverId: driverResult.rows[0].id };

    // Search for client
    const clientResult = await pool.query(
      "SELECT id FROM clients WHERE phone_number = $1",
      [phoneNumber],
    );
    if (clientResult.rows.length > 0)
      return { clientId: clientResult.rows[0].id };

    return {}; // No matching user found
  } catch (err) {
    console.error("❌ [ERROR] Failed to find user ID:", err.message);
    return {};
  }
}

// Fetch and Save Twilio Call Logs to PostgreSQL
exports.syncCallLogs = async () => {
  try {
    console.log("📥 [DEBUG] Fetching latest call logs from Twilio...");
    const calls = await client.calls.list({ limit: 50 });

    for (const call of calls) {
      const { driverId, clientId } = await findUserId(call.from);

      await pool.query(
        `INSERT INTO call_logs (call_sid, timestamp, from_number, to_number, status, duration, direction, driver_id, client_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (call_sid) DO NOTHING;`,
        [
          call.sid,
          call.startTime,
          call.from,
          call.to,
          call.status,
          call.duration,
          call.direction,
          driverId || null,
          clientId || null,
        ],
      );
    }

    console.log("✅ [DEBUG] Call logs synced with driver & client data.");
  } catch (err) {
    console.error("❌ [ERROR] Failed to sync call logs:", err.message);
  }
};

// Fetch Call Logs with Driver & Company Info
exports.getCallLogs = async (req, res) => {
  try {
    console.log("📥 [DEBUG] Fetching call logs from PostgreSQL...");
    const result = await pool.query(`
      SELECT cl.*, 
             d.name AS driver_name, d.phone_number AS driver_phone, 
             c.name AS company_name, c.mc_number, c.dot_number, c.phone AS company_phone
      FROM call_logs cl
      LEFT JOIN drivers d ON cl.driver_id = d.id
      LEFT JOIN companies c ON d.company_id = c.id
      ORDER BY cl.timestamp DESC LIMIT 10;
    `);

    if (result.rows.length === 0) {
      console.warn("⚠️ [WARN] No call logs found.");
      return res.json([]); // Response sent once
    }

    console.log("📜 [DEBUG] Retrieved call logs:", result.rows);
    return res.json(result.rows);
  } catch (err) {
    console.error("❌ [ERROR] Failed to fetch call logs:", err.message);
    return res
      .status(500)
      .json({ error: "Failed to fetch logs", details: err.message });
  }
};

exports.cleanupOldLogs = async () => {
  try {
    console.log("🗑 [DEBUG] Deleting call logs older than 2 years...");
    await pool.query(
      "DELETE FROM call_logs WHERE timestamp < NOW() - INTERVAL '2 years';",
    );
    console.log("✅ [DEBUG] Old call logs deleted.");
  } catch (err) {
    console.error("❌ [ERROR] Failed to delete old logs:", err.message);
  }
};
