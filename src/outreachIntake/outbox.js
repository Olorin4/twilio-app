/* Writes jack.call.v1 events to outreach_outbox. Called with the same
database client (and so the same transaction) as the call row change. The
unique keys on event_id and (call_sid, revision) make a repeat a no-op. */

const { CONTRACT } = require("./contract");
const { buildPayload } = require("./payload");
const { getConfig } = require("./config");

// Only leads go to Outreach.
const shouldEnqueue = (row) => Boolean(row && row.outcome === "lead");

// Inserts the event for `row` at `revision`. Returns true when a new event
// was stored, false when the row is not a lead or the event already exists.
async function enqueue(db, row, revision, options = {}) {
  if (!shouldEnqueue(row)) return false;
  const { env = process.env, occurredAt } = options;
  const payload = buildPayload(row, {
    revision,
    occurredAt,
    sourceBaseUrl: getConfig(env).sourceBaseUrl,
  });
  const result = await db.query(
    `INSERT INTO outreach_outbox
       (event_id, call_sid, revision, contract, payload, status, attempts, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'PENDING', 0, now())
     ON CONFLICT DO NOTHING`,
    [
      payload.event_id,
      row.call_sid,
      revision,
      CONTRACT,
      JSON.stringify(payload),
    ],
  );
  return result.rowCount > 0;
}

module.exports = { enqueue, shouldEnqueue };
