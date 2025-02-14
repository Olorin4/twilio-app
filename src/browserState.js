/* browserState.js is responsible for managing the state 
of the Browser Twilio app. For now this is deactivated*/

const fs = require("fs");
const path = require("path");

// Ensure the status file exists at startup
function initializeClientStatus() {
  if (!fs.existsSync(statusFile)) {
    fs.writeFileSync(statusFile, JSON.stringify({ connected: false }));
    console.log(
      "🟢 [DEBUG] Created missing client-status.json with `connected: false`",
    );
  }
}

// Read client status from file
function getClientStatus() {
  try {
    if (fs.existsSync(statusFile)) {
      const data = fs.readFileSync(statusFile, "utf8");
      return JSON.parse(data).connected;
    }
  } catch (error) {
    console.error("❌ [ERROR] Failed to read client status:", error);
  }
  return false;
}

// Update client status and save it to file
function updateClientStatus(status) {
  try {
    console.log(`🟢 [DEBUG] Writing status to file: ${statusFile}`);

    fs.writeFileSync(statusFile, JSON.stringify({ connected: status }), "utf8");

    const confirmWrite = fs.readFileSync(statusFile, "utf8");
    console.log(`✅ [DEBUG] File updated. Current content: ${confirmWrite}`);
  } catch (error) {
    console.error("❌ [ERROR] Failed to update client status:", error);
  }
}
