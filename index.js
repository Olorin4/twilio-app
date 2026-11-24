/* index.js is responsible for creating the Express server and running it. */

const http = require("http");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const router = require("./src/router");
const { reconcile, reconcileAll } = require("./src/reconciliation");
const {
  requireLogin,
  isTwilioWebhook,
  applyTrustProxy,
} = require("./src/security");

// Create Express webapp
const app = express();
// Before any middleware: req.ip is the client's address (from the edge
// nginx's X-Forwarded-For) only when this is set. Unset keeps Express's
// default (off), and per-client sign-in limits are then off too. An unsafe or
// invalid value logs why and exits.
applyTrustProxy(app, process.env.TRUST_PROXY);
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(async (req, res, next) => {
  if (isTwilioWebhook(req)) return next();
  try {
    return await requireLogin(req, res, next);
  } catch (error) {
    // Fail closed: a login that could not be checked never reaches next().
    console.error("Login middleware failed:", error.message);
    if (!res.headersSent) res.status(503).send("App login is unavailable.");
  }
});
app.use(express.static(path.join(__dirname, "dist")));
app.use(router);

// Create http server and run it:
const server = http.createServer(app);
// The AI receptionist's ConversationRelay WebSocket shares this server.
require("./src/receptionist/server").attach(server);
const port = process.env.PORT || 3001;
server.listen(port, () => console.log("Express server running on *:" + port));
// Logs loudly (never crashes) when migration 013 has not been run.
require("./src/providerContext").checkNumberSchema();
// Logs loudly (never crashes) when migration 014 has not been run, and warns
// when TWILIO_IDENTITY is unset.
require("./src/providerContext").checkUsersSchema();
// Warns when TRUST_PROXY is unset, which turns per-client sign-in limits off.
require("./src/providerContext").checkSignInLimits(app.get("trust proxy"));

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
  require("./src/callAssist/worker").startWorker();
  // setInterval(cleanupOldLogs, 365 * 24 * 60 * 60 * 1000); // Cleanup every year
  console.log("🔄 Auto-sync for calls & messages scheduled.");
}
