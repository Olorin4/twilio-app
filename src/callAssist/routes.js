const { Router } = require("express");
const { randomUUID } = require("node:crypto");
const pool = require("../db");
const { getProvider } = require("../providerContext");
const { callableNumber } = require("../receptionist/phone");
const {
  config,
  eligible,
  uuid,
  callSid,
  normalize,
  e164,
} = require("./config");

const router = Router();
const outcomes = ["connected", "no-answer", "follow-up"];
const safe = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    console.error("Call assist request failed:", error.code || "unavailable");
    if (!res.headersSent)
      res
        .status(503)
        .json({ error: "Call details are temporarily unavailable." });
    else res.end();
  }
};

function context(provider, destination) {
  return {
    workspace: provider.workspaceId,
    connection: provider.id,
    number: provider.phoneNumber,
    destination,
  };
}

const sessionQuery = `SELECT s.*, l.status AS leg_status FROM phone_call_sessions s
  LEFT JOIN LATERAL (
    SELECT status FROM twilio_call_legs WHERE parent_call_sid = s.call_sid
      AND workspace_id = s.workspace_id
      AND provider_connection_id IS NOT DISTINCT FROM s.provider_connection_id
    ORDER BY updated_at DESC LIMIT 1
  ) l ON true WHERE s.workspace_id = $1`;

async function snapshot(workspace, key, sid = false, includeTranscript = true) {
  const {
    rows: [row],
  } = await pool.query(
    `${sessionQuery} AND s.${sid ? "call_sid" : "id"} = $2`,
    [workspace, key],
  );
  if (!row) return null;
  const settings = config();
  const captureAllowed = eligible(settings, {
    workspace: row.workspace_id,
    connection: row.provider_connection_id,
    number: row.from_number,
    destination: row.destination,
  });
  const transcript =
    includeTranscript &&
    settings.retainTranscript &&
    row.capture_ended_at &&
    Date.now() - row.capture_ended_at.getTime() < 7 * 86400000
      ? (
          await pool.query(
            `SELECT speaker, content FROM phone_call_utterances
        WHERE session_id = $1 ORDER BY sequence_id`,
            [row.id],
          )
        ).rows
      : undefined;
  const expired =
    !row.call_sid && Date.now() - row.created_at.getTime() > 120000;
  return {
    id: row.id,
    callSid: row.call_sid,
    leadSid: row.lead_sid,
    assist: row.assist,
    capture:
      row.assist && !captureAllowed && !row.capture_ended_at
        ? "unavailable"
        : row.capture_state,
    suggesting:
      row.assist &&
      captureAllowed &&
      !row.capture_ended_at &&
      Boolean(row.model_lease_until),
    suggestion: row.suggestion,
    suggestionFailed: row.suggestion_failed,
    suggestionLimit: row.suggestion_count >= settings.maxSuggestions,
    canSuggest:
      row.assist &&
      captureAllowed &&
      row.capture_state === "listening" &&
      !row.stop_requested &&
      row.suggestion_count < settings.maxSuggestions,
    stopping: row.stop_requested && !row.stop_confirmed,
    summaryState: expired
      ? "empty"
      : row.assist && row.summary_state === "none" && row.capture_ended_at
        ? "pending"
        : row.summary_state,
    summary: row.summary,
    transcript,
    partial: row.partial,
    status: expired ? "canceled" : row.leg_status,
    notes: row.notes,
    outcome: row.outcome,
    metrics: row.assist
      ? {
          capturedSeconds:
            row.capture_started_at && row.capture_ended_at
              ? Math.max(
                  0,
                  Math.round(
                    (row.capture_ended_at - row.capture_started_at) / 1000,
                  ),
                )
              : null,
          suggestions: row.suggestion_count,
          inputTokens: Number(row.input_tokens),
          outputTokens: Number(row.output_tokens),
        }
      : undefined,
  };
}

router.get(
  "/eligibility",
  safe(async (req, res) => {
    const settings = config();
    const destination = normalize(req.query.destination);
    if (
      !settings.enabled ||
      settings.workspace !== req.workspace.id ||
      !settings.destinations.has(destination)
    )
      return res.json({ enabled: false });
    const provider = await getProvider(req.workspace.id);
    return res.json({
      enabled:
        provider.voiceEnabled &&
        eligible(settings, context(provider, destination)),
    });
  }),
);

