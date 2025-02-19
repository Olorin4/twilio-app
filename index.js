/* index.js is responsible for creating the Express server and running it. */

const config = require("./src/config");
const http = require("http");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const router = require("./src/router");
const { syncCallLogs, syncSmsLogs } = require("./src/logManager");

// Create Express webapp
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(router);

// Create http server and run it
const server = http.createServer(app);
const port = config.PORT;
server.listen(port, () => console.log(`Express server running on *:${port}`));

// Schedule Automatic Sync and Cleanup
if (!global.cleanupScheduled) {
  global.cleanupScheduled = true; // Prevent multiple intervals
  setInterval(syncCallLogs, 1 * 60 * 1000);
  setInterval(syncSmsLogs, 1 * 60 * 1000);
  // setInterval(cleanupOldLogs, 365 * 24 * 60 * 60 * 1000); // Cleanup every year
  console.log("🔄 Auto-sync for calls & messages scheduled.");
}
