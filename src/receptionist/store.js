/* All SQL for receptionist_calls: one row per call the AI receptionist
answered. A row is opened when the call is handed to the agent and closed
once, by the after-call step. */

const pool = require("../db");
const outbox = require("../outreachIntake/outbox");
const { lineCondition } = require("../visibility");

/* Whether the person may see a lead (alias c), with params numbered from
firstParam. A lead follows its call's dialed line (the call_logs row's
to_number, in the same workspace) under the visibility scope; a lead whose
call row is missing is visible to owners only. No scope sees nothing. */
function leadCondition(scope, firstParam) {
  const line = lineCondition(
    scope,
    "vc.to_number",
    "vc.from_number",
    firstParam,
  );
  const logged = `SELECT 1 FROM call_logs vc WHERE vc.call_sid = c.call_sid AND vc.workspace_id = c.workspace_id`;
  return {
    sql: `(CASE WHEN EXISTS (${logged}) THEN EXISTS (${logged} AND ${line.sql})
      ELSE $${firstParam + 2}::boolean END)`,
    params: [...line.params, scope?.all === true],
  };
}

// Every kind's outcomes (kinds.js), plus the two the app records itself.
const OUTCOMES = [
  "lead",
  "not_a_lead",
  "message",
  "urgent",
  "support_request",
  "not_support",
  "spam",
  "abandoned",
  "failed",
];
const STATUSES = ["new", "called", "dismissed"];

const json = (value) => (value == null ? null : JSON.stringify(value));

// Runs `change` (the call row update) and, for a lead of the Outreach intake
// workspace, queues the Outreach event in the same transaction, so a
// committed lead always has its event.
// The event insert runs under a savepoint: if it fails (say the outbox table
// is not migrated yet) the call row is still saved and only the event is
// skipped - the backfill script can add it later. Saving the lead matters
// more than telling Outreach about it.
async function changeWithEvent(sql, params, revision) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(sql, params);
    const row = result.rows[0] || null;
    if (outbox.shouldEnqueue(row, revision)) {
      await client.query("SAVEPOINT outreach_event");
      try {
        await outbox.enqueue(client, row, revision);
        await client.query("RELEASE SAVEPOINT outreach_event");
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT outreach_event");
        console.error("Outreach event not queued:", error.code || "ERROR");
      }
    }
    await client.query("COMMIT");
    return row;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function startCall({
  callSid,
  workspaceId,
  connectionId,
  from,
  agentProfileId,
}) {
  await pool.query(
    `INSERT INTO receptionist_calls
       (call_sid, workspace_id, provider_connection_id, from_number, agent_profile_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (call_sid) DO NOTHING`,
    [callSid, workspaceId, connectionId || null, from, agentProfileId || null],
  );
}

// Closes a call. Only an open call is updated, so whichever caller gets
// there first wins and a second attempt changes nothing. A lead also queues
// revision 1 of its Outreach event (summary pending).
async function finishCall(callSid, fields = {}) {
  if (!OUTCOMES.includes(fields.outcome))
    throw new Error("Unknown receptionist call outcome.");
  return changeWithEvent(
    `UPDATE receptionist_calls SET
       ended_at = now(), outcome = $2, caller_name = $3, company = $4,
       mc_number = $5, usdot = $6, mc_verified = $7, callback_number = $8,
       callback_promise = $9, carrier = $10::jsonb, details = $11::jsonb,
       summary = $12, script = $13::jsonb,
       transcript = COALESCE($14::jsonb, transcript)
     WHERE call_sid = $1 AND ended_at IS NULL
     RETURNING *`,
    [
      callSid,
      fields.outcome,
      fields.callerName || null,
      fields.company || null,
      fields.mcNumber || null,
      fields.usdot || null,
      Boolean(fields.mcVerified),
      fields.callbackNumber || null,
      fields.callbackPromise || null,
      json(fields.carrier),
      json(fields.details),
      fields.summary || null,
      json(fields.script),
      json(fields.transcript),
    ],
    1,
  );
}

// The daily limit is per profile: a caller who reached one business's agent
// three times can still reach another's.
async function countAgentCalls(from, agentProfileId, hours = 24) {
  const result = await pool.query(
    `SELECT count(*) FROM receptionist_calls
     WHERE from_number = $1 AND agent_profile_id = $2
       AND started_at >= now() - make_interval(hours => $3)`,
    [from, agentProfileId, hours],
  );
  return Number(result.rows[0].count);
}

