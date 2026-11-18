/* Writes jack.call.v1 events to outreach_outbox. Called with the same
database client (and so the same transaction) as the call row change. The
unique keys on event_id and (call_sid, revision) make a repeat a no-op. */

const { CONTRACT } = require("./contract");
const { buildPayload } = require("./payload");
const { getConfig } = require("./config");

// Leads go to Outreach. A later revision may also report not_a_lead, but
// only for a call already reported as a lead (checked in the insert).
const shouldEnqueue = (row, revision = 1) =>
  Boolean(
    row &&
      (row.outcome === "lead" ||
        (row.outcome === "not_a_lead" && revision > 1)),
  );

// Inserts the event for `row` at `revision`. Returns true when a new event
// was stored, false when the row does not qualify, the event already exists,
// or (for not_a_lead) the call was never reported as a lead.
async function enqueue(db, row, revision, options = {}) {
  if (!shouldEnqueue(row, revision)) return false;
  const { env = process.env, occurredAt } = options;
  const payload = buildPayload(row, {
    revision,
    occurredAt,
    sourceBaseUrl: getConfig(env).sourceBaseUrl,
  });
  const result = await db.query(
    `INSERT INTO outreach_outbox
       (event_id, call_sid, revision, contract, payload, status, attempts, next_attempt_at)
     SELECT $1, $2, $3, $4, $5::jsonb, 'PENDING', 0, now()
     WHERE $6::boolean OR EXISTS (
       SELECT 1 FROM outreach_outbox WHERE call_sid = $2 AND revision = 1)
     ON CONFLICT DO NOTHING`,
    [
      payload.event_id,
      row.call_sid,
      revision,
      CONTRACT,
      JSON.stringify(payload),
      row.outcome === "lead",
    ],
  );
  return result.rowCount > 0;
}

module.exports = { enqueue, shouldEnqueue };