router.post(
  "/intents",
  safe(async (req, res) => {
    const destination = normalize(req.body?.destination);
    const leadSid = req.body?.leadSid || null;
    const assist = req.body?.assist === true;
    if (!e164.test(destination) || (leadSid && !callSid.test(leadSid)))
      return res.status(400).json({ error: "Choose a valid callback number." });
    const provider = await getProvider(req.workspace.id);
    if (
      !provider.voiceEnabled ||
      (assist && !eligible(config(), context(provider, destination)))
    )
      return res
        .status(409)
        .json({ error: "Live assist is unavailable for this call." });
    if (leadSid) {
      const {
        rows: [lead],
      } = await pool.query(
        "SELECT callback_number, from_number FROM receptionist_calls WHERE call_sid = $1 AND workspace_id = $2",
        [leadSid, req.workspace.id],
      );
      if (
        !lead ||
        (callableNumber(lead.callback_number) ||
          callableNumber(lead.from_number)) !== destination
      )
        return res
          .status(409)
          .json({ error: "The lead callback number changed." });
    }
    const id = randomUUID();
    await pool.query(
      `INSERT INTO phone_call_sessions
      (id, workspace_id, provider_connection_id, account_sid, from_number, destination, lead_sid, assist)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        req.workspace.id,
        provider.id || null,
        provider.accountSid,
        provider.phoneNumber,
        destination,
        leadSid,
        assist,
      ],
    );
    return res.status(201).json({ id });
  }),
);

router.param("sessionId", (req, res, next, id) =>
  uuid.test(id) ? next() : res.sendStatus(400),
);
router.param("callSid", (req, res, next, id) =>
  callSid.test(id) ? next() : res.sendStatus(400),
);

router.get(
  "/history/:callSid",
  safe(async (req, res) => {
    const workspace = req.workspace.id;
    const sid = req.params.callSid;
    const data = await snapshot(workspace, sid, true);
    if (data) return res.json(data);
    const { rowCount } = await pool.query(
      "SELECT 1 FROM call_logs WHERE workspace_id = $1 AND call_sid = $2",
      [workspace, sid],
    );
    return rowCount
      ? res.json({ callSid: sid, notes: "" })
      : res.sendStatus(404);
  }),
);

function resultFields(req) {
  const { notes, outcome } = req.body || {};
  if (
    typeof notes !== "string" ||
    notes.length > 4000 ||
    !(outcome === null || outcomes.includes(outcome))
  )
    return null;
  return { notes: notes.trim(), outcome };
}

router.patch(
  "/history/:callSid",
  safe(async (req, res) => {
    const fields = resultFields(req);
    if (!fields) return res.sendStatus(400);
    const { rowCount } = await pool.query(
      `INSERT INTO phone_call_sessions
       (id, workspace_id, provider_connection_id, account_sid, from_number, destination,
        call_sid, notes, outcome)
     SELECT $1, workspace_id, provider_connection_id, '', COALESCE(from_number, ''),
       COALESCE(to_number, ''), call_sid, $4, $5 FROM call_logs
     WHERE workspace_id = $2 AND call_sid = $3
     ON CONFLICT (call_sid) DO UPDATE SET notes = EXCLUDED.notes, outcome = EXCLUDED.outcome,
       updated_at = now() WHERE phone_call_sessions.workspace_id = EXCLUDED.workspace_id
       AND phone_call_sessions.provider_connection_id IS NOT DISTINCT FROM EXCLUDED.provider_connection_id`,
      [
        randomUUID(),
        req.workspace.id,
        req.params.callSid,
        fields.notes,
        fields.outcome,
      ],
    );
    return res.sendStatus(rowCount ? 204 : 404);
  }),
);

router.get(
  "/sessions/:sessionId",
  safe(async (req, res) => {
    const data = await snapshot(req.workspace.id, req.params.sessionId);
    return data ? res.json(data) : res.sendStatus(404);
  }),
);

router.get(
  "/sessions/:sessionId/events",
  safe(async (req, res) => {
    const key = req.params.sessionId;
    const workspace = req.workspace.id;
    let data = await snapshot(workspace, key, false, false);
    if (!data) return res.sendStatus(404);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    let previous;
    let busy = false;
    let heartbeat = Date.now();
    function write() {
      if (res.writableEnded || res.destroyed) return;
      const serialized = JSON.stringify(data);
      if (previous !== serialized) res.write(`data: ${serialized}\n\n`);
      else if (Date.now() - heartbeat > 15000) {
        res.write(": heartbeat\n\n");
        heartbeat = Date.now();
      }
      previous = serialized;
    }
    write();
    const timer = setInterval(async () => {
      if (busy || res.destroyed) return;
      busy = true;
      try {
        data = await snapshot(workspace, key, false, false);
        if (!data) res.end();
        else write();
      } catch {
        res.end();
      } finally {
        busy = false;
      }
    }, 400);
    res.on("close", () => clearInterval(timer));
  }),
);

router.patch(
  "/sessions/:sessionId",
  safe(async (req, res) => {
    const fields = resultFields(req);
    if (!fields) return res.sendStatus(400);
    const { rowCount } = await pool.query(
      "UPDATE phone_call_sessions SET notes = $3, outcome = $4, updated_at = now() WHERE workspace_id = $1 AND id = $2 AND call_sid IS NOT NULL",
      [req.workspace.id, req.params.sessionId, fields.notes, fields.outcome],
    );
    return res.sendStatus(rowCount ? 204 : 404);
  }),
);

router.post(
  "/sessions/:sessionId/:action",
  safe(async (req, res) => {
    const id = req.params.sessionId;
    const workspace = req.workspace.id;
    const action = req.params.action;
    const data = await snapshot(workspace, id, false, false);
    if (!data?.assist) return res.sendStatus(404);
    if (action === "stop") {
      await pool.query(
        "UPDATE phone_call_sessions SET stop_requested = true, updated_at = now() WHERE id = $1 AND workspace_id = $2",
        [id, workspace],
      );
    } else if (action === "suggest" && data.canSuggest) {
      await pool.query(
        "UPDATE phone_call_sessions SET next_suggestion_at = now(), updated_at = now() WHERE id = $1 AND workspace_id = $2 AND capture_ended_at IS NULL AND NOT stop_requested",
        [id, workspace],
      );
    } else if (
      action === "retry" &&
      data.summaryState === "unavailable" &&
      config().enabled &&
      config().workspace === workspace
    ) {
      const { rowCount } = await pool.query(
        `UPDATE phone_call_sessions SET summary_state = 'pending', summary_attempts = 0, summary_at = now(),
       updated_at = now() WHERE id = $1 AND workspace_id = $2 AND summary_state = 'unavailable'
       AND EXISTS (SELECT 1 FROM phone_call_utterances WHERE session_id = $1)`,
        [id, workspace],
      );
      if (!rowCount) return res.sendStatus(409);
    } else return res.sendStatus(409);
    return res.sendStatus(204);
  }),
);

module.exports = router;
