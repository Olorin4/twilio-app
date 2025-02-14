/* logManager.js is responsible for logging call and sms 
data to a file and retrieving the logs as JSON.
 */

const fs = require("fs");
const path = require("path");
const callLogPath = path.join(__dirname, "calls.log");
const smsLogPath = path.join(__dirname, "messages.log");

exports.logCall = (callData) => {
  try {
    console.log("📞 [DEBUG] Logging call:", callData); //  Debugging call data
    if (!fs.existsSync(callLogPath)) fs.writeFileSync(callLogPath, ""); // Create file if missing
    const logMessage = `[${new Date().toISOString()}] Call from: ${callData.From}, To: ${callData.To || "Unknown"}, Status: ${callData.CallStatus || "Unknown"}\n`;
    fs.appendFileSync(callLogPath, logMessage);
    console.log("✅ [DEBUG] Call logged:", logMessage);
  } catch (error) {
    console.error("❌ [ERROR] Error writing call log:", error);
  }
};

// Retrieve call logs as JSON
exports.getCallLogs = (req, res) => {
  try {
    console.log("📥 [DEBUG] /call-logs API called!"); //  Log when API is hit
    const callLogPath = path.join(__dirname, "calls.log");

    console.log("📁 [DEBUG] Checking log file at:", callLogPath); // Logs path
    console.log("📂 [DEBUG] Current directory:", __dirname); // Logs working directory

    if (!fs.existsSync(callLogPath)) {
      console.warn("⚠️ [WARN] Log file does not exist at:", callLogPath);
      return res.json([]);
    }

    console.log("📖 [DEBUG] Reading log file...");
    const logData = fs.readFileSync(callLogPath, "utf8").trim();

    if (!logData) {
      console.warn("⚠️ [WARN] Log file is empty.");
      return res.json([]);
    }

    console.log("✅ [DEBUG] Raw log file content:\n", logData);

    const logs = logData
      .split("\n")
      .map((line) => {
        const match = line.match(
          /^\[(.*?)\] Call from: (.*?), To: (.*?), Status: (.*?)$/,
        );
        if (!match) {
          console.warn("⚠️ [WARN] Skipping malformed log line:", line);
          return null;
        }

        return {
          timestamp: match[1],
          from: match[2],
          to: match[3],
          status: match[4],
        };
      })
      .filter(Boolean); // Remove null values

    console.log("📜 [DEBUG] Parsed logs:", logs);
    res.json(logs);
  } catch (err) {
    console.error("❌ [ERROR] Failed to read call logs:", err.message);
    res
      .status(500)
      .json({ error: "Failed to fetch logs", details: err.message });
  }
};

exports.getLogsAsJSON = (req, res) => {
  try {
    if (!fs.existsSync(smsLogPath)) {
      console.warn("Log file does not exist. Returning empty array.");
      return res.json([]); // Return an empty array
    }

    const logData = fs.readFileSync(smsLogPath, "utf8");
    const messages = logData
      .trim()
      .split("\n")
      .map((line) => {
        const [from, body] = line.split(", Message: ");
        return {
          from: from.replace("From: ", "").trim(),
          body: body.trim(),
        };
      });

    res.json(messages);
  } catch (err) {
    console.error("Error reading log file:", err);
    res.status(500).json({ error: "Failed to read log file" });
  }
};
