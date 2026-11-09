/* index.js is responsible for creating the Express server and running it. */

const http = require("http");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const router = require("./src/router");
const { reconcile, reconcileAll } = require("./src/reconciliation");
const { requireLogin } = require("./src/security");

// Create Express webapp
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use((req, res, next) => {
  if (
    req.method === "POST" &&
    (req.path === "/voice" ||
      req.path === "/sms" ||
      req.path === "/sms-status" ||
      req.path === "/call-status" ||
      /^\/announcement\/(missed|closed)(\/complete)?$/.test(req.path) ||
      /^\/webhooks\/[0-9a-f-]{36}\/(voice|sms|sms-status|call-status|announcement\/(missed|closed)(\/complete)?)$/i.test(
        req.path,
      ))
  )
    return next();
  return requireLogin(req, res, next);
});
app.use(express.static(path.join(__dirname, "dist")));
app.use(router);

// Create http server and run it:
const server = http.createServer(app);
const port = process.env.PORT || 3001;
server.listen(port, () => console.log("Express server running on *:" + port));

// Schedule Automatic Sync and Cleanup:
if (!global.cleanupScheduled) {
  global.cleanupScheduled = true; // Prevent multiple intervals
  setInterval(
    () =>
      reconcileAll().catch((error) =>
        console.error("Twilio reconciliation failed:", error.message),
      ),
    15 * 60 * 1000,
  );
  if (process.env.TWILIO_CALL_WEBHOOKS_VERIFIED !== "true") {
    setInterval(
      () =>
        reconcile().catch((error) =>
          console.error("Twilio reconciliation failed:", error.message),
        ),
      60 * 1000,
    );
  }
  // setInterval(cleanupOldLogs, 365 * 24 * 60 * 60 * 1000); // Cleanup every year
  console.log("🔄 Auto-sync for calls & messages scheduled.");
}
