/* The softphone's view of calls the AI receptionist answered. Mounted behind
the operator login, like every route that is not a Twilio webhook. */

const { Router } = require("express");
const store = require("./store");
const { publish } = require("../messageEvents");
const { IRON_WING_WORKSPACE_ID } = require("../workspaceContext");

const router = Router();
const callSidPattern = /^CA[0-9a-f]{32}$/i;
const workspaceId = (req) => req.workspace?.id || IRON_WING_WORKSPACE_ID;
// The table does not exist until its migration has run.
const tableMissing = (error) => error?.code === "42P01";

const toLead = (row) => ({
  callSid: row.call_sid,
  from: row.from_number,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  outcome: row.outcome,
  status: row.status,
  callerName: row.caller_name,
  company: row.company,
  mcNumber: row.mc_number,
  usdot: row.usdot,
  mcVerified: row.mc_verified,
  callbackNumber: row.callback_number,
  callbackPromise: row.callback_promise,
  carrier: row.carrier,
  details: row.details,
  summary: row.summary,
  script: row.script,
  transcript: row.transcript,
  // The agent that took the call; null for calls from before agent profiles.
  agentKind: row.agent_kind,
  agentPersonaName: row.agent_persona_name,
});

router.get("/", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    return res.json((await store.listCalls(workspaceId(req))).map(toLead));
  } catch (error) {
    if (tableMissing(error)) return res.json([]);
    console.error("Leads list failed:", error.message);
    return res.status(500).json({ error: "Could not load leads." });
  }
});

router.get("/count", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    return res.json({ leads: await store.countNew(workspaceId(req)) });
  } catch (error) {
    if (!tableMissing(error))
      console.error("Leads count failed:", error.message);
    return res.json({ leads: 0 });
  }
});

router.post("/:callSid/status", async (req, res) => {
  const status = req.body?.status;
  if (
    !callSidPattern.test(req.params.callSid) ||
    !store.STATUSES.includes(status)
  )
    return res.sendStatus(400);
  try {
    const changed = await store.setStatus(
      workspaceId(req),
      req.params.callSid,
      status,
    );
    if (!changed) return res.sendStatus(404);
    publish();
    return res.sendStatus(204);
  } catch (error) {
    console.error("Lead status change failed:", error.message);
    return res.sendStatus(500);
  }
});

module.exports = router;
