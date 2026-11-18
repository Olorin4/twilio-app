/* index.js is responsible for creating the Express server and running it. */

const http = require("http");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const router = require("./src/router");
const { reconcile, reconcileAll } = require("./src/reconciliation");
const { requireLogin, isTwilioWebhook } = require("./src/security");

// Create Express webapp
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use((req, res, next) => {
  if (isTwilioWebhook(req)) return next();
  return requireLogin(req, res, next);
});
app.use(express.static(path.join(__dirname, "dist")));
app.use(router);

// Create http server and run it:
const server = http.createServer(app);
// The AI receptionist's ConversationRelay WebSocket shares this server.
require("./src/receptionist/server").attach(server);
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
  // Sends Jack's leads to Outreach; off unless OUTREACH_INTAKE_ENABLED=1 and
  // the endpoint, token and signing secret are all set.
  if (require("./src/outreachIntake/sender").start())
    console.log("Outreach intake sender started.");
  // setInterval(cleanupOldLogs, 365 * 24 * 60 * 60 * 1000); // Cleanup every year
  console.log("🔄 Auto-sync for calls & messages scheduled.");
}
