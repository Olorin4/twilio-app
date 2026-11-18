/* Queues jack.call.v1 events for lead calls that closed before the outbox
existed (or while it could not be written). Revision 1 for every closed
lead, revision 2 when its summary was stored. A not_a_lead call gets a
revision 2 only when its revision 1 is already in the outbox: the stored row
does not say what the call was first reported as, so a call with no
revision 1 is treated as never reported. Only calls of
OUTREACH_INTAKE_WORKSPACE_ID are read; with it unset nothing is queued. The
outbox's unique keys make a rerun a no-op. Returns counts only. */

const { enqueue } = require("./outbox");
const { getConfig, warnWorkspaceUnset } = require("./config");

async function backfill({ db, since, dryRun = false, env = process.env }) {
  const at = new Date(since);
  if (!since || Number.isNaN(at.getTime()))
    throw new Error("--since must be an ISO date.");
  const { workspaceId } = getConfig(env);
  if (!workspaceId) warnWorkspaceUnset();
  const { rows } = workspaceId
    ? await db.query(
        `SELECT * FROM receptionist_calls
         WHERE ended_at IS NOT NULL AND ended_at >= $1 AND workspace_id = $2
           AND (outcome = 'lead' OR (outcome = 'not_a_lead' AND summary IS NOT NULL))
         ORDER BY ended_at, call_sid`,
        [at, workspaceId],
      )
    : { rows: [] };
  const events = [];
  for (const row of rows) {
    if (row.outcome === "lead") events.push({ row, revision: 1 });
    if (row.summary != null) events.push({ row, revision: 2 });
  }
  const counts = {
    calls: rows.length,
    events: events.length,
    queued: 0,
    existing: 0,
    skipped: 0,
  };
  const sids = rows.map((row) => row.call_sid);
  const found = sids.length
    ? await db.query(
        "SELECT call_sid, revision FROM outreach_outbox WHERE call_sid = ANY($1::text[])",
        [sids],
      )
    : { rows: [] };
  const have = new Set(found.rows.map((r) => `${r.call_sid}:${r.revision}`));
  for (const { row, revision } of events) {
    if (have.has(`${row.call_sid}:${revision}`)) counts.existing += 1;
    else if (row.outcome !== "lead" && !have.has(`${row.call_sid}:1`))
      counts.skipped += 1;
    else if (dryRun) counts.queued += 1;
    // There is no stored time for the summary, so both revisions use the
    // time the call ended: the same event every rerun.
    else if (
      await enqueue(db, row, revision, { env, occurredAt: row.ended_at })
    )
      counts.queued += 1;
    else counts.existing += 1;
  }
  return { ...counts, dryRun };
}

module.exports = { backfill };
