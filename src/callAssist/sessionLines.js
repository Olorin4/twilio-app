/* One-off repair for Live Assist sessions that hold a softphone identity
(client:…) as from_number instead of the line the call used. Release 58bedcf
stored the identity when notes were saved on a softphone call; visibility now
judges such a session by its from_number only when it is a phone number. Sets
from_number to the call's child-leg line where that is known. Rerunnable: a
repaired row no longer matches. */
const { clientLine } = require("../callSql");

async function backfillSessionLines(db) {
  const line = clientLine("cl");
  const { rowCount } = await db.query(
    `UPDATE phone_call_sessions s SET from_number = ${line}
     FROM call_logs cl
     WHERE cl.call_sid = s.call_sid AND cl.workspace_id = s.workspace_id
       AND s.from_number LIKE 'client:%' AND ${line} IS NOT NULL`,
  );
  return rowCount;
}

module.exports = { backfillSessionLines };
