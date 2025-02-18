/* index.js is responsible for creating the Express server and running it. */

const http = require("http");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const router = require("./src/router");
const { syncCallLogs, cleanupOldLogs } = require("./src/logManager");

// Create Express webapp
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use(router);

// Create http server and run it
const server = http.createServer(app);
const port = process.env.PORT || 3001;

server.listen(port, function () {
  console.log("Express server running on *:" + port);
});

// Schedule Automatic Sync and Cleanup
if (!global.cleanupScheduled) {
  global.cleanupScheduled = true; // Ensures this block only runs once

  setInterval(syncCallLogs, 5 * 60 * 1000); // Sync every 5 minutes
  setInterval(cleanupOldLogs, 365 * 24 * 60 * 60 * 1000); // Cleanup every 365 days
  console.log(
    "🔄 [DEBUG] Log Manager: Auto-sync (5 min) and cleanup (1 year) scheduled.",
  );
}
