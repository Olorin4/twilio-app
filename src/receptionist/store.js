/* All SQL for receptionist_calls: one row per call the AI receptionist
answered. A row is opened when the call is handed to the agent and closed
once, by the after-call step. */

const pool = require("../db");
const outbox = require("../outreachIntake/outbox");

const OUTCOMES = ["lead", "not_a_lead", "spam", "abandoned", "failed"];
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
// minutes, so nothing is silently lost.
async function listCalls(workspaceId, limit = 50) {
  const result = await pool.query(
    `SELECT call_sid, from_number, started_at, ended_at,
       COALESCE(outcome, 'failed') AS outcome, status, caller_name, company,
       mc_number, usdot, mc_verified, callback_number, callback_promise,
       carrier, details, summary, script, transcript
     FROM receptionist_calls
     WHERE workspace_id = $1
       AND (ended_at IS NOT NULL OR started_at < now() - interval '15 minutes')
     ORDER BY started_at DESC
     LIMIT $2`,
    [workspaceId, limit],
  );
  return result.rows;
}

async function setStatus(workspaceId, callSid, status) {
  if (!STATUSES.includes(status)) return false;
  const result = await pool.query(
    `UPDATE receptionist_calls
     SET status = $3, handled_at = CASE WHEN $3 = 'new' THEN NULL ELSE now() END
     WHERE workspace_id = $1 AND call_sid = $2`,
    [workspaceId, callSid, status],
  );
  return result.rowCount > 0;
}

// Cards that still need the owner: a lead, a message, or a call the agent
// failed on - including one that was never closed, which the list shows as
// failed.
async function countNew(workspaceId) {
  const result = await pool.query(
    `SELECT count(*) FROM receptionist_calls
     WHERE workspace_id = $1 AND status = 'new'
       AND (outcome IN ('lead', 'not_a_lead', 'failed')
         OR (outcome IS NULL AND started_at < now() - interval '15 minutes'))`,
    [workspaceId],
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