// A call the agent is still on is hidden. One that was never closed (the
// process died, or the session never started) shows as failed after 15
// minutes, so nothing is silently lost. Each row names the agent that took
// the call; a call from before agent profiles has nulls there.
async function listCalls(workspaceId, scope, limit = 50) {
  const visible = leadCondition(scope, 3);
  const result = await pool.query(
    `SELECT c.call_sid, c.from_number, c.started_at, c.ended_at,
       COALESCE(c.outcome, 'failed') AS outcome, c.status, c.caller_name,
       c.company, c.mc_number, c.usdot, c.mc_verified, c.callback_number,
       c.callback_promise, c.carrier, c.details, c.summary, c.script,
       c.transcript, p.kind AS agent_kind,
       p.persona_name AS agent_persona_name
     FROM receptionist_calls c
     LEFT JOIN agent_profiles p
       ON p.id = c.agent_profile_id AND p.workspace_id = c.workspace_id
     WHERE c.workspace_id = $1
       AND (c.ended_at IS NOT NULL OR c.started_at < now() - interval '15 minutes')
       AND ${visible.sql}
     ORDER BY c.started_at DESC
     LIMIT $2`,
    [workspaceId, limit, ...visible.params],
  );
  return result.rows;
}

// False when no lead in the workspace has the SID, or the person may not
// see it: a hidden lead is answered like an unknown one.
async function setStatus(workspaceId, callSid, status, scope) {
  if (!STATUSES.includes(status)) return false;
  const visible = leadCondition(scope, 4);
  const result = await pool.query(
    `UPDATE receptionist_calls c
     SET status = $3, handled_at = CASE WHEN $3 = 'new' THEN NULL ELSE now() END
     WHERE c.workspace_id = $1 AND c.call_sid = $2 AND ${visible.sql}`,
    [workspaceId, callSid, status, ...visible.params],
  );
  return result.rowCount > 0;
}

// Cards that still need the owner: the outcomes that are emailed (a lead or
// a message of any kind), or a call the agent failed on - including one that
// was never closed, which the list shows as failed.
async function countNew(workspaceId, scope) {
  const visible = leadCondition(scope, 2);
  const result = await pool.query(
    `SELECT count(*) FROM receptionist_calls c
     WHERE c.workspace_id = $1 AND c.status = 'new'
       AND (c.outcome IN ('lead', 'not_a_lead', 'message', 'urgent',
                          'support_request', 'failed')
         OR (c.outcome IS NULL AND c.started_at < now() - interval '15 minutes'))
       AND ${visible.sql}`,
    [workspaceId, ...visible.params],
  );
  return Number(result.rows[0].count);
}

// Adds the after-call summary to a call that is already saved. The
// transcript and carrier record written when the call closed are left alone.
// A lead also queues revision 2 of its Outreach event (summary or
// UNAVAILABLE); so does a call reported as a lead that the summary found was
// not_a_lead, so Outreach can retract it.
async function updateSummary(callSid, fields = {}) {
  if (!OUTCOMES.includes(fields.outcome))
    throw new Error("Unknown receptionist call outcome.");
  return changeWithEvent(
    `UPDATE receptionist_calls SET
       outcome = $2, caller_name = $3, company = $4, mc_number = $5,
       usdot = $6, mc_verified = $7, callback_number = $8,
       callback_promise = $9, details = $10::jsonb, summary = $11,
       script = $12::jsonb
     WHERE call_sid = $1 AND ended_at IS NOT NULL
     RETURNING *`,
    [
      callSid,
      fields.outcome,
      fields.callerName || null,
      fields.company || null,
      fields.mcNumber || null,
      fields.usdot || null,
      Boolean(fields.mcVerified),
      fields.callbackNumber || null,
      fields.callbackPromise || null,
      json(fields.details),
      fields.summary || null,
      json(fields.script),
    ],
    2,
  );
}

// Records what the call cost beyond Twilio's own call charge. Either figure
// may be null when it could not be worked out.
async function saveCosts(callSid, { usage, claudeCost, relayCost } = {}) {
  await pool.query(
    `UPDATE receptionist_calls
     SET usage = $2::jsonb, claude_cost = $3, relay_cost = $4
     WHERE call_sid = $1`,
    [callSid, json(usage || []), claudeCost ?? null, relayCost ?? null],
  );
}

// Removes the record of a call that was never handed to the agent after all.
async function discardCall(callSid) {
  await pool.query(
    "DELETE FROM receptionist_calls WHERE call_sid = $1 AND ended_at IS NULL",
    [callSid],
  );
}

module.exports = {
  leadCondition,
  OUTCOMES,
  STATUSES,
  startCall,
  finishCall,
  countAgentCalls,
  listCalls,
  setStatus,
  countNew,
  updateSummary,
  discardCall,
  saveCosts,
};
