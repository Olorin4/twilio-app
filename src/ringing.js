/* Who an inbound call rings. A softphone line rings its enabled assignees who
can still open its workspace, the first 10 by assignment time. A line with
none rings every enabled owner, and so does the legacy number. With no owner
accounts yet, it rings the identity used before user accounts existed.

This runs while Twilio waits for TwiML, so it is one query with a deadline,
and it never throws: any failure rings the bootstrap identity instead, so a
caller never hears silence because of it. */

const pool = require("./db");
const { identityFor } = require("./identity");

const RING_DEADLINE_MS = 1500;
// Twilio's <Dial> takes at most 10 <Client> nouns.
const MAX_RING = 10;

const RING_SQL = `
  WITH assigned AS (
    SELECT u.id, na.created_at AS at
    FROM number_assignees na JOIN app_users u ON u.id = na.user_id
    WHERE na.number_id = $1::uuid AND u.enabled
      AND (u.role = 'owner' OR EXISTS (
        SELECT 1 FROM workspace_members wm
        WHERE wm.workspace_id = $2::uuid AND wm.user_id = u.id))
  ), owners AS (
    SELECT u.id, u.created_at AS at FROM app_users u
    WHERE u.enabled AND u.role = 'owner' AND NOT EXISTS (SELECT 1 FROM assigned)
  )
  SELECT id FROM (
    SELECT id, 0 AS tier, at FROM assigned
    UNION ALL SELECT id, 1 AS tier, at FROM owners
  ) ring
  ORDER BY tier, at, id
  LIMIT ${MAX_RING}`;

// The legacy route has no provider object.
const lineOf = (provider) => provider || { legacy: true };

function bootstrapIdentities(provider) {
  const identity = identityFor({ id: null, bootstrap: true }, lineOf(provider));
  return identity ? [identity] : [];
}

async function ringIdentities(provider) {
  const line = lineOf(provider);
  let timer;
  try {
    const lookup = Promise.resolve(
      pool.query(RING_SQL, [
        line.legacy ? null : line.numberId || null,
        line.workspaceId || null,
      ]),
    );
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("timed out")),
        RING_DEADLINE_MS,
      );
    });
    const { rows } = await Promise.race([lookup, deadline]);
    if (!rows.length) return bootstrapIdentities(provider);
    return rows.map((row) => identityFor({ id: row.id }, line));
  } catch (error) {
    console.error(
      "Ring list unavailable; ringing the bootstrap identity:",
      error.message,
    );
    return bootstrapIdentities(provider);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { ringIdentities, RING_DEADLINE_MS, MAX_RING };
