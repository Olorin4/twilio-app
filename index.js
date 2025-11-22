/* index.js is responsible for creating the Express server and running it. */

import http from "http";
import path from "path";
import express from "express";
import bodyParser from "body-parser";
import router from "./src/router";
import { syncCallLogs, syncSmsLogs } from "./src/logManager";

// Create Express webapp
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(router);

// Create http server and run it
const server = http.createServer(app);
const port = process.env.PORT || 3001;
server.listen(port, () => console.log("Express server running on *:" + port));

// Schedule Automatic Sync and Cleanup
if (!global.cleanupScheduled) {
    global.cleanupScheduled = true; // Prevent multiple intervals
    setInterval(syncCallLogs, 5 * 55 * 1000);
    setInterval(syncSmsLogs, 5 * 55 * 1000);
    // setInterval(cleanupOldLogs, 365 * 24 * 60 * 60 * 1000); // Cleanup every year
    console.log("🔄 Auto-sync for calls & messages scheduled.");
}
