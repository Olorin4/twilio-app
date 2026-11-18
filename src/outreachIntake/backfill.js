/* Queues jack.call.v1 events for lead calls that closed before the outbox
existed (or while it could not be written). Revision 1 for every closed
lead, revision 2 when its summary was stored. The outbox's unique keys make
a rerun a no-op. Returns counts only. */

const { enqueue } = require("./outbox");
const { eventId } = require("./payload");

async function backfill({ db, since, dryRun = false, env = process.env }) {
  const at = new Date(since);
  if (!since || Number.isNaN(at.getTime()))
    throw new Error("--since must be an ISO date.");
  const { rows } = await db.query(
    `SELECT * FROM receptionist_calls
     WHERE outcome = 'lead' AND ended_at IS NOT NULL AND ended_at >= $1
     ORDER BY ended_at, call_sid`,
    [at],
  );
  const events = [];
  for (const row of rows) {
    events.push({ row, revision: 1 });
    if (row.summary != null) events.push({ row, revision: 2 });
  }
  const counts = {
    calls: rows.length,
    events: events.length,
    queued: 0,
    existing: 0,
  };
  if (dryRun) {
    const ids = events.map(({ row, revision }) =>
      eventId(row.call_sid, revision),
    );
    const found = ids.length
      ? await db.query(
          "SELECT count(*) FROM outreach_outbox WHERE event_id = ANY($1::uuid[])",
          [ids],
        )
      : { rows: [{ count: 0 }] };
    counts.existing = Number(found.rows[0].count);
    counts.queued = counts.events - counts.existing;
    return { ...counts, dryRun: true };
  }
  for (const { row, revision } of events) {
    // There is no stored time for the summary, so both revisions use the
    // time the call ended: the same event every rerun.
    const added = await enqueue(db, row, revision, {
      env,
      occurredAt: row.ended_at,
    });
    if (added) counts.queued += 1;
    else counts.existing += 1;
  }
  return { ...counts, dryRun: false };
}

module.exports = { backfill };
