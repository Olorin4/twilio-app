/* SQL shared by call history and the contact timeline, so both read a call
the same way. Every expression is on call_logs aliased cl, and $1 is the
legacy caller ID (TWILIO_CALLER_ID), whose calls count as outgoing. Kept apart
from logManager.js so readers need not load the Twilio client. */
const { lineCondition } = require("./visibility");

// SQL literal matching an E.164 phone number.
const E164_SQL = "'^[+][1-9][0-9]{1,14}$'";

/* The line a softphone call (from client:<identity>) on call_logs row `alias`
used: its newest child leg's E.164 from_number, or NULL. Every E.164 child leg
of a softphone root carries the connection's single callerId today (the
outgoing Dial in src/callResponse.js), so the newest leg is representative;
call_sid breaks ties so the pick is deterministic. Shown as local_number and
used by every visibility filter on a call (history, timeline, Live Assist
details and notes), so all judge the same line. */
const clientLine = (
  alias,
) => `(SELECT child.from_number FROM twilio_call_legs leg JOIN call_logs child ON child.call_sid = leg.call_sid
                AND child.workspace_id = ${alias}.workspace_id AND child.provider_connection_id IS NOT DISTINCT FROM ${alias}.provider_connection_id
                WHERE leg.parent_call_sid = ${alias}.call_sid AND leg.workspace_id = ${alias}.workspace_id
                  AND leg.provider_connection_id IS NOT DISTINCT FROM ${alias}.provider_connection_id
                  AND child.from_number ~ ${E164_SQL}
                ORDER BY leg.updated_at DESC, leg.call_sid DESC LIMIT 1)`;

// The call's line for visibility: its from_number when outbound, else its
// to_number.
const CALL_LINE =
  "CASE WHEN cl.direction LIKE 'outbound%' OR cl.from_number = $1 THEN cl.from_number ELSE cl.to_number END";

const CALL_STATUS = `COALESCE((SELECT leg.status FROM twilio_call_legs leg WHERE (cl.from_number = $1 OR cl.from_number LIKE 'client:%') AND leg.parent_call_sid = cl.call_sid AND leg.workspace_id = cl.workspace_id AND leg.provider_connection_id IS NOT DISTINCT FROM cl.provider_connection_id ORDER BY leg.updated_at DESC LIMIT 1), cl.status)`;

const CALL_MISSED = `(cl.direction = 'inbound' AND cl.from_number NOT LIKE 'client:%' AND EXISTS (SELECT 1 FROM twilio_call_legs leg WHERE leg.parent_call_sid = cl.call_sid AND leg.workspace_id = cl.workspace_id AND leg.provider_connection_id IS NOT DISTINCT FROM cl.provider_connection_id AND leg.status IN ('busy', 'failed', 'no-answer', 'canceled') AND NOT leg.answered) AND NOT EXISTS (SELECT 1 FROM twilio_call_legs leg WHERE leg.parent_call_sid = cl.call_sid AND leg.workspace_id = cl.workspace_id AND leg.provider_connection_id IS NOT DISTINCT FROM cl.provider_connection_id AND leg.answered))`;

const CALL_ANSWERED = `EXISTS (SELECT 1 FROM twilio_call_legs leg WHERE leg.parent_call_sid = cl.call_sid AND leg.workspace_id = cl.workspace_id AND leg.provider_connection_id IS NOT DISTINCT FROM cl.provider_connection_id AND leg.answered)`;

const CALL_ANNOUNCEMENT = `(SELECT json_build_object('kind', a.kind, 'initiated', a.initiated_at IS NOT NULL, 'completed', a.completed_at IS NOT NULL) FROM call_announcements a WHERE a.call_sid = cl.call_sid AND a.workspace_id = cl.workspace_id AND a.provider_connection_id IS NOT DISTINCT FROM cl.provider_connection_id)`;

const CALL_DURATION = `COALESCE((SELECT leg.duration FROM twilio_call_legs leg WHERE cl.direction = 'inbound' AND leg.parent_call_sid = cl.call_sid AND leg.workspace_id = cl.workspace_id AND leg.provider_connection_id IS NOT DISTINCT FROM cl.provider_connection_id AND (leg.answered OR cl.from_number = $1 OR cl.from_number LIKE 'client:%') AND leg.duration IS NOT NULL ORDER BY leg.updated_at DESC LIMIT 1), cl.duration)`;

const CALL_OUTGOING = `(cl.from_number = $1 OR cl.from_number LIKE 'client:%')`;

// The workspace number the call used, as call history shows it.
const CALL_LOCAL_NUMBER = `CASE WHEN cl.from_number LIKE 'client:%' THEN
               ${clientLine("cl")}
             WHEN cl.direction LIKE 'outbound%' OR cl.from_number = $1 THEN cl.from_number
             ELSE cl.to_number END`;

// A root row: not a child leg of another logged call.
const CALL_ROOT = `NOT EXISTS (
          SELECT 1 FROM twilio_call_legs leg
          JOIN call_logs parent ON parent.call_sid = leg.parent_call_sid
            AND parent.workspace_id = cl.workspace_id
            AND parent.provider_connection_id IS NOT DISTINCT FROM cl.provider_connection_id
          WHERE leg.call_sid = cl.call_sid
            AND leg.workspace_id = cl.workspace_id
            AND leg.provider_connection_id IS NOT DISTINCT FROM cl.provider_connection_id
        )`;

// A call log's line, by direction only: from_number when outbound, else
// to_number. Used by Live Assist.
const callLine = (alias) =>
  `CASE WHEN ${alias}.direction LIKE 'outbound%' THEN ${alias}.from_number ELSE ${alias}.to_number END`;

/* Whether the person may see a Live Assist session (alias s), with params
numbered from firstParam. A session on a logged call follows that call's
visibility; one not yet bound to a call follows its line, which is its
from_number. A softphone call (client: root) is judged by s.from_number when
it is a phone number: bindIntent binds a session only when its from_number is
the line the softphone dialed from, and the notes PATCH stores the line the
call used. A session still holding a softphone identity has no known line and
keeps the identity rule. Production has such rows from before this rule
(release 58bedcf stored the identity): migration 015 (backfillSessionLines)
rewrites them, and the notes PATCH repairs any it touches, e.g. one written
before the call's child leg was logged. Kept to a column test: a child-leg lookup
here is repeated inside every visibility branch and makes the timeline slow. */
const SESSION_CLIENT_LINE = `CASE WHEN s.from_number ~ ${E164_SQL} THEN s.from_number END`;

function sessionCondition(scope, firstParam) {
  const call = lineCondition(
    scope,
    callLine("vc"),
    "vc.from_number",
    firstParam,
    SESSION_CLIENT_LINE,
  );
  const line = lineCondition(
    scope,
    "s.from_number",
    "s.from_number",
    firstParam,
  );
  const logged = `SELECT 1 FROM call_logs vc WHERE vc.call_sid = s.call_sid AND vc.workspace_id = s.workspace_id`;
  return {
    sql: `(CASE WHEN EXISTS (${logged}) THEN EXISTS (${logged} AND ${call.sql}) ELSE ${line.sql} END)`,
    params: call.params,
  };
}

module.exports = {
  E164_SQL,
  clientLine,
  CALL_LINE,
  CALL_STATUS,
  CALL_MISSED,
  CALL_ANSWERED,
  CALL_ANNOUNCEMENT,
  CALL_DURATION,
  CALL_OUTGOING,
  CALL_LOCAL_NUMBER,
  CALL_ROOT,
  callLine,
  sessionCondition,
};
