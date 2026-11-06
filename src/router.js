/* router.je is responsible for handling all the incoming requests to the server. 
It is a collection of routes that are defined using the Express Router. 
The router.js file exports an instance of the Express Router that is used in 
the main index.js file to define the routes for the server. */

const Router = require("express").Router;
const { tokenGenerator, tokenForProvider } = require("./token");
const { voiceResponse } = require("./callResponse");
const { smsResponse } = require("./smsResponse");
const { logCall, getCallLogs, getMessageLogs } = require("./logManager");
const { sendFax, getFaxStatus } = require("./sendFax");
const { validateWebhook } = require("./security");
const contactsRouter = require("./contacts");
const { sendSms } = require("./sendSms");
const conversations = require("./conversations");
const { stream } = require("./messageEvents");
const activityViews = require("./activityViews");
const callEvents = require("./callEvents");
const reconciliation = require("./reconciliation");
const workspaceSettings = require("./workspaceSettings");
const { resolveWorkspace } = require("./workspaceContext");
const { authenticateConnectionWebhook } = require("./connectionWebhooks");
const {
  getProvider,
  getProviderForWebhook,
  legacyProvider,
} = require("./providerContext");

// Debugging
console.log("🔍 Checking tokenGenerator in router.js:", typeof tokenGenerator);

const router = new Router();

router.post(
  "/webhooks/:connectionId/sms",
  authenticateConnectionWebhook,
  async (req, res) => {
    try {
      const provider = await getProviderForWebhook(
        req.providerConnection,
        req.body.To,
      );
      if (!provider.smsEnabled) return res.sendStatus(403);
      return smsResponse(req, res);
    } catch (error) {
      return res.sendStatus(
        error.message === "Invalid configured number." ||
          error.message === "Number is not assigned to this connection." ||
          error.message === "Connection does not own this number."
          ? 403
          : 503,
      );
    }
  },
);
router.post(
  "/webhooks/:connectionId/voice",
  authenticateConnectionWebhook,
  async (req, res) => {
    try {
      const outgoing =
        typeof req.body.From === "string" &&
        req.body.From.startsWith("client:");
      const provider = await getProviderForWebhook(
        req.providerConnection,
        outgoing ? req.body.FromNumber : req.body.To,
      );
      if (!provider.voiceEnabled) return res.sendStatus(403);
      if (outgoing) {
        const selected = await getProvider(req.providerConnection.workspaceId);
        if (
          selected.id !== provider.id ||
          selected.numberId !== provider.numberId
        )
          return res.sendStatus(409);
      }
      logCall(req.body, req.providerConnection);
      res.set("Content-Type", "text/xml");
      return res.send(voiceResponse(req.body, provider));
    } catch (error) {
      return res.sendStatus(
        error.message === "Invalid configured number." ||
          error.message === "Number is not assigned to this connection." ||
          error.message === "Connection does not own this number."
          ? 403
          : 503,
      );
    }
  },
);
router.post(
  "/webhooks/:connectionId/sms-status",
  authenticateConnectionWebhook,
  conversations.statusCallback,
);
router.post(
  "/webhooks/:connectionId/call-status",
  authenticateConnectionWebhook,
  callEvents.callback,
);

router.use(
  [
    "/contacts",
    "/call-logs",
    "/message-logs",
    "/conversations",
    "/conversation",
    "/activity-counts",
    "/activity-views",
    "/token",
    "/messages",
    "/reconcile",
  ],
  resolveWorkspace,
);
router.use("/contacts", contactsRouter);
router.use("/settings", workspaceSettings);

router.get("/", (req, res) => res.send("Twilio VoIP API is running!"));

// Webhook for generating an Access Token
router.get("/token", async (req, res) => {
  try {
    const provider =
      req.get("X-Legacy-Connection") === "true"
        ? legacyProvider(req.workspace.id)
        : await getProvider(
            req.workspace.id,
            req.get("X-Connection-Number-Id"),
          );
    const token = tokenForProvider(provider);
    console.log("Token generated successfully");
    res.json({
      ...token,
      phoneNumber: provider.phoneNumber,
      connectionId: provider.id || null,
    });
  } catch (error) {
    console.error(
      "Error generating token:",
      error.code || "connection unavailable",
    );
    res.status(503).json({
      error: "Could not connect this workspace to the phone service.",
    });
  }
});

// Webhook for handling voice calls
router.post("/voice", validateWebhook, async (req, res) => {
  try {
    if (
      typeof req.body.From === "string" &&
      req.body.From.startsWith("client:")
    ) {
      const selected = await getProvider(
        "00000000-0000-4000-8000-000000000001",
      );
      if (!selected.legacy) return res.sendStatus(409);
    }
    console.log("📞 Received call webhook event:", req.body);
    logCall(req.body);
    res.set("Content-Type", "text/xml");
    res.send(voiceResponse(req.body));
  } catch (error) {
    console.error("Error processing voice request:", error);
    res
      .status(500)
      .send("<Response><Say>Call handling error.</Say></Response>");
  }
});

// Webhook for fetching latest call logs from database
router.get("/call-logs", getCallLogs);

// Webhook for handling incoming sms
router.post("/sms", validateWebhook, smsResponse);

// Webhook for fetching latest message logs from database
router.get("/message-logs", getMessageLogs);
router.post("/messages", sendSms);
router.post("/sms-status", validateWebhook, conversations.statusCallback);
router.post("/call-status", validateWebhook, callEvents.callback);
router.post("/reconcile", reconciliation.handleRequest);
router.get("/message-events", stream);
router.get("/conversations", conversations.list);
router.get("/conversation", conversations.thread);
router.get("/activity-counts", activityViews.counts);
router.post("/activity-views/calls/:id", activityViews.markCall);
router.post("/activity-views/conversation", activityViews.markConversation);

// Webhook for sending a fax
router.use("/fax", resolveWorkspace, async (req, res, next) => {
  try {
    const provider = await getProvider(req.workspace.id);
    if (!provider.legacy)
      return res
        .status(409)
        .json({ error: "Fax is not configured for this connection." });
    return next();
  } catch {
    return res.status(503).json({ error: "Fax connection is unavailable." });
  }
});
router.post("/fax", sendFax);
router.get("/fax/:faxSid", getFaxStatus);

module.exports = router;
