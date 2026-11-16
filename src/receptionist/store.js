/* All SQL for receptionist_calls: one row per call the AI receptionist
answered. A row is opened when the call is handed to the agent and closed
once, by the after-call step. */

const pool = require("../db");

const OUTCOMES = ["lead", "not_a_lead", "spam", "abandoned", "failed"];
const STATUSES = ["new", "called", "dismissed"];

const json = (value) => (value == null ? null : JSON.stringify(value));

async function startCall({ callSid, workspaceId, connectionId, from }) {
  await pool.query(
    `INSERT INTO receptionist_calls (call_sid, workspace_id, provider_connection_id, from_number)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (call_sid) DO NOTHING`,
    [callSid, workspaceId, connectionId || null, from],
  );
}

// Closes a call. Only an open call is updated, so whichever caller gets
// there first wins and a second attempt changes nothing.
async function finishCall(callSid, fields = {}) {
  if (!OUTCOMES.includes(fields.outcome))
    throw new Error("Unknown receptionist call outcome.");
  const result = await pool.query(
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
  );
  return result.rows[0] || null;
}

async function countAgentCalls(from, hours = 24) {
  const result = await pool.query(
    `SELECT count(*) FROM receptionist_calls
     WHERE from_number = $1 AND started_at >= now() - make_interval(hours => $2)`,
    [from, hours],
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

async function countNew(workspaceId) {
  const result = await pool.query(
    `SELECT count(*) FROM receptionist_calls
     WHERE workspace_id = $1 AND status = 'new' AND outcome IN ('lead', 'not_a_lead', 'failed')`,
    [workspaceId],
  );
  return Number(result.rows[0].count);
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
};
