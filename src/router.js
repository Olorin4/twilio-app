/* router.je is responsible for handling all the incoming requests to the server. 
It is a collection of routes that are defined using the Express Router. 
The router.js file exports an instance of the Express Router that is used in 
the main index.js file to define the routes for the server. */

const Router = require("express").Router;
const { tokenGenerator, tokenFor } = require("./token");
const { voiceResponse } = require("./callResponse");
const {
  ringIdentities,
  lineRole,
  mayUseLine,
  usableLines,
} = require("./ringing");
const { parseIdentity, isClientOf } = require("./identity");
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
const callAnnouncements = require("./callAnnouncements");
const reconciliation = require("./reconciliation");
const workspaceSettings = require("./workspaceSettings");
const {
  IRON_WING_WORKSPACE_ID,
  canOpenWorkspace,
  resolveWorkspace,
} = require("./workspaceContext");
const { authenticateConnectionWebhook } = require("./connectionWebhooks");
const receptionist = require("./receptionist/twiml");
const callAssist = require("./callAssist/store");
const bindCallIntent = (body, provider) =>
  callAssist
    .bindIntent(body, provider)
    .catch((error) =>
      console.error("Could not link callback:", error.code || "unavailable"),
    );
const {
  getProvider,
  getProviderForWebhook,
  legacyProvider,
} = require("./providerContext");

// Debugging
console.log("🔍 Checking tokenGenerator in router.js:", typeof tokenGenerator);

const router = new Router();

// Who is calling out, from the softphone identity Twilio signed into From.
// Webhooks have no session, so this is the only source of the user.
const callerOf = (from) => {
  const parsed = parseIdentity(from);
  return parsed.bootstrap
    ? { id: null, bootstrap: true }
    : { id: parsed.userId };
};

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
      // A softphone of another line, or no softphone at all, is never
      // treated as an owner.
      if (outgoing && !isClientOf(req.body.From, req.providerConnection))
        return res.sendStatus(403);
      const provider = await getProviderForWebhook(
        req.providerConnection,
        outgoing ? req.body.FromNumber : req.body.To,
      );
      if (!provider.voiceEnabled) return res.sendStatus(403);
      if (outgoing) {
        const role = await lineRole(callerOf(req.body.From), provider);
        if (!role) return res.sendStatus(403);
        // Owners call from the workspace's active number, as before; a
        // member calls from their own line.
        if (role === "owner") {
          const selected = await getProvider(
            req.providerConnection.workspaceId,
          );
          if (
            selected.id !== provider.id ||
            selected.numberId !== provider.numberId
          )
            return res.sendStatus(409);
        }
      }
      if (outgoing && req.body.AssistIntent)
        await bindCallIntent(req.body, provider);
      logCall(req.body, req.providerConnection);
      res.set("Content-Type", "text/xml");
      // The AI receptionist takes the call when it should; otherwise (and on
      // any failure) the call follows the path it always has.
      const agent = outgoing
        ? null
        : await receptionist.agentTwiml({
            body: req.body,
            provider,
            connection: req.providerConnection,
          });
      if (agent) return res.send(agent);
      // Read only when the softphones ring, so agent calls never wait on it.
      const ring = outgoing ? undefined : await ringIdentities(provider);
      return res.send(voiceResponse(req.body, provider, ring));
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
async function transcriptionCallback(req, res) {
  try {
    await callAssist.ingest(req, res);
  } catch (error) {
    console.error("Call assist webhook failed:", error.code || "unavailable");
    res.sendStatus(503);
  }
}
router.post(
  "/webhooks/:connectionId/transcription/:sessionId",
  authenticateConnectionWebhook,
  transcriptionCallback,
);
router.post(
  "/transcription/:sessionId",
  validateWebhook,
  (req, res, next) => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    if (!accountSid || req.body?.AccountSid !== accountSid)
      return res.sendStatus(403);
    req.providerConnection = {
      workspaceId: IRON_WING_WORKSPACE_ID,
      id: null,
      accountSid,
    };
    return next();
  },
  transcriptionCallback,
);
router.post(
  "/webhooks/:connectionId/announcement/:kind/:phase?",
  authenticateConnectionWebhook,
  callAnnouncements.handle,
);
router.post(
  "/announcement/:kind/:phase?",
  validateWebhook,
  callAnnouncements.handle,
);
router.post(
  "/webhooks/:connectionId/receptionist/ended",
  authenticateConnectionWebhook,
  receptionist.endedHandler,
);
router.post("/receptionist/ended", validateWebhook, receptionist.endedHandler);

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
    "/leads",
    "/call-assist",
  ],
  resolveWorkspace,
);
router.use("/contacts", contactsRouter);
router.use("/settings", workspaceSettings);
router.use("/leads", require("./receptionist/routes"));
router.use("/call-assist", require("./callAssist/routes"));

router.get("/", (req, res) => res.send("Twilio VoIP API is running!"));

// The signed-in user, for the browser to tailor what it shows.
router.get("/me", (req, res) => {
  const user = req.user;
  if (!user) return res.status(401).json({ error: "Authentication required." });
  return res.json({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    bootstrap: user.bootstrap === true,
  });
});

// The lines the signed-in user may call and text from in a workspace.
router.get("/me/lines", async (req, res) => {
  const user = req.user;
  if (!user) return res.status(401).json({ error: "Authentication required." });
  const workspaceId = req.query?.workspace;
  if (
    typeof workspaceId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      workspaceId,
    )
  )
    return res.status(400).json({ error: "Invalid workspace." });
  if (!canOpenWorkspace(user, workspaceId))
    return res.status(404).json({ error: "Workspace not found." });
  try {
    return res.json(await usableLines(user, workspaceId));
  } catch (error) {
    console.error("Lines lookup failed:", error.message);
    return res.status(503).json({ error: "Could not load your lines." });
  }
});

const NO_LINE = "No line is assigned to you in this workspace.";

// Webhook for generating an Access Token
router.get("/token", async (req, res) => {
  try {
    let provider =
      req.get("X-Legacy-Connection") === "true"
        ? legacyProvider(req.workspace.id)
        : await getProvider(
            req.workspace.id,
            req.get("X-Connection-Number-Id"),
          );
    // The legacy line is owners only, however it was reached.
    if (provider.legacy && req.user?.role !== "owner")
      return res
        .status(403)
        .json({ error: "Only an owner can use this line." });
    // A member's token, and the number it echoes, are only ever for a line
    // they may use: the one asked for when it is theirs, else their first
    // line on that connection. Never the workspace's active number by
    // default, which may be someone's personal line.
    if (!provider.legacy && req.user?.role !== "owner") {
      if (!(await mayUseLine(req.user, provider))) {
        const own = (await usableLines(req.user, req.workspace.id)).find(
          (line) => line.connectionId === provider.id,
        );
        if (!own) return res.status(403).json({ error: NO_LINE });
        provider = await getProvider(req.workspace.id, own.numberId);
      }
    }
    // The identity is always req.user's own; the client can't choose it.
    const token = tokenFor(req.user, provider);
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
    const outgoing =
      typeof req.body.From === "string" && req.body.From.startsWith("client:");
    if (outgoing) {
      const line = { legacy: true, workspaceId: IRON_WING_WORKSPACE_ID };
      if (!isClientOf(req.body.From, line)) return res.sendStatus(403);
      // The legacy number is owners only.
      if ((await lineRole(callerOf(req.body.From), line)) !== "owner")
        return res.sendStatus(403);
      const selected = await getProvider(IRON_WING_WORKSPACE_ID);
      if (!selected.legacy) return res.sendStatus(409);
      if (req.body.AssistIntent) await bindCallIntent(req.body, selected);
    }
    console.log("📞 Received call webhook event:", req.body);
    logCall(req.body);
    res.set("Content-Type", "text/xml");
    const agent = outgoing
      ? null
      : await receptionist.agentTwiml({
          body: req.body,
          provider: undefined,
          connection: undefined,
        });
    if (agent) return res.send(agent);
    const ring = outgoing ? undefined : await ringIdentities(undefined);
    res.send(voiceResponse(req.body, undefined, ring));
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
